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

import * as crypto from 'crypto';
import { CliError } from './errors';

/**
 * Linear OAuth endpoint URLs. Fixed across all workspaces.
 */
export const LINEAR_AUTHORIZE_ENDPOINT = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';

/**
 * Scopes for the agent install. `actor=app` is incompatible with `admin`,
 * so we deliberately exclude it. `app:assignable` + `app:mentionable` are
 * required for an Agent app install (Phase 2.0b spike, 2026-05-18).
 */
export const LINEAR_OAUTH_SCOPES = [
  'read',
  'write',
  'app:assignable',
  'app:mentionable',
] as const;

/**
 * Linear OAuth token response shape (RFC 6749 §5.1 + Linear's extensions).
 * Verified via direct curl 2026-05-19 — Linear returns `scope` as a
 * space-separated string for apps created after Dec 2023, with
 * `lin_oauth_…` access tokens and `lin_refresh_…` refresh tokens.
 */
export interface LinearTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope: string;
}

/**
 * Persisted form of a Linear OAuth credential. Stored as the JSON
 * `SecretString` of `bgagent-linear-oauth-<slug>` in Secrets Manager.
 *
 * `expires_at` is computed at write time as ISO-8601, so consumers can
 * compare against `new Date()` without depending on Linear's
 * `expires_in` (relative to issuance) being correct on the wall clock.
 *
 * `client_id` and `client_secret` are co-located so Lambda-side refresh
 * can hit Linear's `/oauth/token` without needing additional environment
 * variables — one secret per workspace contains everything the runtime
 * needs to renew the access token autonomously.
 */
export interface StoredLinearOauthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  /** ISO-8601 timestamp; if `now >= expires_at - threshold`, refresh first. */
  readonly expires_at: string;
  /** Space-separated scope string Linear returned (e.g. "read write app:..."). */
  readonly scope: string;
  /** Linear OAuth app Client ID — needed for refresh. */
  readonly client_id: string;
  /** Linear OAuth app Client Secret — needed for refresh. */
  readonly client_secret: string;
  /** Linear organization UUID; webhook payloads carry this. */
  readonly workspace_id: string;
  /** Linear urlKey; matches the suffix on the secret name. */
  readonly workspace_slug: string;
  /** ISO-8601 timestamp of the original install (does NOT change on refresh). */
  readonly installed_at: string;
  /** ISO-8601 timestamp of the most recent refresh write (or first install). */
  readonly updated_at: string;
  /** Cognito sub of the admin who ran `bgagent linear setup`. Audit only. */
  readonly installed_by_platform_user_id: string;
  /**
   * Per-workspace Linear webhook signing secret (`lin_wh_…`).
   *
   * Linear generates a fresh signing secret per webhook subscription, and
   * webhook subscriptions are workspace-scoped — so a single stack-wide
   * signing secret can't verify events from multiple workspaces. The
   * webhook receiver looks this up by orgId at verify time.
   *
   * Optional for back-compat: tokens written before the per-workspace
   * signing flow won't have it, and the receiver falls back to the
   * stack-wide `LINEAR_WEBHOOK_SECRET_ARN` for those installs.
   */
  readonly webhook_signing_secret?: string;
}

/**
 * Common prefix for all per-workspace Linear OAuth secrets. The full
 * secret name is `${LINEAR_OAUTH_SECRET_PREFIX}<slug>`. Use this when
 * scanning Secrets Manager for every workspace install (e.g. the CLI's
 * `list-projects` command queries every workspace it can find).
 */
export const LINEAR_OAUTH_SECRET_PREFIX = 'bgagent-linear-oauth-';

/**
 * Build the secret name for a given Linear workspace slug. Matches the
 * naming convention encoded in the runtime's IAM policy resource pattern,
 * so changes here MUST be matched by the IAM resource pattern in CDK.
 */
export function linearOauthSecretName(workspaceSlug: string): string {
  return `${LINEAR_OAUTH_SECRET_PREFIX}${workspaceSlug}`;
}

/**
 * Compute when an access token should be considered "stale and needs
 * refresh." We refresh if there's <60s left on the access token —
 * gives Lambda invocations a clean buffer to make the upstream call
 * without racing the actual expiry.
 */
const REFRESH_THRESHOLD_SECONDS = 60;

export function isAccessTokenExpiring(
  expiresAt: string,
  thresholdSeconds: number = REFRESH_THRESHOLD_SECONDS,
): boolean {
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) {
    // Treat malformed expires_at as expired — better to over-refresh than
    // proceed with a token that may have rotated under us.
    return true;
  }
  return Date.now() + thresholdSeconds * 1000 >= expiry;
}

/**
 * PKCE pair: a random `code_verifier` and the SHA-256 base64url digest
 * (`code_challenge`). Linear supports both `S256` and `plain`; we always
 * use `S256` because the wire-format cost is identical and stronger.
 *
 * Returned `code_verifier` MUST be sent on the token-exchange POST to
 * complete PKCE. Without it, Linear rejects with `invalid_grant`.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const verifierBytes = crypto.randomBytes(32);
  const codeVerifier = verifierBytes.toString('base64url');
  const challengeBytes = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = challengeBytes.toString('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Build the Linear authorization URL the CLI opens in the browser.
 * `actorApp: true` adds `actor=app` (the Agent install variant).
 */
export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  actorApp?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    // RFC 6749 §3.3: scope is a space-separated list. Linear rejects
    // comma-separated scopes with "Invalid redirect_uri" — the error
    // is misleading; verified by 2.0b smoke test 2026-05-19.
    scope: (opts.scopes ?? LINEAR_OAUTH_SCOPES).join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (opts.actorApp ?? true) {
    params.set('actor', 'app');
  }
  return `${LINEAR_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange an authorization `code` for an access + refresh token by
 * POSTing to Linear's `/oauth/token` endpoint. Mirrors the curl shape
 * verified by the 2026-05-19 manual smoke test.
 *
 * Throws CliError with Linear's error_description on failure (the most
 * common cause of failure is `invalid_grant` from a reused/expired
 * code or `redirect_uri_mismatch`).
 */
export async function exchangeAuthorizationCode(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<LinearTokenResponse> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const response = await fetchImpl(LINEAR_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return parseTokenResponse(response, 'authorization_code exchange');
}

/**
 * Refresh an expiring access token. Linear's refresh tokens are
 * long-lived (no documented TTL) but rotate every refresh call —
 * always persist `refresh_token` from the response back to storage.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<LinearTokenResponse> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const response = await fetchImpl(LINEAR_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return parseTokenResponse(response, 'refresh_token grant');
}

async function parseTokenResponse(
  response: Response,
  contextLabel: string,
): Promise<LinearTokenResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CliError(
      `Linear /oauth/token returned non-JSON during ${contextLabel}: HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const obj = body as { error?: string; error_description?: string };
    throw new CliError(
      `Linear /oauth/token rejected ${contextLabel}: HTTP ${response.status} `
      + `${obj.error ?? 'unknown_error'}: ${obj.error_description ?? '(no description)'}`,
    );
  }
  if (!isLinearTokenResponse(body)) {
    throw new CliError(
      `Linear /oauth/token returned an unexpected shape for ${contextLabel}: `
      + `${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
}

function isLinearTokenResponse(value: unknown): value is LinearTokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.access_token === 'string'
    && typeof obj.token_type === 'string'
    && typeof obj.expires_in === 'number'
    && typeof obj.scope === 'string'
  );
}

/**
 * Compute the `expires_at` ISO timestamp from `expires_in` (seconds).
 * Centralised so the CLI's initial-install path and the Lambda-side
 * refresh path agree on the timestamp shape.
 */
export function computeExpiresAt(expiresInSeconds: number, now: Date = new Date()): string {
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}
