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
 * Atlassian OAuth (3LO) endpoint URLs. Fixed across all tenants.
 */
export const JIRA_AUTHORIZE_ENDPOINT = 'https://auth.atlassian.com/authorize';
export const JIRA_TOKEN_ENDPOINT = 'https://auth.atlassian.com/oauth/token';

/**
 * Scopes for the agent install. The classic-scope set required for ABCA's
 * v1 surface:
 * - `read:jira-work` / `write:jira-work` — read issues + post comments
 * - `read:jira-user` — resolve accountIds → display names during link
 *   preview
 * - `offline_access` — REQUIRED to receive a refresh_token; without it
 *   the access token expires after 1h and the integration cannot
 *   self-renew.
 */
export const JIRA_OAUTH_SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'offline_access',
] as const;

/**
 * Atlassian OAuth token response shape (RFC 6749 §5.1 + Atlassian's
 * extensions). Documented at
 * https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/.
 */
export interface JiraTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope: string;
}

/**
 * One row of the Atlassian `accessible-resources` response. After the
 * authorization-code exchange completes, the CLI calls
 * `https://api.atlassian.com/oauth/token/accessible-resources` to learn
 * which Atlassian Cloud sites the issued token can act on. Each entry is
 * one tenant.
 */
export interface AccessibleResource {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly scopes: readonly string[];
}

/**
 * Persisted form of a Jira OAuth credential. Stored as the JSON
 * `SecretString` of `bgagent-jira-oauth-<cloudId>` in Secrets Manager.
 *
 * Mirrors the agent-side StoredOauthToken in
 * `cdk/src/handlers/shared/jira-oauth-resolver.ts` — the contract is
 * cross-language so the agent runtime, Lambdas, and CLI all read/write
 * the same JSON shape. Required-field set is enforced at deserialization.
 */
export interface StoredJiraOauthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  /** ISO-8601 timestamp; if `now >= expires_at - threshold`, refresh first. */
  readonly expires_at: string;
  /** Space-separated scope string Atlassian returned. */
  readonly scope: string;
  /** Atlassian OAuth app Client ID — needed for refresh. */
  readonly client_id: string;
  /** Atlassian OAuth app Client Secret — needed for refresh. */
  readonly client_secret: string;
  /** Atlassian tenant identifier; webhook payloads carry this. */
  readonly cloud_id: string;
  /** Tenant base URL, e.g. `https://acme.atlassian.net`. */
  readonly site_url: string;
  /** ISO-8601 timestamp of the original install (does NOT change on refresh). */
  readonly installed_at: string;
  /** ISO-8601 timestamp of the most recent refresh write (or first install). */
  readonly updated_at: string;
  /** Cognito sub of the admin who ran `bgagent jira setup`. Audit only. */
  readonly installed_by_platform_user_id: string;
  /**
   * Per-tenant Jira webhook signing secret.
   *
   * Atlassian's "Generic webhooks" support a per-webhook secret that
   * signs events with `X-Hub-Signature: sha256=<hex>`. Webhook
   * subscriptions are tenant-scoped, so a single stack-wide signing
   * secret cannot verify events from multiple tenants.
   *
   * Optional for back-compat: tokens written before per-tenant signing
   * was wired up won't have it, and the receiver falls back to the
   * stack-wide `JIRA_WEBHOOK_SECRET_ARN` for those installs.
   */
  readonly webhook_signing_secret?: string;
}

/**
 * Common prefix for all per-tenant Jira OAuth secrets. The full secret
 * name is `${JIRA_OAUTH_SECRET_PREFIX}<cloudId>`. Use this when scanning
 * Secrets Manager for every tenant install.
 */
export const JIRA_OAUTH_SECRET_PREFIX = 'bgagent-jira-oauth-';

/**
 * Build the secret name for a given Jira cloudId. Matches the naming
 * convention encoded in the runtime's IAM policy resource pattern, so
 * changes here MUST be matched by the IAM resource pattern in CDK.
 */
export function jiraOauthSecretName(cloudId: string): string {
  return `${JIRA_OAUTH_SECRET_PREFIX}${cloudId}`;
}

/**
 * Compute when an access token should be considered "stale and needs
 * refresh." We refresh if there's <60s left.
 */
const REFRESH_THRESHOLD_SECONDS = 60;

export function isAccessTokenExpiring(
  expiresAt: string,
  thresholdSeconds: number = REFRESH_THRESHOLD_SECONDS,
): boolean {
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) {
    return true;
  }
  return Date.now() + thresholdSeconds * 1000 >= expiry;
}

/**
 * PKCE pair: a random `code_verifier` and the SHA-256 base64url digest
 * (`code_challenge`). Atlassian supports `S256`; always use that.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const VERIFIER_BYTES = 32;
  const verifierBytes = crypto.randomBytes(VERIFIER_BYTES);
  const codeVerifier = verifierBytes.toString('base64url');
  const challengeBytes = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = challengeBytes.toString('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Build the Atlassian authorization URL the CLI opens in the browser.
 *
 * Atlassian-specific fields:
 * - `audience=api.atlassian.com` — REQUIRED; missing this returns a
 *   confusing "invalid_client" from the consent screen.
 * - `prompt=consent` — forces the consent UI even if the user has
 *   previously authorized the app, so refresh_token is reissued.
 */
export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: (opts.scopes ?? JIRA_OAUTH_SCOPES).join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });
  return `${JIRA_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange an authorization `code` for an access + refresh token.
 *
 * Atlassian's `/oauth/token` endpoint accepts a JSON body, NOT
 * x-www-form-urlencoded — that's the one shape difference from Linear.
 */
export async function exchangeAuthorizationCode(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<JiraTokenResponse> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const response = await fetchImpl(JIRA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return parseTokenResponse(response, 'authorization_code exchange');
}

/**
 * Refresh an expiring access token. Atlassian rotates refresh tokens on
 * every refresh (with a 1-year sliding window) — always persist the
 * new `refresh_token` from the response back to storage.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<JiraTokenResponse> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const response = await fetchImpl(JIRA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return parseTokenResponse(response, 'refresh_token grant');
}

async function parseTokenResponse(
  response: Response,
  contextLabel: string,
): Promise<JiraTokenResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CliError(
      `Atlassian /oauth/token returned non-JSON during ${contextLabel}: HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const obj = body as { error?: string; error_description?: string };
    throw new CliError(
      `Atlassian /oauth/token rejected ${contextLabel}: HTTP ${response.status} `
      + `${obj.error ?? 'unknown_error'}: ${obj.error_description ?? '(no description)'}`,
    );
  }
  if (!isJiraTokenResponse(body)) {
    throw new CliError(
      `Atlassian /oauth/token returned an unexpected shape for ${contextLabel}: `
      + `${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
}

function isJiraTokenResponse(value: unknown): value is JiraTokenResponse {
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
 */
export function computeExpiresAt(expiresInSeconds: number, now: Date = new Date()): string {
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}

/**
 * After authorization, query the list of Atlassian Cloud sites the
 * issued token can act on. Returns one entry per accessible tenant.
 *
 * Documented at
 * https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#3-1-make-calls-to-the-api-using-the-access-token.
 *
 * In practice an OAuth 3LO install almost always returns exactly one
 * site (the tenant whose admin clicked Authorize); but if the user
 * picked multiple sites on the consent screen we surface the full list
 * so the caller can pick the right one.
 */
export async function fetchAccessibleResources(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessibleResource[]> {
  const resp = await fetchImpl('https://api.atlassian.com/oauth/token/accessible-resources', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new CliError(
      `Atlassian accessible-resources query failed: HTTP ${resp.status}. `
      + 'The access token may be missing scopes — re-check the OAuth app config.',
    );
  }
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    throw new CliError('Atlassian accessible-resources returned non-JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(
      `Atlassian accessible-resources returned an unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return parsed as AccessibleResource[];
}
