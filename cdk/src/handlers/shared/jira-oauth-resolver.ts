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
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

/**
 * Lambda-side resolver for the per-tenant Jira Cloud OAuth token written
 * by `bgagent jira setup` (parity with the Linear resolver).
 *
 * Flow:
 *   1. Look up workspace registry by `cloudId` → `oauth_secret_arn`.
 *   2. Fetch the secret JSON via Secrets Manager.
 *   3. If `expires_at` is within 60s, refresh against Atlassian's
 *      `/oauth/token` endpoint (with stored `refresh_token`) and write the
 *      new JSON back to Secrets Manager.
 *   4. Return the access token.
 *
 * Both reads (registry row, secret value) are cached in-memory with a
 * short TTL so a hot Lambda doesn't hammer DDB / SM on every invocation.
 */

const JIRA_TOKEN_ENDPOINT = 'https://auth.atlassian.com/oauth/token';

/** Cache TTL for the registry row + secret value lookups, in milliseconds. */
const REGISTRY_CACHE_TTL_MS = 60_000;
const SECRET_CACHE_TTL_MS = 60_000;

/** Refresh threshold: refresh tokens with <60s remaining. */
const REFRESH_THRESHOLD_SECONDS = 60;

/** Registry row status values. Anything else is treated as `revoked` (fail-closed). */
type RegistryRowStatus = 'active' | 'revoked';

export interface RegistryRow {
  readonly jira_cloud_id: string;
  readonly site_url: string;
  readonly oauth_secret_arn: string;
  readonly status: RegistryRowStatus;
}

export interface StoredOauthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
  /** Co-located OAuth client credentials so Lambda-side refresh works
   *  without per-Lambda env vars (parity with the Linear store). */
  readonly client_id: string;
  readonly client_secret: string;
  readonly cloud_id: string;
  readonly site_url: string;
  readonly installed_at: string;
  readonly updated_at: string;
  readonly installed_by_platform_user_id: string;
  /** Per-tenant Jira webhook signing secret.
   *
   *  Atlassian's "Generic webhooks" support a per-webhook secret that signs
   *  events with `X-Hub-Signature: sha256=<hex>`. Webhook subscriptions are
   *  tenant-scoped, so a single stack-wide signing secret cannot verify
   *  events from multiple tenants. The webhook receiver looks this up by
   *  `cloudId` at verify time.
   *
   *  Optional for back-compat: tokens written before per-tenant signing
   *  was wired up won't have it, and the receiver falls back to the
   *  stack-wide `JIRA_WEBHOOK_SECRET_ARN` for those installs. */
  readonly webhook_signing_secret?: string;
}

export interface ResolverOptions {
  /** AWS region for SDK clients. Falls back to AWS_REGION env. */
  readonly region?: string;
  /** Override clients for testing. */
  readonly secretsManagerClient?: SecretsManagerClient;
  readonly dynamoDbClient?: DynamoDBDocumentClient;
  /** Override fetch for token-endpoint refresh in tests. */
  readonly fetchImpl?: typeof fetch;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

const registryCache = new Map<string, CacheEntry<RegistryRow>>();
const tokenCache = new Map<string, CacheEntry<StoredOauthToken>>();

/**
 * Drop cached values for a tenant. Used after a refresh so the next caller
 * picks up the rotated token.
 */
export function invalidateJiraOauthCache(cloudId: string, oauthSecretArn?: string): void {
  registryCache.delete(cloudId);
  if (oauthSecretArn) tokenCache.delete(oauthSecretArn);
}

/** Returns true if `expires_at` is within the refresh threshold. */
export function isTokenExpiring(expiresAt: string, thresholdSec: number = REFRESH_THRESHOLD_SECONDS): boolean {
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return true;
  return Date.now() + thresholdSec * 1000 >= ts;
}

export interface ResolvedJiraToken {
  readonly accessToken: string;
  readonly scope: string;
  readonly siteUrl: string;
  readonly oauthSecretArn: string;
}

/**
 * Resolve a usable Jira Cloud OAuth access token for the given tenant.
 *
 * On success: returns `{ accessToken, scope, siteUrl, oauthSecretArn }`.
 * Refreshes silently if the cached token is expiring. Returns null on any
 * failure (registry miss, secret missing, refresh-token revoked) so callers
 * can gracefully no-op rather than blowing up.
 */
export async function resolveJiraOauthToken(
  cloudId: string,
  registryTableName: string,
  options: ResolverOptions = {},
): Promise<ResolvedJiraToken | null> {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const ddb = options.dynamoDbClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const sm = options.secretsManagerClient ?? new SecretsManagerClient({ region });

  // ─── Step 1: Registry row ────────────────────────────────────────
  const row = await getRegistryRow(ddb, registryTableName, cloudId);
  if (!row) {
    logger.warn('Jira tenant not in registry', { jira_cloud_id: cloudId });
    return null;
  }
  if (row.status !== 'active') {
    logger.warn('Jira tenant registry status is not active', {
      jira_cloud_id: cloudId,
      status: row.status,
    });
    return null;
  }

  // ─── Step 2: Cached or fresh token JSON ──────────────────────────
  const cached = tokenCache.get(row.oauth_secret_arn);
  let token: StoredOauthToken;
  if (cached && cached.expiresAt > Date.now() && !isTokenExpiring(cached.value.expires_at)) {
    token = cached.value;
  } else {
    const fetched = await getOauthSecret(sm, row.oauth_secret_arn);
    if (!fetched) {
      logger.error('Jira OAuth secret missing or unreadable', {
        oauth_secret_arn: row.oauth_secret_arn,
        jira_cloud_id: cloudId,
      });
      return null;
    }
    token = fetched;
  }

  // ─── Step 3: Refresh if expiring ─────────────────────────────────
  if (isTokenExpiring(token.expires_at)) {
    const refreshed = await refreshJiraToken(token, sm, row.oauth_secret_arn, options);
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
    siteUrl: token.site_url,
    oauthSecretArn: row.oauth_secret_arn,
  };
}

/**
 * Strict variant of {@link getRegistryRow}: throws on infra error
 * (DDB throttle, network) instead of returning null. Use this from the
 * webhook signature-verification path where a `null` return would let
 * a transient throttle silently downgrade per-tenant verification to
 * the stack-wide fallback secret.
 */
export async function getRegistryRowStrict(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  cloudId: string,
): Promise<RegistryRow | null> {
  const cached = registryCache.get(cloudId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { jira_cloud_id: cloudId },
  }));
  return parseRegistryRow(result.Item, cloudId);
}

export async function getRegistryRow(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  cloudId: string,
): Promise<RegistryRow | null> {
  const cached = registryCache.get(cloudId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result;
  try {
    result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { jira_cloud_id: cloudId },
    }));
  } catch (err) {
    logger.error('Failed to fetch Jira workspace registry row', {
      table_name: tableName,
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- transient DDB throttle degrades to "tenant not in registry"; the verify path uses getRegistryRowStrict which rethrows
  }

  return parseRegistryRow(result.Item, cloudId);
}

function parseRegistryRow(rawItem: unknown, cloudId: string): RegistryRow | null {
  const item = rawItem as Partial<RegistryRow> | undefined;
  if (!item || !item.oauth_secret_arn || !item.site_url) return null;

  // Fail-closed on the status field: missing or unknown values are treated
  // as `revoked`. A partially-written row shouldn't grant access.
  const rawStatus = item.status as string | undefined;
  const status: RegistryRowStatus = rawStatus === 'active' ? 'active' : 'revoked';
  if (rawStatus !== 'active' && rawStatus !== 'revoked' && rawStatus !== undefined) {
    logger.warn('Jira workspace registry row has unknown status — treating as revoked', {
      jira_cloud_id: cloudId,
      raw_status: rawStatus,
    });
  }

  const row: RegistryRow = {
    jira_cloud_id: cloudId,
    site_url: item.site_url,
    oauth_secret_arn: item.oauth_secret_arn,
    status,
  };
  registryCache.set(cloudId, { value: row, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
  return row;
}

const STORED_OAUTH_TOKEN_REQUIRED_FIELDS: ReadonlyArray<keyof StoredOauthToken> = [
  'access_token',
  'refresh_token',
  'expires_at',
  'scope',
  'client_id',
  'client_secret',
  'cloud_id',
  'site_url',
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
    logger.error('Failed to fetch Jira OAuth secret', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- lenient OAuth fetch for task hydration; strict variant getOauthSecretStrict rethrows SM errors
  }
}

/**
 * Strict variant of {@link getOauthSecret}: throws on Secrets Manager
 * error instead of returning null. Use this from the signature-verification
 * path so a transient SM error doesn't silently fall back to stack-wide.
 */
export async function getOauthSecretStrict(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) return null;
  return parseOauthSecret(res.SecretString, secretArn);
}

function parseOauthSecret(secretString: string, secretArn: string): StoredOauthToken | null {
  let parsed: StoredOauthToken;
  try {
    parsed = JSON.parse(secretString) as StoredOauthToken;
  } catch (err) {
    logger.error('Jira OAuth secret value is not valid JSON', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nosemgrep: ts-silent-success-masking -- corrupt secret JSON is logged ERROR; null triggers re-onboard path, not a masked infra failure
  }
  const missing = STORED_OAUTH_TOKEN_REQUIRED_FIELDS.filter(
    (f) => typeof parsed[f] !== 'string' || (parsed[f] as string).length === 0,
  );
  if (missing.length > 0) {
    logger.error('Jira OAuth secret JSON is missing required fields', {
      secret_arn: secretArn,
      missing_fields: missing,
    });
    return null;
  }
  return parsed;
}

type RefreshOutcome =
  | { kind: 'success'; token: StoredOauthToken }
  | { kind: 'invalid_grant' }
  | { kind: 'failure' };

async function refreshJiraToken(
  current: StoredOauthToken,
  sm: SecretsManagerClient,
  secretArn: string,
  options: ResolverOptions,
): Promise<StoredOauthToken | null> {
  const first = await tryRefreshOnce(current, sm, secretArn, options);
  if (first.kind === 'success') return first.token;
  if (first.kind === 'failure') return null;

  // `invalid_grant`: Atlassian rotates refresh_tokens on every use, so a
  // concurrent Lambda may have refreshed before us. Re-read the secret
  // and retry once if the refresh_token changed.
  logger.warn('Jira token refresh got invalid_grant — re-reading secret to check for concurrent refresh', {
    secret_arn: secretArn,
    cloud_id: current.cloud_id,
  });

  const fresh = await getOauthSecret(sm, secretArn);
  if (!fresh) {
    invalidateJiraOauthCache(current.cloud_id, secretArn);
    return null;
  }
  if (fresh.refresh_token === current.refresh_token) {
    logger.error('Jira token refresh permanently rejected — tenant requires re-onboarding', {
      secret_arn: secretArn,
      cloud_id: current.cloud_id,
    });
    invalidateJiraOauthCache(current.cloud_id, secretArn);
    return null;
  }

  if (!isTokenExpiring(fresh.expires_at)) {
    logger.info('Jira OAuth token was refreshed by a concurrent caller; using freshly-read value', {
      secret_arn: secretArn,
      cloud_id: fresh.cloud_id,
      new_expires_at: fresh.expires_at,
    });
    tokenCache.set(secretArn, { value: fresh, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
    return fresh;
  }

  const second = await tryRefreshOnce(fresh, sm, secretArn, options);
  if (second.kind === 'success') return second.token;
  if (second.kind === 'invalid_grant') {
    logger.error('Jira token refresh failed even after re-reading freshly-rotated secret', {
      secret_arn: secretArn,
      cloud_id: fresh.cloud_id,
    });
  }
  invalidateJiraOauthCache(current.cloud_id, secretArn);
  return null;
}

async function tryRefreshOnce(
  current: StoredOauthToken,
  sm: SecretsManagerClient,
  secretArn: string,
  options: ResolverOptions,
): Promise<RefreshOutcome> {
  if (!current.client_id || !current.client_secret) {
    logger.error('Cannot refresh Jira OAuth token: stored secret is missing client_id/client_secret', {
      secret_arn: secretArn,
    });
    return { kind: 'failure' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: current.client_id,
    client_secret: current.client_secret,
    refresh_token: current.refresh_token,
  });

  let resp: Response;
  try {
    resp = await fetchImpl(JIRA_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    logger.error('Jira token refresh fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    invalidateJiraOauthCache(current.cloud_id, secretArn);
    return { kind: 'failure' };
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    logger.error('Jira token refresh returned non-JSON', { status: resp.status });
    return { kind: 'failure' };
  }

  if (!resp.ok) {
    const errObj = parsed as { error?: string; error_description?: string };
    logger.error('Jira token refresh rejected', {
      status: resp.status,
      error: errObj.error,
      error_description: errObj.error_description,
    });
    invalidateJiraOauthCache(current.cloud_id, secretArn);
    if (errObj.error === 'invalid_grant') {
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
    logger.error('Jira token refresh response missing required fields');
    return { kind: 'failure' };
  }

  const now = new Date();
  const next: StoredOauthToken = {
    ...current,
    access_token: tokenResp.access_token,
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
    // Atlassian has already rotated the refresh_token server-side, but the
    // new bundle didn't reach Secrets Manager. Do NOT cache `next`: caching
    // would mask the breakage for SECRET_CACHE_TTL_MS while SM still holds a
    // now-dead refresh_token. Invalidate so the next caller re-reads the
    // (stale) secret and surfaces invalid_grant promptly rather than later.
    logger.error('Failed to persist refreshed Jira OAuth token — SM holds a stale refresh_token; tenant will require re-onboarding if this recurs', {
      secret_arn: secretArn,
      cloud_id: next.cloud_id,
      error: err instanceof Error ? err.message : String(err),
    });
    invalidateJiraOauthCache(next.cloud_id, secretArn);
    return { kind: 'success', token: next };
  }

  logger.info('Jira OAuth token refreshed', {
    cloud_id: next.cloud_id,
    site_url: next.site_url,
    new_expires_at: next.expires_at,
  });

  tokenCache.set(secretArn, { value: next, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return { kind: 'success', token: next };
}

/** Test-only: clear all caches. */
export function _resetCachesForTesting(): void {
  registryCache.clear();
  tokenCache.clear();
}
