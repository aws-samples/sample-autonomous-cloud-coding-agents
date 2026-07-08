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
import type { StoredJiraOauthToken } from '../../src/jira-oauth';

// child_process.execFile — `openBrowser` shells out to the OS opener.
const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

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

describe('makeJiraCommand', () => {
  test('registers the expected subcommands', () => {
    const cmd = makeJiraCommand();
    expect(cmd.name()).toBe('jira');
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(expect.arrayContaining(['app-template', 'setup', 'link', 'map']));
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
