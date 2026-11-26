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

import { createHmac } from 'node:crypto';
import {
  _resetCachesForTesting,
  clearWorkspaceRevocation,
  getOauthSecret,
  getOauthSecretStrict,
  getRegistryRowStrict,
  resolveSoleActiveLinearWorkspace,
  invalidateLinearOauthCache,
  isRefreshTokenRejection,
  isTokenExpiring,
  markWorkspaceRevoked,
  resolveLinearOauthToken,
  type StoredOauthToken,
} from '../../../src/handlers/shared/linear-oauth-resolver';
import { logger } from '../../../src/handlers/shared/logger';

const REGISTRY_TABLE = 'TestLinearWorkspaceRegistry';
const WS_ACME = 'ws-uuid-1';

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
    provider_name: string;
    vault_user_id: string;
    revoked_reason: string;
    installed_at: string;
  }> | null;
  updateShouldFail?: Error;
  storedToken?: StoredOauthToken | null;
  putSecretValueShouldFail?: boolean;
  getSecretValueError?: Error;
}) {
  const ddbSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'UpdateCommand' && opts.updateShouldFail) {
      throw opts.updateShouldFail;
    }
    return { Item: opts.registryItem === null ? undefined : opts.registryItem };
  });
  const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (name === 'GetSecretValueCommand') {
      if (opts.getSecretValueError) throw opts.getSecretValueError;
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
  afterEach(() => jest.restoreAllMocks());

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

  describe('AgentCore Identity vault path (#809)', () => {
    const WORKLOAD = 'abca_linear_oauth';
    let savedWorkload: string | undefined;
    let savedEnabled: string | undefined;

    beforeEach(() => {
      savedWorkload = process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
      savedEnabled = process.env.LINEAR_VAULT_ENABLED;
      process.env.LINEAR_WORKLOAD_IDENTITY_NAME = WORKLOAD;
      process.env.LINEAR_VAULT_ENABLED = 'true';
    });
    afterEach(() => {
      if (savedWorkload === undefined) delete process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
      else process.env.LINEAR_WORKLOAD_IDENTITY_NAME = savedWorkload;
      if (savedEnabled === undefined) delete process.env.LINEAR_VAULT_ENABLED;
      else process.env.LINEAR_VAULT_ENABLED = savedEnabled;
    });

    test('RETURNS the vault subject on the vault-success path, for the agent', async () => {
      const clients = makeFakeClients({
        registryItem: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          provider_name: 'bgagent-linear-oauth-acme',
          vault_user_id: 'linear-ws-acme',
        },
        storedToken: makeStoredToken({ access_token: 'lin_oauth_SM' }),
      });
      const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
        ...clients,
        resolveViaVault: async () => ({ kind: 'token', accessToken: 'lin_oauth_vault' }),
      });
      expect(result?.accessToken).toBe('lin_oauth_vault');
      expect(result?.vaultUserId).toBe('linear-ws-acme');
    });

    test('passes the RECORDED vault_user_id through, not a derived one', async () => {
      const clients = makeFakeClients({
        registryItem: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          provider_name: 'bgagent-linear-oauth-acme',
          vault_user_id: 'linear-ws-acme',
        },
        storedToken: makeStoredToken({ access_token: 'lin_oauth_SM' }),
      });
      const resolveViaVault = jest.fn().mockResolvedValue({ kind: 'token', accessToken: 'lin_oauth_vault' });

      await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, { ...clients, resolveViaVault });

      expect(resolveViaVault).toHaveBeenCalledWith(
        expect.objectContaining({ vaultUserId: 'linear-ws-acme' }),
        WORKLOAD,
      );
    });

    test('vault token is used (no Secrets Manager read) when provider_name is present and the vault succeeds', async () => {
      const clients = makeFakeClients({
        registryItem: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          provider_name: 'bgagent-linear-oauth-acme',
        },
        storedToken: makeStoredToken({ access_token: 'lin_oauth_SM_should_not_be_used' }),
      });
      const resolveViaVault = jest.fn().mockResolvedValue({ kind: 'token', accessToken: 'lin_oauth_from_vault' });

      const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
        ...clients,
        resolveViaVault,
      });

      expect(resolveViaVault).toHaveBeenCalledWith(
        expect.objectContaining({ linearWorkspaceId: 'ws-uuid-1', providerName: 'bgagent-linear-oauth-acme' }),
        WORKLOAD,
      );
      expect(result?.accessToken).toBe('lin_oauth_from_vault');
      expect(result?.workspaceSlug).toBe('acme');
      expect(clients.smSend).not.toHaveBeenCalled();
    });

    test('falls back to the Secrets Manager token when the vault cannot issue one', async () => {
      const clients = makeFakeClients({
        registryItem: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          provider_name: 'bgagent-linear-oauth-acme',
        },
        storedToken: makeStoredToken({ access_token: 'lin_oauth_SM_fallback' }),
      });
      const resolveViaVault = jest.fn().mockResolvedValue({ kind: 'consent-required' });

      const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
        ...clients,
        resolveViaVault,
      });

      expect(resolveViaVault).toHaveBeenCalledTimes(1);
      expect(result?.accessToken).toBe('lin_oauth_SM_fallback');
      expect(clients.smSend).toHaveBeenCalled();
    });

    test('skips the vault entirely when the workspace has no provider_name (SM-only install)', async () => {
      const clients = makeFakeClients({
        registryItem: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
        },
        storedToken: makeStoredToken({ access_token: 'lin_oauth_SM_only' }),
      });
      const resolveViaVault = jest.fn().mockResolvedValue({ kind: 'token', accessToken: 'should-not-be-called' });

      const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
        ...clients,
        resolveViaVault,
      });

      expect(resolveViaVault).not.toHaveBeenCalled();
      expect(result?.accessToken).toBe('lin_oauth_SM_only');
    });

    describe('a token the vault returned is reused for a minute', () => {
      const vaultRow = {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
        provider_name: 'bgagent-linear-oauth-acme',
        vault_user_id: 'linear-ws-acme',
        installed_at: '2026-08-01T00:00:00.000Z',
      };
      const vaultToken = () => jest.fn().mockResolvedValue({ kind: 'token', accessToken: 'lin_oauth_vault' });

      test('two calls in a row ask the vault once; after the minute it is asked again', async () => {
        const resolveViaVault = vaultToken();
        const options = { ...makeFakeClients({ registryItem: vaultRow }), resolveViaVault };

        const first = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, options);
        const second = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, options);

        expect(first?.accessToken).toBe('lin_oauth_vault');
        expect(second).toEqual(first);
        expect(resolveViaVault).toHaveBeenCalledTimes(1);

        jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, options);
        expect(resolveViaVault).toHaveBeenCalledTimes(2);
      });

      test('invalidateLinearOauthCache drops it', async () => {
        const resolveViaVault = vaultToken();
        const options = { ...makeFakeClients({ registryItem: vaultRow }), resolveViaVault };

        await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, options);
        invalidateLinearOauthCache('ws-uuid-1');
        await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, options);

        expect(resolveViaVault).toHaveBeenCalledTimes(2);
      });

      test('a row latched on the vault inference is still asked: a kept token is no re-probe', async () => {
        const beforeTheLatch = vaultToken();
        await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
          ...makeFakeClients({ registryItem: vaultRow }),
          resolveViaVault: beforeTheLatch,
        });
        await markWorkspaceRevoked(
          { send: jest.fn().mockResolvedValue({}) } as never,
          REGISTRY_TABLE, 'ws-uuid-1', vaultRow.installed_at, undefined, 'vault_consent_required',
        );

        const latched = makeFakeClients({
          registryItem: { ...vaultRow, status: 'revoked', revoked_reason: 'vault_consent_required' },
        });
        const reprobe = jest.fn().mockResolvedValue({ kind: 'consent-required', authorizationUrl: 'https://x/authorize' });
        const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
          ...latched,
          resolveViaVault: reprobe,
          onAuthorizationRevoked: async () => undefined,
        });

        expect(reprobe).toHaveBeenCalledTimes(1);
        expect(result).toBeNull();
        expect(latched.ddbSend.mock.calls.filter((c) => c[0].constructor.name === 'UpdateCommand')).toHaveLength(0);
      });
    });
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

  test('fail-closed: a revoked workspace is rejected without ever reading the secret', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'revoked',
      },
      storedToken: makeStoredToken({ access_token: 'lin_oauth_still_valid' }),
    });
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
    expect(clients.smSend).not.toHaveBeenCalled();
  });

  test('control: the same secret DOES resolve when the workspace is active', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: makeStoredToken({ access_token: 'lin_oauth_still_valid' }),
    });
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(result?.accessToken).toBe('lin_oauth_still_valid');
  });

  test('returns null when secret JSON is missing required fields', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
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
    const sentBody = fetchImpl.mock.calls[0][1]!.body as string;
    const sent = new URLSearchParams(sentBody);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('rt-old');
    expect(sent.get('client_id')).toBe('cid');
    expect(sent.get('client_secret')).toBe('csec');
    const putCalls = clients.smSend.mock.calls.filter(
      (c) => c[0]!.constructor.name === 'PutSecretValueCommand',
    );
    expect(putCalls).toHaveLength(1);
    const persisted = JSON.parse(putCalls[0][0].input.SecretString as string);
    expect(persisted.access_token).toBe('lin_oauth_new');
    // Linear invalidates the old refresh token on rotation.
    expect(persisted.refresh_token).toBe('rt-new');
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

  test('gives up on a refresh that Linear takes and never answers', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      },
      storedToken: makeStoredToken({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    });
    // jest's fake timers do not drive the timer of `AbortSignal.timeout`.
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new Error('timed out')));
    const fetchImpl = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason as Error);
    }));

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
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
    await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    const ddbCallsBeforeInvalidate = clients.ddbSend.mock.calls.length;
    expect(ddbCallsBeforeInvalidate).toBe(1);

    invalidateLinearOauthCache('ws-uuid-1', 'arn:secret:acme');
    await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(clients.ddbSend.mock.calls.length).toBe(2);
  });

  test('concurrent-refresh recovery: re-read finds rotated token, skip second /oauth/token POST', async () => {
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a permanently-rejected refresh records the revocation when a recorder is SUPPLIED', async () => {
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
      onAuthorizationRevoked: (detail) => markWorkspaceRevoked(
        ddbClient as never, REGISTRY_TABLE, detail.linearWorkspaceId,
      ).then(() => undefined),
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
    expect(input.ConditionExpression).toContain(':active');
  });

  test('a marker write failure does NOT break token resolution', async () => {
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

    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET'));

    const first = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(first).toBeNull();

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
    const getSecretCalls = clients.smSend.mock.calls.filter(
      (c) => c[0].constructor.name === 'GetSecretValueCommand',
    );
    expect(getSecretCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('markWorkspaceRevoked — the verdict must not outlive the grant it judged', () => {
  const WS = 'ws-uuid-1';
  const INSTALLED = '2026-07-22T10:00:00.000Z';

  function updateOf(send: jest.Mock, call = 0): { condition: string; values: Record<string, unknown> } {
    const input = (send.mock.calls[call][0] as {
      input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    }).input;
    return { condition: input.ConditionExpression, values: input.ExpressionAttributeValues };
  }

  beforeEach(() => _resetCachesForTesting());

  test('scopes the write to the installation it diagnosed, not merely to "active"', async () => {
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

    await expect(markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED))
      .resolves.toBe(false);
  });

  test('a latch that APPLIES reports true, so exactly one caller announces it', async () => {
    const send = jest.fn().mockResolvedValue({});
    await expect(markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED))
      .resolves.toBe(true);
  });

  test('with no installation to name, it requires the attribute to still be ABSENT', async () => {
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
    });

    const updates = clients.ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input?: Record<string, unknown> })
      .filter((cmd) => cmd.constructor.name === 'UpdateCommand');
    expect(updates).toHaveLength(0);
  });

  test('a SUPPLIED recorder carries the installation from the row the resolver read', async () => {
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
      onAuthorizationRevoked: (detail) => markWorkspaceRevoked(
        clients.dynamoDbClient as never, REGISTRY_TABLE, detail.linearWorkspaceId, INSTALLED,
      ).then(() => undefined),
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

describe('a transient Secrets Manager error is not a revocation', () => {
  const WORKLOAD = 'abca_linear_oauth';
  let savedWorkload: string | undefined;
  let savedEnabled: string | undefined;

  const vaultRow = {
    workspace_slug: 'acme',
    oauth_secret_arn: 'arn:secret:acme',
    status: 'active',
    provider_name: 'bgagent-linear-oauth-acme',
    vault_user_id: 'linear-ws-acme',
    installed_at: '2026-08-01T00:00:00.000Z',
  };
  const consentRequired = async () => ({
    kind: 'consent-required' as const,
    authorizationUrl: 'https://x/authorize',
  });
  const updatesFrom = (clients: { ddbSend: jest.Mock }) => clients.ddbSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string } })
    .filter((cmd) => cmd.constructor.name === 'UpdateCommand');

  beforeEach(() => {
    _resetCachesForTesting();
    savedWorkload = process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
    savedEnabled = process.env.LINEAR_VAULT_ENABLED;
    process.env.LINEAR_WORKLOAD_IDENTITY_NAME = WORKLOAD;
    process.env.LINEAR_VAULT_ENABLED = 'true';
  });
  afterEach(() => {
    if (savedWorkload === undefined) delete process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
    else process.env.LINEAR_WORKLOAD_IDENTITY_NAME = savedWorkload;
    if (savedEnabled === undefined) delete process.env.LINEAR_VAULT_ENABLED;
    else process.env.LINEAR_VAULT_ENABLED = savedEnabled;
  });

  test.each([
    ['a throttle', Object.assign(new Error('slow down'), { name: 'ThrottlingException' })],
    ['an IAM denial', Object.assign(new Error('denied'), { name: 'AccessDeniedException' })],
    ['a network blip', Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })],
  ])('vault says consent-required and the SM read hits %s → NO latch', async (_label, err) => {
    const clients = makeFakeClients({ registryItem: vaultRow, getSecretValueError: err });
    const recorder = jest.fn();

    const result = await resolveLinearOauthToken(WS_ACME, REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: consentRequired,
      onAuthorizationRevoked: recorder,
    });

    expect(result).toBeNull();
    expect(recorder).not.toHaveBeenCalled();
    expect(updatesFrom(clients)).toHaveLength(0);
  });

  test('a DELETED secret IS definitive, so it still latches', async () => {
    const clients = makeFakeClients({
      registryItem: vaultRow,
      getSecretValueError: Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }),
    });
    const recorder = jest.fn();

    expect(await resolveLinearOauthToken(WS_ACME, REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: consentRequired,
      onAuthorizationRevoked: recorder,
    })).toBeNull();

    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      source: 'vault-consent-required',
      installedAt: vaultRow.installed_at,
    }));
  });

  test('a bundle present but carrying no grant IS definitive, so it still latches', async () => {
    const clients = makeFakeClients({
      registryItem: vaultRow,
      storedToken: makeStoredToken({ access_token: '', refresh_token: '' }),
    });
    const recorder = jest.fn();

    expect(await resolveLinearOauthToken(WS_ACME, REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: consentRequired,
      onAuthorizationRevoked: recorder,
    })).toBeNull();

    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({ source: 'vault-consent-required' }));
  });

  test('an SM-alive workspace keeps working when the vault needs consent', async () => {
    const clients = makeFakeClients({
      registryItem: vaultRow,
      storedToken: makeStoredToken({ access_token: 'lin_oauth_sm_alive' }),
    });
    const recorder = jest.fn();

    const result = await resolveLinearOauthToken(WS_ACME, REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: consentRequired,
      onAuthorizationRevoked: recorder,
    });

    expect(result?.accessToken).toBe('lin_oauth_sm_alive');
    expect(recorder).not.toHaveBeenCalled();
  });

  // Linear expires a refresh token 30 days after issuance.
  describe('Linear rejects the refresh token of the stored fallback grant', () => {
    const expiredFallback = () => makeStoredToken({
      refresh_token: 'rt-fallback-past-30-days',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      installed_at: '2026-06-01T00:00:00.000Z',
    });
    const rejectedByLinear = () => jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_request', error_description: 'Invalid refresh token' }),
    }) as unknown as typeof fetch;

    test('the vault was unavailable → NO latch, only this event fails', async () => {
      const clients = makeFakeClients({ registryItem: vaultRow, storedToken: expiredFallback() });
      const recorder = jest.fn();

      const result = await resolveLinearOauthToken(WS_ACME, REGISTRY_TABLE, {
        ...clients,
        resolveViaVault: async () => ({ kind: 'unavailable', reason: 'ThrottlingException' }),
        fetchImpl: rejectedByLinear(),
        onAuthorizationRevoked: recorder,
      });

      expect(result).toBeNull();
      expect(recorder).not.toHaveBeenCalled();
      expect(updatesFrom(clients)).toHaveLength(0);
    });

    test('the vault says consent-required → recorded as the vault\'s verdict, so the re-probe can clear it', async () => {
      const clients = makeFakeClients({ registryItem: vaultRow, storedToken: expiredFallback() });
      const recorder = jest.fn();

      const result = await resolveLinearOauthToken(WS_ACME, REGISTRY_TABLE, {
        ...clients,
        resolveViaVault: consentRequired,
        fetchImpl: rejectedByLinear(),
        onAuthorizationRevoked: recorder,
      });

      expect(result).toBeNull();
      expect(recorder).toHaveBeenCalledTimes(1);
      expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
        linearWorkspaceId: WS_ACME,
        source: 'vault-consent-required',
        installedAt: vaultRow.installed_at,
      }));
    });
  });
});

describe('a vault_consent_required latch must be able to self-heal', () => {
  const WORKLOAD = 'abca_linear_oauth';
  const INSTALLED_AT = '2026-08-01T00:00:00.000Z';
  let savedWorkload: string | undefined;
  let savedEnabled: string | undefined;

  beforeEach(() => {
    _resetCachesForTesting();
    savedWorkload = process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
    savedEnabled = process.env.LINEAR_VAULT_ENABLED;
    process.env.LINEAR_WORKLOAD_IDENTITY_NAME = WORKLOAD;
    process.env.LINEAR_VAULT_ENABLED = 'true';
  });
  afterEach(() => {
    if (savedWorkload === undefined) delete process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
    else process.env.LINEAR_WORKLOAD_IDENTITY_NAME = savedWorkload;
    if (savedEnabled === undefined) delete process.env.LINEAR_VAULT_ENABLED;
    else process.env.LINEAR_VAULT_ENABLED = savedEnabled;
  });

  function latchedRow(reason: string) {
    return {
      workspace_slug: 'acme',
      oauth_secret_arn: 'arn:secret:acme',
      status: 'revoked',
      revoked_reason: reason,
      provider_name: 'bgagent-linear-oauth-acme',
      vault_user_id: 'linear-ws-acme',
      installed_at: INSTALLED_AT,
    };
  }

  function updatesFrom(clients: { ddbSend: jest.Mock }) {
    return clients.ddbSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input?: Record<string, unknown> })
      .filter((cmd) => cmd.constructor.name === 'UpdateCommand');
  }

  test('the vault IS re-probed, and a token clears the latch and is returned', async () => {
    const clients = makeFakeClients({
      registryItem: latchedRow('vault_consent_required'),
      storedToken: makeStoredToken({ access_token: '', refresh_token: '' }),
    });
    const resolveViaVault = jest.fn().mockResolvedValue({ kind: 'token', accessToken: 'lin_oauth_alive' });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      resolveViaVault,
      onAuthorizationRevoked: async () => undefined,
    });

    expect(resolveViaVault).toHaveBeenCalled();
    expect(result?.accessToken).toBe('lin_oauth_alive');
    const updates = updatesFrom(clients);
    expect(updates).toHaveLength(1);
    expect(updates[0].input!.UpdateExpression).toContain('revoked_reason');
    expect(updates[0].input!.ConditionExpression).toContain('installed_at = :installed');
  });

  test('a read-only role serves the token but does NOT attempt the clear', async () => {
    const clients = makeFakeClients({
      registryItem: latchedRow('vault_consent_required'),
      storedToken: makeStoredToken({ access_token: '', refresh_token: '' }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: async () => ({ kind: 'token', accessToken: 'lin_oauth_alive' }),
    });

    expect(result?.accessToken).toBe('lin_oauth_alive');
    expect(updatesFrom(clients)).toHaveLength(0);
  });

  test('a refresh_token_rejected latch is NOT re-probed — Linear already refused', async () => {
    const clients = makeFakeClients({
      registryItem: latchedRow('refresh_token_rejected'),
      storedToken: makeStoredToken(),
    });
    const resolveViaVault = jest.fn();

    expect(await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, { ...clients, resolveViaVault }))
      .toBeNull();
    expect(resolveViaVault).not.toHaveBeenCalled();
  });

  test('a re-probe that still needs consent leaves the latch alone and does NOT fall back to SM', async () => {
    const clients = makeFakeClients({
      registryItem: latchedRow('vault_consent_required'),
      storedToken: makeStoredToken({ access_token: 'lin_oauth_stale_SM' }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: async () => ({ kind: 'consent-required', authorizationUrl: 'https://x/authorize' }),
    });

    expect(result).toBeNull();
    expect(updatesFrom(clients)).toHaveLength(0);
    expect(clients.smSend).not.toHaveBeenCalled();
  });

  test('a failed un-latch does not fail the resolve that just succeeded', async () => {
    const clients = makeFakeClients({
      registryItem: latchedRow('vault_consent_required'),
      storedToken: makeStoredToken(),
      updateShouldFail: Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: async () => ({ kind: 'token', accessToken: 'lin_oauth_alive' }),
    });

    expect(result?.accessToken).toBe('lin_oauth_alive');
  });
});

describe('clearWorkspaceRevocation — scoped so it cannot resurrect the wrong row', () => {
  test('requires the row to still be the same installation AND the inference reason', async () => {
    const send = jest.fn().mockResolvedValue({});
    await clearWorkspaceRevocation(
      { send } as never, REGISTRY_TABLE, 'ws-uuid-1', '2026-08-01T00:00:00.000Z',
    );
    const input = send.mock.calls[0][0].input as Record<string, unknown>;
    const condition = input.ConditionExpression as string;
    expect(condition).toContain('revoked_reason = :inference');
    expect(condition).toContain('installed_at = :installed');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':inference'])
      .toBe('vault_consent_required');
    expect(input.UpdateExpression).toContain('revocation_announced_at');
  });

  test('reports false (not a throw) when the condition does not hold', async () => {
    const send = jest.fn().mockRejectedValue(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );
    expect(await clearWorkspaceRevocation({ send } as never, REGISTRY_TABLE, 'ws-uuid-1'))
      .toBe(false);
  });
});

describe('isRefreshTokenRejection — Linear does not send invalid_grant', () => {
  test("Linear's real revoked-token response is recognised", () => {
    expect(isRefreshTokenRejection(400, {
      error: 'invalid_request', error_description: 'Refresh token revoked',
    })).toBe(true);
  });

  test("Linear's real invalid-token response is recognised", () => {
    expect(isRefreshTokenRejection(400, {
      error: 'invalid_request', error_description: 'Invalid refresh token',
    })).toBe(true);
  });

  test('the RFC-standard invalid_grant is still accepted, in case Linear aligns', () => {
    expect(isRefreshTokenRejection(400, { error: 'invalid_grant' })).toBe(true);
  });

  test('a generic invalid_request is NOT treated as a dead grant', () => {
    expect(isRefreshTokenRejection(400, {
      error: 'invalid_request', error_description: 'Missing required parameter: client_id',
    })).toBe(false);
  });

  test('a 5xx or throttle is transient, never a revocation', () => {
    expect(isRefreshTokenRejection(503, { error: 'server_error' })).toBe(false);
    expect(isRefreshTokenRejection(429, { error_description: 'Too many requests' })).toBe(false);
  });
});

// Linear records no audit entry for a revocation and returns the same error whether the token
// ever rotated or was rejected on its first refresh.
describe('token-lineage diagnostic logging', () => {
  const RAW_REFRESH = 'lin_refresh_SENSITIVE_should_never_be_logged';
  const fp = (token: string): string =>
    createHmac('sha256', 'abca.linear.token-lineage.v1').update(token).digest('hex').slice(0, 12);
  const EXPECTED_FP = fp(RAW_REFRESH);

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

  function allLoggedText(): string {
    return [infoSpy, warnSpy, errorSpy]
      .flatMap((s) => s.mock.calls)
      .map((c) => JSON.stringify(c))
      .join(' ');
  }

  test.each([
    ['invalid_request (what Linear really sends)', 'invalid_request'],
    ['invalid_grant (RFC 6749)', 'invalid_grant'],
  ])('permanent rejection logs the fingerprint + age and never the raw token — %s', async (_label, code) => {
    const stored = makeStoredToken({
      refresh_token: RAW_REFRESH,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      installed_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
    });
    const clients = makeFakeClients({
      registryItem: { workspace_slug: 'acme', oauth_secret_arn: 'arn:secret:acme', status: 'active' },
      storedToken: stored,
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: code, error_description: 'Refresh token revoked' }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    const forensics = errorSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('permanently rejected'),
    );
    expect(forensics).toBeDefined();
    const data = forensics![1] as Record<string, unknown>;
    expect(data.refresh_token_fp).toBe(EXPECTED_FP);
    expect(data.token_age_h).toBe(25);
    expect(allLoggedText()).not.toContain(RAW_REFRESH);
  });

  test('a successful refresh logs the old→new fingerprint rotation, not raw tokens', async () => {
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

    expect(result?.accessToken).toBe('lin_oauth_new');
    const refreshed = infoSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('token refreshed'),
    );
    expect(refreshed).toBeDefined();
    const data = refreshed![1] as Record<string, unknown>;
    expect(data.rotated_from_fp).toBe(EXPECTED_FP);
    expect(data.rotated_to_fp).toBe(fp(NEW_RAW));
    expect(allLoggedText()).not.toContain(RAW_REFRESH);
    expect(allLoggedText()).not.toContain(NEW_RAW);
  });
});

describe('a vault-managed bundle carries no grant, and must still verify webhooks', () => {
  const vaultBundle = JSON.stringify({
    access_token: '',
    refresh_token: '',
    expires_at: '',
    scope: '',
    client_id: 'cid',
    client_secret: 'csecret',
    workspace_id: 'ws-uuid-1',
    workspace_slug: 'acme',
    installed_at: '2026-08-29T12:50:19.000Z',
    updated_at: '2026-08-29T12:50:19.000Z',
    installed_by_platform_user_id: 'u-1',
    webhook_signing_secret: 'lin_wh_theRealSecret',
  });

  test('getOauthSecretStrict reads the signing secret out of a grantless bundle', async () => {
    const send = jest.fn().mockResolvedValue({ SecretString: vaultBundle });
    const stored = await getOauthSecretStrict(
      { send } as unknown as Parameters<typeof getOauthSecretStrict>[0],
      'arn:secret:acme',
    );
    expect(stored).not.toBeNull();
    expect(stored?.webhook_signing_secret).toBe('lin_wh_theRealSecret');
  });

  test('a bundle missing IDENTITY fields is still rejected — this is not a blanket relaxation', async () => {
    const corrupt = JSON.stringify({ access_token: '', refresh_token: '', webhook_signing_secret: 'lin_wh_x' });
    const send = jest.fn().mockResolvedValue({ SecretString: corrupt });
    const stored = await getOauthSecretStrict(
      { send } as unknown as Parameters<typeof getOauthSecretStrict>[0],
      'arn:secret:acme',
    );
    expect(stored).toBeNull();
  });

  test('the refresh path still demands a full grant', async () => {
    const send = jest.fn().mockResolvedValue({ SecretString: vaultBundle });
    const fetched = await getOauthSecret(
      { send } as unknown as Parameters<typeof getOauthSecret>[0],
      'arn:secret:acme',
    );
    expect(fetched).toBeNull();
  });
});

describe('webhook_secret_owned — provenance, not value equality', () => {
  beforeEach(() => _resetCachesForTesting());

  function rowWith(extra: Record<string, unknown>) {
    return {
      send: jest.fn().mockResolvedValue({
        Item: {
          linear_workspace_id: 'ws-1',
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          ...extra,
        },
      }),
    } as unknown as Parameters<typeof getRegistryRowStrict>[0];
  }

  test('carries a recorded true through to the reader', async () => {
    const row = await getRegistryRowStrict(rowWith({ webhook_secret_owned: true }), 'registry', 'ws-1');
    expect(row?.webhook_secret_owned).toBe(true);
  });

  test('leaves the field absent when the row predates it', async () => {
    const row = await getRegistryRowStrict(rowWith({}), 'registry', 'ws-1');
    expect(row?.webhook_secret_owned).toBeUndefined();
  });

  test.each([['false-ish string', 'true'], ['number', 1], ['explicit false', false]] as const)(
    'refuses to treat a %s as proof of ownership',
    async (_label, value) => {
      const row = await getRegistryRowStrict(rowWith({ webhook_secret_owned: value }), 'registry', 'ws-1');
      expect(row?.webhook_secret_owned).toBeUndefined();
    },
  );
});

describe('resolveSoleActiveLinearWorkspace — bind only when the answer is unambiguous', () => {
  function scanning(pages: Array<{ Items: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }>) {
    let i = 0;
    return { send: jest.fn(async () => pages[i++]) } as unknown as Parameters<typeof resolveSoleActiveLinearWorkspace>[0];
  }

  test('returns the id when exactly one workspace is active', async () => {
    const ddb = scanning([{ Items: [{ linear_workspace_id: 'org-only', status: 'active' }] }]);
    await expect(resolveSoleActiveLinearWorkspace(ddb, 'registry')).resolves.toBe('org-only');
  });

  test('returns undefined when two are active, rather than picking the first', async () => {
    const ddb = scanning([{
      Items: [
        { linear_workspace_id: 'org-a', status: 'active' },
        { linear_workspace_id: 'org-b', status: 'active' },
      ],
    }]);
    await expect(resolveSoleActiveLinearWorkspace(ddb, 'registry')).resolves.toBeUndefined();
  });

  test('returns undefined on an empty registry', async () => {
    await expect(resolveSoleActiveLinearWorkspace(scanning([{ Items: [] }]), 'registry')).resolves.toBeUndefined();
  });

  test('ignores revoked rows when deciding whether the answer is unique', async () => {
    const ddb = scanning([{
      Items: [
        { linear_workspace_id: 'org-live', status: 'active' },
        { linear_workspace_id: 'org-dead', status: 'revoked' },
      ],
    }]);
    await expect(resolveSoleActiveLinearWorkspace(ddb, 'registry')).resolves.toBe('org-live');
  });

  test('follows pagination before concluding the answer is unique', async () => {
    const ddb = scanning([
      { Items: [{ linear_workspace_id: 'org-a', status: 'active' }], LastEvaluatedKey: { k: 1 } },
      { Items: [{ linear_workspace_id: 'org-b', status: 'active' }] },
    ]);
    await expect(resolveSoleActiveLinearWorkspace(ddb, 'registry')).resolves.toBeUndefined();
  });

  test('returns undefined when no registry table is configured', async () => {
    await expect(resolveSoleActiveLinearWorkspace(scanning([]), undefined)).resolves.toBeUndefined();
  });
});
