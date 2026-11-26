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
import { describeTokenShape } from './linear-oauth';

const JIRA_AUTHORIZE_ENDPOINT = 'https://auth.atlassian.com/authorize';
const JIRA_TOKEN_ENDPOINT = 'https://auth.atlassian.com/oauth/token';

/** Atlassian issues a refresh_token only when `offline_access` is requested. */
const JIRA_OAUTH_SCOPES = [
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
 * One row of the Atlassian `accessible-resources` response: one Atlassian
 * Cloud site (tenant) the issued token can act on.
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
  /** Forge v2 web-trigger URL used for outbound app-auth writes. */
  readonly app_actor_proxy_url?: string;
  /** HMAC secret shared with the Forge app's web-trigger handler. */
  readonly app_actor_shared_secret?: string;
  /** Jira app account id verified during `bgagent jira app-setup`. */
  readonly app_actor_account_id?: string;
  /** Jira app display name verified during `bgagent jira app-setup`. */
  readonly app_actor_display_name?: string;
  /** ISO-8601 timestamp of the latest successful app-actor setup. */
  readonly app_actor_configured_at?: string;
  /**
   * Per-tenant Jira webhook signing secret: Atlassian signs events with
   * `X-Hub-Signature: sha256=<hex>`. The receiver uses this copy when the
   * payload carries cloudId. Jira admin-console payloads omit cloudId, so the
   * sole active tenant also synchronizes its value to the stack-wide verifier.
   *
   * Absent on tokens written before per-tenant signing: the receiver uses the
   * stack-wide `JIRA_WEBHOOK_SECRET_ARN` verifier for those installs.
   */
  readonly webhook_signing_secret?: string;
}

const JIRA_OAUTH_SECRET_PREFIX = 'bgagent-jira-oauth-';

export function jiraOauthSecretName(cloudId: string): string {
  return `${JIRA_OAUTH_SECRET_PREFIX}${cloudId}`;
}

/**
 * Deserialize and validate a stored Jira OAuth bundle read from Secrets
 * Manager. A missing, truncated or malformed secret throws a `CliError`
 * that names `secretId` and tells the operator to re-run setup.
 */
export function parseStoredJiraOauthToken(
  secretString: string | undefined,
  secretId: string,
): StoredJiraOauthToken {
  if (!secretString) {
    throw new CliError(`OAuth secret '${secretId}' has no SecretString. Re-run \`bgagent jira setup\`.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new CliError(`OAuth secret '${secretId}' is not valid JSON. Re-run \`bgagent jira setup\`.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CliError(`OAuth secret '${secretId}' has an unexpected shape. Re-run \`bgagent jira setup\`.`);
  }
  const obj = parsed as Record<string, unknown>;
  const required = [
    'access_token',
    'refresh_token',
    'expires_at',
    'client_id',
    'client_secret',
    'cloud_id',
    'site_url',
  ];
  const missing = required.filter((key) => typeof obj[key] !== 'string' || (obj[key] as string).length === 0);
  if (missing.length > 0) {
    throw new CliError(
      `OAuth secret '${secretId}' is missing required field${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. `
      + `Re-run \`bgagent jira setup\` for tenant '${String(obj.cloud_id ?? 'unknown')}'.`,
    );
  }
  return parsed as StoredJiraOauthToken;
}

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
 * (`code_challenge`).
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
 * - `audience=api.atlassian.com` — required by Atlassian.
 * - `prompt=consent` — required by Atlassian; shows the consent screen.
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
 * x-www-form-urlencoded.
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
 * every refresh — always persist the new `refresh_token` from the
 * response back to storage.
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
      + describeTokenShape(body),
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

export function computeExpiresAt(expiresInSeconds: number, now: Date = new Date()): string {
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}

/**
 * After authorization, query the list of Atlassian Cloud sites the
 * issued token can act on. Returns one entry per accessible tenant.
 *
 * Documented at
 * https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#3-1-make-calls-to-the-api-using-the-access-token.
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
