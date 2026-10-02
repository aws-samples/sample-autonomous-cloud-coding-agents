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
  /** Make every DynamoDB UpdateCommand fail, to exercise the write-failure paths. */
  updateShouldFail?: Error;
  storedToken?: StoredOauthToken | null;
  putSecretValueShouldFail?: boolean;
  /** Make GetSecretValue throw, to separate "read failed" from "no grant stored". */
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
      // The agent mints its own token and must use the same subject, so the resolver
      // has to hand it back — on the path that SUCCEEDS. It was only on the
      // Secrets-Manager return, so a working vault resolution passed nothing on and
      // the agent silently fell back to a dead token: reactions 401'd on an issue
      // whose task was otherwise running fine.
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
      expect(result.accessToken).toBe('lin_oauth_vault');
      expect(result.vaultUserId).toBe('linear-ws-acme');
    });

    test('passes the RECORDED vault_user_id through, not a derived one', async () => {
      // The subject is stored because it cannot be derived: it is slug-based, so one
      // consent can onboard a workspace whose organization UUID is not yet known.
      // The row parser copies fields explicitly and this one was missing from it, so
      // the resolver silently fell back to deriving from the UUID, found no grant,
      // and reported "requires consent" for a healthy workspace. Caught in
      // production, not here, because the old test seam could not see this argument.
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
        // A stored token exists but must NOT be read on the vault-success path.
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
      // Secrets Manager was never queried on the vault-success path.
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
      // Fell through to the SM path.
      expect(result?.accessToken).toBe('lin_oauth_SM_fallback');
      expect(clients.smSend).toHaveBeenCalled();
    });

    test('skips the vault entirely when the workspace has no provider_name (SM-only install)', async () => {
      const clients = makeFakeClients({
        registryItem: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          // no provider_name
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

  // Adversarial fail-closed guard for `bgagent linear remove-workspace` (#306):
  // after a workspace is revoked (registry row flipped to status='revoked'),
  // a request for that slug MUST NOT resolve to a usable token — even if a
  // perfectly valid, non-expiring OAuth secret is still sitting in Secrets
  // Manager. The status gate short-circuits BEFORE the secret is ever read,
  // so a revoked workspace can never leak its token.
  test('fail-closed: a revoked workspace is rejected without ever reading the secret', async () => {
    const clients = makeFakeClients({
      registryItem: {
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'revoked',
      },
      // A fully valid, far-future token — the ONLY thing that should block
      // resolution here is the revoked status.
      storedToken: makeStoredToken({ access_token: 'lin_oauth_still_valid' }),
    });
    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, clients);
    expect(result).toBeNull();
    // The secret must never be fetched for a revoked workspace.
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
    // PutSecretValue must persist the ROTATED pair, not just be called. The stored
    // bundle is what the NEXT invocation reads: persisting the old refresh token
    // leaves this call green while the following refresh replays a token Linear
    // already invalidated on rotation — a grant that dies on its first refresh.
    const putCalls = clients.smSend.mock.calls.filter(
      (c) => c[0]!.constructor.name === 'PutSecretValueCommand',
    );
    expect(putCalls).toHaveLength(1);
    const persisted = JSON.parse(putCalls[0][0].input.SecretString as string);
    expect(persisted.access_token).toBe('lin_oauth_new');
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
    // Returning FALSE (not just "not throwing") is what makes the alert dedup
    // work: a revoked workspace keeps producing events, and only the caller whose
    // conditional write actually applied may announce it (#812).
    await expect(markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED))
      .resolves.toBe(false);
  });

  test('a latch that APPLIES reports true, so exactly one caller announces it', async () => {
    const send = jest.fn().mockResolvedValue({});
    await expect(markWorkspaceRevoked({ send } as never, REGISTRY_TABLE, WS, INSTALLED))
      .resolves.toBe(true);
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
  // The latch takes a workspace offline and, once latched, the vault re-probe answers
  // `consent-required` again — so Secrets Manager is never consulted a second time.
  // That makes the verdict effectively permanent, which is only acceptable when the
  // absence of a grant was actually established. A vault-dead / SM-alive workspace is
  // a real state (`readExistingOauthTokens` preserves it deliberately) and it runs
  // entirely off the Secrets-Manager token, so latching it on one throttled
  // GetSecretValue would be exactly the silent, unrecoverable outage #812 was filed
  // to eliminate.
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
    // ResourceNotFound is evidence, not noise: the fallback genuinely no longer
    // exists, so with the vault also refusing there is nothing left to resolve.
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
    // The fresh-vault-onboarding shape: real JSON, client credentials and signing
    // secret, no access/refresh token. Reading it succeeded; there is simply no grant.
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
    // The state the whole guard protects: vault dead, Secrets Manager fine. It must
    // resolve normally and record nothing.
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
});

describe('a vault_consent_required latch must be able to self-heal', () => {
  // The latch and the guard it trips are the same fact, so it seals itself: `status`
  // goes to `revoked`, the resolver then returns before the vault is ever consulted
  // again, and nothing short of a human re-consent can overturn it. That would be
  // fine if the verdict were a measurement — but it is an inference from a token-less
  // vault response, and any upstream fault that drops the recorded subject produces
  // it for a perfectly healthy workspace.
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
      // Supplying a recorder is what marks this caller as holding the registry write —
      // the clear is gated on it, exactly as the latch is.
      onAuthorizationRevoked: async () => undefined,
    });

    expect(resolveViaVault).toHaveBeenCalled();
    expect(result?.accessToken).toBe('lin_oauth_alive');
    // And the row is put back: leaving it `revoked` while handing out a working token
    // keeps `platform doctor` and the alerting reporting an outage that is over.
    const updates = updatesFrom(clients);
    expect(updates).toHaveLength(1);
    expect(updates[0].input!.UpdateExpression).toContain('revoked_reason');
    expect(updates[0].input!.ConditionExpression).toContain('installed_at = :installed');
  });

  test('a read-only role serves the token but does NOT attempt the clear', async () => {
    // Five of the six minting Lambdas hold read-only on the registry. An ungated clear
    // meant an AccessDenied logged at `error` on every event for a workspace the resolver
    // was serving correctly. The row stays latched until the one write-capable role — the
    // webhook processor — re-probes, which is the asymmetry the latch already has.
    const clients = makeFakeClients({
      registryItem: latchedRow('vault_consent_required'),
      storedToken: makeStoredToken({ access_token: '', refresh_token: '' }),
    });

    const result = await resolveLinearOauthToken('ws-uuid-1', REGISTRY_TABLE, {
      ...clients,
      resolveViaVault: async () => ({ kind: 'token', accessToken: 'lin_oauth_alive' }),
      // No recorder supplied ⇒ no registry write available.
    });

    // The token is still served — refusing to resolve would be the worse failure.
    expect(result?.accessToken).toBe('lin_oauth_alive');
    expect(updatesFrom(clients)).toHaveLength(0);
  });

  test('a refresh_token_rejected latch is NOT re-probed — Linear already refused', async () => {
    // The distinction is the whole point. That reason records a fact, not an
    // inference, so re-probing it would be a pointless call on every event for a
    // workspace that is genuinely dead.
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
    // The row is revoked; the only reason it got past the status guard was to give
    // the vault one more chance. Falling through would resurrect a workspace an
    // operator sees as down, using a token the vault path had already replaced.
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
    // Without the reason clause this would also clear a `refresh_token_rejected`
    // latch — a row Linear itself condemned — and hand back a workspace that is
    // genuinely dead.
    expect(condition).toContain('revoked_reason = :inference');
    expect(condition).toContain('installed_at = :installed');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':inference'])
      .toBe('vault_consent_required');
    // The announcement claim goes too, or a later GENUINE revocation of this same
    // installation would be deduped against the one being cleared here.
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
  // The classifier used to test `error === 'invalid_grant'` (what RFC 6749
  // specifies) and Linear does not send that. Every real revocation was therefore
  // filed as a generic failure, the permanent-rejection branch never ran, and the
  // registry was never marked — detection that existed and could not fire. These
  // are the exact payloads observed live.
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
    // invalid_request is also what a malformed request — our own bug — returns.
    // Marking a workspace revoked for that would take a working workspace offline.
    expect(isRefreshTokenRejection(400, {
      error: 'invalid_request', error_description: 'Missing required parameter: client_id',
    })).toBe(false);
  });

  test('a 5xx or throttle is transient, never a revocation', () => {
    expect(isRefreshTokenRejection(503, { error: 'server_error' })).toBe(false);
    expect(isRefreshTokenRejection(429, { error_description: 'Too many requests' })).toBe(false);
  });
});

describe('token-lineage diagnostic logging', () => {
  // Answers the one question a revoked grant cannot otherwise be asked after the
  // fact: did it ever ROTATE, or was it rejected on its first refresh? Linear
  // records no audit entry for the revocation and returns the same error either
  // way, so if this is not logged as it happens it is not recoverable.
  const RAW_REFRESH = 'lin_refresh_SENSITIVE_should_never_be_logged';
  // Mirrors the source's HMAC-SHA-256(salt) fingerprint — a keyed digest, not a
  // bare hash of the secret. Kept in lockstep with TOKEN_FP_SALT / TOKEN_FP_LENGTH.
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

  /** Every string in every log call, across all levels — for leak assertions. */
  function allLoggedText(): string {
    return [infoSpy, warnSpy, errorSpy]
      .flatMap((s) => s.mock.calls)
      .map((c) => JSON.stringify(c))
      .join(' ');
  }

  // BOTH rejection shapes. Linear actually answers a dead refresh token with
  // `invalid_request` and puts the detail in error_description; `invalid_grant` is
  // what RFC 6749 specifies and what this code originally tested for alone. The
  // forensics must attach to whichever arrives, or they are absent for the real one.
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
    // The age-at-death is the whole point of logging it here.
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
    // Neither the old nor the new raw refresh token may appear in any log.
    expect(allLoggedText()).not.toContain(RAW_REFRESH);
    expect(allLoggedText()).not.toContain(NEW_RAW);
  });
});

describe('a vault-managed bundle carries no grant, and must still verify webhooks', () => {
  // THE fresh-vault-install bug. A vault-onboarded workspace writes access_token,
  // refresh_token, expires_at and scope as empty strings by design — AgentCore holds
  // the grant. The strict parse required all four, so it rejected the bundle before
  // `webhook_signing_secret` could be read, verification fell back to the
  // stack-wide secret, and every delivery 401'd while the install looked healthy.
  //
  // Missed in live testing because the workspace under test was MIGRATED from
  // Secrets Manager and therefore still had tokens — the preservation behaviour
  // masked it. Only a genuinely fresh vault install reaches this.
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
    // Only the four grant fields become optional. A bundle without a workspace or
    // client identity is corrupt and must not be treated as verifiable.
    const corrupt = JSON.stringify({ access_token: '', refresh_token: '', webhook_signing_secret: 'lin_wh_x' });
    const send = jest.fn().mockResolvedValue({ SecretString: corrupt });
    const stored = await getOauthSecretStrict(
      { send } as unknown as Parameters<typeof getOauthSecretStrict>[0],
      'arn:secret:acme',
    );
    expect(stored).toBeNull();
  });

  test('the refresh path still demands a full grant', async () => {
    // Relaxing verification must not let the refresh path try to renew a grant that
    // is not there; a vault workspace has no Secrets-Manager token to refresh.
    const send = jest.fn().mockResolvedValue({ SecretString: vaultBundle });
    const fetched = await getOauthSecret(
      { send } as unknown as Parameters<typeof getOauthSecret>[0],
      'arn:secret:acme',
    );
    expect(fetched).toBeNull();
  });
});
