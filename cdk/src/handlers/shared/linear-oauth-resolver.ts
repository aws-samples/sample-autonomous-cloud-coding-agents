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

import { createHmac } from 'node:crypto';
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

/**
 * `revoked_reason` written when the vault answered with an authorization URL
 * instead of a token and no Secrets-Manager token could cover for it.
 *
 * Named rather than inlined because three places have to agree on the exact
 * string — the writer, the re-probe guard and the un-latch condition — and a typo
 * in any one of them silently turns the self-healing path off.
 */
const VAULT_CONSENT_REVOCATION_REASON = 'vault_consent_required';

/** `revoked_reason` written when Linear itself rejected the refresh token. */
const REFRESH_REJECTED_REVOCATION_REASON = 'refresh_token_rejected';

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
  /**
   * Why `status` was flipped to `revoked`, as written by {@link markWorkspaceRevoked}.
   *
   * Read, not just written, because the two reasons differ in how much they are
   * worth believing. `refresh_token_rejected` is Linear itself refusing a refresh
   * token — a fact. `vault_consent_required` is an INFERENCE from the vault
   * answering with an authorization URL instead of a token, and this PR has
   * already shipped one bug (`d415fd1f`, a row-parser fault) that produced that
   * answer spuriously. Since the latch makes the resolver refuse the row, a
   * spurious inference would be permanent: the vault is never retried, so the
   * grant that still works is never consulted again. Rows latched on the
   * inference are therefore re-probed — see `resolveLinearOauthToken`.
   */
  readonly revoked_reason?: string;
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
  const latch = async (detail: RevocationDetail): Promise<void> => {
    try {
      await markWorkspaceRevoked(
        ddb,
        registryTableName,
        detail.linearWorkspaceId,
        detail.installedAt,
        undefined,
        detail.source === 'vault-consent-required'
          ? VAULT_CONSENT_REVOCATION_REASON
          : REFRESH_REJECTED_REVOCATION_REASON,
      );
    } catch (err) {
      // `error`, not `warn`: the diagnosis is true and now unrecorded, and nothing
      // downstream retries this write. A recording layer that fails quietly is the
      // thing #812 was filed to remove. The operator has still been told, because
      // the announcement above already went out.
      logger.error('Could not record the revoked Linear authorization', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return async (detail: RevocationDetail): Promise<void> => {
    const topicArn = revocationAlertTopicArn();
    if (!topicArn) {
      logger.warn('Linear authorization revoked, but no alert topic is configured — recorded only', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
      });
      await latch(detail);
      return;
    }

    // ANNOUNCE FIRST, LATCH SECOND. The latch is what seals this code path — a
    // `revoked` row makes the resolver return before it ever re-detects the dead
    // grant — so doing it first made the notification a one-shot side effect of a
    // single write. One SNS throttle or one KMS denial on the topic key during that
    // invocation and the workspace was recorded dead with nobody told, permanently,
    // because every later event took the "already recorded" path.
    //
    // Dedup therefore hangs off a claim of its own rather than off "did THIS call
    // flip the status", which is what makes a failed publish retryable at all.
    const claimed = await claimRevocationAnnouncement(
      ddb,
      registryTableName,
      detail.linearWorkspaceId,
      detail.installedAt,
    );
    if (!claimed) {
      logger.info('Revocation already announced — not announcing again', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
      });
      // Still latch. The claim may be held by an invocation that announced but could
      // not record, and this write is conditional and idempotent — so retrying it is
      // free and is the only thing that eventually gets the row marked.
      await latch(detail);
      return;
    }

    if (!await announceRevocation(detail, { topicArn })) {
      // Hand the claim back and leave the row ACTIVE, so the next event for this
      // workspace re-detects the same dead grant and tries the publish again.
      // Latching here instead would trade a retryable failure for a silent one.
      await releaseRevocationAnnouncement(ddb, registryTableName, detail.linearWorkspaceId);
      return;
    }

    await latch(detail);
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
  // A row latched `revoked` because the VAULT asked for consent is re-probed rather
  // than written off. That verdict is an inference, not Linear refusing anything
  // (see RegistryRow.revoked_reason), and the latch is self-sealing: it makes this
  // guard return before Step 1b, so the vault is never asked again and a wrong
  // inference can only be cleared by a human re-consent. Re-probing costs one
  // GetResourceOauth2Token on a workspace that is already down, and a token in
  // reply is proof the latch was wrong — so it is also what clears it.
  //
  // `refresh_token_rejected` is NOT re-probed: there Linear itself rejected the
  // refresh token, and no amount of retrying changes that.
  const latchedOnVaultInference = row.status === 'revoked'
    && row.revoked_reason === 'vault_consent_required';
  if (row.status !== 'active' && !latchedOnVaultInference) {
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
    if (vaultResult.kind === 'token' && latchedOnVaultInference) {
      // The re-probe answered with a token, so the latch described a grant that is
      // in fact alive. Clear it before returning: leaving the row `revoked` while
      // handing back a working token means `platform doctor` and the alerting keep
      // reporting a dead workspace, and the next cold Lambda re-probes again.
      // Best-effort — a failed un-latch must not fail the resolve that just
      // succeeded, and the next event retries it.
      try {
        await clearWorkspaceRevocation(ddb, registryTableName, linearWorkspaceId, row.installed_at);
      } catch (err) {
        logger.error('Vault re-probe succeeded but the revoked marker could not be cleared', {
          linear_workspace_id: linearWorkspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  // The re-probe did not produce a token, so the latch stands. Stop here rather
  // than falling through to Secrets Manager: this row is `revoked`, and the only
  // reason it got past the status guard was to give the vault one more chance.
  if (latchedOnVaultInference) {
    logger.warn('Linear workspace is still latched revoked after a vault re-probe', {
      linear_workspace_id: linearWorkspaceId,
      revoked_reason: row.revoked_reason,
    });
    return null;
  }

  // ─── Step 2: Cached or fresh token JSON ──────────────────────────
  const cached = tokenCache.get(row.oauth_secret_arn);
  let token: StoredOauthToken;
  if (cached && cached.expiresAt > Date.now() && !isTokenExpiring(cached.value.expires_at)) {
    token = cached.value;
  } else {
    // Read through the variant that separates "there is no grant" from "the read
    // failed", because the latch below treats a null as grounds to take the workspace
    // offline. `getOauthSecret` collapses a throttle, a network blip and an IAM denial
    // into the same null as a genuinely grant-less bundle — and a vault-dead /
    // SM-alive workspace (the state `readExistingOauthTokens` deliberately preserves)
    // runs entirely off that Secrets-Manager token. Latching it on one blip is
    // unrecoverable: the row goes `revoked`, and from then on the vault re-probe
    // answers `consent-required` again, so Secrets Manager is never consulted a second
    // time. A transient error is not evidence that a credential was withdrawn.
    let fetched: StoredOauthToken | null;
    try {
      fetched = await getOauthSecretForResolve(sm, row.oauth_secret_arn);
    } catch (err) {
      logger.error('Could not read the Linear OAuth secret — declining to treat this as a revocation', {
        oauth_secret_arn: row.oauth_secret_arn,
        linear_workspace_id: linearWorkspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Resolution fails for THIS event; the next one retries. Nothing is latched.
      return null;
    }
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
 * Mark a workspace's registry row as ``revoked``, so the dead authorization is
 * discoverable instead of living only in a log line. The resolver already
 * refuses a non-active row, so this also stops the pointless
 * refresh-then-fail work on every subsequent event.
 *
 * Effective only where the registry write is granted, which is why the caller is
 * gated on `LINEAR_REVOCATION_RECORDING`: a role holding READ-ONLY on the table
 * would fail AccessDenied here and have it swallowed, which is the
 * looks-implemented-does-nothing state this function exists to leave behind.
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

/**
 * Claim the right to announce this revocation, exactly once per installation.
 *
 * Deliberately independent of the `active → revoked` status latch. Keying the
 * announcement off that write coupled "recorded" to "notified", so a publish that
 * failed after a successful record could never be retried — the row was already
 * `revoked`, so every later detection was deduped away. Here the notification has
 * its own `attribute_not_exists` claim, which a failed publish releases.
 *
 * Conditioned on `installed_at` and NOT on `status`. A re-authorization rewrites
 * `installed_at`, so a verdict about the previous installation cannot announce
 * against its replacement — while `status` is deliberately not consulted, because
 * this claim is taken BEFORE the row is latched and would otherwise never hold.
 */
async function claimRevocationAnnouncement(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
  expectedInstalledAt?: string,
  now: string = new Date().toISOString(),
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { linear_workspace_id: linearWorkspaceId },
      UpdateExpression: 'SET revocation_announced_at = :now',
      ConditionExpression: expectedInstalledAt === undefined
        ? 'attribute_not_exists(revocation_announced_at) AND attribute_not_exists(installed_at)'
        : 'attribute_not_exists(revocation_announced_at) AND installed_at = :installed',
      ExpressionAttributeValues: {
        ':now': now,
        ...(expectedInstalledAt !== undefined && { ':installed': expectedInstalledAt }),
      },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    // Not a dedup answer — the claim could not be evaluated. Announce rather than
    // stay silent: a duplicate email costs an operator nothing, and this is the
    // last step before the only signal that leaves the account.
    logger.error('Could not claim the revocation announcement; announcing without dedup', {
      linear_workspace_id: linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Release an announcement claim whose publish failed, so the next detection of the
 * same dead grant retries it. Best-effort by construction: if this write also
 * fails there is nothing further to fall back to, and the `error` log is the record.
 */
async function releaseRevocationAnnouncement(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { linear_workspace_id: linearWorkspaceId },
      UpdateExpression: 'REMOVE revocation_announced_at',
    }));
    logger.warn('Released the revocation announcement claim after a failed publish — will retry', {
      linear_workspace_id: linearWorkspaceId,
    });
  } catch (err) {
    logger.error('Revocation was recorded but could not be announced, and the retry claim is stuck', {
      linear_workspace_id: linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Undo a `vault_consent_required` latch after the vault has proven the grant alive.
 *
 * The counterpart to {@link markWorkspaceRevoked}, and the reason that latch is
 * safe to apply on an inference. Without it a single wrong "consent required"
 * answer takes a workspace offline until a human re-consents, because the latch
 * stops the resolver before it can ever ask the vault again.
 *
 * Scoped the same way as the latch — same installation (`installed_at`), and only
 * from `revoked`. That keeps it from resurrecting a row an operator revoked
 * deliberately, or one revoked for `refresh_token_rejected`: the condition requires
 * the reason to still be the inference this function is allowed to overturn.
 *
 * `revocation_announced_at` is removed too, so a later genuine revocation of the
 * same installation is announced again instead of being deduped against this one.
 */
export async function clearWorkspaceRevocation(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
  expectedInstalledAt?: string,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { linear_workspace_id: linearWorkspaceId },
      UpdateExpression: 'SET #s = :active REMOVE revoked_at, revoked_reason, revocation_announced_at',
      ConditionExpression: expectedInstalledAt === undefined
        ? '#s = :revoked AND revoked_reason = :inference AND attribute_not_exists(installed_at)'
        : '#s = :revoked AND revoked_reason = :inference AND installed_at = :installed',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':revoked': 'revoked',
        ':inference': VAULT_CONSENT_REVOCATION_REASON,
        ...(expectedInstalledAt !== undefined && { ':installed': expectedInstalledAt }),
      },
    }));
    logger.warn('Cleared the revoked marker — the vault re-probe returned a working token', {
      linear_workspace_id: linearWorkspaceId,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      logger.info('Left the revoked marker in place — the row is no longer the latch this would clear', {
        linear_workspace_id: linearWorkspaceId,
      });
      return false;
    }
    throw err;
  }
  registryCache.delete(linearWorkspaceId);
  return true;
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
    // Distinguishes a latch built on Linear's own refusal from one built on an
    // inference the vault path can re-test. See RegistryRow.revoked_reason.
    ...(typeof item.revoked_reason === 'string' && { revoked_reason: item.revoked_reason }),
  };
  registryCache.set(linearWorkspaceId, { value: row, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
  return row;
}

/**
 * The four fields that describe an OAUTH GRANT, as opposed to the workspace
 * identity and the webhook signing secret that live in the same bundle.
 *
 * A vault-managed workspace legitimately has none of them: AgentCore holds the
 * refresh token and mints access tokens on demand, so the bundle carries only the
 * client credentials and the signing secret. Requiring them for every read coupled
 * webhook SIGNATURE VERIFICATION to the presence of an OAuth token — two unrelated
 * concerns — and rejected the whole bundle before `webhook_signing_secret` could be
 * read, so a freshly vault-onboarded workspace 401'd on every delivery.
 */
const STORED_OAUTH_GRANT_FIELDS: ReadonlyArray<keyof StoredOauthToken> = [
  'access_token',
  'refresh_token',
  'expires_at',
  'scope',
];

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
 * Read the stored grant for token resolution, distinguishing "there is no grant"
 * from "the read did not complete".
 *
 * Returns null only for a DEFINITE absence — the secret does not exist, holds no
 * string, or holds JSON without the grant fields. Every other Secrets-Manager error
 * throws, because `resolveLinearOauthToken` uses a null here as grounds to latch the
 * workspace `revoked`, and that verdict must rest on evidence rather than on a
 * throttle.
 *
 * Deliberately not {@link getOauthSecretStrict}: that one parses `without-grant` for
 * the webhook-signature path, where a bundle with no access token is valid. Here the
 * missing grant is the whole question, so the full contract is required.
 */
async function getOauthSecretForResolve(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!res.SecretString) return null;
    return parseOauthSecret(res.SecretString, secretArn);
  } catch (err) {
    // A deleted secret IS a definite absence; anything else is not a verdict.
    if ((err as { name?: string } | undefined)?.name === 'ResourceNotFoundException') {
      return null; // nosemgrep: ts-silent-success-masking -- ResourceNotFound IS the empty success this function reports: the secret does not exist, so there is definitively no stored grant. Every other error rethrows on the next line, which is the whole point of the function.
    }
    throw err;
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
  // WITHOUT-GRANT deliberately: the only caller is webhook signature verification,
  // which reads `webhook_signing_secret`. Requiring an access token here rejected
  // vault-managed bundles — whose grant lives in AgentCore, not this secret — and
  // silently downgraded them to the stack-wide fallback, i.e. 401 on every event.
  return parseOauthSecret(res.SecretString, secretArn, 'without-grant');
}

/**
 * `full` — the whole contract, for callers that will use or refresh the grant.
 * `without-grant` — everything except the four grant fields, for callers that only
 * need the workspace identity or the webhook signing secret. A vault-managed
 * bundle is valid under `without-grant` and invalid under `full`, which is the
 * distinction that matters.
 */
type OauthSecretParseMode = 'full' | 'without-grant';

function parseOauthSecret(
  secretString: string,
  secretArn: string,
  mode: OauthSecretParseMode = 'full',
): StoredOauthToken | null {
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
  const requiredFields = mode === 'full'
    ? STORED_OAUTH_TOKEN_REQUIRED_FIELDS
    : STORED_OAUTH_TOKEN_REQUIRED_FIELDS.filter((f) => !STORED_OAUTH_GRANT_FIELDS.includes(f));
  const missing = requiredFields.filter(
    (f) => typeof parsed[f] !== 'string' || (parsed[f] as string).length === 0,
  );
  if (missing.length > 0) {
    logger.error('Linear OAuth secret JSON is missing required fields', {
      secret_arn: secretArn,
      missing_fields: missing,
      parse_mode: mode,
    });
    return null;
  }
  return parsed;
}

/** Milliseconds per hour — for the token-age diagnostics. */
const MS_PER_HOUR = 3_600_000;
/** Length of the truncated token fingerprint logged for lineage. */
const TOKEN_FP_LENGTH = 12;

/**
 * A short, stable, non-reversible fingerprint of a token — safe to log; never the
 * raw value.
 *
 * HMAC-SHA-256 with a fixed application salt rather than a bare hash of the
 * secret: the keyed digest is the correct primitive for fingerprinting a
 * credential, it is not the "password hash" a fast-hash attack applies to, and it
 * matches the `createHmac` idiom the webhook-verify handlers already use.
 * Truncated to a prefix — enough to correlate one token across log events, not
 * enough to be a credential.
 */
const TOKEN_FP_SALT = 'abca.linear.token-lineage.v1';
function fingerprintToken(token: string | undefined): string {
  if (!token) return 'none';
  // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key -- fixed DOMAIN-SEPARATION salt, not a key protecting anything: the digest authenticates nothing, is never compared against attacker input, and must be stable across Lambdas and invocations or fingerprints from different processes cannot be correlated — which is the whole purpose. A secret key would defeat the feature without adding a property anything relies on.
  return createHmac('sha256', TOKEN_FP_SALT).update(token).digest('hex').slice(0, TOKEN_FP_LENGTH);
}

/**
 * Diagnostic lineage of a stored OAuth grant. Additive observability only — never
 * affects control flow.
 *
 * This is what distinguishes a grant that ROTATED normally and later died from one
 * rejected on its very first refresh. That distinction is not recoverable after the
 * fact from anything else: a revoked grant produces the same error either way, and
 * Linear records no audit entry for it. `token_age_h` runs from `installed_at` (the
 * original onboard) and `since_last_refresh_h` from `updated_at`, so the age-at-death
 * is visible in the line that reports the death.
 */
function tokenLineage(token: StoredOauthToken): Record<string, string | number> {
  const nowMs = Date.now();
  const ageH = (fromIso: string | undefined): number | 'unknown' => {
    if (!fromIso) return 'unknown';
    const t = Date.parse(fromIso);
    return Number.isNaN(t) ? 'unknown' : Math.round(((nowMs - t) / MS_PER_HOUR) * 10) / 10;
  };
  return {
    // Truncated keyed digest — identifies the token across events; not reversible.
    refresh_token_fp: fingerprintToken(token.refresh_token),
    token_age_h: ageH(token.installed_at),
    since_last_refresh_h: ageH(token.updated_at),
    installed_at: token.installed_at ?? 'unknown',
    updated_at: token.updated_at ?? 'unknown',
  };
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
    ...tokenLineage(current),
  });

  const fresh = await getOauthSecret(sm, secretArn);
  if (!fresh) {
    invalidateLinearOauthCache(current.workspace_id, secretArn);
    return null;
  }
  if (fresh.refresh_token === current.refresh_token) {
    // No race — Linear truly rejected this refresh_token. Caller needs
    // a fresh OAuth dance.
    // The revocation-forensics line: the fingerprint and ages tell whether Linear
    // killed a grant we still held, and how old it was at death.
    logger.error('Linear token refresh permanently rejected — workspace requires re-onboarding', {
      secret_arn: secretArn,
      workspace_id: current.workspace_id,
      ...tokenLineage(current),
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
      secret_arn: secretArn,
      ...tokenLineage(current),
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
      // The rotated token lives only in THIS invocation's memory while Secrets
      // Manager still holds the old one, so a later refresh replays a spent token
      // and is rejected. The fingerprint pair is what pins that scenario if it
      // happens, rather than leaving it indistinguishable from a real revocation.
      rotated_from_fp: fingerprintToken(current.refresh_token),
      rotated_to_fp: fingerprintToken(next.refresh_token),
    });
    // Even if persistence fails, the in-memory token still works for
    // THIS Lambda invocation. Other concurrent Lambdas may race-refresh
    // and one will get invalid_grant; the re-read-and-retry path above
    // will recover.
  }

  // Positive-path log so operators diagnosing intermittent 401s have
  // a breadcrumb showing which workspace refreshed and to what expiry.
  // The rotation trail lets a LATER rejection be correlated to the exact token just
  // persisted: if Linear rejects rotated_to_fp on the next call, the grant was killed
  // server-side rather than a stale or raced token being replayed.
  logger.info('Linear OAuth token refreshed', {
    workspace_id: next.workspace_id,
    workspace_slug: next.workspace_slug,
    new_expires_at: next.expires_at,
    rotated_from_fp: fingerprintToken(current.refresh_token),
    rotated_to_fp: fingerprintToken(next.refresh_token),
    // Age of the grant refreshed FROM — pairs with the death-age on a later rejection.
    token_age_h: tokenLineage(current).token_age_h,
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
