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

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { announceRevocation, revocationAlertTopicArn } from './linear-revocation-alert';
import {
  LINEAR_VAULT_SCOPES,
  type VaultTokenResult,
  isVaultEnabled,
  resolveLinearTokenViaVault,
  type VaultTokenInput,
  vaultWorkloadIdentityName,
} from './linear-vault-token';
import { logger } from './logger';
import { makeClient, makeDocClient } from './ua';

/**
 * Lambda-side resolver for the per-workspace Linear OAuth token written
 * by `bgagent linear setup` (Phase 2.0b Option 2). Mirrors the CLI's
 * `cli/src/linear-oauth.ts` helpers but uses AWS SDK clients suitable
 * for Lambda execution.
 *
 * Flow:
 *   1. Look up workspace registry table by `linearWorkspaceId` →
 *      `oauth_secret_arn`.
 *   2. Fetch the secret JSON via Secrets Manager.
 *   3. If `expires_at` is within 60s, refresh against Linear's
 *      `/oauth/token` (with stored `refresh_token`) and write the new
 *      JSON back to Secrets Manager.
 *   4. Return the access token.
 *
 * Both reads (registry row, secret value) are cached in-memory with a
 * short TTL so a hot Lambda doesn't hammer DDB / SM on every invocation.
 */

const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';

/** Cache TTL for the registry row + secret value lookups, in milliseconds. */
const REGISTRY_CACHE_TTL_MS = 60_000;
const SECRET_CACHE_TTL_MS = 60_000;

/** Refresh threshold: refresh tokens with <60s remaining. */
const REFRESH_THRESHOLD_SECONDS = 60;

/** Registry row status values. Anything else (missing, unknown
 *  string) is treated as `revoked` so a corrupt or partially-written
 *  row blocks resolution rather than silently granting access. */
type RegistryRowStatus = 'active' | 'revoked';

export interface RegistryRow {
  readonly linear_workspace_id: string;
  readonly workspace_slug: string;
  readonly oauth_secret_arn: string;
  readonly status: RegistryRowStatus;
  /**
   * When the CURRENT authorization was installed. Rewritten by every
   * (re-)authorization, which is what makes it usable as an installation
   * identity: a diagnosis about one grant must not be applied to its successor.
   * Optional — rows written before it was recorded have none.
   */
  readonly installed_at?: string;
  /**
   * Full AgentCore Identity credential-provider name for this workspace, written
   * by `bgagent linear setup` when onboarding through the token vault (RFC #249
   * Phase 1). Absent for workspaces onboarded via the Secrets-Manager-only flow;
   * the resolver only attempts the vault path when this is present AND
   * `LINEAR_VAULT_ENABLED` is set, and always falls back to the SM token
   * (`oauth_secret_arn`) if vault issuance is unavailable.
   */
  readonly provider_name?: string;
  /**
   * The user id the vault grant was bound to at consent time.
   *
   * Recorded rather than derived from `linear_workspace_id`, because the
   * organization UUID is only knowable once a token exists — deriving it forces a
   * second consent just to learn the org. Absent on workspaces onboarded before
   * this was stored; those fall back to the derived form.
   */
  readonly vault_user_id?: string;
}

export interface StoredOauthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
  /** Co-located OAuth client credentials so Lambda-side refresh works
   *  without per-Lambda env vars (Phase 2.0b-O2). */
  readonly client_id: string;
  readonly client_secret: string;
  readonly workspace_id: string;
  readonly workspace_slug: string;
  readonly installed_at: string;
  readonly updated_at: string;
  readonly installed_by_platform_user_id: string;
  /** Per-workspace Linear webhook signing secret (`lin_wh_…`).
   *
   *  Linear generates a fresh signing secret per webhook subscription, and
   *  webhook subscriptions are workspace-scoped — so a single stack-wide
   *  signing secret can't verify events from multiple workspaces. The
   *  webhook receiver looks this up by orgId at verify time.
   *
   *  Optional for back-compat: tokens written before the per-workspace
   *  signing flow won't have it, and the receiver falls back to the
   *  stack-wide `LINEAR_WEBHOOK_SECRET_ARN` for those installs. */
  readonly webhook_signing_secret?: string;
}

/**
 * What the platform knows at the moment it discovers an authorization is dead.
 *
 * `source` matters because the two paths fail differently: Secrets Manager
 * surfaces a revoked grant as an `invalid_grant` REJECTION, while the AgentCore
 * vault surfaces it as "consent required" (an authorization URL instead of a
 * token). A detector that only understood the first would go quiet exactly when a
 * workspace moved onto the vault.
 */
export interface RevocationDetail {
  readonly linearWorkspaceId: string;
  /** Human-facing name for the alert; the slug is what goes in the fix command. */
  readonly workspaceSlug?: string;
  /**
   * `installed_at` of the grant being diagnosed. Passed through to the registry
   * latch so a verdict about one installation can never revoke its successor.
   */
  readonly installedAt?: string;
  readonly source: 'secrets-manager-refresh' | 'vault-consent-required';
}

export interface ResolverOptions {
  /** AWS region for SDK clients. Falls back to AWS_REGION env. */
  readonly region?: string;
  /** Override clients for testing. */
  readonly secretsManagerClient?: SecretsManagerClient;
  readonly dynamoDbClient?: DynamoDBDocumentClient;
  /** Override fetch for token-endpoint refresh in tests. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Called once the authorization is known dead. Injected rather than written
   * inline so this module keeps doing one job — resolving a token — and callers
   * with registry write access opt in. Must not throw; the caller wraps it.
   *
   * Receives the full {@link RevocationDetail} rather than just an id, because a
   * notification that cannot name the workspace or the recovery command is not
   * actionable, and `source` is what lets an operator tell "Linear rejected our
   * refresh token" apart from "the vault wants a fresh consent".
   */
  readonly onAuthorizationRevoked?: (detail: RevocationDetail) => Promise<void>;
  /**
   * Override the vault token resolver in tests. Production leaves this unset and
   * uses {@link resolveLinearTokenViaVault}. Returns the access token string, or
   * null to fall back to the Secrets-Manager token.
   */
  /**
   * Test seam for the vault call. Takes the FULL request, not a few unpacked
   * fields: the earlier three-argument shape could not observe `vaultUserId`, so no
   * test at this seam could catch the subject being dropped upstream — and one was,
   * silently, by the row parser. A mock narrower than the real call hides exactly
   * the mistakes it exists to catch.
   */
  readonly resolveViaVault?: (
    input: VaultTokenInput,
    workloadIdentityName: string,
  ) => Promise<VaultTokenResult>;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

const registryCache = new Map<string, CacheEntry<RegistryRow>>();
const tokenCache = new Map<string, CacheEntry<StoredOauthToken>>();

/**
 * Drop cached values for a workspace. Used after a refresh so the next
 * caller picks up the rotated token.
 */
export function invalidateLinearOauthCache(linearWorkspaceId: string, oauthSecretArn?: string): void {
  registryCache.delete(linearWorkspaceId);
  if (oauthSecretArn) tokenCache.delete(oauthSecretArn);
}

/** Returns true if `expires_at` is within the refresh threshold. */
export function isTokenExpiring(expiresAt: string, thresholdSec: number = REFRESH_THRESHOLD_SECONDS): boolean {
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return true;
  return Date.now() + thresholdSec * 1000 >= ts;
}

/**
 * Resolve a usable Linear OAuth access token for the given workspace.
 *
 * On success: returns `{ accessToken, scope, workspaceSlug }`. Refreshes
 * silently if the cached token is expiring. Returns null on any failure
 * (registry miss, secret missing, refresh-token revoked) so callers can
 * gracefully no-op rather than blowing up.
 *
 * Throws ONLY for environment misconfigurations (e.g. workspace registry
 * env var unset, Linear OAuth client credentials env vars unset) — those
 * are deploy bugs, not runtime conditions.
 */
export interface ResolvedLinearToken {
  readonly accessToken: string;
  readonly scope: string;
  readonly workspaceSlug: string;
  readonly oauthSecretArn: string;
  /**
   * AgentCore credential-provider name for this workspace, when it was onboarded
   * through the vault (RFC #249 Phase 1). Undefined for Secrets-Manager-only
   * installs. Stamped into the agent's channel_metadata so the agent-side
   * resolver can mint its own token via the vault (config.py); absent ⇒ the
   * agent stays on the SM path.
   */
  readonly providerName?: string;
  /**
   * The user id the vault grant is bound to, as recorded at consent time. Passed
   * to the agent so it mints under the same subject; see RegistryRow.vault_user_id.
   */
  readonly vaultUserId?: string;
}

/**
 * The recorder used when a caller does not supply one.
 *
 * WHY THIS IS A DEFAULT AND NOT THREADED THROUGH CALLERS. Seven modules resolve
 * Linear tokens inside the webhook processor (feedback, issue lookup, orchestration
 * channel, the processor itself…). Passing the recorder from each one was tried and
 * missed four of them — the live test tripped over `linear-feedback`, which is where
 * a revocation is often discovered because posting a reply is the first thing that
 * needs a token. Any future caller would have to remember too, and forgetting is
 * silent. Defaulting here covers every path, present and future.
 *
 * Gated on `LINEAR_REVOCATION_RECORDING` so it stays OFF for roles that hold only
 * READ on the registry: there the conditional write would fail AccessDenied and be
 * swallowed, which is the inert-but-looks-implemented state this whole issue exists
 * to remove. Only the role granted the write has the variable set.
 */
function defaultRevocationRecorder(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
): ((detail: RevocationDetail) => Promise<void>) | undefined {
  if (process.env.LINEAR_REVOCATION_RECORDING !== 'true') return undefined;
  return async (detail: RevocationDetail): Promise<void> => {
    const latched = await markWorkspaceRevoked(
      ddb,
      registryTableName,
      detail.linearWorkspaceId,
      detail.installedAt,
      undefined,
      detail.source === 'vault-consent-required' ? 'vault_consent_required' : 'refresh_token_rejected',
    );
    if (!latched) {
      // Already revoked, or the row has moved on to a NEWER installation than the
      // one this verdict describes. Nothing new to announce.
      logger.info('Revocation already recorded — not announcing again', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
      });
      return;
    }
    const topicArn = revocationAlertTopicArn();
    if (!topicArn) {
      logger.warn('Linear authorization revoked, but no alert topic is configured — recorded only', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
      });
      return;
    }
    await announceRevocation(detail, { topicArn });
  };
}

export async function resolveLinearOauthToken(
  linearWorkspaceId: string,
  registryTableName: string,
  options: ResolverOptions = {},
): Promise<ResolvedLinearToken | null> {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const ddb = options.dynamoDbClient ?? makeDocClient({ region });
  const sm = options.secretsManagerClient ?? makeClient(SecretsManagerClient, { region });
  // Caller-supplied recorder wins (tests inject one); otherwise the env-gated
  // default covers every code path in this Lambda.
  const recordRevocation = options.onAuthorizationRevoked
    ?? defaultRevocationRecorder(ddb, registryTableName);

  // ─── Step 1: Registry row ────────────────────────────────────────
  const row = await getRegistryRow(ddb, registryTableName, linearWorkspaceId);
  if (!row) {
    logger.warn('Linear workspace not in registry', { linear_workspace_id: linearWorkspaceId });
    return null;
  }
  if (row.status !== 'active') {
    logger.warn('Linear workspace registry status is not active', {
      linear_workspace_id: linearWorkspaceId,
      status: row.status,
    });
    return null;
  }

  // Set when the vault says the grant needs a fresh consent. Consumed only if no
  // path yields a token, so a vault-dead / SM-alive workspace keeps working.
  let vaultConsentRequired = false;

  // ─── Step 1b: AgentCore Identity vault (RFC #249 Phase 1) ────────
  // When the vault is enabled AND this workspace was onboarded through it
  // (provider_name recorded), mint the token via the Token Vault. Any failure
  // (not consented, permission, throttle, provider missing) returns null and
  // falls through to the Secrets-Manager path below — the vault NEVER blocks
  // token resolution. Absent provider_name / disabled flag skips it entirely,
  // so SM-only installs are unaffected.
  const workloadName = vaultWorkloadIdentityName();
  if (row.provider_name && workloadName && (isVaultEnabled() || options.resolveViaVault)) {
    const viaVault = options.resolveViaVault ?? resolveLinearTokenViaVault;
    const vaultResult = await viaVault(
      {
        linearWorkspaceId,
        providerName: row.provider_name,
        vaultUserId: row.vault_user_id,
        region,
      },
      workloadName,
    );
    // A vault grant that needs consent is DEAD, not slow — remember it so the
    // no-token-anywhere path below can report it. Deliberately NOT latched here:
    // a workspace may still hold a working Secrets-Manager token, and marking the
    // row `revoked` while resolution still succeeds would take a functioning
    // workspace offline (the resolver refuses a non-active row).
    vaultConsentRequired = vaultResult.kind === 'consent-required';
    if (vaultResult.kind === 'token') {
      return {
        accessToken: vaultResult.accessToken,
        scope: LINEAR_VAULT_SCOPES.join(' '),
        workspaceSlug: row.workspace_slug,
        // No SM secret is read/written on the vault path, but the ARN is still
        // returned so downstream SM-fallback wiring stays populated.
        oauthSecretArn: row.oauth_secret_arn,
        providerName: row.provider_name,
        // The agent mints its own token and must use the SAME subject. Omitting it
        // here — while the Secrets-Manager return below carried it — meant the
        // SUCCESSFUL vault path was the one that failed to pass it on, so the agent
        // derived the legacy subject, found no grant, and dropped back to a dead
        // Secrets-Manager token: reactions 401'd while the Lambda's own calls worked.
        ...(row.vault_user_id && { vaultUserId: row.vault_user_id }),
      };
    }
    // Anything other than a token ⇒ fall through to Secrets-Manager resolution.
  }

  // ─── Step 2: Cached or fresh token JSON ──────────────────────────
  const cached = tokenCache.get(row.oauth_secret_arn);
  let token: StoredOauthToken;
  if (cached && cached.expiresAt > Date.now() && !isTokenExpiring(cached.value.expires_at)) {
    token = cached.value;
  } else {
    const fetched = await getOauthSecret(sm, row.oauth_secret_arn);
    if (!fetched) {
      logger.error('Linear OAuth secret missing or unreadable', {
        oauth_secret_arn: row.oauth_secret_arn,
        linear_workspace_id: linearWorkspaceId,
      });
      // Vault-onboarded workspace whose grant needs consent AND whose Secrets
      // Manager fallback is gone: nothing can produce a token, so this IS the
      // revocation. Report it here rather than letting the vault path fail
      // silently — the whole point of #812 is that the vault's "consent required"
      // is as terminal as Secrets Manager's `invalid_grant`, just quieter.
      if (vaultConsentRequired && recordRevocation) {
        try {
          await recordRevocation({
            linearWorkspaceId,
            workspaceSlug: row.workspace_slug,
            installedAt: row.installed_at,
            source: 'vault-consent-required',
          });
        } catch (err) {
          logger.warn('Could not mark the Linear workspace as revoked (non-fatal)', {
            linear_workspace_id: linearWorkspaceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return null;
    }
    token = fetched;
  }

  // ─── Step 3: Refresh if expiring ─────────────────────────────────
  if (isTokenExpiring(token.expires_at)) {
    // The revoked-marker is OPT-IN, not defaulted.
    //
    // Every Lambda that resolves a token holds READ-ONLY access to the registry
    // table, and no stack grants it write. Defaulting the marker on therefore
    // meant the write ran and failed AccessDenied on every revoked refresh, and
    // the failure was swallowed — so the feature read as working while being
    // permanently inert, which is worse than being visibly absent.
    //
    // A caller that genuinely holds registry write (or supplies its own recorder)
    // passes ``onAuthorizationRevoked`` explicitly. When the grant lands, flip the
    // default here in the same change — not before.
    // Pass the RESOLVED recorder (caller-supplied or env-gated default) so the
    // permanent-rejection branch inside the refresh can record + announce.
    const refreshed = await refreshLinearToken(token, sm, row.oauth_secret_arn, {
      ...options,
      ...(recordRevocation && { onAuthorizationRevoked: recordRevocation }),
    });
    if (!refreshed) {
      // Refresh failed — return null so the caller can fall back to
      // best-effort behaviour. Cache is already invalidated.
      return null;
    }
    token = refreshed;
  } else {
    // Cache only when not just-refreshed (just-refreshed value is already
    // the freshest possible).
    tokenCache.set(row.oauth_secret_arn, { value: token, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  }

  return {
    accessToken: token.access_token,
    scope: token.scope,
    workspaceSlug: token.workspace_slug,
    oauthSecretArn: row.oauth_secret_arn,
    // Carried through even on the SM path so the agent's channel_metadata gets
    // the provider name and can attempt the vault itself (RFC #249 Phase 1).
    ...(row.provider_name && { providerName: row.provider_name }),
    ...(row.vault_user_id && { vaultUserId: row.vault_user_id }),
  };
}

/**
 * Strict variant of {@link getRegistryRow}: throws on infra error
 * (DDB throttle, network) instead of returning null. Use this from the
 * webhook signature-verification path where a `null` return would let
 * a transient throttle silently downgrade per-workspace verification
 * to the stack-wide fallback secret.
 *
 * The lenient `null`-on-error variant is kept for `resolveLinearOauthToken`,
 * whose graceful no-op contract is intentional (an MCP token lookup
 * failing should let the agent run without Linear, not blow up the
 * task). Mixing the two contracts in one function silently fails open;
 * splitting them keeps each call site honest.
 */
/**
 * Mark a workspace's registry row as ``revoked``, so the dead authorization is
 * discoverable instead of living only in a log line. The resolver already
 * refuses a non-active row, so this also stops the pointless
 * refresh-then-fail work on every subsequent event.
 *
 * NOT YET EFFECTIVE IN PRODUCTION: every Lambda that resolves a token currently
 * has READ-ONLY access to the registry table, so this write fails AccessDenied
 * and is swallowed (deliberately — recording the diagnosis must never break token
 * resolution). Granting the write is deferred; until then the operator-facing
 * signal is the indeterminate state from `bgagent platform doctor`, which reports
 * that the workspace could not be confirmed rather than claiming it is fine.
 * Tracked in the backlog under the Linear auth-revocation item.
 *
 * Scoped to the installation it actually diagnosed. ``status = active`` alone is
 * not enough: a re-authorization writes ``active`` again, so a straggler holding
 * the OLD token — a queued event, a retry, another Lambda mid-flight — would find
 * the condition satisfied and revoke the working grant the operator had just
 * installed, taking the workspace down again with a stale verdict. Conditioning
 * on ``installed_at`` (rewritten by every re-authorization) makes the write apply
 * only while the row still describes the same installation. ``expectedInstalledAt``
 * is passed by the caller rather than re-read here, because a re-read would race
 * the same way.
 *
 * When the caller has no ``installed_at`` to name (a row written before it was
 * recorded), the write falls back to requiring the attribute to still be absent —
 * so a re-authorization, which adds it, likewise takes the row out of scope.
 *
 * Returns whether THIS call latched the row. That boolean is the dedup key for
 * notification (#812): a revoked workspace keeps producing events, and each one
 * re-detects the same dead grant, so alerting on detection would page once per
 * event. Only the caller that actually flipped `active → revoked` should announce
 * it; everyone else gets `false` because the conditional write did not apply.
 */
export async function markWorkspaceRevoked(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
  expectedInstalledAt?: string,
  now: string = new Date().toISOString(),
  reason: string = 'refresh_token_rejected',
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { linear_workspace_id: linearWorkspaceId },
      UpdateExpression: 'SET #s = :revoked, revoked_at = :now, revoked_reason = :reason',
      ConditionExpression: expectedInstalledAt === undefined
        ? '#s = :active AND attribute_not_exists(installed_at)'
        : '#s = :active AND installed_at = :installed',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':revoked': 'revoked',
        ':active': 'active',
        ':now': now,
        ':reason': reason,
        ...(expectedInstalledAt !== undefined && { ':installed': expectedInstalledAt }),
      },
    }));
    logger.warn('Marked Linear workspace as revoked — re-authorization required', {
      linear_workspace_id: linearWorkspaceId,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      // Already marked, or re-authorized since this diagnosis was made — either
      // way the verdict no longer describes the row, so leave it alone.
      logger.info('Skipped the revoked marker — the registry row is no longer the installation diagnosed', {
        linear_workspace_id: linearWorkspaceId,
      });
      return false;
    }
    throw err;
  }
  registryCache.delete(linearWorkspaceId);
  return true;
}

export async function getRegistryRowStrict(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
): Promise<RegistryRow | null> {
  const cached = registryCache.get(linearWorkspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // No try/catch — caller (verifyLinearRequestForWorkspace) wants the
  // error to bubble so the receiver returns 500 and Linear retries,
  // rather than silently falling back to the stack-wide secret.
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { linear_workspace_id: linearWorkspaceId },
  }));
  return parseRegistryRow(result.Item, linearWorkspaceId);
}

export async function getRegistryRow(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
): Promise<RegistryRow | null> {
  const cached = registryCache.get(linearWorkspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // Wrap the DDB call so a transient throttle during a webhook burst
  // doesn't crash the Lambda invocation (which would trigger SQS
  // retries on the upstream webhook). Returning null here lets the
  // caller fall back cleanly — the resolver layer treats this as
  // "workspace not in registry" which is the correct user-visible
  // behaviour for a transient error.
  let result;
  try {
    result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { linear_workspace_id: linearWorkspaceId },
    }));
  } catch (err) {
    logger.error('Failed to fetch Linear workspace registry row', {
      table_name: tableName,
      linear_workspace_id: linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- transient DDB throttle degrades to "workspace not in registry"; avoids webhook retry storm
  }

  return parseRegistryRow(result.Item, linearWorkspaceId);
}

/**
 * Shared parser for raw DDB items into a {@link RegistryRow}, used by
 * both {@link getRegistryRow} (lenient) and {@link getRegistryRowStrict}
 * (throws on infra). Caches on success.
 */
function parseRegistryRow(rawItem: unknown, linearWorkspaceId: string): RegistryRow | null {
  const item = rawItem as Partial<RegistryRow> | undefined;
  if (!item || !item.oauth_secret_arn || !item.workspace_slug) return null;

  // Fail-closed on the status field: missing or unknown values are
  // treated as `revoked`, NOT `active`. A partially-written row
  // (e.g. a half-finished `bgagent linear setup`) shouldn't grant
  // access just because the status column is empty. Operators must
  // explicitly write `status: active` to enable a workspace.
  const rawStatus = item.status as string | undefined;
  const status: RegistryRowStatus = rawStatus === 'active' ? 'active' : 'revoked';
  if (rawStatus !== 'active' && rawStatus !== 'revoked' && rawStatus !== undefined) {
    logger.warn('Linear workspace registry row has unknown status — treating as revoked', {
      linear_workspace_id: linearWorkspaceId,
      raw_status: rawStatus,
    });
  }

  const row: RegistryRow = {
    linear_workspace_id: linearWorkspaceId,
    workspace_slug: item.workspace_slug,
    oauth_secret_arn: item.oauth_secret_arn,
    status,
    ...(typeof item.installed_at === 'string' && { installed_at: item.installed_at }),
    // Present only for vault-onboarded workspaces (RFC #249 Phase 1); gates the
    // vault resolution path in resolveLinearOauthToken.
    ...(typeof item.provider_name === 'string' && { provider_name: item.provider_name }),
    // The subject the vault grant is bound to. This parser copies fields
    // explicitly, so anything omitted here is silently dropped no matter how
    // correctly the callers thread it — which is exactly what happened: the
    // resolver fell back to deriving the subject from the organization UUID, found
    // no grant under it, and reported "requires consent" for a healthy workspace.
    ...(typeof item.vault_user_id === 'string' && { vault_user_id: item.vault_user_id }),
  };
  registryCache.set(linearWorkspaceId, { value: row, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
  return row;
}

/**
 * Required fields on the StoredOauthToken JSON in Secrets Manager.
 * Validated as a set at deserialization so a missing field fails fast
 * here, not 24 hours later inside `tryRefreshOnce` when the refresh
 * call needs `client_id` / `client_secret` and finds them undefined.
 *
 * Keep this list in sync with the `StoredOauthToken` interface above
 * AND the CLI-side `StoredLinearOauthToken` shape (see
 * `cli/src/linear-oauth.ts`). The contract test in
 * `cdk/test/contracts/stored-oauth-token-parity.test.ts` enforces
 * the cross-language match.
 */
const STORED_OAUTH_TOKEN_REQUIRED_FIELDS: ReadonlyArray<keyof StoredOauthToken> = [
  'access_token',
  'refresh_token',
  'expires_at',
  'scope',
  'client_id',
  'client_secret',
  'workspace_id',
  'workspace_slug',
  'installed_at',
  'updated_at',
  'installed_by_platform_user_id',
];

export async function getOauthSecret(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!res.SecretString) return null;
    return parseOauthSecret(res.SecretString, secretArn);
  } catch (err) {
    logger.error('Failed to fetch Linear OAuth secret', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- lenient OAuth fetch for task hydration; strict variant getOauthSecretStrict rethrows SM errors
  }
}

/**
 * Strict variant of {@link getOauthSecret}: throws on Secrets Manager
 * error (network, IAM) instead of returning null. Use this from the
 * webhook signature-verification path where a `null` return would let
 * a transient SM error silently downgrade per-workspace verification
 * to the stack-wide fallback secret. Only returns null for a row that
 * exists but has no string value or fails JSON-shape validation.
 */
export async function getOauthSecretStrict(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  // No outer try/catch — caller (verifyLinearRequestForWorkspace) wants
  // SM errors to bubble so the receiver returns 500 and Linear retries,
  // rather than silently falling back to the stack-wide secret.
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) return null;
  return parseOauthSecret(res.SecretString, secretArn);
}

function parseOauthSecret(secretString: string, secretArn: string): StoredOauthToken | null {
  let parsed: StoredOauthToken;
  try {
    parsed = JSON.parse(secretString) as StoredOauthToken;
  } catch (err) {
    logger.error('Linear OAuth secret value is not valid JSON', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- corrupt secret JSON is logged ERROR; null triggers re-onboard path, not a masked infra failure
  }
  const missing = STORED_OAUTH_TOKEN_REQUIRED_FIELDS.filter(
    (f) => typeof parsed[f] !== 'string' || (parsed[f] as string).length === 0,
  );
  if (missing.length > 0) {
    logger.error('Linear OAuth secret JSON is missing required fields', {
      secret_arn: secretArn,
      missing_fields: missing,
    });
    return null;
  }
  return parsed;
}

/**
 * Outcome of a single Linear /oauth/token POST. Three terminal states:
 * - `success` — refreshed token (caller persists + caches)
 * - `invalid_grant` — Linear rejected the refresh_token, likely
 *    because another caller rotated it first. Caller can retry once
 *    after re-reading the secret.
 * - `failure` — any other error (network, 5xx, missing fields). No
 *    retry; surface null upward.
 */
type RefreshOutcome =
  | { kind: 'success'; token: StoredOauthToken }
  | { kind: 'invalid_grant' }
  | { kind: 'failure' };

/**
 * Does this token-endpoint rejection mean the refresh token itself is dead?
 *
 * LIVE-CORRECTED: this used to test `error === 'invalid_grant'` only, which is what
 * RFC 6749 specifies — and which Linear does not send. Linear answers a dead
 * refresh token with HTTP 400 and:
 *
 *     { "error": "invalid_request", "error_description": "Refresh token revoked" }
 *     { "error": "invalid_request", "error_description": "Invalid refresh token" }
 *
 * so every real revocation was classified as a generic `failure`. The consequence
 * was invisible but total: the permanent-rejection branch never ran, so the
 * registry was never marked revoked and no operator was ever notified — the
 * detection existed and could not fire. Confirmed against the token-lineage logs
 * from the #807 investigation and reproduced deliberately with a bogus refresh
 * token (#812).
 *
 * `invalid_request` alone is NOT enough to conclude the grant is dead — it is also
 * what a malformed request (our bug) returns — so the description must name the
 * refresh token. `invalid_grant` stays accepted in case Linear aligns with the RFC.
 */
export function isRefreshTokenRejection(
  status: number,
  err: { error?: string; error_description?: string },
): boolean {
  if (err.error === 'invalid_grant') return true;
  return status === 400 && /refresh token/i.test(err.error_description ?? '');
}
async function refreshLinearToken(
  current: StoredOauthToken,
  sm: SecretsManagerClient,
  secretArn: string,
  options: ResolverOptions,
): Promise<StoredOauthToken | null> {
  // First attempt with whatever refresh_token we have.
  const first = await tryRefreshOnce(current, sm, secretArn, options);
  if (first.kind === 'success') return first.token;
  if (first.kind === 'failure') return null;

  // `invalid_grant`: Linear rotates refresh_tokens on every use, so a
  // concurrent Lambda may have refreshed before us. Re-read the secret
  // from SM (bypassing cache) and retry once if the refresh_token
  // changed. This avoids permanently bricking the workspace's token
  // chain when two Lambdas race the same refresh.
  logger.warn('Linear token refresh got invalid_grant — re-reading secret to check for concurrent refresh', {
    secret_arn: secretArn,
    workspace_id: current.workspace_id,
  });

  const fresh = await getOauthSecret(sm, secretArn);
  if (!fresh) {
    invalidateLinearOauthCache(current.workspace_id, secretArn);
    return null;
  }
  if (fresh.refresh_token === current.refresh_token) {
    // No race — Linear truly rejected this refresh_token. Caller needs
    // a fresh OAuth dance.
    logger.error('Linear token refresh permanently rejected — workspace requires re-onboarding', {
      secret_arn: secretArn,
      workspace_id: current.workspace_id,
    });
    // RECORD the verdict, don't just log it. This is the only moment the
    // platform knows the authorization is dead: from here on every event for
    // this workspace is dropped, and without a durable marker the sole evidence
    // is this log line — so an operator sees their trigger label do nothing and
    // has no way to find out why (live-caught 2026-07-25, silent for over an
    // hour). Marking the registry row makes `bgagent platform doctor` able to
    // report it and name the remedy. Best-effort: a failed write must not turn a
    // feedback outage into a thrown handler.
    if (options.onAuthorizationRevoked) {
      try {
        await options.onAuthorizationRevoked({
          linearWorkspaceId: current.workspace_id,
          workspaceSlug: current.workspace_slug,
          installedAt: current.installed_at,
          source: 'secrets-manager-refresh',
        });
      } catch (err) {
        logger.warn('Could not mark the Linear workspace as revoked (non-fatal)', {
          workspace_id: current.workspace_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    invalidateLinearOauthCache(current.workspace_id, secretArn);
    return null;
  }

  // Another caller rotated the token. If the freshly-read token is
  // itself not expiring, just use it — no second refresh needed.
  if (!isTokenExpiring(fresh.expires_at)) {
    logger.info('Linear OAuth token was refreshed by a concurrent caller; using freshly-read value', {
      secret_arn: secretArn,
      workspace_id: fresh.workspace_id,
      new_expires_at: fresh.expires_at,
    });
    tokenCache.set(secretArn, { value: fresh, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
    return fresh;
  }

  // Concurrent caller refreshed but the new token is also already
  // expiring (rare but possible if both Lambdas raced and the second
  // got a tiny TTL). Retry refresh once with the new refresh_token.
  const second = await tryRefreshOnce(fresh, sm, secretArn, options);
  if (second.kind === 'success') return second.token;
  if (second.kind === 'invalid_grant') {
    logger.error('Linear token refresh failed even after re-reading freshly-rotated secret', {
      secret_arn: secretArn,
      workspace_id: fresh.workspace_id,
    });
  }
  invalidateLinearOauthCache(current.workspace_id, secretArn);
  return null;
}

async function tryRefreshOnce(
  current: StoredOauthToken,
  sm: SecretsManagerClient,
  secretArn: string,
  options: ResolverOptions,
): Promise<RefreshOutcome> {
  if (!current.client_id || !current.client_secret) {
    logger.error('Cannot refresh Linear OAuth token: stored secret is missing client_id/client_secret', {
      secret_arn: secretArn,
    });
    return { kind: 'failure' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: current.client_id,
    client_secret: current.client_secret,
  });

  let resp: Response;
  try {
    resp = await fetchImpl(LINEAR_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    logger.error('Linear token refresh fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Network-level failure: invalidate cache so the next call
    // re-reads from Secrets Manager instead of looping on a stale
    // expiring token. Without this the catch returned null without
    // invalidating, hammering Linear in a tight loop until the cache
    // TTL expires.
    invalidateLinearOauthCache(current.workspace_id, secretArn);
    return { kind: 'failure' };
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    logger.error('Linear token refresh returned non-JSON', { status: resp.status });
    return { kind: 'failure' };
  }

  if (!resp.ok) {
    const errObj = parsed as { error?: string; error_description?: string };
    logger.error('Linear token refresh rejected', {
      status: resp.status,
      error: errObj.error,
      error_description: errObj.error_description,
    });
    invalidateLinearOauthCache(current.workspace_id, secretArn);
    if (isRefreshTokenRejection(resp.status, errObj)) {
      return { kind: 'invalid_grant' };
    }
    return { kind: 'failure' };
  }

  const tokenResp = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokenResp.access_token || !tokenResp.expires_in) {
    logger.error('Linear token refresh response missing required fields');
    return { kind: 'failure' };
  }

  const now = new Date();
  const next: StoredOauthToken = {
    ...current,
    access_token: tokenResp.access_token,
    // Linear rotates refresh_token on every refresh. Persist the new one;
    // re-using the old one will fail (one-shot grants).
    refresh_token: tokenResp.refresh_token ?? current.refresh_token,
    expires_at: new Date(now.getTime() + tokenResp.expires_in * 1000).toISOString(),
    scope: tokenResp.scope ?? current.scope,
    updated_at: now.toISOString(),
  };

  // Persist back to Secrets Manager so other Lambdas (and the agent
  // runtime) see the rotated token.
  try {
    await sm.send(new PutSecretValueCommand({
      SecretId: secretArn,
      SecretString: JSON.stringify(next),
    }));
  } catch (err) {
    logger.error('Failed to persist refreshed Linear OAuth token', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
    });
    // Even if persistence fails, the in-memory token still works for
    // THIS Lambda invocation. Other concurrent Lambdas may race-refresh
    // and one will get invalid_grant; the re-read-and-retry path above
    // will recover.
  }

  // Positive-path log so operators diagnosing intermittent 401s have
  // a breadcrumb showing which workspace refreshed and to what expiry.
  logger.info('Linear OAuth token refreshed', {
    workspace_id: next.workspace_id,
    workspace_slug: next.workspace_slug,
    new_expires_at: next.expires_at,
  });

  // Cache the freshest value.
  tokenCache.set(secretArn, { value: next, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return { kind: 'success', token: next };
}

/** Test-only: clear all caches. */
export function _resetCachesForTesting(): void {
  registryCache.clear();
  tokenCache.clear();
}
