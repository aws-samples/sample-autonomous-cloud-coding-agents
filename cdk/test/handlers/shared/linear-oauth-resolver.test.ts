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

import { createHash } from 'node:crypto';
import {
  _resetCachesForTesting,
  invalidateLinearOauthCache,
  isTokenExpiring,
  markWorkspaceRevoked,
  resolveLinearOauthToken,
  type StoredOauthToken,
} from '../../../src/handlers/shared/linear-oauth-resolver';
import { logger } from '../../../src/handlers/shared/logger';

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

  test('a permanently-rejected refresh records the revocation when a recorder is SUPPLIED', async () => {
    // The failure this guards: when the authorization dies, every event for the
    // workspace is dropped and the ONLY evidence was a log line, so an operator
    // saw their trigger label do nothing with no way to find out why. Marking
    // the row is what makes `bgagent platform doctor` able to say so.
    //
    // The recorder is OPT-IN: every Lambda that resolves a token holds read-only
    // registry access, so defaulting it on meant the write failed AccessDenied
    // and was swallowed on every revoked refresh — inert while reading as
    // working. This passes it explicitly, the way a caller with the grant would.
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stale = makeStoredToken({ refresh_token: 'rt-dead', expires_at: expiringSoon });

    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetSecretValueCommand') {
        return { SecretString: JSON.stringify(stale) };
      }
      return {};
    });
    const ddbSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateCommand') return {};
      return { Item: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' } };
    });
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveLinearOauthToken>[2]>;
    const ddbClient = { send: ddbSend } as unknown as Opts['dynamoDbClient'];
    const result = await resolveLinearOauthToken('ws-uuid-revoke', REGISTRY_TABLE, {
      dynamoDbClient: ddbClient,
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAuthorizationRevoked: (workspaceId) => markWorkspaceRevoked(
        ddbClient as never, REGISTRY_TABLE, workspaceId,
      ),
    });
    expect(result).toBeNull();

    const update = ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input?: Record<string, unknown> })
      .find((c) => c.constructor.name === 'UpdateCommand');
    expect(update).toBeDefined();
    const input = update!.input as {
      ExpressionAttributeValues: Record<string, string>;
      ConditionExpression: string;
    };
    expect(input.ExpressionAttributeValues[':revoked']).toBe('revoked');
    expect(input.ExpressionAttributeValues[':reason']).toBe('refresh_token_rejected');
    // Conditional on still being active, so a late straggler can't clobber a
    // workspace an operator has already re-authorized.
    expect(input.ConditionExpression).toContain(':active');
  });

  test('a marker write failure does NOT break token resolution', async () => {
    // Recording the diagnosis is strictly a bonus; if the registry write fails
    // the caller must still get its clean null rather than a thrown handler.
    const expiringSoon = new Date(Date.now() + 10 * 1000).toISOString();
    const stale = makeStoredToken({ refresh_token: 'rt-dead2', expires_at: expiringSoon });
    const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetSecretValueCommand') {
        return { SecretString: JSON.stringify(stale) };
      }
      return {};
    });
    const ddbSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateCommand') throw new Error('AccessDenied');
      return { Item: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' } };
    });
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
    });

    type Opts = NonNullable<Parameters<typeof resolveLinearOauthToken>[2]>;
    await expect(resolveLinearOauthToken('ws-uuid-revoke-2', REGISTRY_TABLE, {
      dynamoDbClient: { send: ddbSend } as unknown as Opts['dynamoDbClient'],
      secretsManagerClient: { send: smSend } as unknown as Opts['secretsManagerClient'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeNull();
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

describe('markWorkspaceRevoked — the verdict must not outlive the grant it judged', () => {
  const WS = 'ws-uuid-1';
  const INSTALLED = '2026-07-22T10:00:00.000Z';

  /** The condition + values of the Nth Update. */
  function updateOf(send: jest.Mock, call = 0): { condition: string; values: Record<string, unknown> } {
    const input = (send.mock.calls[call][0] as {
      input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    }).input;
    return { condition: input.ConditionExpression, values: input.ExpressionAttributeValues };
  }

  beforeEach(() => _resetCachesForTesting());

  test('scopes the write to the installation it diagnosed, not merely to "active"', async () => {
    // status = active alone is not enough: a re-authorization writes active
    // again, so a straggler holding the OLD token would satisfy that condition
    // and revoke the working grant the operator just installed.
    const send = jest.fn().mockResolvedValue({});
    await markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED);

    const { condition, values } = updateOf(send);
    expect(condition).toContain('installed_at = :installed');
    expect(values[':installed']).toBe(INSTALLED);
    expect(condition).toContain('#s = :active');
  });

  test('a row re-authorized since the diagnosis is left alone, and says so', async () => {
    const conditional = new Error('The conditional request failed');
    (conditional as { name?: string }).name = 'ConditionalCheckFailedException';
    const send = jest.fn().mockRejectedValue(conditional);

    // Never throws — recording a diagnosis must not break token resolution.
    await expect(markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED))
      .resolves.toBeUndefined();
  });

  test('with no installation to name, it requires the attribute to still be ABSENT', async () => {
    // A row predating installed_at: a re-authorization adds the attribute, so
    // requiring its absence likewise takes the row out of scope.
    const send = jest.fn().mockResolvedValue({});
    await markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS);

    const { condition, values } = updateOf(send);
    expect(condition).toContain('attribute_not_exists(installed_at)');
    expect(values).not.toHaveProperty(':installed');
  });

  test('a non-conditional failure propagates — a silent AccessDenied is what kept this dormant', async () => {
    const send = jest.fn().mockRejectedValue(new Error('AccessDeniedException'));
    await expect(markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED))
      .rejects.toThrow('AccessDenied');
  });

  test('the resolver writes NOTHING to the registry when no recorder is supplied', async () => {
    // Guards the inert-but-looks-working state: the resolver used to default the
    // marker on, so on every revoked refresh it issued a registry write that the
    // caller's read-only role rejected, and the AccessDenied was swallowed. No
    // stack in the arc grants registry write, so the correct behaviour with no
    // recorder is to not attempt the write at all.
    const stored = makeStoredToken({ expires_at: new Date(Date.now() + 60 * 1000).toISOString() });
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
        installed_at: INSTALLED,
      } as never,
      storedToken: stored,
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'refresh token revoked' }),
    });

    // No onAuthorizationRevoked supplied → no registry write is attempted.
    await resolveLinearOauthToken(WS, REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const updates = clients.ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input?: Record<string, unknown> })
      .filter((cmd) => cmd.constructor.name === 'UpdateCommand');
    expect(updates).toHaveLength(0);
  });

  test('a SUPPLIED recorder carries the installation from the row the resolver read', async () => {
    // The value must come from the read that drove this refresh attempt. Re-reading
    // it inside the recorder would race a concurrent re-authorization exactly as
    // the status-only condition did, so this asserts the wiring, not just that
    // some marker fired.
    const stored = makeStoredToken({ expires_at: new Date(Date.now() + 60 * 1000).toISOString() });
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
        installed_at: INSTALLED,
      } as never,
      storedToken: stored,
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'refresh token revoked' }),
    });

    await resolveLinearOauthToken(WS, REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAuthorizationRevoked: (workspaceId) => markWorkspaceRevoked(
        clients.dynamoDbClient as never, REGISTRY_TABLE, workspaceId, INSTALLED,
      ),
    });

    const updates = clients.ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input?: Record<string, unknown> })
      .filter((cmd) => cmd.constructor.name === 'UpdateCommand');
    expect(updates).toHaveLength(1);
    expect(updates[0].input!.ConditionExpression).toContain('installed_at = :installed');
    expect((updates[0].input!.ExpressionAttributeValues as Record<string, unknown>)[':installed'])
      .toBe(INSTALLED);
  });
});

describe('token-lineage diagnostic logging (#807)', () => {
  const RAW_REFRESH = 'lin_refresh_SENSITIVE_should_never_be_logged';
  // sha256("lin_refresh_SENSITIVE_should_never_be_logged").slice(0,12) — computed
  // independently so the test pins the exact fingerprint the code must emit.
  const EXPECTED_FP = createHash('sha256').update(RAW_REFRESH).digest('hex').slice(0, 12);

  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetCachesForTesting();
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  /** Every string in every log call across all levels — for leak assertions. */
  function allLoggedText(): string {
    return [infoSpy, warnSpy, errorSpy]
      .flatMap((s) => s.mock.calls)
      .map((c) => JSON.stringify(c))
      .join(' ');
  }

  test('permanent rejection logs the fingerprint + age and NEVER the raw refresh token', async () => {
    const stored = makeStoredToken({
      refresh_token: RAW_REFRESH,
      expires_at: new Date(Date.now() - 1000).toISOString(), // force a refresh
      installed_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // ~25h old
    });
    const clients = makeFakeClients({
      registryItem: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
      storedToken: stored,
    });
    // 400 invalid_grant; the re-read returns the SAME token → permanent rejection.
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull(); // behavior unchanged: still returns null on revocation
    const forensics = errorSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('permanently rejected'),
    );
    expect(forensics).toBeDefined();
    const data = forensics![1] as Record<string, unknown>;
    expect(data.refresh_token_fp).toBe(EXPECTED_FP);
    expect(data.token_age_h).toBe(25); // the ~25h death-age clue is captured
    // The raw token must not appear ANYWHERE in ANY log.
    expect(allLoggedText()).not.toContain(RAW_REFRESH);
  });

  test('successful refresh logs the old→new fingerprint rotation, not raw tokens', async () => {
    const stored = makeStoredToken({
      refresh_token: RAW_REFRESH,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const clients = makeFakeClients({
      registryItem: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
      storedToken: stored,
    });
    const NEW_RAW = 'rt-rotated-new-SENSITIVE';
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'lin_oauth_new',
        token_type: 'Bearer',
        expires_in: 86399,
        refresh_token: NEW_RAW,
        scope: 'read write app:assignable app:mentionable',
      }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.accessToken).toBe('lin_oauth_new'); // behavior unchanged
    const refreshed = infoSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('token refreshed'),
    );
    expect(refreshed).toBeDefined();
    const data = refreshed![1] as Record<string, unknown>;
    expect(data.rotated_from_fp).toBe(EXPECTED_FP);
    expect(data.rotated_to_fp).toBe(
      createHash('sha256').update(NEW_RAW).digest('hex').slice(0, 12),
    );
    // Neither the old nor the new raw refresh token may appear in logs.
    expect(allLoggedText()).not.toContain(RAW_REFRESH);
    expect(allLoggedText()).not.toContain(NEW_RAW);
  });
});
