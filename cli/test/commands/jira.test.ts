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
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ApiClient } from '../../src/api-client';
import {
  isWebhookSecretConfigured,
  JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY,
  makeJiraCommand,
  openBrowser,
  renderJiraAppTemplate,
  upsertOauthSecret,
} from '../../src/commands/jira';
import * as config from '../../src/config';
import { generateInviteCode, INVITE_CODE_ALPHABET } from '../../src/invite-code';
import type { StoredJiraOauthToken } from '../../src/jira-oauth';

// child_process.execFile — `openBrowser` shells out to the OS opener.
const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

// Secrets Manager — invite-user reads the per-tenant OAuth bundle.
const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  };
});

// OAuth callback server — avoid binding a real localhost socket in `setup`.
const awaitOauthCallbackMock = jest.fn();
jest.mock('../../src/oauth-callback-server', () => {
  const actual = jest.requireActual('../../src/oauth-callback-server');
  return {
    ...actual,
    awaitOauthCallback: (...args: unknown[]) => awaitOauthCallbackMock(...args),
  };
});

// ApiClient — the `link` action calls `.jiraLink()`.
const jiraLinkMock = jest.fn();
jest.mock('../../src/api-client', () => ({
  ApiClient: jest.fn(() => ({ jiraLink: jiraLinkMock })),
}));

// Shared secret prompt — avoid touching real stdin in `setup`.
const promptSecretMock = jest.fn();
jest.mock('../../src/prompt-secret', () => ({
  promptSecret: (...args: unknown[]) => promptSecretMock(...args),
}));

// DynamoDB DocumentClient — capture PutCommand inputs from the `map` action.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  };
});

// CloudFormation — `getStackOutput` reads JiraProjectMappingTableName from here.
const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
  };
});

function sampleToken(overrides: Partial<StoredJiraOauthToken> = {}): StoredJiraOauthToken {
  return {
    access_token: 'access-xyz',
    refresh_token: 'refresh-xyz',
    expires_at: '2026-06-17T01:00:00.000Z',
    scope: 'read:jira-work write:jira-work read:jira-user',
    client_id: 'client-id',
    client_secret: 'client-secret',
    cloud_id: 'cloud-123',
    site_url: 'https://acme.atlassian.net',
    installed_at: '2026-06-17T00:00:00.000Z',
    updated_at: '2026-06-17T00:00:00.000Z',
    installed_by_platform_user_id: 'sub-abc',
    ...overrides,
  };
}

function fakeIdToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('makeJiraCommand', () => {
  test('registers the expected subcommands', () => {
    const cmd = makeJiraCommand();
    expect(cmd.name()).toBe('jira');
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(expect.arrayContaining(['app-template', 'setup', 'invite-user', 'link', 'map']));
  });

  test('`map` exposes a --label option defaulting to the trigger label', () => {
    const cmd = makeJiraCommand();
    const map = cmd.commands.find((c) => c.name() === 'map');
    expect(map).toBeDefined();
    const labelOpt = map!.options.find((o) => o.long === '--label');
    expect(labelOpt).toBeDefined();
    // Default is the package-wide trigger label ('bgagent').
    expect(labelOpt!.defaultValue).toBe('bgagent');
    // `--repo` is required on map.
    expect(map!.options.find((o) => o.long === '--repo')?.required).toBe(true);
  });

  test('`map` exposes optional --status-on-start / --status-on-pr flags', () => {
    const cmd = makeJiraCommand();
    const map = cmd.commands.find((c) => c.name() === 'map');
    const startOpt = map!.options.find((o) => o.long === '--status-on-start');
    const prOpt = map!.options.find((o) => o.long === '--status-on-pr');
    expect(startOpt).toBeDefined();
    expect(prOpt).toBeDefined();
    // Optional: not mandatory and no default value (so the agent falls back to
    // its heuristics when unset). `.required` here is Commander's "the option
    // *argument* is required when the flag is present" (from `<name>`), not
    // "the flag is mandatory" — that's `.mandatory`.
    expect(startOpt!.mandatory).toBeFalsy();
    expect(prOpt!.mandatory).toBeFalsy();
    expect(startOpt!.defaultValue).toBeUndefined();
    expect(prOpt!.defaultValue).toBeUndefined();
  });
});

describe('jira map action', () => {
  let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    ddbSend.mockReset().mockResolvedValue({});
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'JiraProjectMappingTableName', OutputValue: 'JiraProjectsTable' },
        ],
      }],
    });
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    loadConfigSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('persists status_on_start / status_on_pr when both flags are supplied', async () => {
    const program = makeJiraCommand();
    await program.parseAsync([
      'node', 'bgagent', 'map', 'cloud-1', 'ENG',
      '--repo', 'org/repo',
      '--status-on-start', 'Doing',
      '--status-on-pr', 'Code Review',
    ]);

    const putCmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(putCmd).toBeInstanceOf(PutCommand);
    expect(putCmd.input.Item).toMatchObject({
      jira_project_identity: 'cloud-1#ENG',
      repo: 'org/repo',
      status_on_start: 'Doing',
      status_on_pr: 'Code Review',
    });
  });

  test('omits status_on_* keys entirely when the flags are not supplied', async () => {
    const program = makeJiraCommand();
    await program.parseAsync([
      'node', 'bgagent', 'map', 'cloud-1', 'ENG', '--repo', 'org/repo',
    ]);

    const putCmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(putCmd.input.Item).not.toHaveProperty('status_on_start');
    expect(putCmd.input.Item).not.toHaveProperty('status_on_pr');
  });

  test('trims override values before persisting', async () => {
    const program = makeJiraCommand();
    await program.parseAsync([
      'node', 'bgagent', 'map', 'cloud-1', 'ENG', '--repo', 'org/repo',
      '--status-on-start', '  Doing  ',
      '--status-on-pr', '  Code Review  ',
    ]);

    const putCmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(putCmd.input.Item).toMatchObject({ status_on_start: 'Doing', status_on_pr: 'Code Review' });
  });

  test('treats whitespace-only overrides as unset (not persisted)', async () => {
    // #605: a truthy whitespace value would otherwise persist and permanently
    // no-op at the agent (strip() -> "" matches no status, no fallback).
    const program = makeJiraCommand();
    await program.parseAsync([
      'node', 'bgagent', 'map', 'cloud-1', 'ENG', '--repo', 'org/repo',
      '--status-on-start', '   ',
      '--status-on-pr', '\t',
    ]);

    const putCmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(putCmd.input.Item).not.toHaveProperty('status_on_start');
    expect(putCmd.input.Item).not.toHaveProperty('status_on_pr');
  });
});

describe('generateInviteCode', () => {
  test('emits "link-" prefix followed by exactly 8 alphabet characters', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^link-[a-z0-9]{8}$/);
    expect(code).toHaveLength(13);
  });

  test('only uses characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      const chars = code.slice('link-'.length);
      for (const c of chars) {
        expect(INVITE_CODE_ALPHABET).toContain(c);
      }
    }
  });
});

describe('openBrowser', () => {
  beforeEach(() => execFileMock.mockReset());

  test('resolves true when the OS opener succeeds', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    await expect(openBrowser('https://example.test')).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test('resolves false when the OS opener errors', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(new Error('no opener')));
    await expect(openBrowser('https://example.test')).resolves.toBe(false);
  });

  test.each([
    ['darwin', 'open'],
    ['win32', 'cmd'],
    ['linux', 'xdg-open'],
  ] as const)('invokes %s on %s', async (platform, expectedCmd) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    try {
      await openBrowser('https://example.test');
      expect(execFileMock.mock.calls[0]?.[0]).toBe(expectedCmd);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('jira app-template action', () => {
  test('prints the rendered template with provided options', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    try {
      const program = makeJiraCommand();
      await program.parseAsync(['node', 'bgagent', 'app-template', '--developer-name', 'Acme']);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toContain('bgagent — Acme');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('jira link action', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    jiraLinkMock.mockReset();
    (ApiClient as jest.Mock).mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('--output json prints the link result and skips the interactive preview', async () => {
    jiraLinkMock.mockResolvedValueOnce({ linked_at: '2026-06-17T01:00:00.000Z' });
    const program = makeJiraCommand();
    await program.parseAsync(['node', 'bgagent', 'link', 'CODE123', '--output', 'json']);
    // Single jiraLink call (no dry-run preview in JSON mode).
    expect(jiraLinkMock).toHaveBeenCalledTimes(1);
    expect(jiraLinkMock).toHaveBeenCalledWith('CODE123');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('2026-06-17T01:00:00.000Z'))).toBe(true);
  });

  test('text mode aborts without linking when the user declines', async () => {
    jiraLinkMock.mockResolvedValueOnce({
      jira_account_id: 'acct-1', // no name/email/site → exercises fallback branches
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline') as typeof import('readline');
    const rlMock = { question: (_q: string, cb: (a: string) => void) => cb('n'), close: jest.fn() };
    const rlSpy = jest.spyOn(readline, 'createInterface').mockReturnValue(rlMock as unknown as ReturnType<typeof readline.createInterface>);
    try {
      const program = makeJiraCommand();
      await program.parseAsync(['node', 'bgagent', 'link', 'CODE123']);
      // Only the dry-run preview ran; no real link call.
      expect(jiraLinkMock).toHaveBeenCalledTimes(1);
      expect(jiraLinkMock).toHaveBeenCalledWith('CODE123', { dryRun: true });
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Aborted'))).toBe(true);
    } finally {
      rlSpy.mockRestore();
    }
  });

  test('text mode shows a dry-run preview, then confirms and links', async () => {
    // First call = dry-run preview; second = the real link.
    jiraLinkMock
      .mockResolvedValueOnce({
        jira_user_name: 'Maya K',
        jira_user_email: 'maya@example.test',
        jira_site_url: 'https://acme.atlassian.net',
      })
      .mockResolvedValueOnce({ linked_at: '2026-06-17T02:00:00.000Z' });
    // Auto-confirm the prompt by feeding "y\n" on stdin.
    const stdinSpy = jest.spyOn(process.stdin, 'on').mockImplementation(function (this: typeof process.stdin) {
      return this;
    } as never);
    const rlMock = { question: (_q: string, cb: (a: string) => void) => cb('y'), close: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline') as typeof import('readline');
    const rlSpy = jest.spyOn(readline, 'createInterface').mockReturnValue(rlMock as unknown as ReturnType<typeof readline.createInterface>);
    try {
      const program = makeJiraCommand();
      await program.parseAsync(['node', 'bgagent', 'link', 'CODE123']);
      expect(jiraLinkMock).toHaveBeenCalledWith('CODE123', { dryRun: true });
      expect(jiraLinkMock).toHaveBeenCalledWith('CODE123');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Jira account linked'))).toBe(true);
    } finally {
      rlSpy.mockRestore();
      stdinSpy.mockRestore();
    }
  });
});

describe('jira invite-user action', () => {
  const originalFetch = global.fetch;
  let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;
  let loadCredentialsSpy: jest.SpiedFunction<typeof config.loadCredentials>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;

  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'JiraRegistryTable' },
          { OutputKey: 'JiraUserMappingTableName', OutputValue: 'JiraUsersTable' },
        ],
      }],
    });
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
    loadCredentialsSpy = jest.spyOn(config, 'loadCredentials').mockReturnValue({
      id_token: fakeIdToken('admin-sub'),
    } as ReturnType<typeof config.loadCredentials>);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    loadConfigSpy.mockRestore();
    loadCredentialsSpy.mockRestore();
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  function mockRegistryAndSecret(overrides: Partial<StoredJiraOauthToken> = {}): void {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          jira_cloud_id: 'cloud-123',
          site_url: 'https://acme.atlassian.net',
          oauth_secret_arn: 'arn:jira-oauth',
          status: 'active',
        },
      })
      // Existing-link lookup: no active mapping for the picked Jira identity.
      .mockResolvedValueOnce({})
      // PutCommand writing the pending# row.
      .mockResolvedValueOnce({});
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify(sampleToken({
        cloud_id: 'cloud-123',
        site_url: 'https://acme.atlassian.net',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        ...overrides,
      })),
    });
  }

  async function runInvite(args: string[]): Promise<void> {
    const program = makeJiraCommand();
    await program.parseAsync(['node', 'bgagent', 'invite-user', ...args]);
  }

  test('writes a pending invite row for a Jira user resolved by email', async () => {
    mockRegistryAndSecret();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([{
        accountId: 'acct-1',
        displayName: 'Maya K',
        emailAddress: 'maya@example.test',
        active: true,
        accountType: 'atlassian',
      }]),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runInvite(['cloud-123', 'maya@example.test']);

    const getCmd = ddbSend.mock.calls[0][0] as GetCommand;
    expect(getCmd).toBeInstanceOf(GetCommand);
    expect(getCmd.input).toMatchObject({
      TableName: 'JiraRegistryTable',
      Key: { jira_cloud_id: 'cloud-123' },
    });

    const searchUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(searchUrl.pathname).toBe('/ex/jira/cloud-123/rest/api/3/user/search');
    expect(searchUrl.searchParams.get('query')).toBe('maya@example.test');
    expect(searchUrl.searchParams.get('maxResults')).toBe('10');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer access-xyz' },
    });

    // calls[0] = registry GetCommand, calls[1] = existing-link GetCommand,
    // calls[2] = the pending# PutCommand.
    const putCmd = ddbSend.mock.calls[2][0] as PutCommand;
    expect(putCmd).toBeInstanceOf(PutCommand);
    expect(putCmd.input.TableName).toBe('JiraUsersTable');
    expect(putCmd.input.Item).toMatchObject({
      status: 'pending',
      jira_cloud_id: 'cloud-123',
      jira_site_url: 'https://acme.atlassian.net',
      jira_account_id: 'acct-1',
      jira_user_name: 'Maya K',
      jira_user_email: 'maya@example.test',
      invited_by_platform_user_id: 'admin-sub',
    });
    expect(putCmd.input.Item?.jira_identity).toMatch(/^pending#link-[a-z0-9]{8}$/);
    expect(putCmd.input.Item?.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000) + 23 * 60 * 60);
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('bgagent jira link link-'))).toBe(true);
  });

  test('resolves a direct Jira accountId without requiring an email search result', async () => {
    mockRegistryAndSecret();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        accountId: 'acct-1',
        displayName: 'Maya K',
        active: true,
        accountType: 'atlassian',
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runInvite(['cloud-123', 'acct-1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const lookupUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(lookupUrl.pathname).toBe('/ex/jira/cloud-123/rest/api/3/user');
    expect(lookupUrl.searchParams.get('accountId')).toBe('acct-1');
    const putCmd = ddbSend.mock.calls[2][0] as PutCommand;
    expect(putCmd.input.Item).toMatchObject({
      jira_account_id: 'acct-1',
      jira_user_name: 'Maya K',
      jira_user_email: '',
    });
  });

  test('refreshes and persists an expired Jira OAuth token before resolving the user', async () => {
    mockRegistryAndSecret({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      webhook_signing_secret: 'tenant-secret',
    });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read:jira-work write:jira-work read:jira-user',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{
          accountId: 'acct-1',
          displayName: 'Maya K',
          emailAddress: 'maya@example.test',
          active: true,
          accountType: 'atlassian',
        }]),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runInvite(['cloud-123', 'maya@example.test']);

    const putSecret = smSend.mock.calls[1][0] as PutSecretValueCommand;
    expect(putSecret).toBeInstanceOf(PutSecretValueCommand);
    expect(putSecret.input.SecretId).toBe('arn:jira-oauth');
    const persisted = JSON.parse(putSecret.input.SecretString as string) as StoredJiraOauthToken;
    expect(persisted).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      webhook_signing_secret: 'tenant-secret',
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer new-access' },
    });
  });

  test('fails before writing when the admin is not logged in', async () => {
    loadCredentialsSpy.mockReturnValue(undefined as ReturnType<typeof config.loadCredentials>);

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/Not authenticated/);

    expect(ddbSend).not.toHaveBeenCalled();
    expect(smSend).not.toHaveBeenCalled();
  });

  test('fails when the Jira tenant is not active in the registry', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { jira_cloud_id: 'cloud-123', status: 'revoked' } });

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/not in the registry/);

    expect(smSend).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('fails when the tenant OAuth secret has no stored value', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        jira_cloud_id: 'cloud-123',
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:jira-oauth',
        status: 'active',
      },
    });
    smSend.mockResolvedValueOnce({});

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/has no SecretString/);

    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('falls back to Jira user search when a direct accountId lookup returns 404', async () => {
    mockRegistryAndSecret();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{
          accountId: 'acct-1',
          displayName: 'Maya K',
          active: true,
          accountType: 'atlassian',
        }]),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runInvite(['cloud-123', 'acct-1']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(searchUrl.pathname).toBe('/ex/jira/cloud-123/rest/api/3/user/search');
    const putCmd = ddbSend.mock.calls[2][0] as PutCommand;
    expect(putCmd.input.Item).toMatchObject({ jira_account_id: 'acct-1' });
  });

  test('rejects an ambiguous Jira user search before writing an invite', async () => {
    mockRegistryAndSecret();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ([
        { accountId: 'acct-1', displayName: 'Maya K', active: true, accountType: 'atlassian' },
        { accountId: 'acct-2', displayName: 'Maya L', active: true, accountType: 'atlassian' },
      ]),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/multiple users/);

    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('fails if Atlassian refreshes an expired token without returning a rotated refresh token', async () => {
    mockRegistryAndSecret({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-access',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read:jira-work write:jira-work read:jira-user',
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/returned no refresh_token/);

    expect(smSend).toHaveBeenCalledTimes(1);
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('warns (but still writes the invite) when the Jira identity is already linked', async () => {
    // Registry GetCommand → active tenant; existing-link GetCommand → an
    // active mapping for the resolved account; PutCommand → the pending row.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          jira_cloud_id: 'cloud-123',
          site_url: 'https://acme.atlassian.net',
          oauth_secret_arn: 'arn:jira-oauth',
          status: 'active',
        },
      })
      .mockResolvedValueOnce({ Item: { jira_identity: 'cloud-123#acct-1', status: 'active' } })
      .mockResolvedValueOnce({});
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify(sampleToken({
        cloud_id: 'cloud-123',
        site_url: 'https://acme.atlassian.net',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })),
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accountId: 'acct-1', displayName: 'Maya K', active: true, accountType: 'atlassian' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runInvite(['cloud-123', 'acct-1']);

    // Existing-link lookup keyed on `<cloudId>#<accountId>`.
    const linkLookup = ddbSend.mock.calls[1][0] as GetCommand;
    expect(linkLookup).toBeInstanceOf(GetCommand);
    expect(linkLookup.input.Key).toEqual({ jira_identity: 'cloud-123#acct-1' });
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('already linked'))).toBe(true);
    // The invite is still written despite the warning.
    expect(ddbSend.mock.calls[2][0]).toBeInstanceOf(PutCommand);
  });

  test('refuses to invite an inactive or app Jira account', async () => {
    mockRegistryAndSecret();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accountId: 'acct-1', displayName: 'Bot', active: false, accountType: 'app' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(runInvite(['cloud-123', 'acct-1'])).rejects.toThrow(/inactive or is an app account/);

    // Registry + secret read happened, but no invite row was written.
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('guards the pending row against code collisions with a conditional put', async () => {
    mockRegistryAndSecret();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accountId: 'acct-1', displayName: 'Maya K', active: true, accountType: 'atlassian' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runInvite(['cloud-123', 'acct-1']);

    const putCmd = ddbSend.mock.calls[2][0] as PutCommand;
    expect(putCmd.input.ConditionExpression).toBe('attribute_not_exists(jira_identity)');
  });

  test('surfaces an actionable error when the generated code collides', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          jira_cloud_id: 'cloud-123',
          site_url: 'https://acme.atlassian.net',
          oauth_secret_arn: 'arn:jira-oauth',
          status: 'active',
        },
      })
      .mockResolvedValueOnce({}) // existing-link lookup: not linked
      .mockRejectedValueOnce(Object.assign(new Error('conditional check failed'), {
        name: 'ConditionalCheckFailedException',
      }));
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify(sampleToken({
        cloud_id: 'cloud-123',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })),
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accountId: 'acct-1', displayName: 'Maya K', active: true, accountType: 'atlassian' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(runInvite(['cloud-123', 'acct-1'])).rejects.toThrow(/collided with an existing invite/);
  });

  test('fails with an actionable error when the OAuth secret is malformed JSON', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        jira_cloud_id: 'cloud-123',
        site_url: 'https://acme.atlassian.net',
        oauth_secret_arn: 'arn:jira-oauth',
        status: 'active',
      },
    });
    smSend.mockResolvedValueOnce({ SecretString: '{not-json' });

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/is not valid JSON/);

    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('fails when the registry row is missing oauth_secret_arn', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        jira_cloud_id: 'cloud-123',
        site_url: 'https://acme.atlassian.net',
        status: 'active',
      },
    });

    await expect(runInvite(['cloud-123', 'maya@example.test'])).rejects.toThrow(/missing oauth_secret_arn/);

    expect(smSend).not.toHaveBeenCalled();
  });

  test('throws a clear error when required stack outputs are missing (not deployed)', async () => {
    cfnSend.mockReset().mockResolvedValue({ Stacks: [{ Outputs: [] }] });

    await expect(runInvite(['cloud-123', 'maya@example.test']))
      .rejects.toThrow(/missing outputs .*JiraWorkspaceRegistryTableName.*JiraUserMappingTableName/s);

    expect(ddbSend).not.toHaveBeenCalled();
    expect(smSend).not.toHaveBeenCalled();
  });
});

describe('jira setup action', () => {
  let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;

  beforeEach(() => {
    cfnSend.mockReset();
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
  });

  afterEach(() => loadConfigSpy.mockRestore());

  test('throws a clear error when required stack outputs are missing (not deployed)', async () => {
    // No outputs → getStackOutput returns null for both → setup aborts early.
    cfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    const program = makeJiraCommand();
    program.exitOverride();
    await expect(
      program.parseAsync(['node', 'bgagent', 'setup']),
    ).rejects.toThrow(/missing outputs .*JiraWorkspaceRegistryTableName.*JiraWebhookSecretArn/s);
  });

  test('aborts on OAuth state mismatch after generating PKCE/state (covers randomState)', async () => {
    cfnSend.mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
          { OutputKey: 'JiraWebhookSecretArn', OutputValue: 'arn:webhook' },
        ],
      }],
    });
    const payload = Buffer.from(JSON.stringify({ sub: 'cognito-sub-123' })).toString('base64url');
    const credsSpy = jest.spyOn(config, 'loadCredentials').mockReturnValue({
      id_token: `header.${payload}.sig`,
    } as ReturnType<typeof config.loadCredentials>);
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    execFileMock.mockImplementation((_c: string, _a: string[], cb: (e: Error | null) => void) => cb(null));
    // Callback returns a direct-oauth result with a state that can't match the
    // freshly generated one → setup throws right after randomState()/PKCE.
    awaitOauthCallbackMock.mockResolvedValue({ kind: 'direct-oauth', code: 'auth-code', state: 'definitely-not-the-state' });
    try {
      const program = makeJiraCommand();
      await expect(
        program.parseAsync([
          'node', 'bgagent', 'setup',
          '--client-id', 'cid', '--client-secret', 'csecret', '--no-browser',
        ]),
      ).rejects.toThrow(/OAuth state mismatch/);
    } finally {
      credsSpy.mockRestore();
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test('fails fast when the caller is not authenticated (no id_token)', async () => {
    cfnSend.mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
          { OutputKey: 'JiraWebhookSecretArn', OutputValue: 'arn:webhook' },
        ],
      }],
    });
    const credsSpy = jest.spyOn(config, 'loadCredentials').mockReturnValue(undefined as ReturnType<typeof config.loadCredentials>);
    try {
      const program = makeJiraCommand();
      await expect(program.parseAsync(['node', 'bgagent', 'setup'])).rejects.toThrow(/Not authenticated/);
    } finally {
      credsSpy.mockRestore();
    }
  });

  test('fails with a clear error when the cached id_token is malformed (extractCognitoSub branch)', async () => {
    cfnSend.mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
          { OutputKey: 'JiraWebhookSecretArn', OutputValue: 'arn:webhook' },
        ],
      }],
    });
    // id_token present but not a 3-segment JWT → extractCognitoSub throws.
    const credsSpy = jest.spyOn(config, 'loadCredentials').mockReturnValue({
      id_token: 'not-a-jwt',
    } as ReturnType<typeof config.loadCredentials>);
    try {
      const program = makeJiraCommand();
      await expect(program.parseAsync(['node', 'bgagent', 'setup'])).rejects.toThrow(/Could not read Cognito sub/);
    } finally {
      credsSpy.mockRestore();
    }
  });

  test('resolves caller identity then prompts for the Client ID (covers extractCognitoSub + promptSecret)', async () => {
    // Outputs present so setup proceeds past the deploy gate.
    cfnSend.mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'JiraWorkspaceRegistryTableName', OutputValue: 'RegTable' },
          { OutputKey: 'JiraWebhookSecretArn', OutputValue: 'arn:webhook' },
        ],
      }],
    });
    // A well-formed id_token with a `sub` claim so extractCognitoSub succeeds.
    const payload = Buffer.from(JSON.stringify({ sub: 'cognito-sub-123' })).toString('base64url');
    const credsSpy = jest.spyOn(config, 'loadCredentials').mockReturnValue({
      id_token: `header.${payload}.sig`,
    } as ReturnType<typeof config.loadCredentials>);
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    // promptSecret returns '' so setup throws "Client ID is required" right
    // after the prompt (before the OAuth flow).
    promptSecretMock.mockReset().mockResolvedValue('');
    try {
      const program = makeJiraCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'setup']),
      ).rejects.toThrow(/Client ID is required/);
    } finally {
      credsSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('jira map action', () => {
  let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    ddbSend.mockReset().mockResolvedValue({});
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'JiraProjectMappingTableName', OutputValue: 'ProjMapTable' }] }],
    });
    loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    // `process.exit` throws so we can assert it was reached without killing Jest.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    loadConfigSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  async function runMap(args: string[]): Promise<void> {
    const program = makeJiraCommand();
    await program.parseAsync(['node', 'bgagent', 'map', ...args]);
  }

  test('writes an active mapping row with the resolved label on the happy path', async () => {
    await runMap(['cloud-123', 'ENG', '--repo', 'owner/repo', '--label', 'agentme']);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const putInput = ddbSend.mock.calls[0][0].input;
    expect(putInput.TableName).toBe('ProjMapTable');
    expect(putInput.Item).toMatchObject({
      jira_project_identity: 'cloud-123#ENG',
      cloud_id: 'cloud-123',
      project_key: 'ENG',
      repo: 'owner/repo',
      label_filter: 'agentme',
      status: 'active',
    });
  });

  test('defaults the trigger label to bgagent when --label is omitted', async () => {
    await runMap(['cloud-123', 'ENG', '--repo', 'owner/repo']);
    expect(ddbSend.mock.calls[0][0].input.Item.label_filter).toBe('bgagent');
  });

  test('rejects an invalid --repo value before writing', async () => {
    await expect(runMap(['cloud-123', 'ENG', '--repo', 'not-a-repo'])).rejects.toThrow('process.exit:1');
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('rejects an invalid project key before writing', async () => {
    await expect(runMap(['cloud-123', 'bad-key', '--repo', 'owner/repo'])).rejects.toThrow('process.exit:1');
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('exits when the stack output is missing (stack not deployed)', async () => {
    cfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    await expect(runMap(['cloud-123', 'ENG', '--repo', 'owner/repo'])).rejects.toThrow('process.exit:1');
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe('renderJiraAppTemplate', () => {
  test('uses defaults and includes the three required Jira scopes', () => {
    const out = renderJiraAppTemplate();
    expect(out).toContain('bgagent — ABCA');
    expect(out).toContain('read:jira-work, write:jira-work, read:jira-user');
  });

  test('honors developerName / description / callbackUrl overrides', () => {
    const out = renderJiraAppTemplate({
      developerName: 'Acme',
      description: 'custom desc',
      callbackUrl: 'http://localhost:9999/callback',
    });
    expect(out).toContain('bgagent — Acme');
    expect(out).toContain('custom desc');
    expect(out).toContain('http://localhost:9999/callback');
  });
});

describe('upsertOauthSecret', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof upsertOauthSecret>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('creates the secret and returns its ARN on first install', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:new' });
    const arn = await upsertOauthSecret(mockClient, 'bgagent-jira-oauth-cloud-123', sampleToken(), 'cloud-123');
    expect(arn).toBe('arn:new');
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateSecretCommand);
  });

  test('falls back to PutSecretValue when the secret already exists', async () => {
    mockSend
      .mockRejectedValueOnce(new ResourceExistsException({ message: 'exists', $metadata: {} }))
      .mockResolvedValueOnce({ ARN: 'arn:existing' });
    const arn = await upsertOauthSecret(mockClient, 'bgagent-jira-oauth-cloud-123', sampleToken(), 'cloud-123');
    expect(arn).toBe('arn:existing');
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(PutSecretValueCommand);
  });

  test('rethrows non-ResourceExists errors', async () => {
    const err = new Error('kms denied');
    err.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(err);
    await expect(
      upsertOauthSecret(mockClient, 'bgagent-jira-oauth-cloud-123', sampleToken(), 'cloud-123'),
    ).rejects.toThrow('kms denied');
  });

  test('throws when CreateSecret returns no ARN', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(
      upsertOauthSecret(mockClient, 'bgagent-jira-oauth-cloud-123', sampleToken(), 'cloud-123'),
    ).rejects.toThrow(/CreateSecret returned no ARN/);
  });

  test('throws when PutSecretValue (existing-secret path) returns no ARN', async () => {
    mockSend
      .mockRejectedValueOnce(new ResourceExistsException({ message: 'exists', $metadata: {} }))
      .mockResolvedValueOnce({});
    await expect(
      upsertOauthSecret(mockClient, 'bgagent-jira-oauth-cloud-123', sampleToken(), 'cloud-123'),
    ).rejects.toThrow(/PutSecretValue returned no ARN/);
  });
});

describe('isWebhookSecretConfigured', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof isWebhookSecretConfigured>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns false for the CDK-generated JSON placeholder (the #368 case)', async () => {
    // Mirrors what the JiraIntegration construct seeds via generateSecretString:
    // a JSON object carrying the explicit placeholder marker key.
    const placeholder = JSON.stringify({
      [JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY]: true,
      value: 'abcdEFGH1234random',
    });
    mockSend.mockResolvedValueOnce({ SecretString: placeholder });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('returns true for an operator-set bare-string secret', async () => {
    // Atlassian signing secrets are operator-chosen bare strings, no fixed prefix.
    mockSend.mockResolvedValueOnce({ SecretString: 'operator-chosen-signing-secret' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(true);
  });

  test('returns true for the legacy bare-string CDK placeholder (pre-#368, indistinguishable from real)', async () => {
    // Stacks deployed before the explicit-placeholder fix seeded a bare random
    // string. It is conservatively reported as configured — such installs must
    // redeploy the stack (regenerating the JSON placeholder) before setup seeds.
    mockSend.mockResolvedValueOnce({ SecretString: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(true);
  });

  test('returns true for an operator value that happens to start with "{" but is not the placeholder', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: '{not really json' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(true);
  });

  test('returns true for JSON that lacks the placeholder marker key', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: '{"value":"abcd"}' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(true);
  });

  test('returns false on ResourceNotFoundException (secret not created yet)', async () => {
    const err = new Error('Secrets Manager cannot find the specified secret.');
    err.name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(err);
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('throws on AccessDenied so operators see the IAM gap instead of a confusing re-prompt', async () => {
    const err = new Error('User is not authorized to perform: secretsmanager:GetSecretValue');
    err.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(err);
    await expect(isWebhookSecretConfigured(mockClient, 'arn:secret')).rejects.toThrow(/IAM permission gap/);
  });

  test('returns false when SecretString is missing', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('returns false when SecretString is empty', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: '' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('wraps a non-Error rejection with the IAM-gap guidance', async () => {
    // A thrown non-Error value exercises the `?? \'Error\'` / String(err) branches.
    mockSend.mockRejectedValueOnce('boom');
    await expect(isWebhookSecretConfigured(mockClient, 'arn:secret')).rejects.toThrow(/IAM permission gap/);
  });
});
