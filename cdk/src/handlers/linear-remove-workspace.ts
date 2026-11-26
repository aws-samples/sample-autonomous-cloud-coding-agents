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

import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import type { LinearRevocationReason } from './shared/linear-oauth-resolver';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { makeClient, makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const sm = makeClient(SecretsManagerClient);

const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

const SLUG_RE = /^[a-zA-Z0-9_-]{4,50}$/;

const ADMIN_REMOVED_REVOCATION_REASON: LinearRevocationReason = 'admin_removed';

const REMOVABLE_ROW = '#status = :active OR (#status = :revoked AND (attribute_not_exists(revoked_reason) OR revoked_reason <> :reason))';

const OAUTH_SECRET_NAME_PREFIX = 'bgagent-linear-oauth-';

const MAX_SCAN_PAGES = 20;

interface RemoveWorkspaceResponseBody {
  readonly workspace_slug: string;
  readonly linear_workspace_id: string;
  readonly status: 'revoked' | 'purged';
  readonly secret: 'deleted' | 'absent' | 'not_applicable';
  readonly provider_name?: string;
}

/**
 * DELETE /v1/linear/workspaces/{slug} — deregister a Linear workspace.
 *
 * Cognito-authenticated. Only the workspace admin (the platform user recorded
 * as `installed_by_platform_user_id`) may remove it.
 *
 * A slug that more than one active row carries is refused (#883): nothing is
 * written, and the admin of any of those rows gets 409
 * `WORKSPACE_SLUG_AMBIGUOUS` with the `linear_workspace_id` of each.
 *
 * By default this is a soft removal: the registry row is flipped to
 * `status='revoked'` with `revoked_reason='admin_removed'`, and the
 * per-workspace `bgagent-linear-oauth-<slug>` secret is deleted. With the
 * query flag `purge=true` the registry row is deleted outright.
 *
 * Idempotent on the secret; the response says which of three things happened:
 *   - `secret: 'deleted'`        — a live secret was destroyed here.
 *   - `secret: 'absent'`         — nothing to delete.
 *   - `secret: 'not_applicable'` — this workspace is vault-managed and never
 *                                  had a Secrets Manager secret of its own.
 *
 * The AgentCore credential provider of a vault-managed workspace (a row with
 * `provider_name`) is not deleted: `provider_name` is echoed in the response.
 * Project mappings are not touched.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  let slug = '';
  let phase: 'lookup' | 'registry_write' | 'secret_delete' = 'lookup';

  try {
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Authentication required.', requestId);
    }

    slug = (event.pathParameters?.slug ?? '').trim();
    if (!SLUG_RE.test(slug)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid workspace slug. Must be 4-50 chars matching [a-zA-Z0-9_-].',
        requestId,
      );
    }

    const purge = event.queryStringParameters?.purge === 'true';

    if (!WORKSPACE_REGISTRY_TABLE) {
      logger.error('LINEAR_WORKSPACE_REGISTRY_TABLE_NAME is not set — cannot service a workspace removal', {
        request_id: requestId,
        workspace_slug: slug,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
    }
    const registryTable = WORKSPACE_REGISTRY_TABLE;

    const matches: Record<string, unknown>[] = [];
    let scanKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: registryTable,
        FilterExpression: `workspace_slug = :slug AND (${REMOVABLE_ROW})`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':slug': slug, ':active': 'active', ':revoked': 'revoked', ':reason': ADMIN_REMOVED_REVOCATION_REASON },
        ExclusiveStartKey: scanKey,
        ConsistentRead: true,
      }));
      matches.push(...(page.Items ?? []));
      scanKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      pages += 1;
      if (scanKey && pages >= MAX_SCAN_PAGES) {
        logger.error('Linear registry scan hit the page cap before the end of the registry', {
          request_id: requestId,
          workspace_slug: slug,
          pages,
          max_pages: MAX_SCAN_PAGES,
        });
        return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
      }
    } while (scanKey);
    const active = matches.filter((item) => item.status === 'active');
    const candidates = active.length > 0 ? active : matches.slice(0, 1);
    if (candidates.length === 0) {
      return errorResponse(404, ErrorCode.WORKSPACE_NOT_FOUND, `Workspace '${slug}' is not an active registration.`, requestId);
    }

    if (!candidates.some((item) => item.installed_by_platform_user_id === userId)) {
      logger.warn('Linear remove-workspace rejected: caller is not the workspace admin', {
        request_id: requestId,
        workspace_slug: slug,
      });
      return errorResponse(403, ErrorCode.FORBIDDEN, 'Only the workspace admin who installed this workspace may remove it.', requestId);
    }

    if (candidates.length > 1) {
      const workspaceIds = candidates.map((item) => item.linear_workspace_id as string);
      logger.warn('Linear remove-workspace refused: several active registry rows carry the slug', {
        request_id: requestId,
        workspace_slug: slug,
        linear_workspace_ids: workspaceIds,
      });
      return errorResponse(
        409,
        ErrorCode.WORKSPACE_SLUG_AMBIGUOUS,
        `Workspace slug '${slug}' names ${workspaceIds.length} active registrations `
        + `(linear_workspace_id ${workspaceIds.join(', ')}), so nothing was removed. `
        + 'In the registry table, revoke by its id each one that should be removed; '
        + 'a removal by slug works again when a single active one is left. '
        + 'The Linear setup guide gives the steps for this error code.',
        requestId,
      );
    }
    const [row] = candidates;

    const linearWorkspaceId = row.linear_workspace_id as string;
    const installedAt = row.installed_at as string | undefined;
    const oauthSecretArn = row.oauth_secret_arn as string | undefined;
    const providerName = row.provider_name as string | undefined;
    const now = new Date().toISOString();

    phase = 'registry_write';

    try {
      await ddb.send(new UpdateCommand({
        TableName: registryTable,
        Key: { linear_workspace_id: linearWorkspaceId },
        UpdateExpression: 'SET #status = :revoked, revoked_reason = :reason, revoked_at = :now, revoked_by_platform_user_id = :uid, updated_at = :now',
        ConditionExpression: `(${REMOVABLE_ROW}) AND ${installedAt === undefined ? 'attribute_not_exists(installed_at)' : 'installed_at = :installed'}`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked',
          ':reason': ADMIN_REMOVED_REVOCATION_REASON,
          ':active': 'active',
          ':now': now,
          ':uid': userId,
          ...(installedAt !== undefined && { ':installed': installedAt }),
        },
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      logger.warn('Linear remove-workspace lost a race: the registry row was removed or set up again between the read and the write', {
        request_id: requestId,
        workspace_slug: slug,
        linear_workspace_id: linearWorkspaceId,
        oauth_secret_arn: oauthSecretArn,
      });
      return errorResponse(
        404,
        ErrorCode.WORKSPACE_NOT_FOUND,
        `Workspace '${slug}' was removed or set up again while this request was running, so it removed nothing.`,
        requestId,
      );
    }

    phase = 'secret_delete';
    const secretId = oauthSecretArn ?? `${OAUTH_SECRET_NAME_PREFIX}${slug}`;
    let secret: RemoveWorkspaceResponseBody['secret'];
    try {
      await sm.send(new DeleteSecretCommand({
        SecretId: secretId,
        // A secret scheduled for deletion blocks creating one with the same name.
        ForceDeleteWithoutRecovery: true,
      }));
      secret = 'deleted';
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'ResourceNotFoundException') {
        await markSecretDeletionFailed(registryTable, linearWorkspaceId, secretId, name)
          .catch((markErr) => logger.error('Failed to persist secret-deletion-failed marker', {
            request_id: requestId,
            linear_workspace_id: linearWorkspaceId,
            error: markErr instanceof Error ? markErr.message : String(markErr),
          }));
        logger.error('Linear OAuth secret delete failed — workspace revoked but secret must be manually purged', {
          request_id: requestId,
          workspace_slug: slug,
          linear_workspace_id: linearWorkspaceId,
          oauth_secret_id: secretId,
          error_name: name,
        });
        return errorResponse(
          500,
          ErrorCode.SECRET_DELETE_FAILED,
          `Workspace '${slug}' was revoked but its OAuth secret could not be deleted. `
          + 'The workspace is disabled (fail-closed), but an operator must manually delete '
          + `the Secrets Manager secret. Request ID ${requestId}.`,
          requestId,
        );
      }
      secret = providerName && !oauthSecretArn ? 'not_applicable' : 'absent';
      logger.info('Linear OAuth secret not present at removal time', {
        request_id: requestId,
        workspace_slug: slug,
        oauth_secret_id: secretId,
        secret,
      });
    }

    if (purge) {
      phase = 'registry_write';
      await ddb.send(new DeleteCommand({
        TableName: registryTable,
        Key: { linear_workspace_id: linearWorkspaceId },
      }));
    }

    logger.info('Linear workspace removed', {
      request_id: requestId,
      workspace_slug: slug,
      linear_workspace_id: linearWorkspaceId,
      mode: purge ? 'purged' : 'revoked',
      secret,
      ...(providerName && { vault_provider_name: providerName }),
    });

    return successResponse(200, {
      workspace_slug: slug,
      linear_workspace_id: linearWorkspaceId,
      status: purge ? 'purged' : 'revoked',
      secret,
      ...(providerName && { provider_name: providerName }),
    } satisfies RemoveWorkspaceResponseBody, requestId);
  } catch (err) {
    logger.error('Linear remove-workspace handler failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
      workspace_slug: slug,
      phase,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

async function markSecretDeletionFailed(
  registryTable: string,
  linearWorkspaceId: string,
  oauthSecretId: string,
  errorName: string | undefined,
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: registryTable,
    Key: { linear_workspace_id: linearWorkspaceId },
    UpdateExpression:
      'SET secret_deletion_failed = :t, secret_deletion_error = :e, orphaned_oauth_secret_arn = :arn',
    ExpressionAttributeValues: {
      ':t': true,
      ':e': errorName ?? 'unknown',
      ':arn': oauthSecretId,
    },
  }));
}
