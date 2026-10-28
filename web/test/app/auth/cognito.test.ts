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

import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CALLBACK_PATH,
  createCognitoAuthAdapter,
  decodeJwtPayload,
  type CognitoAuthEnvironment,
} from '../../../src/app/providers/auth/cognito';

const OPTIONS = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_Pool',
  userPoolClientId: 'client-123',
  domain: 'https://abca.auth.us-east-1.amazoncognito.com/',
};
const DOMAIN = 'https://abca.auth.us-east-1.amazoncognito.com';
const ORIGIN = 'https://d111.cloudfront.net';
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

function idToken(overrides: Record<string, unknown> = {}): string {
  return jwt({
    sub: 'user-1',
    email: 'op@example.com',
    'cognito:groups': ['operators'],
    aud: OPTIONS.userPoolClientId,
    iss: `https://cognito-idp.us-east-1.amazonaws.com/${OPTIONS.userPoolId}`,
    token_use: 'id',
    exp: NOW / 1000 + 3600,
    ...overrides,
  });
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function environment(path = '/', search = '') {
  const storage = new Map<string, string>();
  const env = {
    storage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as unknown as Storage,
    fetch: vi.fn<typeof fetch>(),
    crypto: webcrypto as unknown as Crypto,
    location: { origin: ORIGIN, pathname: path, search, hash: '' },
    redirect: vi.fn<(url: string) => void>(),
    replaceUrl: vi.fn<(path: string) => void>(),
    now: vi.fn(() => NOW),
  } satisfies CognitoAuthEnvironment;
  return { env, storage };
}

/** Runs signIn and returns the authorize URL it redirected to. */
async function startSignIn(env: CognitoAuthEnvironment): Promise<URL> {
  void createCognitoAuthAdapter(OPTIONS, env).signIn();
  await vi.waitFor(() => expect(env.redirect).toHaveBeenCalled());
  return new URL(vi.mocked(env.redirect).mock.calls[0][0]);
}

describe('createCognitoAuthAdapter', () => {
  it('is signed out when nothing is stored', async () => {
    const { env } = environment();
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).resolves.toBeNull();
  });

  it('redirects to managed login with PKCE S256, state and nonce', async () => {
    const { env, storage } = environment('/tasks/abc', '?tab=events');
    const url = await startSignIn(env);

    expect(`${url.origin}${url.pathname}`).toBe(`${DOMAIN}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: `${ORIGIN}${CALLBACK_PATH}`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    const pending = JSON.parse(storage.get('abca-console-pending-sign-in')!);
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('nonce')).toBe(pending.nonce);
    expect(pending.returnTo).toBe('/tasks/abc?tab=events');
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier));
    expect(url.searchParams.get('code_challenge')).toBe(Buffer.from(digest).toString('base64url'));
  });

  it('exchanges the code on the callback and returns to the original page', async () => {
    const first = environment('/tasks/abc');
    const authorize = await startSignIn(first.env);
    const pending = JSON.parse(first.storage.get('abca-console-pending-sign-in')!);

    const { env, storage } = environment(CALLBACK_PATH, `?code=the-code&state=${authorize.searchParams.get('state')}`);
    storage.set('abca-console-pending-sign-in', JSON.stringify(pending));
    env.fetch.mockResolvedValueOnce(tokenResponse({ id_token: idToken({ nonce: pending.nonce }), refresh_token: 'refresh-1' }));

    const session = await createCognitoAuthAdapter(OPTIONS, env).restore();

    expect(session?.user).toEqual({ id: 'user-1', email: 'op@example.com', groups: ['operators'] });
    const [url, init] = env.fetch.mock.calls[0];
    expect(url).toBe(`${DOMAIN}/oauth2/token`);
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
      client_id: 'client-123',
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: `${ORIGIN}${CALLBACK_PATH}`,
      code_verifier: pending.verifier,
    });
    expect(env.replaceUrl).toHaveBeenCalledWith('/tasks/abc');
    expect(storage.has('abca-console-pending-sign-in')).toBe(false);
    await expect(session!.getToken()).resolves.toBe(idToken({ nonce: pending.nonce }));
  });

  it('completes the callback once when restore runs twice (React StrictMode)', async () => {
    const { env, storage } = environment(CALLBACK_PATH, '?code=c&state=s');
    storage.set('abca-console-pending-sign-in', JSON.stringify({ state: 's', nonce: 'n', verifier: 'v', returnTo: '/tasks' }));
    env.fetch.mockResolvedValueOnce(tokenResponse({ id_token: idToken({ nonce: 'n' }), refresh_token: 'r' }));
    const adapter = createCognitoAuthAdapter(OPTIONS, env);
    const [first, second] = await Promise.all([adapter.restore(), adapter.restore()]);
    expect(first?.user.id).toBe('user-1');
    expect(second).toBe(first);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(env.replaceUrl).toHaveBeenCalledWith('/tasks');
  });

  it('rejects a callback whose state does not match', async () => {
    const { env, storage } = environment(CALLBACK_PATH, '?code=c&state=forged');
    storage.set('abca-console-pending-sign-in', JSON.stringify({ state: 'real', nonce: 'n', verifier: 'v', returnTo: '/' }));
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).rejects.toThrow(/does not match/);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.replaceUrl).toHaveBeenCalledWith('/');
  });

  it('rejects a callback without a pending sign-in', async () => {
    const { env } = environment(CALLBACK_PATH, '?code=c&state=s');
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).rejects.toThrow(/does not match/);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('rejects an ID token with the wrong nonce', async () => {
    const { env, storage } = environment(CALLBACK_PATH, '?code=c&state=s');
    storage.set('abca-console-pending-sign-in', JSON.stringify({ state: 's', nonce: 'expected', verifier: 'v', returnTo: '/' }));
    env.fetch.mockResolvedValueOnce(tokenResponse({ id_token: idToken({ nonce: 'other' }) }));
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).rejects.toThrow(/does not match/);
    expect(storage.has('abca-console-tokens')).toBe(false);
  });

  it.each([
    ['another client', { aud: 'someone-else' }],
    ['another pool', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other' }],
    ['an access token', { token_use: 'access' }],
  ])('rejects an ID token issued for %s', async (_label, overrides) => {
    const { env, storage } = environment(CALLBACK_PATH, '?code=c&state=s');
    storage.set('abca-console-pending-sign-in', JSON.stringify({ state: 's', nonce: 'n', verifier: 'v', returnTo: '/' }));
    env.fetch.mockResolvedValueOnce(tokenResponse({ id_token: idToken({ nonce: 'n', ...overrides }) }));
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).rejects.toThrow(/not issued for this console/);
  });

  it('surfaces an error returned by managed login', async () => {
    const { env } = environment(CALLBACK_PATH, '?error=access_denied&error_description=User+is+disabled');
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).rejects.toThrow('sign-in failed: User is disabled');
  });

  it('surfaces a failed code exchange', async () => {
    const { env, storage } = environment(CALLBACK_PATH, '?code=c&state=s');
    storage.set('abca-console-pending-sign-in', JSON.stringify({ state: 's', nonce: 'n', verifier: 'v', returnTo: '/' }));
    env.fetch.mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, 400));
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).rejects.toThrow('sign-in failed: invalid_grant');
  });

  it('never returns to another origin after sign-in', async () => {
    const { env, storage } = environment(CALLBACK_PATH, '?code=c&state=s');
    storage.set('abca-console-pending-sign-in', JSON.stringify({ state: 's', nonce: 'n', verifier: 'v', returnTo: '//evil.example' }));
    env.fetch.mockResolvedValueOnce(tokenResponse({ id_token: idToken({ nonce: 'n' }) }));
    await createCognitoAuthAdapter(OPTIONS, env).restore();
    expect(env.replaceUrl).toHaveBeenCalledWith('/');
  });

  it('restores a stored session and refreshes the ID token near expiry, once for concurrent callers', async () => {
    const { env, storage } = environment();
    storage.set('abca-console-tokens', JSON.stringify({ idToken: idToken(), refreshToken: 'refresh-1', expiresAt: NOW + 3_600_000 }));
    const session = await createCognitoAuthAdapter(OPTIONS, env).restore();
    expect(session?.user.id).toBe('user-1');
    expect(env.fetch).not.toHaveBeenCalled();

    env.now.mockReturnValue(NOW + 3_590_000);
    const renewed = idToken({ exp: NOW / 1000 + 7200 });
    env.fetch.mockResolvedValueOnce(tokenResponse({ id_token: renewed }));
    await expect(Promise.all([session!.getToken(), session!.getToken()])).resolves.toEqual([renewed, renewed]);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(env.fetch.mock.calls[0][1]!.body as URLSearchParams)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
    expect(JSON.parse(storage.get('abca-console-tokens')!).refreshToken).toBe('refresh-1');
  });

  it('treats an expired session that cannot refresh as signed out', async () => {
    const { env, storage } = environment();
    storage.set('abca-console-tokens', JSON.stringify({ idToken: idToken(), refreshToken: 'r', expiresAt: NOW - 1 }));
    env.fetch.mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, 400));
    await expect(createCognitoAuthAdapter(OPTIONS, env).restore()).resolves.toBeNull();
    expect(storage.has('abca-console-tokens')).toBe(false);
  });

  it('signs out: clears tokens, revokes the refresh token, ends the managed-login session', async () => {
    const { env, storage } = environment();
    storage.set('abca-console-tokens', JSON.stringify({ idToken: idToken(), refreshToken: 'refresh-1', expiresAt: NOW + 3_600_000 }));
    const session = await createCognitoAuthAdapter(OPTIONS, env).restore();
    env.fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await session!.signOut();

    expect(storage.has('abca-console-tokens')).toBe(false);
    expect(env.fetch.mock.calls[0][0]).toBe(`${DOMAIN}/oauth2/revoke`);
    const logout = new URL(env.redirect.mock.calls[0][0]);
    expect(`${logout.origin}${logout.pathname}`).toBe(`${DOMAIN}/logout`);
    expect(logout.searchParams.get('client_id')).toBe('client-123');
    expect(logout.searchParams.get('logout_uri')).toBe(`${ORIGIN}/`);
  });

  it('still signs out when revocation fails', async () => {
    const { env, storage } = environment();
    storage.set('abca-console-tokens', JSON.stringify({ idToken: idToken(), refreshToken: 'r', expiresAt: NOW + 3_600_000 }));
    const session = await createCognitoAuthAdapter(OPTIONS, env).restore();
    env.fetch.mockRejectedValueOnce(new TypeError('network down'));
    await session!.signOut();
    expect(env.redirect).toHaveBeenCalled();
  });
});

describe('decodeJwtPayload', () => {
  it('decodes base64url payloads with non-ASCII characters', () => {
    expect(decodeJwtPayload(jwt({ name: 'Zoë ✓' }))).toEqual({ name: 'Zoë ✓' });
  });

  it('rejects a malformed token', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow('malformed token');
  });
});
