/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sm = new SecretsManagerClient({});

const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME!;
const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME!;

/** Same slug shape the CLI enforces (`SLUG_RE` in cli/src/commands/linear.ts). */
const SLUG_RE = /^[a-zA-Z0-9_-]{4,50}$/;

/**
 * DELETE /v1/linear/workspaces/{slug} — deregister a Linear workspace.
 *
 * Cognito-authenticated. Only the workspace admin (the platform user who
 * ran `bgagent linear setup`/`add-workspace` for the slug, recorded as
 * `installed_by_platform_user_id`) may remove it.
 *
 * By default this is a *soft* removal that preserves the audit trail:
 *   1. Flip the registry row to `status='revoked'` (the OAuth resolver
 *      fail-closes on any status != 'active' — see
 *      `shared/linear-oauth-resolver.ts`, so a revoked workspace can no
 *      longer resolve a token and its inbound webhooks stop routing).
 *   2. Delete the per-workspace `bgagent-linear-oauth-<slug>` secret so no
 *      credential lingers.
 *   3. Delete project mappings that carry this workspace's id (best effort).
 *
 * Query flags:
 *   - `purge=true`         — delete the registry row outright (no audit row).
 *   - `keep_mappings=true` — leave `LinearProjectMappingTable` rows alone.
 *
 * Idempotent on the secret: if the secret is already gone we report
 * `secret_deleted: false` and still complete the revoke, so a retried or
 * partially-completed removal converges cleanly.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Authentication required.', requestId);
    }

    const slug = (event.pathParameters?.slug ?? '').trim();
    if (!SLUG_RE.test(slug)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid workspace slug. Must be 4-50 chars matching [a-zA-Z0-9_-].',
        requestId,
      );
    }

    const purge = event.queryStringParameters?.purge === 'true';
    const keepMappings = event.queryStringParameters?.keep_mappings === 'true';

    // ─── Locate the registry row by slug ─────────────────────────────
    // The registry table is keyed on `linear_workspace_id`, so a slug
    // lookup is a filtered scan. Only `status='active'` rows are valid
    // removal targets — an already-revoked (or unknown) slug returns 404
    // so the endpoint is not a revoke-oracle and we never re-run the
    // destructive path on a row that's already been torn down.
    const scan = await ddb.send(new ScanCommand({
      TableName: WORKSPACE_REGISTRY_TABLE,
      FilterExpression: 'workspace_slug = :slug AND #status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':slug': slug, ':active': 'active' },
      Limit: 1,
    }));
    const row = scan.Items?.[0];
    if (!row) {
      // Collapse "no such row" and "already revoked" into one 404 — the
      // caller learns nothing about existence, and there's nothing left
      // to remove either way.
      return errorResponse(404, ErrorCode.WORKSPACE_NOT_FOUND, `Workspace '${slug}' is not an active registration.`, requestId);
    }

    // ─── Admin authorization ─────────────────────────────────────────
    const installedBy = row.installed_by_platform_user_id as string | undefined;
    if (installedBy !== userId) {
      logger.warn('Linear remove-workspace rejected: caller is not the workspace admin', {
        request_id: requestId,
        workspace_slug: slug,
      });
      return errorResponse(403, ErrorCode.FORBIDDEN, 'Only the workspace admin who installed this workspace may remove it.', requestId);
    }

    const linearWorkspaceId = row.linear_workspace_id as string;
    const oauthSecretArn = row.oauth_secret_arn as string | undefined;
    const now = new Date().toISOString();

    // ─── Registry: revoke (soft) or purge (hard) ─────────────────────
    if (purge) {
      await ddb.send(new DeleteCommand({
        TableName: WORKSPACE_REGISTRY_TABLE,
        Key: { linear_workspace_id: linearWorkspaceId },
      }));
    } else {
      await ddb.send(new UpdateCommand({
        TableName: WORKSPACE_REGISTRY_TABLE,
        Key: { linear_workspace_id: linearWorkspaceId },
        UpdateExpression: 'SET #status = :revoked, revoked_at = :now, revoked_by_platform_user_id = :uid, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now, ':uid': userId },
      }));
    }

    // ─── Secrets Manager: delete the per-workspace OAuth secret ───────
    // Idempotent: a ResourceNotFoundException means the secret was already
    // removed by a prior (partial) run — that's success, not an error.
    let secretDeleted = false;
    if (oauthSecretArn) {
      try {
        await sm.send(new DeleteSecretCommand({
          SecretId: oauthSecretArn,
          // No recovery window — the workspace is being torn down and the
          // registry row is the audit record. Leaving a scheduled-deletion
          // secret around would block a same-slug re-onboarding.
          ForceDeleteWithoutRecovery: true,
        }));
        secretDeleted = true;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== 'ResourceNotFoundException') {
          // Any other SM error is a real failure — don't mask it.
          throw err;
        }
        logger.info('Linear OAuth secret already absent — treating removal as idempotent', {
          request_id: requestId,
          workspace_slug: slug,
        });
      }
    }

    // ─── Project mappings (optional) ─────────────────────────────────
    // The mapping table is keyed on `linear_project_id` and only rows that
    // carry a `linear_workspace_id` can be attributed to this workspace.
    // Rows onboarded before that field existed cannot be safely matched to
    // a slug, so they are intentionally left alone (see PR notes) — the
    // operator can remove them by project id if needed.
    let mappingsRemoved = 0;
    if (!keepMappings) {
      mappingsRemoved = await deleteWorkspaceProjectMappings(linearWorkspaceId);
    }

    logger.info('Linear workspace removed', {
      request_id: requestId,
      workspace_slug: slug,
      linear_workspace_id: linearWorkspaceId,
      mode: purge ? 'purged' : 'revoked',
      secret_deleted: secretDeleted,
      mappings_removed: mappingsRemoved,
    });

    return successResponse(200, {
      workspace_slug: slug,
      linear_workspace_id: linearWorkspaceId,
      status: purge ? 'purged' : 'revoked',
      secret_deleted: secretDeleted,
      mappings_removed: mappingsRemoved,
    }, requestId);
  } catch (err) {
    logger.error('Linear remove-workspace handler failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/**
 * Delete every `LinearProjectMappingTable` row attributable to the given
 * workspace. Attribution is by the `linear_workspace_id` field on the row;
 * rows without it are skipped (cannot be safely matched to a workspace).
 * Returns the number of rows deleted.
 */
async function deleteWorkspaceProjectMappings(linearWorkspaceId: string): Promise<number> {
  let removed = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const scan = await ddb.send(new ScanCommand({
      TableName: PROJECT_MAPPING_TABLE,
      FilterExpression: 'linear_workspace_id = :ws',
      ExpressionAttributeValues: { ':ws': linearWorkspaceId },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of scan.Items ?? []) {
      await ddb.send(new DeleteCommand({
        TableName: PROJECT_MAPPING_TABLE,
        Key: { linear_project_id: item.linear_project_id as string },
      }));
      removed += 1;
    }
    lastKey = scan.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return removed;
}
