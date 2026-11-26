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

export const LINEAR_AUTHORIZE_ENDPOINT = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';

/**
 * Scopes for the agent install. Linear rejects `admin` together with `actor=app`,
 * and an Agent app install requires `app:assignable` and `app:mentionable`.
 */
export const LINEAR_OAUTH_SCOPES = [
  'read',
  'write',
  'app:assignable',
  'app:mentionable',
] as const;

/**
 * Linear OAuth token response shape (RFC 6749 §5.1 + Linear's extensions).
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
 */
export interface StoredLinearOauthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  /** ISO-8601 timestamp; if `now >= expires_at - threshold`, refresh first. */
  readonly expires_at: string;
  /** Space-separated scope string Linear returned (e.g. "read write app:..."). */
  readonly scope: string;
  readonly client_id: string;
  readonly client_secret: string;
  /** Linear organization UUID. */
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
   * Optional for back-compat: tokens written before the per-workspace
   * signing flow won't have it, and the receiver falls back to the
   * stack-wide `LINEAR_WEBHOOK_SECRET_ARN` for those installs.
   */
  readonly webhook_signing_secret?: string;
}

/**
 * Common prefix for all per-workspace Linear OAuth secrets. The full
 * secret name is `${LINEAR_OAUTH_SECRET_PREFIX}<slug>`.
 */
export const LINEAR_OAUTH_SECRET_PREFIX = 'bgagent-linear-oauth-';

export function linearOauthSecretName(workspaceSlug: string): string {
  return `${LINEAR_OAUTH_SECRET_PREFIX}${workspaceSlug}`;
}

/**
 * PKCE pair: a random `code_verifier` and the SHA-256 base64url digest
 * (`code_challenge`).
 *
 * Returned `code_verifier` MUST be sent on the token-exchange POST to
 * complete PKCE. Without it, Linear rejects with `invalid_grant`.
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
 * Build the Linear authorization URL the CLI opens in the browser.
 * `actorApp: true` adds `actor=app` (the Agent install variant).
 *
 * `forceConsent` adds `prompt=consent`: Linear then shows the consent screen even when
 * every scope was already granted. Without it an app already installed in the workspace
 * returns no authorization code.
 */
export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  actorApp?: boolean;
  forceConsent?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    // RFC 6749 §3.3: scope is space-separated. Linear answers comma-separated
    // scopes with a misleading "Invalid redirect_uri".
    scope: LINEAR_OAUTH_SCOPES.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (opts.actorApp ?? true) {
    params.set('actor', 'app');
  }
  if (opts.forceConsent) {
    params.set('prompt', 'consent');
  }
  return `${LINEAR_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange an authorization `code` for an access + refresh token by
 * POSTing to Linear's `/oauth/token` endpoint.
 *
 * Throws CliError with Linear's error_description on failure.
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
 * Refresh an expiring access token. Linear rotates the refresh token on every call:
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
  } catch (_err) {
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
      + describeTokenShape(body),
    );
  }
  return body;
}

/**
 * Describe an off-contract token response by field names and types. Values are never
 * included: one of them is the credential.
 */
export function describeTokenShape(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return `not a JSON object (got ${value === null ? 'null' : typeof value})`;
  }
  const obj = value as Record<string, unknown>;
  const problems = ([
    ['access_token', 'string'],
    ['token_type', 'string'],
    ['expires_in', 'number'],
    ['scope', 'string'],
  ] as ReadonlyArray<readonly [string, string]>)
    .filter(([key, want]) => typeof obj[key] !== want)
    .map(([key, want]) => `${key} expected ${want}, got ${obj[key] === undefined ? 'absent' : typeof obj[key]}`);
  return `${problems.join('; ')} (keys present: ${Object.keys(obj).sort().join(', ')})`;
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
 */
export function computeExpiresAt(expiresInSeconds: number, now: Date = new Date()): string {
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}

/**
 * Read a workspace's stored `webhook_signing_secret` from its OAuth bundle.
 * `fetchSecretString` fetches the per-workspace OAuth `SecretString`; `isNotFound`
 * classifies its errors.
 *
 * Returns undefined when the secret does not exist, is empty, or holds no `lin_wh_…`
 * `webhook_signing_secret`. Throws on any other fetch error and on a bundle that is
 * not valid JSON.
 */
export async function readExistingWebhookSecret(
  fetchSecretString: () => Promise<string | undefined>,
  isNotFound: (err: unknown) => boolean,
): Promise<string | undefined> {
  let raw: string | undefined;
  try {
    raw = await fetchSecretString();
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  if (!raw) return undefined;
  const bundle = JSON.parse(raw) as Partial<StoredLinearOauthToken>;
  return bundle.webhook_signing_secret?.startsWith('lin_wh_')
    ? bundle.webhook_signing_secret
    : undefined;
}

export type StoredGrantFields =
  Pick<StoredLinearOauthToken, 'access_token' | 'refresh_token' | 'expires_at' | 'scope'>;

/**
 * Decide the grant fields to persist: a freshly issued token if there is one, else the
 * grant already stored, else empty.
 */
export function resolveStoredGrantFields(
  issued: LinearTokenResponse | undefined,
  preserved: StoredGrantFields | undefined,
  now: Date = new Date(),
): StoredGrantFields {
  return {
    access_token: issued?.access_token ?? preserved?.access_token ?? '',
    refresh_token: issued?.refresh_token ?? preserved?.refresh_token ?? '',
    expires_at: issued ? computeExpiresAt(issued.expires_in, now) : preserved?.expires_at ?? '',
    scope: issued?.scope ?? preserved?.scope ?? '',
  };
}

/**
 * The OAuth token fields of an existing bundle, or undefined when the secret does not
 * exist, is empty, or holds no refresh token. Throws on any other fetch error and on a
 * bundle that is not valid JSON.
 */
export async function readExistingOauthTokens(
  fetchSecretString: () => Promise<string | undefined>,
  isNotFound: (err: unknown) => boolean,
): Promise<Pick<StoredLinearOauthToken, 'access_token' | 'refresh_token' | 'expires_at' | 'scope'> | undefined> {
  let raw: string | undefined;
  try {
    raw = await fetchSecretString();
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  if (!raw) return undefined;
  const bundle = JSON.parse(raw) as Partial<StoredLinearOauthToken>;
  if (!bundle.refresh_token) return undefined;
  return {
    access_token: bundle.access_token ?? '',
    refresh_token: bundle.refresh_token,
    expires_at: bundle.expires_at ?? '',
    scope: bundle.scope ?? '',
  };
}

/**
 * Refresh a workspace's token and write the rotated bundle through `writeSecret` in one
 * step. Linear rotates the refresh token on every use, so the stored one is spent as
 * soon as the refresh succeeds.
 *
 * Returns `refreshed` when the rotated bundle was written; `rejected` when Linear
 * answered `invalid_grant`, or the bundle lacks a refresh token or client credentials;
 * `error` otherwise, including a rotation that succeeded but could not be written.
 */
export async function verifyLinearRefreshAndPersist(args: {
  readSecret: () => Promise<string | undefined>;
  writeSecret: (secretString: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<'refreshed' | 'rejected' | 'error'> {
  let stored: StoredLinearOauthToken;
  try {
    const raw = await args.readSecret();
    if (!raw) return 'error';
    stored = JSON.parse(raw) as StoredLinearOauthToken;
  } catch {
    return 'error';
  }
  if (!stored.refresh_token || !stored.client_id || !stored.client_secret) {
    return 'rejected';
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken({
      refreshToken: stored.refresh_token,
      clientId: stored.client_id,
      clientSecret: stored.client_secret,
      ...(args.fetchImpl && { fetchImpl: args.fetchImpl }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes('invalid_grant') ? 'rejected' : 'error';
  }

  const now = args.now ?? new Date();
  const next: StoredLinearOauthToken = {
    ...stored,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    expires_at: computeExpiresAt(refreshed.expires_in, now),
    scope: refreshed.scope,
    updated_at: now.toISOString(),
  };
  try {
    await args.writeSecret(JSON.stringify(next));
  } catch {
    return 'error';
  }
  return 'refreshed';
}
