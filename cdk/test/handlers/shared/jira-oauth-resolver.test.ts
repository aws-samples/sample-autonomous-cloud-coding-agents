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
  getOauthSecret,
  getOauthSecretStrict,
  getRegistryRow,
  getRegistryRowStrict,
  invalidateJiraOauthCache,
  isTokenExpiring,
  resolveJiraOauthToken,
  type StoredOauthToken,
} from '../../../src/handlers/shared/jira-oauth-resolver';

const REGISTRY_TABLE = 'TestJiraWorkspaceRegistry';

function makeStoredToken(overrides: Partial<StoredOauthToken> = {}): StoredOauthToken {
  const now = new Date();
  const future = new Date(now.getTime() + 12 * 3600 * 1000);
  return {
    access_token: 'jira_oauth_default',
    refresh_token: 'jira_refresh_default',
    expires_at: future.toISOString(),
    scope: 'read:jira-work write:jira-work offline_access',
    client_id: 'cid',
    client_secret: 'csec',
    cloud_id: 'cloud-uuid-1',
    site_url: 'https://acme.atlassian.net',
    installed_at: now.toISOString(),
    updated_at: now.toISOString(),
    installed_by_platform_user_id: 'cog-sub',
    ...overrides,
  };
}

function makeFakeClients(opts: {
  registryItem?: Partial<{
    jira_cloud_id: string;
    site_url: string;
    oauth_secret_arn: string;
    status: string;
  }> | null;
  storedToken?: StoredOauthToken | null;
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
      return {};
    }
    return {};
  });
  type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
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

describe('resolveJiraOauthToken', () => {
  beforeEach(() => {
    _resetCachesForTesting();
  });

  test('happy path: returns access token + site url + secret arn', async () => {
    const stored = makeStoredToken({ access_token: 'jira_oauth_happy' });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);

    expect(result).toEqual({
      accessToken: 'jira_oauth_happy',
      scope: stored.scope,
      siteUrl: 'https://acme.atlassian.net',
      oauthSecretArn: 'arn:secret:acme',
    });
  });

  test('returns null when tenant is not in the registry', async () => {
    const clients = makeFakeClients({ registryItem: null });
    const result = await resolveJiraOauthToken('cloud-not-installed', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('returns null when registry status is not active', async () => {
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'revoked',
      },
      storedToken: makeStoredToken(),
    });
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('returns null when secret JSON is missing required fields', async () => {
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      // Cast: the test deliberately writes a malformed token to assert the
      // resolver guards against it.
      storedToken: { access_token: 'partial' } as unknown as StoredOauthToken,
    });
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('returns null when secret string is absent', async () => {
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: null,
    });
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
  });

  test('refreshes token via Atlassian /oauth/token when expiring (JSON body)', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stored = makeStoredToken({
      access_token: 'jira_oauth_old',
      refresh_token: 'rt-old',
      expires_at: expiringSoon,
    });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'jira_oauth_new',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-new',
        scope: 'read:jira-work write:jira-work offline_access',
      }),
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.accessToken).toBe('jira_oauth_new');
    // Atlassian expects a JSON body (NOT form-encoded — the one shape
    // difference from Linear). It must carry client creds + refresh_token.
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe('https://auth.atlassian.com/oauth/token');
    expect(call[1]!.headers['Content-Type']).toBe('application/json');
    const sent = JSON.parse(call[1]!.body as string);
    expect(sent.grant_type).toBe('refresh_token');
    expect(sent.refresh_token).toBe('rt-old');
    expect(sent.client_id).toBe('cid');
    expect(sent.client_secret).toBe('csec');
    // PutSecretValue should have persisted the rotated token.
    const putCalls = clients.smSend.mock.calls.filter(
      (c) => c[0]!.constructor.name === 'PutSecretValueCommand',
    );
    expect(putCalls).toHaveLength(1);
  });

  test('returns null when refresh request fails (invalid_grant, same token)', async () => {
    const stored = makeStoredToken({
      refresh_token: 'rt-shared',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
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

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });

  test('returns null when refresh response is missing access_token', async () => {
    const stored = makeStoredToken({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token_type: 'Bearer' }),
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  test('returns null when refresh returns non-JSON', async () => {
    const stored = makeStoredToken({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  test('returns null when stored token is missing client credentials (cannot refresh)', async () => {
    const stored = {
      ...makeStoredToken({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      client_id: '',
      client_secret: '',
    } as StoredOauthToken;
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });
    const fetchImpl = jest.fn();
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // parseOauthSecret already rejects empty required fields, so the
    // resolver returns null before refresh; either way no POST happens.
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('invalidateJiraOauthCache clears the cache', async () => {
    const stored = makeStoredToken();
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    // Second call hits the cache, doesn't re-query DDB.
    await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    const ddbCallsBeforeInvalidate = clients.ddbSend.mock.calls.length;
    expect(ddbCallsBeforeInvalidate).toBe(1);

    invalidateJiraOauthCache('cloud-uuid-1', 'arn:secret:acme');
    await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    expect(clients.ddbSend.mock.calls.length).toBe(2);
  });

  test('concurrent-refresh recovery: re-read finds rotated token, skip second /oauth/token POST', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const wellInFuture = new Date(Date.now() + 12 * 3600 * 1000).toISOString();

    const stale = makeStoredToken({
      access_token: 'jira_stale',
      refresh_token: 'rt-stale',
      expires_at: expiringSoon,
    });
    const rotated = makeStoredToken({
      access_token: 'jira_concurrent_winner',
      refresh_token: 'rt-rotated-by-other-lambda',
      expires_at: wellInFuture,
    });

    // First GetSecretValue returns stale; second returns rotated.
    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetSecretValueCommand') {
        const callIdx =
          smSend.mock.calls.filter((c) => c[0].constructor.name === 'GetSecretValueCommand').length - 1;
        return { SecretString: JSON.stringify(callIdx === 0 ? stale : rotated) };
      }
      return {};
    });
    const ddbSend = jest.fn().mockImplementation(() => ({
      Item: { site_url: 'https://acme.atlassian.net', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
    }));

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'token rotated' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.accessToken).toBe('jira_concurrent_winner');
    // Exactly ONE /oauth/token POST — no second refresh call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const getSecretCalls = smSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'GetSecretValueCommand',
    );
    expect(getSecretCalls).toHaveLength(2);
  });

  test('concurrent-refresh: invalid_grant with same refresh_token on re-read returns null', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const sameStale = makeStoredToken({
      access_token: 'jira_stale',
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
      Item: { site_url: 'https://acme.atlassian.net', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
    }));

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    // No second /oauth/token POST once the refresh_token is permanently rejected.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('refresh rejected with a non-invalid_grant error returns null (no re-read retry)', async () => {
    const stored = makeStoredToken({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    // A server_error (not invalid_grant) is a hard failure — the resolver
    // must NOT attempt the concurrent-refresh re-read path.
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'server_error' }),
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('refresh succeeds even when PutSecretValue persistence fails (non-fatal)', async () => {
    const stored = makeStoredToken({ expires_at: new Date(Date.now() + 10 * 1000).toISOString() });
    const ddbSend = jest.fn().mockImplementation(() => ({
      Item: { site_url: 'https://acme.atlassian.net', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
    }));
    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetSecretValueCommand') return { SecretString: JSON.stringify(stored) };
      if (name === 'PutSecretValueCommand') throw new Error('synthetic put failure');
      return {};
    });

    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'jira_persist_fail_ok', refresh_token: 'rt-new', expires_in: 3600 }),
    });

    type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Persistence failure is logged but does not fail the resolve — the
    // freshly-minted access token is still returned for this invocation.
    expect(result?.accessToken).toBe('jira_persist_fail_ok');
  });

  test('invalid_grant then re-read returns unreadable secret yields null', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stale = makeStoredToken({ refresh_token: 'rt-old', expires_at: expiringSoon });

    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetSecretValueCommand') {
        const idx =
          smSend.mock.calls.filter((c) => c[0].constructor.name === 'GetSecretValueCommand').length - 1;
        // First read: stale token. Second (re-read after invalid_grant):
        // secret has gone missing → null.
        return { SecretString: idx === 0 ? JSON.stringify(stale) : undefined };
      }
      return {};
    });
    const ddbSend = jest.fn().mockImplementation(() => ({
      Item: { site_url: 'https://acme.atlassian.net', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
    }));
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  test('refresh fetch network failure returns null and invalidates cache', async () => {
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stale = makeStoredToken({ expires_at: expiringSoon });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stale,
    });

    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET'));

    const first = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(first).toBeNull();

    // After the failure the cache should be invalidated — the second call
    // re-reads SM rather than looping on the stale cached token.
    const fetchImpl2 = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'jira_after_retry',
        refresh_token: 'rt-new',
        expires_in: 3600,
      }),
    });

    const second = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl2 as unknown as typeof fetch,
    });
    expect(second?.accessToken).toBe('jira_after_retry');
    const getSecretCalls = clients.smSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'GetSecretValueCommand',
    );
    expect(getSecretCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveJiraOauthToken: forceRefresh (reactive-401 path, issue #370)', () => {
  beforeEach(() => {
    _resetCachesForTesting();
  });

  test('refreshes even when the stored token is NOT expiring', async () => {
    // Token is valid for 12h (makeStoredToken default) — the proactive check
    // would never refresh it. forceRefresh must refresh anyway.
    const stored = makeStoredToken({
      access_token: 'jira_oauth_valid',
      refresh_token: 'rt-old',
    });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'jira_oauth_forced',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-new',
      }),
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      forceRefresh: true,
    });

    expect(result?.accessToken).toBe('jira_oauth_forced');
    // A refresh actually happened (one /oauth/token POST + one persist).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const putCalls = clients.smSend.mock.calls.filter(
      (c) => c[0]!.constructor.name === 'PutSecretValueCommand',
    );
    expect(putCalls).toHaveLength(1);
  });

  test('bypasses the in-memory token cache', async () => {
    const stored = makeStoredToken({ access_token: 'cached_token', refresh_token: 'rt-old' });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });

    // Prime the cache with a normal (non-forced) resolve — no refresh, token valid.
    const first = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, clients);
    expect(first?.accessToken).toBe('cached_token');

    // Now force-refresh: must NOT return the cached token; must mint a new one.
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'minted_token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-new',
      }),
    });
    const second = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      forceRefresh: true,
    });
    expect(second?.accessToken).toBe('minted_token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns null when the forced refresh is rejected (invalid_grant)', async () => {
    const stored = makeStoredToken({ refresh_token: 'rt-dead' });
    const clients = makeFakeClients({
      registryItem: {
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: stored,
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'revoked' }),
    });

    const result = await resolveJiraOauthToken('cloud-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      forceRefresh: true,
    });

    expect(result).toBeNull();
  });
});

describe('getRegistryRow / parseRegistryRow', () => {
  beforeEach(() => {
    _resetCachesForTesting();
  });

  type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
  const asDdb = (send: jest.Mock) => ({ send }) as unknown as NonNullable<Opts['dynamoDbClient']>;

  test('returns null when DDB returns no item', async () => {
    const send = jest.fn().mockResolvedValue({ Item: undefined });
    const row = await getRegistryRow(asDdb(send), REGISTRY_TABLE, 'cloud-x');
    expect(row).toBeNull();
  });

  test('returns null and logs when DDB throws (non-strict swallows error)', async () => {
    const send = jest.fn().mockRejectedValue(new Error('DDB throttle'));
    const row = await getRegistryRow(asDdb(send), REGISTRY_TABLE, 'cloud-x');
    expect(row).toBeNull();
  });

  test('unknown status is treated as revoked (fail-closed)', async () => {
    const send = jest.fn().mockResolvedValue({
      Item: { site_url: 'https://x.atlassian.net', oauth_secret_arn: 'arn:s', status: 'weird' },
    });
    const row = await getRegistryRow(asDdb(send), REGISTRY_TABLE, 'cloud-x');
    expect(row?.status).toBe('revoked');
  });

  test('active status round-trips and caches', async () => {
    const send = jest.fn().mockResolvedValue({
      Item: { site_url: 'https://x.atlassian.net', oauth_secret_arn: 'arn:s', status: 'active' },
    });
    const ddb = asDdb(send);
    const first = await getRegistryRow(ddb, REGISTRY_TABLE, 'cloud-cache');
    expect(first?.status).toBe('active');
    // Second read should be served from cache (no extra DDB call).
    await getRegistryRow(ddb, REGISTRY_TABLE, 'cloud-cache');
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('getRegistryRowStrict propagates DDB errors instead of swallowing them', async () => {
    const send = jest.fn().mockRejectedValue(new Error('DDB throttle'));
    await expect(getRegistryRowStrict(asDdb(send), REGISTRY_TABLE, 'cloud-x')).rejects.toThrow(
      'DDB throttle',
    );
  });
});

describe('getOauthSecret / getOauthSecretStrict', () => {
  beforeEach(() => {
    _resetCachesForTesting();
  });

  type Opts = NonNullable<Parameters<typeof resolveJiraOauthToken>[2]>;
  const asSm = (send: jest.Mock) => ({ send }) as unknown as NonNullable<Opts['secretsManagerClient']>;

  test('returns parsed token on valid JSON', async () => {
    const stored = makeStoredToken();
    const send = jest.fn().mockResolvedValue({ SecretString: JSON.stringify(stored) });
    const token = await getOauthSecret(asSm(send), 'arn:s');
    expect(token?.access_token).toBe(stored.access_token);
  });

  test('returns null on invalid JSON', async () => {
    const send = jest.fn().mockResolvedValue({ SecretString: 'not { json' });
    const token = await getOauthSecret(asSm(send), 'arn:s');
    expect(token).toBeNull();
  });

  test('returns null when SecretString is absent', async () => {
    const send = jest.fn().mockResolvedValue({ SecretString: undefined });
    const token = await getOauthSecret(asSm(send), 'arn:s');
    expect(token).toBeNull();
  });

  test('non-strict swallows SM errors and returns null', async () => {
    const send = jest.fn().mockRejectedValue(new Error('SM down'));
    const token = await getOauthSecret(asSm(send), 'arn:s');
    expect(token).toBeNull();
  });

  test('strict variant propagates SM errors', async () => {
    const send = jest.fn().mockRejectedValue(new Error('SM down'));
    await expect(getOauthSecretStrict(asSm(send), 'arn:s')).rejects.toThrow('SM down');
  });

  test('strict variant returns null when SecretString is absent', async () => {
    const send = jest.fn().mockResolvedValue({ SecretString: undefined });
    const token = await getOauthSecretStrict(asSm(send), 'arn:s');
    expect(token).toBeNull();
  });
});
