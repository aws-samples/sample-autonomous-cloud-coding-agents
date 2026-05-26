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

import { CliError } from '../src/errors';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  generatePkce,
  isAccessTokenExpiring,
  LINEAR_AUTHORIZE_ENDPOINT,
  LINEAR_OAUTH_SCOPES,
  LINEAR_TOKEN_ENDPOINT,
  linearOauthSecretName,
  refreshAccessToken,
} from '../src/linear-oauth';

describe('linearOauthSecretName', () => {
  test('prefixes with bgagent-linear-oauth-', () => {
    expect(linearOauthSecretName('acme')).toBe('bgagent-linear-oauth-acme');
    expect(linearOauthSecretName('acme-corp')).toBe('bgagent-linear-oauth-acme-corp');
  });
});

describe('LINEAR_OAUTH_SCOPES', () => {
  test('matches the actor=app-compatible scope set verified in the spike', () => {
    // Locked: removing app:assignable / app:mentionable breaks the Agent install
    // (verified 2026-05-18); adding `admin` breaks actor=app entirely.
    expect(LINEAR_OAUTH_SCOPES).toEqual(['read', 'write', 'app:assignable', 'app:mentionable']);
  });
});

describe('generatePkce', () => {
  test('produces base64url-encoded verifier and SHA-256 challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url-encoded SHA-256 = 43 chars (256 bits / 6 bits per char, no padding)
    expect(codeChallenge.length).toBe(43);
  });

  test('generates fresh values on each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  test('challenge is deterministic from the verifier', async () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    // Replay the verifier through SHA-256 and base64url-encode — must match.
    const { createHash } = await import('crypto');
    const expected = createHash('sha256').update(codeVerifier).digest().toString('base64url');
    expect(codeChallenge).toBe(expected);
  });
});

describe('buildAuthorizationUrl', () => {
  test('includes all required OAuth + PKCE params and actor=app by default', () => {
    const url = buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://localhost:8443/oauth/callback',
      state: 'state-uuid',
      codeChallenge: 'challenge-base64url',
    });
    expect(url.startsWith(LINEAR_AUTHORIZE_ENDPOINT)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://localhost:8443/oauth/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe('state-uuid');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-base64url');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('actor')).toBe('app');
    // Space-separated per RFC 6749 §3.3. Comma-separated triggers Linear's
    // misleading "Invalid redirect_uri" — caught during smoke test 2026-05-19.
    expect(parsed.searchParams.get('scope')).toBe('read write app:assignable app:mentionable');
  });

  test('actorApp:false drops the actor param entirely (regression OAuth fallback)', () => {
    const url = buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://localhost:8443/oauth/callback',
      state: 'state-uuid',
      codeChallenge: 'challenge',
      actorApp: false,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('actor')).toBe(false);
  });
});

describe('isAccessTokenExpiring', () => {
  test('returns false for a token expiring well in the future', () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    expect(isAccessTokenExpiring(future)).toBe(false);
  });

  test('returns true within the 60s threshold', () => {
    const soon = new Date(Date.now() + 30 * 1000).toISOString();
    expect(isAccessTokenExpiring(soon)).toBe(true);
  });

  test('returns true for a past expiry', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isAccessTokenExpiring(past)).toBe(true);
  });

  test('returns true for a malformed expires_at (defensive: prefer over-refresh)', () => {
    expect(isAccessTokenExpiring('not a date')).toBe(true);
  });

  test('respects custom threshold', () => {
    const fiveMinutesOut = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(isAccessTokenExpiring(fiveMinutesOut, 10)).toBe(false);
    expect(isAccessTokenExpiring(fiveMinutesOut, 600)).toBe(true);
  });
});

describe('computeExpiresAt', () => {
  test('adds expires_in seconds to the given now', () => {
    const now = new Date('2026-05-19T12:00:00.000Z');
    expect(computeExpiresAt(86400, now)).toBe('2026-05-20T12:00:00.000Z');
  });
});

// ─── Token endpoint round-trip tests ────────────────────────────────────────

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('exchangeAuthorizationCode', () => {
  test('happy path: parses Linear`s RFC-shaped response', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(200, {
      access_token: 'lin_oauth_aaaaaa',
      token_type: 'Bearer',
      expires_in: 86399,
      refresh_token: 'lin_refresh_bbbbbb',
      scope: 'read write app:assignable app:mentionable',
    }));

    const result = await exchangeAuthorizationCode({
      code: 'authcode',
      codeVerifier: 'verifier',
      redirectUri: 'https://localhost:8443/oauth/callback',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.access_token).toBe('lin_oauth_aaaaaa');
    expect(result.refresh_token).toBe('lin_refresh_bbbbbb');
    expect(result.expires_in).toBe(86399);
    expect(result.scope).toBe('read write app:assignable app:mentionable');

    // Verify the wire body is exactly what Linear expects (RFC 6749 §4.1.3).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(LINEAR_TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const sent = new URLSearchParams(init.body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('authcode');
    expect(sent.get('code_verifier')).toBe('verifier');
    expect(sent.get('redirect_uri')).toBe('https://localhost:8443/oauth/callback');
    expect(sent.get('client_id')).toBe('cid');
    expect(sent.get('client_secret')).toBe('csec');
  });

  test('translates Linear OAuth error responses to CliError with description', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(400, {
      error: 'invalid_grant',
      error_description: 'authorization code has already been used',
    }));

    await expect(exchangeAuthorizationCode({
      code: 'authcode',
      codeVerifier: 'verifier',
      redirectUri: 'https://localhost:8443/oauth/callback',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/invalid_grant.*authorization code has already been used/);
  });

  test('rejects responses missing access_token (unexpected Linear shape)', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(200, {
      not_a_token: 'oops',
    }));

    await expect(exchangeAuthorizationCode({
      code: 'authcode',
      codeVerifier: 'verifier',
      redirectUri: 'https://localhost:8443/oauth/callback',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/unexpected shape/);
  });

  test('rejects non-JSON responses (Linear maintenance / proxy intercepts)', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);

    await expect(exchangeAuthorizationCode({
      code: 'authcode',
      codeVerifier: 'verifier',
      redirectUri: 'https://localhost:8443/oauth/callback',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/non-JSON.*HTTP 502/);
  });
});

describe('refreshAccessToken', () => {
  test('happy path: posts refresh_token grant and returns new tokens', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(200, {
      access_token: 'lin_oauth_new',
      token_type: 'Bearer',
      expires_in: 86399,
      refresh_token: 'lin_refresh_rotated',
      scope: 'read write app:assignable app:mentionable',
    }));

    const result = await refreshAccessToken({
      refreshToken: 'lin_refresh_old',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.access_token).toBe('lin_oauth_new');
    expect(result.refresh_token).toBe('lin_refresh_rotated');

    const [, init] = fetchImpl.mock.calls[0];
    const sent = new URLSearchParams(init.body);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('lin_refresh_old');
    // refresh grant does NOT send code/code_verifier/redirect_uri
    expect(sent.get('code')).toBeNull();
    expect(sent.get('redirect_uri')).toBeNull();
  });

  test('translates revoked-refresh-token error to CliError', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(400, {
      error: 'invalid_grant',
      error_description: 'refresh token was revoked',
    }));

    await expect(refreshAccessToken({
      refreshToken: 'lin_refresh_revoked',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(CliError);
  });
});
