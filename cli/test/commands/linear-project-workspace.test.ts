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

import { GetSecretValueCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  classifyWebhookSecretProvenance,
  findProjectOwnerWorkspace,
  listActiveWorkspaceRows,
  listOnboardedWorkspaceSlugs,
  resolveWorkspaceAccessToken,
} from '../../src/commands/linear';

const mintLinearTokenFromVaultMock = jest.fn();
jest.mock('../../src/linear-vault', () => {
  const actual = jest.requireActual('../../src/linear-vault');
  return {
    ...actual,
    mintLinearTokenFromVault: (...args: unknown[]) => mintLinearTokenFromVaultMock(...args),
  };
});

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ACME = 'c0000000-0000-4000-8000-0000000ac0e1';
const ORG_RIVAL = 'c0000000-0000-4000-8000-0000000b10a2';

function fakeSm(bundles: Record<string, unknown>, secretList?: string[]): SecretsManagerClient {
  return {
    send: jest.fn(async (cmd: unknown) => {
      if (cmd instanceof ListSecretsCommand) {
        return { SecretList: (secretList ?? []).map((n) => ({ Name: n })) };
      }
      if (cmd instanceof GetSecretValueCommand) {
        const id = (cmd.input as { SecretId?: string }).SecretId ?? '';
        if (!(id in bundles)) throw new Error(`ResourceNotFoundException: ${id}`);
        return { SecretString: JSON.stringify(bundles[id]) };
      }
      throw new Error('unexpected command');
    }),
  } as unknown as SecretsManagerClient;
}

function fakeDdb(items: Array<Record<string, unknown>>) {
  return {
    send: jest.fn(async (cmd: unknown) => {
      if (cmd instanceof ScanCommand) return { Items: items };
      throw new Error('unexpected command');
    }),
  } as never;
}

function fakeLinear(byToken: Record<string, { org: string; projects: string[] }>) {
  return jest.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
    const token = auth.replace('Bearer ', '');
    const ws = byToken[token];
    if (!ws) return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;

    const body = JSON.parse((init?.body as string) ?? '{}') as {
      query: string;
      variables?: { id?: string; after?: string | null };
    };
    if (body.query.includes('project(id: $id)')) {
      const wanted = body.variables?.id ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            organization: { id: ws.org },
            project: ws.projects.includes(wanted) ? { id: wanted } : null,
          },
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          organization: { id: ws.org },
          projects: {
            nodes: ws.projects.map((id) => ({ id })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('listActiveWorkspaceRows', () => {
  test('drops rows whose status is not active', async () => {
    const ddb = fakeDdb([
      { workspace_slug: 'acme', status: 'active' },
      { workspace_slug: 'gone', status: 'revoked' },
      { workspace_slug: 'half-written' },
    ]);
    const rows = await listActiveWorkspaceRows(ddb, 'registry');
    expect(rows.map((r) => r.workspace_slug)).toEqual(['acme']);
  });
});

describe('listOnboardedWorkspaceSlugs', () => {
  test('prefers the registry so a revoked install is not a candidate', async () => {
    const ddb = fakeDdb([
      { workspace_slug: 'acme', status: 'active' },
      { workspace_slug: 'rival', status: 'revoked' },
    ]);
    const slugs = await listOnboardedWorkspaceSlugs({
      sm: fakeSm({}, ['bgagent-linear-oauth-acme', 'bgagent-linear-oauth-rival']),
      ddb,
      registryTableName: 'registry',
    });
    expect(slugs).toEqual(['acme']);
  });

  test('falls back to the secret prefix when no registry is configured', async () => {
    const slugs = await listOnboardedWorkspaceSlugs({
      sm: fakeSm({}, ['bgagent-linear-oauth-acme', 'bgagent-linear-oauth-rival', 'unrelated-secret']),
    });
    expect(slugs).toEqual(['acme', 'rival']);
  });
});

describe('resolveWorkspaceAccessToken', () => {
  test('reads the Secrets Manager bundle when the workspace is not vault-managed', async () => {
    const result = await resolveWorkspaceAccessToken({
      slug: 'acme',
      sm: fakeSm({ 'bgagent-linear-oauth-acme': { access_token: 'tok-acme' } }),
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
    });
    expect(result).toEqual({ kind: 'token', accessToken: 'tok-acme' });
  });

  test('reports a reason instead of throwing so a caller can keep scanning workspaces', async () => {
    const result = await resolveWorkspaceAccessToken({
      slug: 'missing',
      sm: fakeSm({}),
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
    });
    expect(result.kind).toBe('unavailable');
  });

  test('treats a bundle with no access_token as unavailable, not as an empty token', async () => {
    const result = await resolveWorkspaceAccessToken({
      slug: 'acme',
      sm: fakeSm({ 'bgagent-linear-oauth-acme': { refresh_token: 'r' } }),
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
    });
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'secret bgagent-linear-oauth-acme is missing access_token',
    });
  });

  describe('for a workspace on the Identity vault', () => {
    const VAULT_ROW = {
      workspace_slug: 'acme',
      linear_workspace_id: ORG_ACME,
      provider_name: 'bgagent-linear-oauth-acme',
      vault_user_id: 'linear-ws-acme',
      status: 'active',
    };
    const resolve = (row: Record<string, unknown>, bundle: Record<string, unknown>) => resolveWorkspaceAccessToken({
      slug: 'acme',
      sm: fakeSm({ 'bgagent-linear-oauth-acme': bundle }),
      ddb: fakeDdb([row]),
      registryTableName: 'registry',
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
    });

    beforeEach(() => {
      mintLinearTokenFromVaultMock.mockReset().mockResolvedValue({ kind: 'token', accessToken: 'vault-tok' });
    });

    test('mints from the vault, under the subject the registry row records', async () => {
      await expect(resolve(VAULT_ROW, { refresh_token: '' })).resolves.toEqual({ kind: 'token', accessToken: 'vault-tok' });
      expect(mintLinearTokenFromVaultMock).toHaveBeenCalledWith({
        region: 'us-east-1',
        workloadName: 'wl',
        providerName: 'bgagent-linear-oauth-acme',
        userId: 'linear-ws-acme',
      });
    });

    test('derives the subject from the workspace id for a row that records none', async () => {
      const { vault_user_id: _recorded, ...legacyRow } = VAULT_ROW;
      await resolve(legacyRow, { refresh_token: '' });
      expect(mintLinearTokenFromVaultMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: `linear-workspace-${ORG_ACME}` }),
      );
    });

    test('falls back to the token in the bundle when the vault has no live grant', async () => {
      mintLinearTokenFromVaultMock.mockResolvedValue({ kind: 'consent-required' });
      await expect(resolve(VAULT_ROW, { access_token: 'tok-acme' })).resolves.toEqual({ kind: 'token', accessToken: 'tok-acme' });
    });

    test('does not ask the vault for a workspace whose row names no provider', async () => {
      const { provider_name: _provider, vault_user_id: _recorded, ...secretsManagerRow } = VAULT_ROW;
      await expect(resolve(secretsManagerRow, { access_token: 'tok-acme' })).resolves.toEqual({ kind: 'token', accessToken: 'tok-acme' });
      expect(mintLinearTokenFromVaultMock).not.toHaveBeenCalled();
    });
  });
});

describe('findProjectOwnerWorkspace', () => {
  const sm = fakeSm({
    'bgagent-linear-oauth-acme': { access_token: 'tok-acme' },
    'bgagent-linear-oauth-rival': { access_token: 'tok-rival' },
  });
  const fetchImpl = fakeLinear({
    'tok-acme': { org: ORG_ACME, projects: [PROJECT_A] },
    'tok-rival': { org: ORG_RIVAL, projects: [PROJECT_B] },
  });

  test('returns the workspace whose own token can see the project', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: PROJECT_A,
      slugs: ['acme', 'rival'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'found', slug: 'acme', workspaceId: ORG_ACME });
  });

  test('does not attribute a project to a workspace that cannot see it', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: PROJECT_A,
      slugs: ['rival', 'acme'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'found', slug: 'acme', workspaceId: ORG_ACME });
  });

  test('reports not-found rather than guessing when no workspace owns the project', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      slugs: ['acme', 'rival'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl,
    });
    expect(result.kind).toBe('not-found');
  });

  test('records an unreachable workspace as an error and keeps searching the rest', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: PROJECT_A,
      slugs: ['unknown-slug', 'acme'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'found', slug: 'acme', workspaceId: ORG_ACME });
  });

  test('surfaces per-workspace errors when nothing resolved', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: PROJECT_A,
      slugs: ['unknown-slug'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl,
    });
    expect(result.kind).toBe('not-found');
    if (result.kind === 'not-found') {
      expect(result.errors.join(' ')).toContain('unknown-slug');
    }
  });

  const refusing = (...refused: string[]) => jest.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    return refused.includes(auth.replace('Bearer ', ''))
      ? { ok: true, status: 200, json: async () => ({ errors: [{ message: 'Authentication required' }] }) }
      : fetchImpl(url, init);
  }) as unknown as typeof fetch;

  test('reports an `errors` answer as the error of that workspace', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: PROJECT_B,
      slugs: ['rival'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl: refusing('tok-rival'),
    });
    expect(result).toEqual({ kind: 'not-found', searched: ['rival'], errors: ['rival: Authentication required'] });
  });

  test('keeps searching the rest after an `errors` answer', async () => {
    const result = await findProjectOwnerWorkspace({
      projectId: PROJECT_A,
      slugs: ['rival', 'acme'],
      sm,
      region: 'us-east-1',
      vaultWorkloadName: 'wl',
      fetchImpl: refusing('tok-rival'),
    });
    expect(result).toEqual({ kind: 'found', slug: 'acme', workspaceId: ORG_ACME });
  });
});

describe('classifyWebhookSecretProvenance', () => {
  const STACK_WIDE = 'lin_wh_firstWorkspaceSecret';

  test('a secret that differs from the stack-wide one is provably own', () => {
    expect(classifyWebhookSecretProvenance('lin_wh_mine', STACK_WIDE)).toBe('own');
  });

  test('a secret equal to the stack-wide one withholds a verdict', () => {
    expect(classifyWebhookSecretProvenance(STACK_WIDE, STACK_WIDE)).toBe('inherited');
  });

  test('no per-workspace secret at all is its own category', () => {
    expect(classifyWebhookSecretProvenance(undefined, STACK_WIDE)).toBe('absent');
  });

  test('owns it when no stack-wide secret exists, since nothing could have been mirrored', () => {
    expect(classifyWebhookSecretProvenance('lin_wh_mine', undefined)).toBe('own');
  });

  test('absent beats a missing stack-wide secret — nothing to own', () => {
    expect(classifyWebhookSecretProvenance(undefined, undefined)).toBe('absent');
  });

  test('an empty stored secret is absent, not an own secret equal to nothing', () => {
    expect(classifyWebhookSecretProvenance('', STACK_WIDE)).toBe('absent');
  });
});
