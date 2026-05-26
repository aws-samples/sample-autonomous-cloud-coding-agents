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
  _resetCachesForTesting,
  invalidateLinearOauthCache,
  isTokenExpiring,
  resolveLinearOauthToken,
  type StoredOauthToken,
} from '../../../src/handlers/shared/linear-oauth-resolver';

const REGISTRY_TABLE = 'TestLinearWorkspaceRegistry';

function makeStoredToken(overrides: Partial<StoredOauthToken> = {}): StoredOauthToken {
  const now = new Date();
  const future = new Date(now.getTime() + 12 * 3600 * 1000);
  return {
    access_token: 'lin_oauth_default',
    refresh_token: 'lin_refresh_default',
    expires_at: future.toISOString(),
    scope: 'read write app:assignable app:mentionable',
    client_id: 'cid',
    client_secret: 'csec',
    workspace_id: 'ws-uuid-1',
    workspace_slug: 'acme',
    installed_at: now.toISOString(),
    updated_at: now.toISOString(),
    installed_by_platform_user_id: 'cog-sub',
    ...overrides,
  };
}

function makeFakeClients(opts: {
  registryItem?: Partial<{
    linear_workspace_id: string;
    workspace_slug: string;
    oauth_secret_arn: string;
    status: string;
  }> | null;
  storedToken?: StoredOauthToken | null;
  putSecretValueShouldFail?: boolean;
}) {
  const ddbSend = jest.fn().mockImplementation(() => ({
    Item: opts.registryItem === null ? undefined : opts.registryItem,
  }));
  const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (name === 'GetSecretValueCommand') {
      if (opts.storedToken === null) return { SecretString: undefined };
      return { SecretString: JSON.stringify(opts.storedToken) };
    }
    if (name === 'PutSecretValueCommand') {
      if (opts.putSecretValueShouldFail) {
        throw new Error('synthetic put failure');
      }
      return {};
    }
    return {};
  });
  type Opts = NonNullable<Parameters<typeof resolveLinearOauthToken>[2]>;
  return {
    dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
    secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
    ddbSend,
    smSend,
  };
}

describe('isTokenExpiring', () => {
  test('returns false for a future expiry well past the threshold', () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    expect(isTokenExpiring(future)).toBe(false);
  });

  test('returns true within the 60s threshold', () => {
    const soon = new Date(Date.now() + 30 * 1000).toISOString();
    expect(isTokenExpiring(soon)).toBe(true);
  });

  test('returns true for a past expiry', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isTokenExpiring(past)).toBe(true);
  });

  test('returns true for malformed timestamps (defensive)', () => {
    expect(isTokenExpiring('not a date')).toBe(true);
  });
});

describe('resolveLinearOauthToken', () => {
  beforeEach(() => {
    _resetCachesForTesting();
  });

  test('happy path: returns access token + workspace slug + secret arn', async () => {
    const stored = makeStoredToken({ access_token: 'lin_oauth_happy' });
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);

    expect(result).toEqual({
      accessToken: 'lin_oauth_happy',
      scope: stored.scope,
      workspaceSlug: 'acme',
      oauthSecretArn: 'arn:secret:acme',
    });
  });

  test('returns null when workspace is not in the registry', async () => {
    const clients = makeFakeClients({ registryItem: null });
    const result = await resolveLinearOauthToken('ws-not-installed', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('returns null when registry status is not active', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'revoked',
      },
      storedToken: makeStoredToken(),
    });
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('returns null when secret JSON is missing required fields', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      // Cast: the test deliberately writes a malformed token to assert the
      // resolver guards against it.
      storedToken: { access_token: 'partial' } as unknown as StoredOauthToken,
    });
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('refreshes token via Linear /oauth/token when expiring', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stored = makeStoredToken({
      access_token: 'lin_oauth_old',
      refresh_token: 'rt-old',
      expires_at: expiringSoon,
    });
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'lin_oauth_new',
        token_type: 'Bearer',
        expires_in: 86399,
        refresh_token: 'rt-new',
        scope: 'read write app:assignable app:mentionable',
      }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.accessToken).toBe('lin_oauth_new');
    // Refresh body must include client_id+client_secret from the secret JSON.
    const sentBody = fetchImpl.mock.calls[0][1]!.body as string;
    const sent = new URLSearchParams(sentBody);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('rt-old');
    expect(sent.get('client_id')).toBe('cid');
    expect(sent.get('client_secret')).toBe('csec');
    // PutSecretValue should have persisted the rotated token.
    const putCalls = clients.smSend.mock.calls.filter(
      (c) => c[0]!.constructor.name === 'PutSecretValueCommand',
    );
    expect(putCalls).toHaveLength(1);
  });

  test('returns null when refresh request fails', async () => {
    const stored = makeStoredToken({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'refresh token revoked',
      }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });

  test('invalidateLinearOauthCache clears the cache', async () => {
    const stored = makeStoredToken();
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    // Second call hits the cache, doesn't re-query DDB.
    await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    const ddbCallsBeforeInvalidate = clients.ddbSend.mock.calls.length;
    expect(ddbCallsBeforeInvalidate).toBe(1);

    invalidateLinearOauthCache('ws-uuid-1', 'arn:secret:acme');
    await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(clients.ddbSend.mock.calls.length).toBe(2);
  });

  test('concurrent-refresh recovery: re-read finds rotated token, skip second /oauth/token POST', async () => {
    // Setup: stored token is expiring (10s from now). First /oauth/token
    // call returns 400 invalid_grant (a concurrent caller already
    // rotated). Re-read of SM finds the rotated, future-dated token.
    // Resolver should return the freshly-read access_token without
    // a second refresh POST.
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const wellInFuture = new Date(Date.now() + 12 * 3600 * 1000).toISOString();

    const stale = makeStoredToken({
      access_token: 'lin_stale',
      refresh_token: 'rt-stale',
      expires_at: expiringSoon,
    });
    const rotated = makeStoredToken({
      access_token: 'lin_concurrent_winner',
      refresh_token: 'rt-rotated-by-other-lambda',
      expires_at: wellInFuture,
    });

    // First GetSecretValue returns stale; second returns rotated.
    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetSecretValueCommand') {
        const callIdx = smSend.mock.calls.filter((c) => c[0].constructor.name === 'GetSecretValueCommand').length - 1;
        return { SecretString: JSON.stringify(callIdx === 0 ? stale : rotated) };
      }
      return {};
    });
    const ddbSend = jest.fn().mockImplementation(() => ({
      Item: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
    }));

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'token rotated' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveLinearOauthToken>[2]>;
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.accessToken).toBe('lin_concurrent_winner');
    // Exactly ONE /oauth/token POST — no second refresh call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Two GetSecretValue calls (initial + re-read).
    const getSecretCalls = smSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'GetSecretValueCommand',
    );
    expect(getSecretCalls).toHaveLength(2);
  });

  test('concurrent-refresh: invalid_grant with same refresh_token on re-read returns null (permanent rejection)', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const sameStale = makeStoredToken({
      access_token: 'lin_stale',
      refresh_token: 'rt-shared',
      expires_at: expiringSoon,
    });

    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetSecretValueCommand') {
        return { SecretString: JSON.stringify(sameStale) };
      }
      return {};
    });
    const ddbSend = jest.fn().mockImplementation(() => ({
      Item: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
    }));

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveLinearOauthToken>[2]>;
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    // No second /oauth/token POST — once we know the refresh_token
    // is permanently rejected, we don't retry against the same token.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('cache invalidation on network failure: next call re-reads SM instead of looping on stale token', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stale = makeStoredToken({ expires_at: expiringSoon });
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stale,
    });

    // First refresh: fetch throws (network failure).
    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET'));

    const first = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(first).toBeNull();

    // After the failure the cache should be invalidated. Verify by
    // checking the second call goes back to SM (not a cached stale
    // token). We use a fresh fetchImpl on the retry so it can succeed.
    const fetchImpl2 = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'lin_after_retry',
        refresh_token: 'rt-new',
        expires_in: 86400,
      }),
    });

    const second = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl2 as unknown as typeof fetch,
    });
    expect(second?.accessToken).toBe('lin_after_retry');
    // The second call had to re-fetch from SM (token cache was cleared
    // by the previous failure). Counting GetSecretValueCommand calls:
    // first call = 1, second call after invalidation = 1 more = 2 total.
    const getSecretCalls = clients.smSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'GetSecretValueCommand',
    );
    expect(getSecretCalls.length).toBeGreaterThanOrEqual(2);
  });
});
