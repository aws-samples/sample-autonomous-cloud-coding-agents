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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

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

interface RegistryRow {
  readonly linear_workspace_id: string;
  readonly workspace_slug: string;
  readonly oauth_secret_arn: string;
  readonly status: string;
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
}

export async function resolveLinearOauthToken(
  linearWorkspaceId: string,
  registryTableName: string,
  options: ResolverOptions = {},
): Promise<ResolvedLinearToken | null> {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const ddb = options.dynamoDbClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const sm = options.secretsManagerClient ?? new SecretsManagerClient({ region });

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
      return null;
    }
    token = fetched;
  }

  // ─── Step 3: Refresh if expiring ─────────────────────────────────
  if (isTokenExpiring(token.expires_at)) {
    const refreshed = await refreshLinearToken(token, sm, row.oauth_secret_arn, options);
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
  };
}

async function getRegistryRow(
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
  const item = result.Item as Partial<RegistryRow> | undefined;
  if (!item || !item.oauth_secret_arn || !item.workspace_slug) return null;

  const row: RegistryRow = {
    linear_workspace_id: linearWorkspaceId,
    workspace_slug: item.workspace_slug,
    oauth_secret_arn: item.oauth_secret_arn,
    status: item.status ?? 'active',
  };
  registryCache.set(linearWorkspaceId, { value: row, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS });
  return row;
}

async function getOauthSecret(
  sm: SecretsManagerClient,
  secretArn: string,
): Promise<StoredOauthToken | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!res.SecretString) return null;
    const parsed = JSON.parse(res.SecretString) as StoredOauthToken;
    if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_at) return null;
    return parsed;
  } catch (err) {
    logger.error('Failed to fetch Linear OAuth secret', {
      secret_arn: secretArn,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function refreshLinearToken(
  current: StoredOauthToken,
  sm: SecretsManagerClient,
  secretArn: string,
  options: ResolverOptions,
): Promise<StoredOauthToken | null> {
  if (!current.client_id || !current.client_secret) {
    logger.error('Cannot refresh Linear OAuth token: stored secret is missing client_id/client_secret', {
      secret_arn: secretArn,
    });
    return null;
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
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    logger.error('Linear token refresh returned non-JSON', { status: resp.status });
    return null;
  }

  if (!resp.ok) {
    const errObj = parsed as { error?: string; error_description?: string };
    logger.error('Linear token refresh rejected', {
      status: resp.status,
      error: errObj.error,
      error_description: errObj.error_description,
    });
    // Caller can attempt a fresh OAuth dance; we don't recover automatically.
    invalidateLinearOauthCache(current.workspace_id, secretArn);
    return null;
  }

  const tokenResp = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokenResp.access_token || !tokenResp.expires_in) {
    logger.error('Linear token refresh response missing required fields');
    return null;
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
    // the rest of THIS Lambda invocation. Other concurrent Lambdas may
    // race-refresh; Linear's idempotency-on-replay grace window
    // (30 min documented) absorbs the duplicate.
  }

  // Cache the freshest value.
  tokenCache.set(secretArn, { value: next, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return next;
}

/** Test-only: clear all caches. */
export function _resetCachesForTesting(): void {
  registryCache.clear();
  tokenCache.clear();
}
