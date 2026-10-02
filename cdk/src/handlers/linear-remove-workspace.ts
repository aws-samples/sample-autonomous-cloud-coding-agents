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

// Built through the attributed factory, not `new XxxClient({})` — a naked
// constructor silently drops the solution user agent (#319).
const ddb = makeDocClient();
const sm = makeClient(SecretsManagerClient);

// Left `string | undefined` — matching every other reader of this same var
// (`linear-webhook.ts:41`, `linear-webhook-processor.ts:88`,
// `orchestration-reconciler.ts:96`, `github-webhook-processor.ts:61`) — and
// guarded once inside the handler. A `!` would assert away a deploy misconfig
// and surface it as an opaque `TableName: undefined` SDK error instead.
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

/** Same slug shape the CLI enforces (`SLUG_RE` in cli/src/commands/linear.ts). */
const SLUG_RE = /^[a-zA-Z0-9_-]{4,50}$/;

/**
 * `revoked_reason` written for a deliberate operator removal.
 *
 * Declared here because this handler is the only writer, but typed by
 * `LinearRevocationReason` so the resolver stays the single authority on the
 * vocabulary — a rename there breaks this build. The import is `import type`
 * on purpose: a value import would drag the entire OAuth resolver (SNS
 * alerting, its DDB/Secrets Manager clients, the token-refresh path) into this
 * Lambda's bundle, and would land this handler in the `agent.test.ts`
 * minting-handler census, which exists to make exactly that import a test
 * failure.
 *
 * Deliberately NOT `vault_consent_required`: that is the one revoked reason the
 * resolver re-probes instead of refusing, so using it here would let a later
 * successful vault probe un-latch a workspace an operator removed on purpose.
 */
const ADMIN_REMOVED_REVOCATION_REASON: LinearRevocationReason = 'admin_removed';

/**
 * Prefix of the per-workspace OAuth secret name, so a row that never recorded
 * its `oauth_secret_arn` can still be torn down: the name is deterministic.
 *
 * Duplicated as a literal rather than imported, and that is deliberate — the
 * three other definitions live in places a bundled Lambda handler must not
 * import from: `cli/src/linear-oauth.ts` (`LINEAR_OAUTH_SECRET_PREFIX`, a
 * different package), `cdk/src/constructs/linear-identity-vault.ts:51`
 * (`LINEAR_CREDENTIAL_PROVIDER_PREFIX`, would drag `aws-cdk-lib` into the
 * function bundle), and the IAM resource pattern
 * `bgagent-linear-oauth-*` at `linear-integration.ts:519`, which is what
 * makes the by-name delete permitted. Changing the convention means changing
 * all four.
 */
const OAUTH_SECRET_NAME_PREFIX = 'bgagent-linear-oauth-';

/**
 * Upper bound on registry scan pages. The registry holds one row per onboarded
 * workspace (tens at most), so ~20 pages is orders of magnitude of headroom;
 * past it something is structurally wrong (the table outgrew the scan design)
 * and a clean 500 naming the cap beats burning the 10s Lambda timeout.
 */
const MAX_SCAN_PAGES = 20;

/**
 * The response body. Declared here and applied with `satisfies` at the return
 * so the shape is pinned to a type rather than to whatever the object literal
 * happens to say — `LinearRemoveWorkspaceResponse` in `cli/src/types.ts` is on
 * `check-types-sync.ts`'s `CLI_ONLY_ALLOWLIST` (like `LinearLinkResponse` and
 * its siblings), so nothing else cross-checks the two. Keep them in step.
 */
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
 * Cognito-authenticated. Only the workspace admin (the platform user who
 * ran `bgagent linear setup`/`add-workspace` for the slug, recorded as
 * `installed_by_platform_user_id`) may remove it.
 *
 * By default this is a *soft* removal that preserves the audit trail:
 *   1. Flip the registry row to `status='revoked'` with
 *      `revoked_reason='admin_removed'`. The OAuth resolver refuses any
 *      non-active row (`shared/linear-oauth-resolver.ts`) with one documented
 *      exception — a `revoked` row whose reason is `vault_consent_required` is
 *      re-probed rather than refused (`:392-394`). `admin_removed` is
 *      deliberately not that reason, so an admin removal is terminal: the
 *      workspace stops resolving tokens and routing webhooks the instant this
 *      write lands, and no later vault probe can un-latch it.
 *   2. Delete the per-workspace `bgagent-linear-oauth-<slug>` secret so no
 *      credential lingers.
 *
 * Query flag:
 *   - `purge=true` — delete the registry row outright (no audit row).
 *
 * Idempotent on the secret, and the response says *which* of three things
 * happened rather than collapsing them into one boolean:
 *   - `secret: 'deleted'`        — a live secret was destroyed here.
 *   - `secret: 'absent'`         — nothing to delete (a prior partial run, or
 *                                  a row that never recorded an ARN and has no
 *                                  secret under the deterministic name).
 *   - `secret: 'not_applicable'` — this workspace is vault-managed and never
 *                                  had a Secrets Manager secret of its own.
 *
 * **Vault-managed workspaces are NOT fully torn down by this endpoint.** A row
 * with `provider_name` was onboarded through AgentCore Identity, and its
 * **credential provider lives outside CloudFormation**, holding the Linear
 * client secret and a live, self-refreshing grant. This handler does not touch
 * it — a cross-service teardown with its own failure modes, tracked separately.
 * It *reports* it: `provider_name` is echoed in the response so the CLI can
 * print the exact `delete-oauth2-credential-provider` follow-up. Without that,
 * the vault path renders byte-identically to a clean teardown while a
 * self-refreshing credential survives.
 *
 * Project mappings are NOT touched here: `LinearProjectMappingTable` rows
 * carry no workspace identifier (the `onboard-project` writer records only
 * `linear_project_id`), so they cannot be attributed to a workspace. Removing
 * a mapping is a by-project-id operation (see LINEAR_SETUP_GUIDE). A follow-up
 * will record `linear_workspace_id` at onboard time to enable workspace-scoped
 * cleanup.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  // Outer-scope breadcrumbs so the top-level catch can name the workspace
  // and the phase that failed — the difference between "which secret
  // leaked?" being answerable from one log line vs. a manual hunt.
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
      // Deploy misconfiguration, not a caller error. Log it as itself instead
      // of letting the SDK reject `TableName: undefined` from inside the scan.
      logger.error('LINEAR_WORKSPACE_REGISTRY_TABLE_NAME is not set — cannot service a workspace removal', {
        request_id: requestId,
        workspace_slug: slug,
      });
      return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
    }
    const registryTable = WORKSPACE_REGISTRY_TABLE;

    // ─── Locate the registry row by slug ─────────────────────────────
    // The registry table is keyed on `linear_workspace_id`, so a slug
    // lookup is a filtered scan. Only `status='active'` rows are valid
    // removal targets — an already-revoked (or unknown) slug returns 404,
    // so the endpoint does not distinguish revoked from missing and the
    // destructive path is not re-run on a row that's already torn down.
    // The scan is `ConsistentRead` and the revoke below carries a
    // `ConditionExpression`, because a filtered scan alone is a TOCTOU:
    // read-your-writes matters when a removal lands seconds after
    // `add-workspace`, and the condition is what actually settles two
    // concurrent DELETEs.
    //
    // No `Limit`: DynamoDB applies a FilterExpression *after* evaluating
    // items, so `Limit: N` bounds items examined, not items matched — a
    // filtered `Limit: 1` scan can return `[]` + a LastEvaluatedKey while
    // the target sits one page deeper (the normal shared-stack state once
    // the registry holds more than one row). We follow the continuation key
    // until a match or key exhaustion (not to completion — the loop stops on
    // the first match), matching the paginated small-table scan of this same
    // registry shape in `shared/jira-tenant-registry.ts:32-46`, which is
    // also where the `ConsistentRead` precedent comes from. The registry
    // holds one row per onboarded workspace and stays small (tens of rows at
    // most); if it ever grows large, add a GSI on `workspace_slug` and Query
    // it. (`shared/linear-issue-lookup.ts:131-136` scans this table
    // *without* pagination — a counter-example, not the precedent, and worth
    // its own fix.)
    let row: Record<string, unknown> | undefined;
    let scanKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: registryTable,
        FilterExpression: 'workspace_slug = :slug AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':slug': slug, ':active': 'active' },
        ExclusiveStartKey: scanKey,
        ConsistentRead: true,
      }));
      row = page.Items?.[0];
      scanKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      pages += 1;
      if (!row && scanKey && pages >= MAX_SCAN_PAGES) {
        // Bounded rather than open-ended: without this the only stop is the
        // 10s timeout, which surfaces as a generic 500 with no cause. Not a
        // 404 — the row may well exist further in, and claiming it doesn't
        // would be the same lie this endpoint is being fixed to stop telling.
        logger.error('Linear registry scan hit the page cap without finding the workspace', {
          request_id: requestId,
          workspace_slug: slug,
          pages,
          max_pages: MAX_SCAN_PAGES,
        });
        return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
      }
    } while (!row && scanKey);
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
    // Present only on rows onboarded through the AgentCore Identity vault. Read
    // (and reported) but never deleted here — see the header note.
    const providerName = row.provider_name as string | undefined;
    const now = new Date().toISOString();

    // Track which teardown phase we're in so a mid-stream failure logs
    // *where* it broke — critical because the registry row is revoked
    // first (fail-closed), so a later failure can leave a live OAuth
    // secret orphaned. On-call needs the phase + workspace id from the
    // error log to find and hand-purge it.
    phase = 'registry_write';

    // ─── Registry: revoke first (fail-closed), always ────────────────
    // Even on `--purge` we flip the row to `status='revoked'` BEFORE
    // deleting the secret, rather than deleting the row outright. This is
    // deliberate: the OAuth resolver refuses a non-active row — and
    // `revoked_reason='admin_removed'` is specifically not the one reason it
    // re-probes instead of refusing (`linear-oauth-resolver.ts:392-394`) — so
    // the workspace stops resolving tokens and routing webhooks the instant
    // this write lands, terminally. It also keeps the row present through the
    // secret-delete step, so a failure there can persist a durable
    // orphaned-secret marker on the row (see `markSecretDeletionFailed`).
    // The hard `--purge` delete of the row happens only AFTER the secret
    // is confirmed gone.
    //
    // The `ConditionExpression` is what closes the scan's TOCTOU: it makes
    // "the row was active when we decided to remove it" a property of the
    // write, not of a read that happened earlier. Two concurrent DELETEs now
    // resolve to one revoke and one 404 instead of both proceeding.
    try {
      await ddb.send(new UpdateCommand({
        TableName: registryTable,
        Key: { linear_workspace_id: linearWorkspaceId },
        UpdateExpression: 'SET #status = :revoked, revoked_reason = :reason, revoked_at = :now, revoked_by_platform_user_id = :uid, updated_at = :now',
        ConditionExpression: '#status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked',
          ':reason': ADMIN_REMOVED_REVOCATION_REASON,
          ':active': 'active',
          ':now': now,
          ':uid': userId,
        },
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      // Someone else moved the row out of `active` between our scan and this
      // write — a concurrent DELETE, or the resolver latching the row revoked
      // after Linear rejected its refresh token. Either way this request
      // changed nothing, so 404 (the same answer a caller gets for an
      // already-revoked slug) is the truthful one. Log the secret ARN at WARN:
      // if the winner was the resolver rather than a peer DELETE, nobody
      // deleted the secret, and this line is what makes that orphan findable.
      logger.warn('Linear remove-workspace lost a race: the registry row was no longer active at write time', {
        request_id: requestId,
        workspace_slug: slug,
        linear_workspace_id: linearWorkspaceId,
        oauth_secret_arn: oauthSecretArn,
      });
      return errorResponse(404, ErrorCode.WORKSPACE_NOT_FOUND, `Workspace '${slug}' is not an active registration.`, requestId);
    }

    // ─── Secrets Manager: delete the per-workspace OAuth secret ───────
    // Idempotent: a ResourceNotFoundException means the secret was already
    // removed by a prior (partial) run — that's success, not an error.
    //
    // The delete is attempted even when the row recorded no `oauth_secret_arn`,
    // because the secret name is deterministic (`bgagent-linear-oauth-<slug>`)
    // and the function's IAM grant is a prefix grant over exactly that shape.
    // A `setup` that created the secret and then died before finishing the row
    // leaves precisely this state, and the old code skipped it — reporting
    // "already absent" about a secret it never looked for.
    phase = 'secret_delete';
    const secretId = oauthSecretArn ?? `${OAUTH_SECRET_NAME_PREFIX}${slug}`;
    let secret: RemoveWorkspaceResponseBody['secret'];
    try {
      await sm.send(new DeleteSecretCommand({
        SecretId: secretId,
        // No recovery window — the workspace is being torn down and the
        // registry row is the audit record. Leaving a scheduled-deletion
        // secret around would block a same-slug re-onboarding.
        ForceDeleteWithoutRecovery: true,
      }));
      secret = 'deleted';
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'ResourceNotFoundException') {
        // A real SM failure (e.g. AccessDenied, throttle). The registry
        // row is already revoked (fail-closed holds) AND still present
        // (the `--purge` delete has not run yet), so we persist a durable
        // marker on the row (best-effort) so the leaked secret is
        // discoverable and the operator can hand-purge it, then surface a
        // distinct, actionable error instead of an opaque 500. We do NOT
        // proceed to the `--purge` row delete — deleting the row here
        // would strip the only durable record of the orphaned secret. Do
        // NOT swallow.
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
      // Nothing under that name. Two different facts share this branch, and
      // the response distinguishes them:
      //   - the row recorded an ARN, or the workspace isn't vault-managed →
      //     there was supposed to be a secret here and it's gone: `absent`.
      //   - vault-managed AND no ARN was ever recorded → the credential lives
      //     in the AgentCore provider, not in Secrets Manager, so there was
      //     never a per-workspace secret to delete: `not_applicable`.
      // Collapsing these was the bug: `not_applicable` is the one case where
      // "nothing was deleted" does NOT mean teardown is complete.
      secret = providerName && !oauthSecretArn ? 'not_applicable' : 'absent';
      logger.info('Linear OAuth secret not present at removal time', {
        request_id: requestId,
        workspace_slug: slug,
        oauth_secret_id: secretId,
        secret,
      });
    }

    // ─── Registry: purge (hard delete) ───────────────────────────────
    // Only on `--purge`, and only now that the secret is confirmed gone —
    // so we never delete the audit/marker row while a live secret could
    // still be orphaned.
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
      // Present ⇒ an AgentCore credential provider survives this removal and
      // an operator still has to delete it. Logged so the follow-up is
      // reconstructable from CloudWatch alone, not only from the CLI output
      // the operator may have scrolled past.
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
    // Include the workspace slug + failing phase so on-call can locate an
    // orphaned secret / half-cleaned mapping table from the error log.
    logger.error('Linear remove-workspace handler failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
      workspace_slug: slug,
      phase,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}

/**
 * Best-effort durable marker written to the registry row when the OAuth
 * secret delete fails after the row was already revoked. The registry row is
 * always still present at this point — the revoke is an `UpdateCommand` and
 * the `--purge` row delete runs only after the secret is confirmed gone — so
 * the marker survives on every flag combination and makes the orphaned-secret
 * condition discoverable. Never throws to the caller — the caller already
 * logs + returns an actionable error.
 *
 * `oauthSecretId` is whatever was handed to `DeleteSecret` — the recorded ARN
 * when the row had one, otherwise the deterministic name. Recording the name in
 * that second case is the point: it is the identifier an operator can act on.
 */
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
