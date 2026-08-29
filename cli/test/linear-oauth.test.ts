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
  readExistingOauthTokens,
  readExistingWebhookSecret,
  refreshAccessToken,
  resolveWebhookSecretAction,
  verifyLinearRefreshAndPersist,
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

  test('forceConsent adds prompt=consent so an already-installed app can RE-authorize', () => {
    // Without this, Linear short-circuits an installed app with "already
    // installed" and returns no authorization code — so `linear setup`, the
    // documented remedy for a revoked authorization, could not actually recover
    // one (live-caught 2026-07-25).
    const url = buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://localhost:8443/oauth/callback',
      state: 'state-uuid',
      codeChallenge: 'challenge',
      forceConsent: true,
    });
    expect(new URL(url).searchParams.get('prompt')).toBe('consent');
  });

  test('prompt is omitted unless asked, so the param set stays minimal by default', () => {
    const url = buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://localhost:8443/oauth/callback',
      state: 'state-uuid',
      codeChallenge: 'challenge',
    });
    expect(new URL(url).searchParams.has('prompt')).toBe(false);
  });

  test('forceConsent composes with actor=app — the combination the install path needs', () => {
    // The failing case is specifically an actor=app re-install, so both params
    // must survive together.
    const parsed = new URL(buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://localhost:8443/oauth/callback',
      state: 'state-uuid',
      codeChallenge: 'challenge',
      actorApp: true,
      forceConsent: true,
    }));
    expect(parsed.searchParams.get('actor')).toBe('app');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
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

describe('verifyLinearRefreshAndPersist', () => {
  // This is the only code that can settle "is this workspace's authorization
  // actually alive?", and it does so DESTRUCTIVELY: Linear rotates the refresh
  // token on every use, so an attempt that isn't persisted spends the stored
  // token and strands the workspace. Both halves are pinned here.

  const STORED = JSON.stringify({
    access_token: 'lin_old',
    refresh_token: 'lin_refresh_old',
    client_id: 'cid',
    client_secret: 'csec',
    expires_at: '2026-07-25T12:00:00.000Z',
    workspace_slug: 'acme',
  });

  const refreshOk = () => jest.fn().mockResolvedValueOnce(mockResponse(200, {
    access_token: 'lin_new',
    token_type: 'Bearer',
    expires_in: 86400,
    refresh_token: 'lin_refresh_rotated',
    scope: 'read write',
  }));

  test('a live grant is refreshed AND the rotated token is persisted', async () => {
    const writeSecret = jest.fn().mockResolvedValue(undefined);
    const result = await verifyLinearRefreshAndPersist({
      readSecret: async () => STORED,
      writeSecret,
      fetchImpl: refreshOk() as unknown as typeof fetch,
      now: new Date('2026-07-26T10:00:00.000Z'),
    });

    expect(result).toBe('refreshed');
    const saved = JSON.parse(writeSecret.mock.calls[0][0]);
    // The rotated refresh token is what makes the NEXT refresh possible; saving
    // the old one back would work once and then fail forever.
    expect(saved.refresh_token).toBe('lin_refresh_rotated');
    expect(saved.access_token).toBe('lin_new');
    expect(saved.expires_at).toBe('2026-07-27T10:00:00.000Z');
    // Fields it does not own are carried through untouched — the webhook secret
    // and client credentials live in this same bundle.
    expect(saved.client_secret).toBe('csec');
    expect(saved.workspace_slug).toBe('acme');
  });

  test('a rotation that could not be saved reports error, never health', async () => {
    // The token has already been spent at this point, so a green tick here would
    // hide a workspace this very check just broke.
    const result = await verifyLinearRefreshAndPersist({
      readSecret: async () => STORED,
      writeSecret: async () => { throw new Error('AccessDeniedException on PutSecretValue'); },
      fetchImpl: refreshOk() as unknown as typeof fetch,
    });
    expect(result).toBe('error');
  });

  test("only Linear's invalid_grant is read as revoked", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(mockResponse(400, {
      error: 'invalid_grant', error_description: 'refresh token was revoked',
    }));
    const result = await verifyLinearRefreshAndPersist({
      readSecret: async () => STORED,
      writeSecret: async () => { throw new Error('must not be called'); },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBe('rejected');
  });

  test('a 5xx or network failure is error — NOT revoked', async () => {
    // Reporting revoked here would send an operator to re-authorize a perfectly
    // healthy workspace because Linear had a bad minute.
    for (const failing of [
      jest.fn().mockResolvedValueOnce(mockResponse(503, { error: 'service_unavailable' })),
      jest.fn().mockRejectedValueOnce(new Error('ECONNRESET')),
    ]) {
      const result = await verifyLinearRefreshAndPersist({
        readSecret: async () => STORED,
        writeSecret: async () => { throw new Error('must not be called'); },
        fetchImpl: failing as unknown as typeof fetch,
      });
      expect(result).toBe('error');
    }
  });

  test('a bundle with no refresh token is rejected without any network call', async () => {
    // Nothing can renew this grant, which is a genuine dead end rather than an
    // inconclusive probe.
    const fetchImpl = jest.fn();
    const result = await verifyLinearRefreshAndPersist({
      readSecret: async () => JSON.stringify({ access_token: 'lin_old', client_id: 'cid', client_secret: 'csec' }),
      writeSecret: async () => { throw new Error('must not be called'); },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBe('rejected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an unreadable or malformed secret is error, and nothing is spent', async () => {
    const fetchImpl = jest.fn();
    for (const readSecret of [
      async () => { throw new Error('AccessDenied'); },
      async () => undefined,
      async () => 'not json',
    ]) {
      const result = await verifyLinearRefreshAndPersist({
        readSecret: readSecret as () => Promise<string | undefined>,
        writeSecret: async () => { throw new Error('must not be called'); },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result).toBe('error');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveWebhookSecretAction', () => {
  it('PRESERVES an existing per-workspace secret over the stack-wide one (multi-workspace re-run — the bug)', () => {
    // The regression: re-running `setup` on an already-installed workspace must
    // NOT overwrite its working signing secret with the stack-wide fallback
    // (which belongs to a different workspace once >1 is installed) — that
    // silently breaks signature verification (webhook 401 "Invalid signature").
    const action = resolveWebhookSecretAction('lin_wh_thisWorkspace', true);
    expect(action).toEqual({ kind: 'preserve', secret: 'lin_wh_thisWorkspace' });
  });

  it('preserves the existing secret even when no stack-wide secret is set', () => {
    expect(resolveWebhookSecretAction('lin_wh_existing', false)).toEqual({
      kind: 'preserve',
      secret: 'lin_wh_existing',
    });
  });

  it('mirrors the stack-wide secret when there is no per-workspace one yet (first workspace)', () => {
    expect(resolveWebhookSecretAction(undefined, true)).toEqual({ kind: 'mirror-stackwide' });
  });

  it('prompts when neither a per-workspace nor a stack-wide secret exists (first install)', () => {
    expect(resolveWebhookSecretAction(undefined, false)).toEqual({ kind: 'prompt' });
  });

  it('ignores a malformed existing secret (not lin_wh_) and falls through', () => {
    // A corrupt/empty value must not be "preserved" as if valid.
    expect(resolveWebhookSecretAction('garbage', true)).toEqual({ kind: 'mirror-stackwide' });
    expect(resolveWebhookSecretAction('', false)).toEqual({ kind: 'prompt' });
  });
});

describe('readExistingWebhookSecret — fail-closed pre-read (#612 review B1/B2)', () => {
  const notFound = (err: unknown) => (err as { name?: string }).name === 'ResourceNotFoundException';
  const bundle = (secret?: string) =>
    JSON.stringify({ access_token: 'a', webhook_signing_secret: secret });

  it('returns the existing lin_wh_ secret when the bundle has one (→ preserve, not clobber)', async () => {
    const got = await readExistingWebhookSecret(async () => bundle('lin_wh_thisWorkspace'), notFound);
    // This is the value that makes resolveWebhookSecretAction PRESERVE — the fix.
    expect(got).toBe('lin_wh_thisWorkspace');
    expect(resolveWebhookSecretAction(got, true)).toEqual({ kind: 'preserve', secret: 'lin_wh_thisWorkspace' });
  });

  it('returns undefined on ResourceNotFoundException (genuine first install)', async () => {
    const got = await readExistingWebhookSecret(async () => {
      throw Object.assign(new Error('no'), { name: 'ResourceNotFoundException' });
    }, notFound);
    expect(got).toBeUndefined();
  });

  it('returns undefined when the bundle exists but has no/malformed secret', async () => {
    expect(await readExistingWebhookSecret(async () => bundle(undefined), notFound)).toBeUndefined();
    expect(await readExistingWebhookSecret(async () => bundle('not-a-wh'), notFound)).toBeUndefined();
    expect(await readExistingWebhookSecret(async () => undefined, notFound)).toBeUndefined();
  });

  it('THROWS (fails closed) on AccessDenied — must NOT default to undefined and clobber', async () => {
    // The B1 bug: a bare catch here would return undefined → mirror-stackwide →
    // the #611 clobber, silently. The pre-read must surface the error instead.
    const accessDenied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    await expect(
      readExistingWebhookSecret(async () => { throw accessDenied; }, notFound),
    ).rejects.toBe(accessDenied);
  });

  it('THROWS on KMSAccessDeniedException / Throttling / network (any non-not-found)', async () => {
    for (const name of ['KMSAccessDeniedException', 'ThrottlingException', 'InternalServiceError']) {
      const err = Object.assign(new Error(name), { name });
      await expect(
        readExistingWebhookSecret(async () => { throw err; }, notFound),
      ).rejects.toBe(err);
    }
  });

  it('THROWS on a corrupt-but-present bundle (JSON.parse) — not silently "nothing to preserve"', async () => {
    await expect(
      readExistingWebhookSecret(async () => '{not valid json', notFound),
    ).rejects.toThrow();
  });
});

describe('readExistingOauthTokens — keeps the fallback real when moving to the vault', () => {
  // A fresh vault onboarding stores no Linear token, which is the point. But a
  // workspace MOVING onto the vault already has a working one, and writing empty
  // strings over it would destroy the only credential that still works if the vault
  // becomes unreachable — making the documented Secrets-Manager fallback a fiction.
  const notFound = (err: unknown) => (err as { name?: string }).name === 'ResourceNotFoundException';

  test('returns the token fields worth preserving', async () => {
    const got = await readExistingOauthTokens(async () => JSON.stringify({
      access_token: 'lin_oauth_a', refresh_token: 'lin_refresh_b',
      expires_at: '2026-09-01T00:00:00.000Z', scope: 'read write',
      webhook_signing_secret: 'lin_wh_zzz',
    }), notFound);
    expect(got).toEqual({
      access_token: 'lin_oauth_a', refresh_token: 'lin_refresh_b',
      expires_at: '2026-09-01T00:00:00.000Z', scope: 'read write',
    });
  });

  test('a bundle with NO refresh token has nothing worth preserving', async () => {
    // Without a refresh token the bundle cannot renew itself, so it is not a
    // fallback — carrying it forward would only look like one.
    const got = await readExistingOauthTokens(
      async () => JSON.stringify({ access_token: 'lin_oauth_a', webhook_signing_secret: 'lin_wh_z' }),
      notFound,
    );
    expect(got).toBeUndefined();
  });

  test('a genuine first install yields undefined, not an error', async () => {
    const got = await readExistingOauthTokens(async () => {
      throw Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' });
    }, notFound);
    expect(got).toBeUndefined();
  });

  test('any OTHER read failure throws — silently discarding a live token is worse', async () => {
    // AccessDenied/KMS/throttle must not be mistaken for "nothing to preserve".
    await expect(readExistingOauthTokens(async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    }, notFound)).rejects.toThrow(/denied/);
  });

  test('a corrupt bundle surfaces rather than being read as empty', async () => {
    await expect(readExistingOauthTokens(async () => '{not json', notFound)).rejects.toThrow();
  });

  test('an empty secret string yields undefined', async () => {
    expect(await readExistingOauthTokens(async () => '', notFound)).toBeUndefined();
  });
});
