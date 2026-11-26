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
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';

const REGISTRY_CACHE_TTL_MS = 60_000;
const SECRET_CACHE_TTL_MS = 60_000;

const REFRESH_THRESHOLD_SECONDS = 60;

/**
 * Within 30 minutes Linear answers a retry with the same refresh token with the
 * replacement credentials (https://linear.app/developers/oauth-2-0-authentication).
 */
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Why a registry row was latched `revoked`. Only `vault_consent_required` is
 * re-probed; the other reasons are terminal.
 */
export type LinearRevocationReason =
  | 'refresh_token_rejected'
  | 'vault_consent_required'
  | 'admin_removed';

const VAULT_CONSENT_REVOCATION_REASON: LinearRevocationReason = 'vault_consent_required';

const REFRESH_REJECTED_REVOCATION_REASON: LinearRevocationReason = 'refresh_token_rejected';

type RegistryRowStatus = 'active' | 'revoked';

export interface RegistryRow {
  readonly linear_workspace_id: string;
  readonly workspace_slug: string;
  readonly oauth_secret_arn: string;
  readonly status: RegistryRowStatus;
  /**
   * When the CURRENT authorization was installed. Rewritten by every
   * (re-)authorization.
   * Optional — rows written before it was recorded have none.
   */
  readonly installed_at?: string;
  /**
   * Full AgentCore Identity credential-provider name for this workspace, written
   * by `bgagent linear setup` when onboarding through the token vault (RFC #249
   * Phase 1). Absent for workspaces onboarded via the Secrets-Manager-only flow.
   */
  readonly provider_name?: string;
  /**
   * The user id the vault grant was bound to at consent time. Absent on workspaces
   * onboarded before this was stored; those fall back to the derived form.
   */
  readonly vault_user_id?: string;
  /**
   * Whether this workspace's `webhook_signing_secret` is provably its OWN, rather than
   * a copy of another workspace's.
   *
   * Absent on rows written before this was recorded, which is why the reader treats
   * absence as "not proven" rather than as `false`, and only acts on it where sharing
   * can actually cross a tenant boundary — a stack with two or more active workspaces.
   */
  readonly webhook_secret_owned?: boolean;
  /**
   * Why `status` was flipped to `revoked`, as written by {@link markWorkspaceRevoked}.
   */
  readonly revoked_reason?: LinearRevocationReason;
  readonly revoked_at?: string;
}

export interface StoredOauthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
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
   *  signing secret can't verify events from multiple workspaces.
   *
   *  Optional for back-compat: tokens written before the per-workspace
   *  signing flow won't have it, and the receiver falls back to the
   *  stack-wide `LINEAR_WEBHOOK_SECRET_ARN` for those installs. */
  readonly webhook_signing_secret?: string;
}

/**
 * What the platform knows at the moment it discovers an authorization is dead.
 */
export interface RevocationDetail {
  readonly linearWorkspaceId: string;
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
   * Called once the authorization is known dead. Must not throw; the caller wraps it.
   */
  readonly onAuthorizationRevoked?: (detail: RevocationDetail) => Promise<void>;
  /**
   * Test seam for the vault call. Production leaves this unset and uses
   * {@link resolveLinearTokenViaVault}.
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
const vaultTokenCache = new Map<string, CacheEntry<string>>();

export function invalidateLinearOauthCache(linearWorkspaceId: string, oauthSecretArn?: string): void {
  registryCache.delete(linearWorkspaceId);
  vaultTokenCache.delete(linearWorkspaceId);
  if (oauthSecretArn) tokenCache.delete(oauthSecretArn);
}

async function askVault(
  viaVault: NonNullable<ResolverOptions['resolveViaVault']>,
  input: VaultTokenInput,
  workloadName: string,
  reuseRecentToken: boolean,
): Promise<VaultTokenResult> {
  const kept = vaultTokenCache.get(input.linearWorkspaceId);
  if (reuseRecentToken && kept && kept.expiresAt > Date.now()) {
    return { kind: 'token', accessToken: kept.value };
  }
  const result = await viaVault(input, workloadName);
  if (result.kind === 'token') {
    vaultTokenCache.set(input.linearWorkspaceId, {
      value: result.accessToken,
      expiresAt: Date.now() + SECRET_CACHE_TTL_MS,
    });
  }
  return result;
}

export function isTokenExpiring(expiresAt: string, thresholdSec: number = REFRESH_THRESHOLD_SECONDS): boolean {
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return true;
  return Date.now() + thresholdSec * 1000 >= ts;
}

export interface ResolvedLinearToken {
  readonly accessToken: string;
  readonly scope: string;
  readonly workspaceSlug: string;
  readonly oauthSecretArn: string;
  /**
   * AgentCore credential-provider name for this workspace, when it was onboarded
   * through the vault (RFC #249 Phase 1). Undefined for Secrets-Manager-only
   * installs.
   */
  readonly providerName?: string;
  /**
   * The user id the vault grant is bound to, as recorded at consent time.
   */
  readonly vaultUserId?: string;
}

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
      await latch(detail);
      return;
    }

    if (!await announceRevocation(detail, { topicArn })) {
      await releaseRevocationAnnouncement(ddb, registryTableName, detail.linearWorkspaceId);
      return;
    }

    await latch(detail);
  };
}

function refreshRejectionRecorder(
  vaultAnswer: VaultTokenResult['kind'] | undefined,
  rowInstalledAt: string | undefined,
  recordRevocation: ResolverOptions['onAuthorizationRevoked'],
): ResolverOptions['onAuthorizationRevoked'] {
  if (vaultAnswer === undefined) return recordRevocation;
  if (vaultAnswer !== 'consent-required' || !recordRevocation) return undefined;
  return (detail) => recordRevocation({ ...detail, installedAt: rowInstalledAt, source: 'vault-consent-required' });
}

/**
 * Resolve a usable Linear OAuth access token for the given workspace. Refreshes
 * silently if the cached token is expiring. Returns null on any failure
 * (registry miss, secret missing, refresh-token revoked) so callers can
 * gracefully no-op rather than blowing up.
 */
export async function resolveLinearOauthToken(
  linearWorkspaceId: string,
  registryTableName: string,
  options: ResolverOptions = {},
): Promise<ResolvedLinearToken | null> {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const ddb = options.dynamoDbClient ?? makeDocClient({ region });
  const sm = options.secretsManagerClient ?? makeClient(SecretsManagerClient, { region });
  const recordRevocation = options.onAuthorizationRevoked
    ?? defaultRevocationRecorder(ddb, registryTableName);

  const row = await getRegistryRow(ddb, registryTableName, linearWorkspaceId);
  if (!row) {
    logger.warn('Linear workspace not in registry', { linear_workspace_id: linearWorkspaceId });
    return null;
  }
  const latchedOnVaultInference = row.status === 'revoked'
    && row.revoked_reason === VAULT_CONSENT_REVOCATION_REASON;
  if (row.status !== 'active' && !latchedOnVaultInference) {
    logger.warn('Linear workspace registry status is not active', {
      linear_workspace_id: linearWorkspaceId,
      status: row.status,
    });
    return null;
  }

  let vaultAnswer: VaultTokenResult['kind'] | undefined;

  const workloadName = vaultWorkloadIdentityName();
  if (row.provider_name && workloadName && (isVaultEnabled() || options.resolveViaVault)) {
    const viaVault = options.resolveViaVault ?? resolveLinearTokenViaVault;
    const vaultResult = await askVault(
      viaVault,
      {
        linearWorkspaceId,
        providerName: row.provider_name,
        vaultUserId: row.vault_user_id,
        region,
      },
      workloadName,
      !latchedOnVaultInference,
    );
    vaultAnswer = vaultResult.kind;
    if (vaultResult.kind === 'token' && latchedOnVaultInference && recordRevocation) {
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
        oauthSecretArn: row.oauth_secret_arn,
        providerName: row.provider_name,
        ...(row.vault_user_id && { vaultUserId: row.vault_user_id }),
      };
    }
  }

  if (latchedOnVaultInference) {
    logger.warn('Linear workspace is still latched revoked after a vault re-probe', {
      linear_workspace_id: linearWorkspaceId,
      revoked_reason: row.revoked_reason,
    });
    return null;
  }

  const cached = tokenCache.get(row.oauth_secret_arn);
  let token: StoredOauthToken;
  if (cached && cached.expiresAt > Date.now() && !isTokenExpiring(cached.value.expires_at)) {
    token = cached.value;
  } else {
    let fetched: StoredOauthToken | null;
    try {
      fetched = await getOauthSecretForResolve(sm, row.oauth_secret_arn);
    } catch (err) {
      logger.error('Could not read the Linear OAuth secret — declining to treat this as a revocation', {
        oauth_secret_arn: row.oauth_secret_arn,
        linear_workspace_id: linearWorkspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // nosemgrep: ts-silent-success-masking -- null IS this resolver's whole failure encoding ("Returns null on any failure … so callers can gracefully no-op", see the contract on the function); it can never be confused with an empty success because no success path returns null, and the cause is logged with full context immediately above
    }
    if (!fetched) {
      logger.error('Linear OAuth secret missing or unreadable', {
        oauth_secret_arn: row.oauth_secret_arn,
        linear_workspace_id: linearWorkspaceId,
      });
      if (vaultAnswer === 'consent-required' && recordRevocation) {
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

  if (isTokenExpiring(token.expires_at)) {
    const refreshed = await refreshLinearToken(token, sm, row.oauth_secret_arn, {
      ...options,
      onAuthorizationRevoked: refreshRejectionRecorder(vaultAnswer, row.installed_at, recordRevocation),
    });
    if (!refreshed) {
      return null;
    }
    token = refreshed;
  } else {
    tokenCache.set(row.oauth_secret_arn, { value: token, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  }

  return {
    accessToken: token.access_token,
    scope: token.scope,
    workspaceSlug: token.workspace_slug,
    oauthSecretArn: row.oauth_secret_arn,
    ...(row.provider_name && { providerName: row.provider_name }),
    ...(row.vault_user_id && { vaultUserId: row.vault_user_id }),
  };
}

/**
 * Mark a workspace's registry row as ``revoked``. The write applies only while
 * the row is ``active`` and its ``installed_at`` equals ``expectedInstalledAt``.
 *
 * When the caller has no ``installed_at`` to name (a row written before it was
 * recorded), the write falls back to requiring the attribute to still be absent.
 *
 * Returns whether THIS call latched the row.
 */
export async function markWorkspaceRevoked(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
  expectedInstalledAt?: string,
  now: string = new Date().toISOString(),
  reason: LinearRevocationReason = REFRESH_REJECTED_REVOCATION_REASON,
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
    logger.error('Could not claim the revocation announcement; announcing without dedup', {
      linear_workspace_id: linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

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
 * Scoped the same way as the latch — same installation (`installed_at`), and only
 * from `revoked`, while the reason is still `vault_consent_required`.
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
 * (DDB throttle, network) instead of returning null.
 */
export async function getRegistryRowStrict(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
): Promise<RegistryRow | null> {
  const cached = registryCache.get(linearWorkspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { linear_workspace_id: linearWorkspaceId },
  }));
  return parseRegistryRow(result.Item, linearWorkspaceId);
}

async function getRegistryRow(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  linearWorkspaceId: string,
): Promise<RegistryRow | null> {
  const cached = registryCache.get(linearWorkspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

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

function parseRegistryRow(rawItem: unknown, linearWorkspaceId: string): RegistryRow | null {
  const item = rawItem as Partial<RegistryRow> | undefined;
  if (!item || !item.oauth_secret_arn || !item.workspace_slug) return null;

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
    ...(typeof item.provider_name === 'string' && { provider_name: item.provider_name }),
    ...(typeof item.vault_user_id === 'string' && { vault_user_id: item.vault_user_id }),
    ...(typeof item.revoked_reason === 'string' && { revoked_reason: item.revoked_reason }),
    ...(item.webhook_secret_owned === true && { webhook_secret_owned: true }),
  };
  registryCache.set(linearWorkspaceId, { value: row, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
  return row;
}

const STORED_OAUTH_GRANT_FIELDS: ReadonlyArray<keyof StoredOauthToken> = [
  'access_token',
  'refresh_token',
  'expires_at',
  'scope',
];

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

async function getOauthSecretForResolve(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!res.SecretString) return null;
    return parseOauthSecret(res.SecretString, secretArn);
  } catch (err) {
    if ((err as { name?: string } | undefined)?.name === 'ResourceNotFoundException') {
      return null;
    }
    throw err;
  }
}

/**
 * Strict variant of {@link getOauthSecret}: throws on Secrets Manager
 * error (network, IAM) instead of returning null. Only returns null for a row that
 * exists but has no string value or fails JSON-shape validation.
 */
export async function getOauthSecretStrict(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) return null;
  return parseOauthSecret(res.SecretString, secretArn, 'without-grant');
}

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

const MS_PER_HOUR = 3_600_000;
const TOKEN_FP_LENGTH = 12;

const TOKEN_FP_SALT = 'abca.linear.token-lineage.v1';
function fingerprintToken(token: string | undefined): string {
  if (!token) return 'none';
  // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key -- fixed DOMAIN-SEPARATION salt, not a key protecting anything: the digest authenticates nothing, is never compared against attacker input, and must be stable across Lambdas and invocations or fingerprints from different processes cannot be correlated — which is the whole purpose. A secret key would defeat the feature without adding a property anything relies on.
  return createHmac('sha256', TOKEN_FP_SALT).update(token).digest('hex').slice(0, TOKEN_FP_LENGTH);
}

function tokenLineage(token: StoredOauthToken): Record<string, string | number> {
  const nowMs = Date.now();
  const ageH = (fromIso: string | undefined): number | 'unknown' => {
    if (!fromIso) return 'unknown';
    const t = Date.parse(fromIso);
    return Number.isNaN(t) ? 'unknown' : Math.round(((nowMs - t) / MS_PER_HOUR) * 10) / 10;
  };
  return {
    refresh_token_fp: fingerprintToken(token.refresh_token),
    token_age_h: ageH(token.installed_at),
    since_last_refresh_h: ageH(token.updated_at),
    installed_at: token.installed_at ?? 'unknown',
    updated_at: token.updated_at ?? 'unknown',
  };
}

type RefreshOutcome =
  | { kind: 'success'; token: StoredOauthToken }
  | { kind: 'invalid_grant' }
  | { kind: 'failure' };

/**
 * Does this token-endpoint rejection mean the refresh token itself is dead?
 *
 * Not RFC 6749's `invalid_grant` — Linear does not send it. A dead refresh token
 * comes back as HTTP 400 with:
 *
 *     { "error": "invalid_request", "error_description": "Refresh token revoked" }
 *     { "error": "invalid_request", "error_description": "Invalid refresh token" }
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
  const first = await tryRefreshOnce(current, sm, secretArn, options);
  if (first.kind === 'success') return first.token;
  if (first.kind === 'failure') return null;

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
    logger.error('Linear token refresh permanently rejected — workspace requires re-onboarding', {
      secret_arn: secretArn,
      workspace_id: current.workspace_id,
      ...tokenLineage(current),
    });
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

  if (!isTokenExpiring(fresh.expires_at)) {
    logger.info('Linear OAuth token was refreshed by a concurrent caller; using freshly-read value', {
      secret_arn: secretArn,
      workspace_id: fresh.workspace_id,
      new_expires_at: fresh.expires_at,
    });
    tokenCache.set(secretArn, { value: fresh, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
    return fresh;
  }

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
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error('Linear token refresh fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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
    // Linear rotates refresh_token on every refresh; re-using the old one
    // will fail (one-shot grants).
    refresh_token: tokenResp.refresh_token ?? current.refresh_token,
    expires_at: new Date(now.getTime() + tokenResp.expires_in * 1000).toISOString(),
    scope: tokenResp.scope ?? current.scope,
    updated_at: now.toISOString(),
  };

  try {
    await sm.send(new PutSecretValueCommand({
      SecretId: secretArn,
      SecretString: JSON.stringify(next),
    }));
  } catch (err) {
    logger.error('Failed to persist refreshed Linear OAuth token', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
      rotated_from_fp: fingerprintToken(current.refresh_token),
      rotated_to_fp: fingerprintToken(next.refresh_token),
    });
  }

  logger.info('Linear OAuth token refreshed', {
    workspace_id: next.workspace_id,
    workspace_slug: next.workspace_slug,
    new_expires_at: next.expires_at,
    rotated_from_fp: fingerprintToken(current.refresh_token),
    rotated_to_fp: fingerprintToken(next.refresh_token),
    token_age_h: tokenLineage(current).token_age_h,
  });

  tokenCache.set(secretArn, { value: next, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return { kind: 'success', token: next };
}

/**
 * The one active Linear workspace on this stack, or undefined when zero or
 * several are active. Not cached: a Scan per call.
 */
export async function resolveSoleActiveLinearWorkspace(
  ddbClient: DynamoDBDocumentClient,
  registryTableName: string | undefined,
): Promise<string | undefined> {
  if (!registryTableName) return undefined;
  const active: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddbClient.send(new ScanCommand({
      TableName: registryTableName,
      ProjectionExpression: 'linear_workspace_id, #s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExclusiveStartKey: lastKey,
      ConsistentRead: true,
    }));
    for (const item of page.Items ?? []) {
      if (item.status === 'active' && typeof item.linear_workspace_id === 'string') {
        active.push(item.linear_workspace_id);
      }
    }
    lastKey = page.LastEvaluatedKey;
    if (active.length > 1) break;
  } while (lastKey);

  if (active.length === 1) return active[0];
  logger.warn('Cannot bind a stack-wide-verified Linear delivery: registry does not have exactly one active workspace', {
    active_workspace_count: active.length,
  });
  return undefined;
}

export function _resetCachesForTesting(): void {
  registryCache.clear();
  tokenCache.clear();
  vaultTokenCache.clear();
}
