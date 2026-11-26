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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { makeLinearCommand } from '../../src/commands/linear';
import * as configMod from '../../src/config';
import { savePendingConsent, takePendingConsent } from '../../src/linear-pending-consent';

let capturedState = '';
const awaitOauthCallbackMock = jest.fn(
  () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ kind: 'direct-oauth' as const, code: 'auth-code', state: capturedState }),
        0,
      ),
    ),
);
jest.mock('../../src/oauth-callback-server', () => ({
  ...jest.requireActual('../../src/oauth-callback-server'),
  awaitOauthCallback: (...args: Parameters<typeof awaitOauthCallbackMock>) => awaitOauthCallbackMock(...args),
  CALLBACK_URL: 'http://localhost:8080/oauth/callback',
}));

const exchangeAuthorizationCodeMock = jest.fn();
jest.mock('../../src/linear-oauth', () => {
  const actual = jest.requireActual('../../src/linear-oauth');
  return {
    ...actual,
    exchangeAuthorizationCode: (...args: unknown[]) => exchangeAuthorizationCodeMock(...args),
  };
});

const upsertLinearCredentialProviderMock = jest.fn();
const beginVaultConsentMock = jest.fn();
jest.mock('../../src/linear-vault', () => {
  const actual = jest.requireActual('../../src/linear-vault');
  return {
    ...actual,
    upsertLinearCredentialProvider: (...args: unknown[]) => upsertLinearCredentialProviderMock(...args),
    beginVaultConsent: (...args: unknown[]) => beginVaultConsentMock(...args),
  };
});

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return { ...actual, SecretsManagerClient: jest.fn(() => ({ send: smSend })) };
});

const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return { ...actual, CloudFormationClient: jest.fn(() => ({ send: cfnSend })) };
});

const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  };
});
jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({})) };
});

let typed: string[] = [];
jest.mock('readline', () => ({
  createInterface: () => ({
    once: (event: string, cb: (line: string) => void) => {
      if (event === 'line') cb(typed.shift() ?? '');
    },
    close: () => undefined,
  }),
}));

const FAKE_ID_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'sub-abc' })).toString('base64url')}.y`;

const WEBHOOK_ARN = 'arn:aws:secretsmanager:us-west-2:111122223333:secret:LinearWebhookSecret-abc';
const PER_WORKSPACE_NAME = 'bgagent-linear-oauth-demo';
const THIS_WS_SECRET = 'lin_wh_thisWorkspace';
const OTHER_WS_SECRET = 'lin_wh_otherWorkspace';

function priorWorkspaceBundle(webhookSigningSecret = THIS_WS_SECRET): string {
  return JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: '2026-06-17T01:00:00.000Z',
    scope: 'read write',
    client_id: 'client-id',
    client_secret: 'client-secret',
    workspace_id: 'org-demo',
    workspace_slug: 'demo',
    installed_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    installed_by_platform_user_id: 'sub-abc',
    webhook_signing_secret: webhookSigningSecret,
  });
}

describe('linear setup — second-workspace re-run preserves the per-workspace webhook secret (#611/#612 B2)', () => {
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    capturedState = '';
    awaitOauthCallbackMock.mockClear();
    exchangeAuthorizationCodeMock.mockReset();
    upsertLinearCredentialProviderMock.mockReset();
    beginVaultConsentMock.mockReset();
    smSend.mockReset();
    cfnSend.mockReset();
    ddbSend.mockReset();

    cfnSend.mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
          { OutputKey: 'LinearUserMappingTableName', OutputValue: 'user-mapping-table' },
          { OutputKey: 'LinearWebhookSecretArn', OutputValue: WEBHOOK_ARN },
        ],
      }],
    });

    exchangeAuthorizationCodeMock.mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'read write',
    });

    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: { id: 'viewer-1', name: 'Admin', email: 'admin@demo.test' },
          organization: { id: 'org-demo', name: 'Demo', urlKey: 'demo' },
          teams: { nodes: [] },
          users: { nodes: [] },
        },
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    ddbSend.mockResolvedValue({});
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('refuses to proceed when the workspace has no signing secret of its own', async () => {
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        const id = (cmd as GetSecretValueCommand).input.SecretId ?? '';
        if (String(id).includes('bgagent-linear-oauth-')) {
          return Promise.reject(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
        }
        return Promise.resolve({ SecretString: 'lin_wh_stackWideOther' });
      }
      return Promise.resolve({});
    });

    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
      { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
    );
    const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
      { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
    );
    try {
      const program = makeLinearCommand();
      await expect(program.parseAsync([
        'node', 'bgagent', 'setup', 'zzsecondws',
        '--client-id', 'cid', '--client-secret', 'csecret', '--webhook-secret', '', '--no-browser',
      ])).rejects.toThrow(/no webhook signing secret of its own/);
    } finally {
      cfgSpy.mockRestore();
      credSpy.mockRestore();
    }
  });

  test('the final per-workspace PutSecretValue keeps THIS workspace secret, not the stack-wide other', async () => {
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        const id = cmd.input.SecretId;
        if (id === PER_WORKSPACE_NAME) return Promise.resolve({ SecretString: priorWorkspaceBundle() });
        if (id === WEBHOOK_ARN) return Promise.resolve({ SecretString: OTHER_WS_SECRET });
        return Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} }));
      }
      if (cmd instanceof CreateSecretCommand) {
        return Promise.reject(new ResourceExistsException({ message: 'exists', $metadata: {} }));
      }
      if (cmd instanceof PutSecretValueCommand) {
        return Promise.resolve({ ARN: `arn:${cmd.input.SecretId}` });
      }
      return Promise.resolve({});
    });

    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
      { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
    );
    const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
      { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
    );
    const printed: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      printed.push(line);
      const m = line.match(/[?&]state=([^&\s]+)/);
      if (m) capturedState = decodeURIComponent(m[1]);
    });
    try {
      const program = makeLinearCommand();
      await program.parseAsync([
        'node', 'bgagent', 'setup', 'demo',
        '--client-id', 'cid', '--client-secret', 'csecret', '--webhook-secret', '', '--no-browser',
      ]);
    } finally {
      cfgSpy.mockRestore();
      credSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(capturedState).not.toBe('');
    expect(awaitOauthCallbackMock).toHaveBeenCalled();

    const perWsPuts = smSend.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is InstanceType<typeof PutSecretValueCommand> =>
        cmd instanceof PutSecretValueCommand && cmd.input.SecretId === PER_WORKSPACE_NAME);

    expect(perWsPuts.length).toBeGreaterThanOrEqual(1);
    for (const put of perWsPuts) {
      const bundle = JSON.parse(String(put.input.SecretString)) as { webhook_signing_secret?: string };
      expect(bundle.webhook_signing_secret).toBe(THIS_WS_SECRET);
      expect(bundle.webhook_signing_secret).not.toBe(OTHER_WS_SECRET);
    }
    expect(printed).toContain('  ✓ Preserving this workspace\'s existing webhook signing secret (re-run — not overwriting)');

    const stackWidePuts = smSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd instanceof PutSecretValueCommand && cmd.input.SecretId === WEBHOOK_ARN);
    expect(stackWidePuts).toHaveLength(0);

    const registryPut = ddbSend.mock.calls
      .map((c) => c[0])
      .find((cmd) => cmd instanceof PutCommand && cmd.input.TableName === 'registry-table');
    expect(registryPut).toBeDefined();

    expect((registryPut as InstanceType<typeof PutCommand>).input.Item?.webhook_secret_owned).toBe(true);
  });

  test.each([
    ['with nothing stored', undefined],
    ['in place of the one stored', priorWorkspaceBundle()],
  ])('records ownership when the operator supplies this workspace\'s own secret (%s)', async (_stored, bundle) => {
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        const id = (cmd as GetSecretValueCommand).input.SecretId;
        if (id === WEBHOOK_ARN) return Promise.resolve({ SecretString: OTHER_WS_SECRET });
        if (bundle) return Promise.resolve({ SecretString: bundle });
        return Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} }));
      }
      if (cmd instanceof CreateSecretCommand) {
        return Promise.reject(new ResourceExistsException({ message: 'exists', $metadata: {} }));
      }
      if (cmd instanceof PutSecretValueCommand) return Promise.resolve({ ARN: 'arn:x' });
      return Promise.resolve({});
    });

    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
      { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
    );
    const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
      { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
    );
    const printed: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      printed.push(line);
      const m = line.match(/[?&]state=([^&\s]+)/);
      if (m) capturedState = decodeURIComponent(m[1]);
    });
    try {
      await makeLinearCommand().parseAsync([
        'node', 'bgagent', 'setup', 'demo',
        '--client-id', 'cid', '--client-secret', 'csecret',
        '--webhook-secret', 'lin_wh_suppliedByOperator', '--no-browser',
      ]);
    } finally {
      cfgSpy.mockRestore();
      credSpy.mockRestore();
      logSpy.mockRestore();
    }

    const registryPut = ddbSend.mock.calls
      .map((c) => c[0])
      .find((cmd) => cmd instanceof PutCommand && cmd.input.TableName === 'registry-table');
    expect((registryPut as InstanceType<typeof PutCommand>).input.Item?.webhook_secret_owned).toBe(true);

    const bundleWrites = smSend.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is InstanceType<typeof PutSecretValueCommand> => cmd instanceof PutSecretValueCommand)
      .map((put) => [put.input.SecretId, (JSON.parse(String(put.input.SecretString)) as { webhook_signing_secret?: string }).webhook_signing_secret]);
    expect(bundleWrites).toEqual([[PER_WORKSPACE_NAME, 'lin_wh_suppliedByOperator']]);
    expect(printed).toContain('  ✓ Using the webhook signing secret you entered');
  });

  test('ends by linking the admin to the member they pick, never to the app\'s own user', async () => {
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        if (cmd.input.SecretId === WEBHOOK_ARN) return Promise.resolve({ SecretString: OTHER_WS_SECRET });
        return Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} }));
      }
      if (cmd instanceof CreateSecretCommand) return Promise.resolve({ ARN: 'arn:x' });
      return Promise.resolve({});
    });
    // With `actor=app` the Linear token belongs to the app's bot user, not to whoever ran `setup`.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: { id: 'bot' },
          organization: { id: 'org-demo', name: 'Demo', urlKey: 'demo' },
          teams: { nodes: [] },
          users: {
            nodes: [
              { id: 'bot', name: 'bgagent', email: 'bot-uuid@oauthapp.linear.app' },
              { id: 'u-1', name: 'Admin', email: 'admin@demo.test' },
            ],
          },
        },
      }),
    }));
    typed = ['1'];
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
      { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
    );
    const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
      { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
    );
    const printed: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      printed.push(line);
      const m = line.match(/[?&]state=([^&\s]+)/);
      if (m) capturedState = decodeURIComponent(m[1]);
    });
    try {
      await makeLinearCommand().parseAsync([
        'node', 'bgagent', 'setup', 'demo',
        '--client-id', 'cid', '--client-secret', 'csecret',
        '--webhook-secret', 'lin_wh_suppliedByOperator', '--no-browser',
      ]);
    } finally {
      typed = [];
      if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
      else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      cfgSpy.mockRestore();
      credSpy.mockRestore();
      logSpy.mockRestore();
    }

    const userMappings = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is InstanceType<typeof PutCommand> =>
        cmd instanceof PutCommand && cmd.input.TableName === 'user-mapping-table')
      .map((put) => put.input.Item);
    expect(userMappings).toEqual([{
      linear_identity: 'org-demo#u-1',
      platform_user_id: 'sub-abc',
      linear_workspace_id: 'org-demo',
      linear_user_id: 'u-1',
      linked_at: expect.any(String),
      status: 'active',
      link_method: 'auto_setup_oauth',
    }]);
    expect(printed).toContain('    1. Admin (admin@demo.test)');
    expect(printed.join('\n')).not.toContain('oauthapp.linear.app');
  });

  describe('refuses before anything is written', () => {
    const DEMO_ROW = { linear_workspace_id: 'org-demo', workspace_slug: 'demo', status: 'active' };
    const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let configDir: string;

    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      typed = [];
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-linear-setup-'));
      process.env.BGAGENT_CONFIG_DIR = configDir;
    });

    afterEach(() => {
      if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
      else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      delete process.env.BGAGENT_CONFIG_DIR;
      fs.rmSync(configDir, { recursive: true, force: true });
    });

    function saveConsent(): void {
      savePendingConsent({
        slug: 'demo',
        state: 'state-1',
        codeVerifier: 'verifier-1',
        clientId: 'cid',
        redirectUri: 'https://consent.example.test/',
        createdAt: new Date().toISOString(),
      });
    }

    function deployConsentPage(): void {
      cfnSend.mockResolvedValue({
        Stacks: [{
          Outputs: [
            { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
            { OutputKey: 'LinearUserMappingTableName', OutputValue: 'user-mapping-table' },
            { OutputKey: 'LinearWebhookSecretArn', OutputValue: WEBHOOK_ARN },
            { OutputKey: 'LinearVaultConsentUrl', OutputValue: 'https://consent.example.test/' },
          ],
        }],
      });
    }

    function stubSecrets(
      bundle: string | undefined,
      readStackWide: () => Promise<unknown> = async () => ({ SecretString: OTHER_WS_SECRET }),
    ): void {
      smSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetSecretValueCommand) {
          if (cmd.input.SecretId === WEBHOOK_ARN) return readStackWide();
          if (cmd.input.SecretId === PER_WORKSPACE_NAME && bundle) return Promise.resolve({ SecretString: bundle });
          return Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} }));
        }
        if (cmd instanceof CreateSecretCommand) {
          return Promise.reject(new ResourceExistsException({ message: 'exists', $metadata: {} }));
        }
        if (cmd instanceof PutSecretValueCommand) return Promise.resolve({ ARN: `arn:${cmd.input.SecretId}` });
        return Promise.resolve({});
      });
    }

    function stubRegistry(scan: () => Promise<unknown>): void {
      ddbSend.mockImplementation((cmd: unknown) => (cmd instanceof ScanCommand ? scan() : Promise.resolve({})));
    }

    function authorize(organization: { id: string; urlKey: string }): void {
      fetchMock.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: { viewer: { id: 'viewer-1' }, organization, teams: { nodes: [] }, users: { nodes: [] } },
        }),
      }));
    }

    async function runLinear(...argv: string[]): Promise<void> {
      const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
        { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
      );
      const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
        { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
      );
      const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        const m = args.map(String).join(' ').match(/[?&]state=([^&\s]+)/);
        if (m) capturedState = decodeURIComponent(m[1]);
      });
      try {
        await makeLinearCommand().parseAsync(['node', 'bgagent', ...argv]);
      } finally {
        cfgSpy.mockRestore();
        credSpy.mockRestore();
        logSpy.mockRestore();
      }
    }

    function runSetup(webhookSecret: string, ...more: string[]): Promise<void> {
      return runLinear(
        'setup', 'demo',
        '--client-id', 'cid', '--client-secret', 'csecret', '--webhook-secret', webhookSecret, '--no-browser',
        ...more,
      );
    }

    const writes = (): string[] => [...smSend.mock.calls, ...ddbSend.mock.calls]
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof CreateSecretCommand || cmd instanceof PutSecretValueCommand || cmd instanceof PutCommand)
      .map((cmd) => cmd.constructor.name);

    test('a registry that cannot be read', async () => {
      stubSecrets(undefined);
      stubRegistry(() => Promise.reject(throttled()));

      await expect(runSetup('lin_wh_suppliedByOperator')).rejects.toThrow('Rate exceeded');
      expect(writes()).toEqual([]);
    });

    test('a registry that cannot be read, before `--code` uses up the saved consent', async () => {
      saveConsent();
      stubSecrets(undefined);
      stubRegistry(() => Promise.reject(throttled()));

      await expect(runSetup('lin_wh_suppliedByOperator', '--code', 'code=abc&state=state-1'))
        .rejects.toThrow('Rate exceeded');
      expect(takePendingConsent('demo').codeVerifier).toBe('verifier-1');
    });

    describe('an answer whose OAuth state is not the one this machine sent', () => {
      test('to the loopback listener of `setup`', async () => {
        stubSecrets(undefined);
        stubRegistry(() => Promise.resolve({ Items: [] }));
        awaitOauthCallbackMock.mockResolvedValueOnce({ kind: 'direct-oauth', code: 'auth-code', state: 'not-the-state' });

        await expect(runSetup('lin_wh_suppliedByOperator')).rejects.toThrow(/OAuth state mismatch/);
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });

      test('to the loopback listener of `add-workspace`', async () => {
        stubSecrets(priorWorkspaceBundle());
        stubRegistry(() => Promise.resolve({ Items: [{ ...DEMO_ROW, oauth_secret_arn: PER_WORKSPACE_NAME }] }));
        awaitOauthCallbackMock.mockResolvedValueOnce({ kind: 'direct-oauth', code: 'auth-code', state: 'not-the-state' });

        await expect(runLinear('add-workspace', 'beta', '--no-browser')).rejects.toThrow(/OAuth state mismatch/);
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });

      test('pasted from the consent page', async () => {
        deployConsentPage();
        upsertLinearCredentialProviderMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND bedrock-agentcore-control'));
        stubSecrets(undefined);
        stubRegistry(() => Promise.resolve({ Items: [] }));
        typed = ['code=abc&state=not-the-state'];

        await expect(runSetup('lin_wh_suppliedByOperator')).rejects.toThrow(/OAuth state mismatch/);
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });

      test('pasted to `--code`, for the consent an earlier run saved', async () => {
        saveConsent();
        stubSecrets(undefined);
        stubRegistry(() => Promise.resolve({ Items: [] }));

        await expect(runSetup('lin_wh_suppliedByOperator', '--code', 'code=abc&state=not-the-state'))
          .rejects.toThrow(/OAuth state mismatch/);
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });
    });

    describe('a workspace that is on the Identity vault, when the run would not use the vault', () => {
      const VAULT_ROW = { ...DEMO_ROW, provider_name: 'bgagent-linear-oauth-demo' };

      test('on a stack that was deployed again without the vault', async () => {
        stubSecrets(priorWorkspaceBundle());
        stubRegistry(() => Promise.resolve({ Items: [VAULT_ROW] }));

        await expect(runSetup('')).rejects.toThrow(/already onboarded through the AgentCore Identity vault/);
        expect(awaitOauthCallbackMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });

      test('with `--code`, which finishes a consent of the Secrets Manager path', async () => {
        deployConsentPage();
        saveConsent();
        stubSecrets(priorWorkspaceBundle());
        stubRegistry(() => Promise.resolve({ Items: [VAULT_ROW] }));

        await expect(runSetup('', '--code', 'code=abc&state=state-1')).rejects.toThrow(
          /already onboarded through the AgentCore Identity vault[\s\S]*re-run without `--code`/,
        );
        expect(upsertLinearCredentialProviderMock).not.toHaveBeenCalled();
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });
    });

    test('a stored secret that is the stack-wide one, when the operator supplies none', async () => {
      const readStackWide = jest.fn()
        .mockResolvedValueOnce({ SecretString: OTHER_WS_SECRET })
        .mockRejectedValue(throttled());
      stubSecrets(priorWorkspaceBundle(OTHER_WS_SECRET), readStackWide);
      stubRegistry(() => Promise.resolve({ Items: [DEMO_ROW] }));

      await expect(runSetup('')).rejects.toThrow(/no webhook signing secret of its own/);
      expect(writes()).toEqual([]);
    });

    test('a value that is not a signing secret, without telling a first install to skip it', async () => {
      stubSecrets(undefined);
      stubRegistry(() => Promise.resolve({ Items: [] }));

      const refusal = await runSetup('abc').catch((err: Error) => err.message);

      expect(refusal).toMatch(/does not look like a Linear webhook signing secret/);
      expect(refusal).not.toMatch(/skip|Enter|update-webhook-secret/);
      expect(writes()).toEqual([]);
    });

    test('a value that is not a signing secret, saying that Enter keeps a secret already stored', async () => {
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: [DEMO_ROW] }));

      const refusal = await runSetup('abc').catch((err: Error) => err.message);

      expect(refusal).toMatch(/press Enter to keep the one already stored/);
      expect(refusal).not.toMatch(/skip/);
      expect(writes()).toEqual([]);
    });

    test('and the help of --webhook-secret says what an empty value does: keep, not skip', () => {
      const setup = makeLinearCommand().commands.find((c) => c.name() === 'setup');
      const help = setup?.options.find((o) => o.long === '--webhook-secret')?.description;

      expect(help).toMatch(/empty value to keep the secret already stored/);
      expect(help).not.toMatch(/skip/);
    });

    test.each([
      ['registered to another workspace', [DEMO_ROW]],
      ['not registered', []],
    ])('a workspace other than the one the slug names (slug %s)', async (_slugIs, rows) => {
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: rows }));
      authorize({ id: 'org-alpha', urlKey: 'alpha' });

      await expect(runSetup('')).rejects.toThrow(/does not match Linear's urlKey 'alpha'/);
      expect(writes()).toEqual([]);
    });

    test('but not a workspace renamed in Linear, under the slug it is registered with', async () => {
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: [DEMO_ROW] }));
      authorize({ id: 'org-demo', urlKey: 'demo-renamed' });

      await runSetup('');

      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });

    test('and not a workspace whose URL key cannot be a slug, under a slug that is free', async () => {
      // Linear has URL keys shorter than the 4 characters of the shortest slug (linear.app/n8n).
      stubSecrets(undefined);
      stubRegistry(() => Promise.resolve({ Items: [] }));
      authorize({ id: 'org-n8n', urlKey: 'n8n' });

      await runSetup('lin_wh_suppliedByOperator');

      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });

    test('but a slug that is registered to another workspace, whatever the URL key of the one authorized', async () => {
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: [DEMO_ROW] }));
      authorize({ id: 'org-n8n', urlKey: 'n8n' });

      await expect(runSetup('')).rejects.toThrow(/does not match Linear's urlKey 'n8n'/);
      expect(writes()).toEqual([]);
    });

    const REMOVED = { status: 'revoked', revoked_reason: 'admin_removed' };

    test.each([
      ['active', [DEMO_ROW]],
      ['revoked when its grant died', [{ ...DEMO_ROW, status: 'revoked', revoked_reason: 'refresh_token_rejected' }]],
      ['active, read after the row of one that `remove-workspace` ended', [{ ...DEMO_ROW, ...REMOVED, linear_workspace_id: 'org-gone' }, DEMO_ROW]],
    ])('and a slug that is registered to another workspace, when the one authorized has it as URL key (registration %s)', async (_registration, rows) => {
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: rows }));
      authorize({ id: 'org-other', urlKey: 'demo' });

      await expect(runSetup('')).rejects.toThrow(
        'Slug \'demo\' is registered to another Linear workspace (org-demo)',
      );
      expect(writes()).toEqual([]);
    });

    test('but not a slug whose registration `remove-workspace` ended', async () => {
      stubSecrets(undefined);
      stubRegistry(() => Promise.resolve({ Items: [{ ...DEMO_ROW, ...REMOVED }] }));
      authorize({ id: 'org-other', urlKey: 'demo' });

      await runSetup('lin_wh_suppliedByOperator');

      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });

    test('and not the workspace that is registered with the slug, read after the row of one whose grant died', async () => {
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({
        Items: [{ ...DEMO_ROW, linear_workspace_id: 'org-dead', status: 'revoked', revoked_reason: 'refresh_token_rejected' }, DEMO_ROW],
      }));
      authorize({ id: 'org-demo', urlKey: 'demo' });

      await runSetup('');

      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });

    test('and not on the Identity vault, where a refusal would repeat on every later run', async () => {
      deployConsentPage();
      upsertLinearCredentialProviderMock.mockResolvedValue({
        providerName: 'bgagent-linear-oauth-demo', callbackUrl: 'https://callback.example.test/', created: false,
      });
      beginVaultConsentMock.mockResolvedValue({ kind: 'already-consented', poll: async () => 'vault-token' });
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: [] }));
      authorize({ id: 'org-alpha', urlKey: 'alpha' });

      await runSetup('');

      expect(beginVaultConsentMock).toHaveBeenCalledTimes(1);
      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });
  });
});
