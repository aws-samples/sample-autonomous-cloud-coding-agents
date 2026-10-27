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

import type { AuthAdapter, AuthSession, AuthUser } from './AuthProvider';

/**
 * Sign-in with Cognito managed login: OAuth 2.0 authorization code + PKCE (S256)
 * against the stack's public app client, no client secret.
 *
 * Tokens live in sessionStorage, so they are scoped to the tab and gone when it
 * closes. The ID token is decoded only to show who is signed in and to check it
 * was issued for this client; the API's Cognito authorizer verifies it on every
 * request, so nothing here is an authorization decision.
 */
export interface CognitoAuthOptions {
  readonly region: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  /** Managed login base URL, e.g. `https://abca-123.auth.us-east-1.amazoncognito.com`. */
  readonly domain: string;
}

/** Browser seams, injectable for tests. */
export interface CognitoAuthEnvironment {
  readonly storage: Storage;
  readonly fetch: typeof fetch;
  readonly crypto: Crypto;
  readonly location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>;
  /** Leaves the app for the hosted sign-in or sign-out page. */
  redirect(url: string): void;
  /** Rewrites the current URL without navigating (drops `?code=` after the callback). */
  replaceUrl(path: string): void;
  now(): number;
}

export const CALLBACK_PATH = '/auth/callback';
const TOKENS_KEY = 'abca-console-tokens';
const PENDING_KEY = 'abca-console-pending-sign-in';
/** Refresh this long before expiry, so a token never lapses mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

interface StoredTokens {
  readonly idToken: string;
  readonly refreshToken?: string;
  /** Epoch ms when the ID token expires. */
  readonly expiresAt: number;
}

interface PendingSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: string;
}

interface IdTokenClaims {
  readonly sub: string;
  readonly email?: string;
  readonly aud: string;
  readonly iss: string;
  readonly exp: number;
  readonly token_use: string;
  readonly nonce?: string;
  readonly 'cognito:groups'?: readonly string[];
}

class CognitoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CognitoAuthError';
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(crypto: Crypto): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pkceChallenge(crypto: Crypto, verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new CognitoAuthError('malformed token');
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof payload !== 'object' || payload === null) throw new CognitoAuthError('malformed token');
  return payload as Record<string, unknown>;
}

/** Only same-origin paths are valid post-sign-in destinations (no open redirect). */
function safeReturnPath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith(CALLBACK_PATH) ? value : '/';
}

function readJson<T>(storage: Storage, key: string): T | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function createCognitoAuthAdapter(options: CognitoAuthOptions, env: CognitoAuthEnvironment = browserEnvironment()): AuthAdapter {
  const domain = options.domain.replace(/\/+$/, '');
  const redirectUri = `${env.location.origin}${CALLBACK_PATH}`;
  const issuer = `https://cognito-idp.${options.region}.amazonaws.com/${options.userPoolId}`;
  let refreshing: Promise<StoredTokens> | null = null;

  function claimsOf(idToken: string, expectedNonce?: string): IdTokenClaims {
    const claims = decodeJwtPayload(idToken) as unknown as IdTokenClaims;
    if (claims.token_use !== 'id' || claims.aud !== options.userPoolClientId || claims.iss !== issuer) {
      throw new CognitoAuthError('the sign-in response was not issued for this console');
    }
    if (expectedNonce !== undefined && claims.nonce !== expectedNonce) {
      throw new CognitoAuthError('the sign-in response does not match this sign-in attempt');
    }
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') {
      throw new CognitoAuthError('malformed token');
    }
    return claims;
  }

  async function tokenRequest(params: Record<string, string>): Promise<{ id_token: string; refresh_token?: string }> {
    const res = await env.fetch(`${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: options.userPoolClientId, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; refresh_token?: string; error?: string };
    if (!res.ok || typeof body.id_token !== 'string') {
      throw new CognitoAuthError(`sign-in failed: ${body.error ?? `HTTP ${res.status}`}`);
    }
    return { id_token: body.id_token, refresh_token: body.refresh_token };
  }

  function store(idToken: string, refreshToken: string | undefined, nonce?: string): StoredTokens {
    const claims = claimsOf(idToken, nonce);
    const tokens: StoredTokens = { idToken, refreshToken, expiresAt: claims.exp * 1000 };
    env.storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    return tokens;
  }

  async function refresh(current: StoredTokens): Promise<StoredTokens> {
    if (!current.refreshToken) throw new CognitoAuthError('your session has expired; sign in again');
    // Cognito does not rotate the refresh token by default; keep the one we have.
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
    return store(body.id_token, body.refresh_token ?? current.refreshToken);
  }

  function fresh(tokens: StoredTokens): boolean {
    return tokens.expiresAt - EXPIRY_MARGIN_MS > env.now();
  }

  async function currentTokens(): Promise<StoredTokens> {
    const tokens = readJson<StoredTokens>(env.storage, TOKENS_KEY);
    if (!tokens) throw new CognitoAuthError('you are signed out');
    if (fresh(tokens)) return tokens;
    refreshing ??= refresh(tokens).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function sessionFor(tokens: StoredTokens): AuthSession {
    const claims = claimsOf(tokens.idToken);
    const user: AuthUser = { id: claims.sub, email: claims.email ?? '', groups: claims['cognito:groups'] ?? [] };
    return {
      user,
      getToken: async () => (await currentTokens()).idToken,
      signOut: async () => {
        const stored = readJson<StoredTokens>(env.storage, TOKENS_KEY);
        env.storage.removeItem(TOKENS_KEY);
        if (stored?.refreshToken) {
          // Best effort: the hosted logout below also ends the managed-login session.
          await env.fetch(`${domain}/oauth2/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: options.userPoolClientId, token: stored.refreshToken }),
          }).catch(() => undefined);
        }
        const logout = new URLSearchParams({ client_id: options.userPoolClientId, logout_uri: `${env.location.origin}/` });
        env.redirect(`${domain}/logout?${logout}`);
      },
    };
  }

  async function completeSignIn(): Promise<AuthSession> {
    const params = new URLSearchParams(env.location.search);
    const pending = readJson<PendingSignIn>(env.storage, PENDING_KEY);
    env.storage.removeItem(PENDING_KEY);
    const error = params.get('error');
    if (error) throw new CognitoAuthError(`sign-in failed: ${params.get('error_description') ?? error}`);
    const code = params.get('code');
    if (!code || !pending || params.get('state') !== pending.state) {
      throw new CognitoAuthError('the sign-in response does not match this sign-in attempt; sign in again');
    }
    const body = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: pending.verifier,
    });
    const tokens = store(body.id_token, body.refresh_token, pending.nonce);
    env.replaceUrl(safeReturnPath(pending.returnTo));
    return sessionFor(tokens);
  }

  return {
    async restore() {
      if (env.location.pathname === CALLBACK_PATH) {
        try {
          return await completeSignIn();
        } catch (error) {
          env.replaceUrl('/');
          throw error;
        }
      }
      const stored = readJson<StoredTokens>(env.storage, TOKENS_KEY);
      if (!stored) return null;
      try {
        return sessionFor(await currentTokens());
      } catch {
        env.storage.removeItem(TOKENS_KEY);
        return null;
      }
    },

    async signIn() {
      const pending: PendingSignIn = {
        state: randomToken(env.crypto),
        nonce: randomToken(env.crypto),
        verifier: randomToken(env.crypto),
        returnTo: safeReturnPath(`${env.location.pathname}${env.location.search}${env.location.hash}`),
      };
      env.storage.setItem(PENDING_KEY, JSON.stringify(pending));
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: options.userPoolClientId,
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await pkceChallenge(env.crypto, pending.verifier),
        code_challenge_method: 'S256',
      });
      env.redirect(`${domain}/oauth2/authorize?${query}`);
      // The page is navigating away; never settle so the UI stays in its loading state.
      return new Promise<never>(() => undefined);
    },
  };
}

function browserEnvironment(): CognitoAuthEnvironment {
  return {
    storage: window.sessionStorage,
    fetch: (...args) => window.fetch(...args),
    crypto: window.crypto,
    location: window.location,
    redirect: (url) => window.location.assign(url),
    replaceUrl: (path) => window.history.replaceState(null, '', path),
    now: () => Date.now(),
  };
}
