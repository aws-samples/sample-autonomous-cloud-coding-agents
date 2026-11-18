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

// Companion to jira.test.ts: covers the Linear adapter's CLI helper twins
// (openBrowser / upsertOauthSecret / command surface). These mirror the Jira
// helpers and were previously untested at the unit level.
import {
  CreateSecretCommand,
  type GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  makeLinearCommand,
  openBrowser,
  upsertOauthSecret,
} from '../../src/commands/linear';
import * as configMod from '../../src/config';
import type { StoredLinearOauthToken } from '../../src/linear-oauth';
import * as promptSecretMod from '../../src/prompt-secret';

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const linearLinkMock = jest.fn();
jest.mock('../../src/api-client', () => ({
  ApiClient: jest.fn(() => ({ linearLink: linearLinkMock })),
}));

// SecretsManagerClient — `list-projects` enumerates OAuth-install secrets.
const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  };
});

// CloudFormation — `findStackOutput` resolves stack outputs at setup time.
const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
  };
});

// DynamoDB — `backfill-secret-provenance` reads the workspace registry and updates its rows;
// `list-projects` looks a workspace up in it.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  };
});

// linear-vault: PARTIAL mock of the one call that reaches AgentCore.
const mintLinearTokenFromVaultMock = jest.fn();
jest.mock('../../src/linear-vault', () => {
  const actual = jest.requireActual('../../src/linear-vault');
  return {
    ...actual,
    mintLinearTokenFromVault: (...args: unknown[]) => mintLinearTokenFromVaultMock(...args),
  };
});

function sampleToken(overrides: Partial<StoredLinearOauthToken> = {}): StoredLinearOauthToken {
  return {
    access_token: 'access-xyz',
    refresh_token: 'refresh-xyz',
    expires_at: '2026-06-17T01:00:00.000Z',
    scope: 'read write',
    client_id: 'client-id',
    client_secret: 'client-secret',
    workspace_id: 'org-uuid',
    workspace_slug: 'acme',
    installed_at: '2026-06-17T00:00:00.000Z',
    updated_at: '2026-06-17T00:00:00.000Z',
    installed_by_platform_user_id: 'sub-abc',
    ...overrides,
  };
}

describe('linear openBrowser', () => {
  beforeEach(() => execFileMock.mockReset());

  test('resolves true when the OS opener succeeds', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    await expect(openBrowser('https://example.test')).resolves.toBe(true);
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

describe('linear upsertOauthSecret', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof upsertOauthSecret>[0];

  beforeEach(() => mockSend.mockReset());

  test('creates the secret and returns its ARN on first install', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:new' });
    const arn = await upsertOauthSecret(mockClient, 'bgagent-linear-oauth-acme', sampleToken(), 'acme');
    expect(arn).toBe('arn:new');
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateSecretCommand);
  });

  test('falls back to PutSecretValue when the secret already exists', async () => {
    mockSend
      .mockRejectedValueOnce(new ResourceExistsException({ message: 'exists', $metadata: {} }))
      .mockResolvedValueOnce({ ARN: 'arn:existing' });
    const arn = await upsertOauthSecret(mockClient, 'bgagent-linear-oauth-acme', sampleToken(), 'acme');
    expect(arn).toBe('arn:existing');
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(PutSecretValueCommand);
  });

  test('rethrows non-ResourceExists errors', async () => {
    const err = new Error('kms denied');
    err.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(err);
    await expect(
      upsertOauthSecret(mockClient, 'bgagent-linear-oauth-acme', sampleToken(), 'acme'),
    ).rejects.toThrow('kms denied');
  });
});

describe('makeLinearCommand', () => {
  test('registers the expected subcommands', () => {
    const cmd = makeLinearCommand();
    expect(cmd.name()).toBe('linear');
    const names = cmd.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['app-template', 'setup', 'link']));
  });

  test('link --output json links and prints the result, skipping the preview', async () => {
    linearLinkMock.mockReset().mockResolvedValueOnce({ linked_at: '2026-06-17T03:00:00.000Z' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    try {
      const program = makeLinearCommand();
      await program.parseAsync(['node', 'bgagent', 'link', 'link-abc', '--output', 'json']);
      expect(linearLinkMock).toHaveBeenCalledTimes(1);
      expect(linearLinkMock).toHaveBeenCalledWith('link-abc');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('2026-06-17T03:00:00.000Z'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('link text mode previews via dry-run, prompts, then links on confirm', async () => {
    linearLinkMock
      .mockReset()
      .mockResolvedValueOnce({
        linear_user_name: 'Maya K',
        linear_user_email: 'maya@example.test',
        linear_workspace_slug: 'acme',
      })
      .mockResolvedValueOnce({ linked_at: '2026-06-17T04:00:00.000Z' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline') as typeof import('readline');
    // Linear's promptLine uses the non-TTY branch (rl.once('line', …)) under Jest.
    const rlMock = {
      once: (event: string, cb: (line: string) => void) => {
        if (event === 'line') cb('y');
      },
      close: jest.fn(),
    };
    const rlSpy = jest.spyOn(readline, 'createInterface').mockReturnValue(rlMock as unknown as ReturnType<typeof readline.createInterface>);
    try {
      const program = makeLinearCommand();
      await program.parseAsync(['node', 'bgagent', 'link', 'link-abc']);
      expect(linearLinkMock).toHaveBeenCalledWith('link-abc', { dryRun: true });
      expect(linearLinkMock).toHaveBeenCalledWith('link-abc');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Linear account linked'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      rlSpy.mockRestore();
    }
  });

  test.each(['setup', 'add-workspace', 'update-webhook-secret', 'remove-workspace', 'invite-user'])(
    '%s refuses a slug that cannot be a workspace URL key, before it reads anything',
    async (command) => {
      await expect(makeLinearCommand().parseAsync(['node', 'bgagent', command, 'a!'])).rejects.toThrow(
        'Invalid workspace slug \'a!\'. Must be 4-50 chars matching [a-zA-Z0-9_-]. '
        + 'This is the Linear urlKey, e.g. \'acme\' from linear.app/acme/...',
      );

      expect(cfnSend).not.toHaveBeenCalled();
      expect(smSend).not.toHaveBeenCalled();
      expect(ddbSend).not.toHaveBeenCalled();
    },
  );

  describe.each(['setup', 'add-workspace', 'invite-user'])('%s, which records the platform user who ran it', (command) => {
    // The three read that user from the cached ID token. `setup` and `add-workspace` used to
    // wrap a token they could not read in a sentence of their own, and `invite-user` printed
    // the bare reason, with no remedy.
    test.each([
      ['no login', null, 'Not authenticated. Run `bgagent login` first.'],
      ['an ID token that cannot be read', { id_token: 'not-a-jwt' }, 'Credentials file is corrupt. Run `bgagent login` to re-authenticate.'],
    ])('fails on %s with the error of every command that needs a login', async (_what, credentials, message) => {
      cfnSend.mockReset().mockResolvedValue({
        Stacks: [{
          Outputs: ['LinearWorkspaceRegistryTableName', 'LinearUserMappingTableName', 'LinearWebhookSecretArn']
            .map((OutputKey) => ({ OutputKey, OutputValue: `value-of-${OutputKey}` })),
        }],
      });
      const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
      const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(credentials as ReturnType<typeof configMod.loadCredentials>);
      try {
        const failure = await makeLinearCommand().parseAsync(['node', 'bgagent', command, 'acme']).catch((err: Error) => err.message);

        expect(failure).toBe(message);
        expect(smSend).not.toHaveBeenCalled();
        expect(ddbSend).not.toHaveBeenCalled();
      } finally {
        cfgSpy.mockRestore();
        credSpy.mockRestore();
      }
    });
  });

  test('setup aborts with a clear error when stack outputs are missing (covers findStackOutput)', async () => {
    cfnSend.mockReset().mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    try {
      const program = makeLinearCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'setup', 'acme']),
      ).rejects.toThrow(/missing outputs/);
    } finally {
      cfgSpy.mockRestore();
    }
  });

  test('list-projects exits when there are no OAuth installs in the registry', async () => {
    smSend.mockReset().mockResolvedValue({ SecretList: [], NextToken: undefined });
    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    try {
      const program = makeLinearCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'list-projects']),
      ).rejects.toThrow('process.exit:1');
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('No Linear OAuth installs'))).toBe(true);
    } finally {
      cfgSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('app-template offers no --bot-name — Linear\'s app form has no such field', () => {
    // Verified against the live form: there is no GitHub username field, so a flag
    // that fills one in only invites operators to look for something absent.
    const program = makeLinearCommand();
    const appTemplate = program.commands.find((c) => c.name() === 'app-template');
    const flags = (appTemplate?.options ?? []).map((o) => o.long);
    expect(flags).not.toContain('--bot-name');
    expect(flags).toContain('--app-name');
  });

  test('app-template offers no --aws-callback-url: the CLI sends no redirect URI of the operator\'s choosing', () => {
    // The option made the template print any URL as the app's Redirect URI. `setup` and
    // `add-workspace` send the loopback, the consent page or the vault callback and nothing
    // else, so an app registered with that URL failed consent with "Invalid redirect_uri".
    const appTemplate = makeLinearCommand().commands.find((c) => c.name() === 'app-template');
    const flags = (appTemplate?.options ?? []).map((o) => o.long);
    expect(flags).not.toContain('--aws-callback-url');
    expect(flags).toContain('--vault-callback-url');
  });
});

describe('linear list-projects --slug', () => {
  const originalFetch = global.fetch;
  let out: string[];
  let err: string[];
  let cfgSpy: jest.SpiedFunction<typeof configMod.loadConfig>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let errSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    // The bundle of `acme` holds a token; the stack publishes no registry, so no vault lookup.
    smSend.mockReset().mockResolvedValue({ SecretString: JSON.stringify({ access_token: 'tok-acme' }) });
    cfnSend.mockReset().mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    out = [];
    err = [];
    cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => { out.push(String(line)); });
    errSpy = jest.spyOn(console, 'error').mockImplementation((line?: unknown) => { err.push(String(line)); });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    cfgSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  /** Run the command with Linear giving `response` to the projects query. */
  async function listProjects(response: { ok: boolean; status: number; body?: unknown }): Promise<void> {
    global.fetch = jest.fn(async () => ({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    })) as unknown as typeof fetch;
    await makeLinearCommand().parseAsync(['node', 'bgagent', 'list-projects', '--slug', 'acme']);
  }

  test('lists the projects Linear returns', async () => {
    await listProjects({
      ok: true,
      status: 200,
      body: { data: { projects: { nodes: [{ id: 'p-1', name: 'Roadmap', teams: { nodes: [{ name: 'Platform' }] } }] } } },
    });
    expect(out).toEqual(expect.arrayContaining([
      'Found 1 Linear project(s):\n',
      '  Roadmap',
      '    id:        p-1',
      '    workspace: acme',
      '    team:      Platform',
    ]));
    expect(err).toEqual([]);
  });

  test.each([
    ['an empty list', { data: { projects: { nodes: [] } } }],
    ['a list without nodes', { data: { projects: {} } }],
  ])('says that the workspace has no projects when Linear returns %s', async (_what, body) => {
    await listProjects({ ok: true, status: 200, body });
    expect(out).toContain('Workspace \'acme\' has no projects yet.');
    expect(err).toEqual([]);
  });

  // Linear answers a token it refuses with HTTP 200 and an `errors` array, with no data.
  // Read as an empty project list, the operator was told to create a project in Linear.
  test.each([
    ['an `errors` answer', { ok: true, status: 200, body: { errors: [{ message: 'Authentication required' }] } }, 'Authentication required'],
    ['an HTTP error', { ok: false, status: 401 }, '401'],
  ])('reports %s as the workspace failing, not as a workspace without projects', async (_what, response, reason) => {
    await listProjects(response);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('acme');
    expect(err[0]).toContain(reason);
    expect(out.join('\n')).not.toMatch(/has no projects yet/);
  });

  test('asks the Identity vault first for a workspace that is on it', async () => {
    // Such a workspace has no access token in its bundle, by design. The command has to hand
    // the registry and the stack's workload name to the lookup, or it fails on the workspaces
    // that work.
    cfnSend.mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
          { OutputKey: 'LinearVaultWorkloadName', OutputValue: 'wl-of-this-stack' },
        ],
      }],
    });
    ddbSend.mockReset().mockResolvedValue({
      Items: [{
        workspace_slug: 'acme', linear_workspace_id: 'org-acme', provider_name: 'bgagent-linear-oauth-acme', vault_user_id: 'linear-ws-acme',
      }],
    });
    smSend.mockResolvedValue({ SecretString: JSON.stringify({ refresh_token: '' }) });
    mintLinearTokenFromVaultMock.mockReset().mockResolvedValue({ kind: 'token', accessToken: 'vault-tok' });

    await listProjects({ ok: true, status: 200, body: { data: { projects: { nodes: [{ id: 'p-1', name: 'Roadmap' }] } } } });

    expect(mintLinearTokenFromVaultMock).toHaveBeenCalledWith({
      region: 'us-west-2',
      workloadName: 'wl-of-this-stack',
      providerName: 'bgagent-linear-oauth-acme',
      userId: 'linear-ws-acme',
    });
    expect(global.fetch).toHaveBeenCalledWith('https://api.linear.app/graphql', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer vault-tok' }),
    }));
    expect(out).toContain('  Roadmap');
    expect(err).toEqual([]);
  });

  test('skips a workspace that has no usable token, and says why', async () => {
    smSend.mockResolvedValue({ SecretString: JSON.stringify({ refresh_token: 'r' }) });

    await listProjects({ ok: true, status: 200, body: { data: { projects: { nodes: [] } } } });

    expect(err).toEqual(['Skipping \'acme\': secret bgagent-linear-oauth-acme is missing access_token']);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(out).toContain('No projects listed: 1 of 1 workspace(s) could not be queried (see the errors above).');
  });
});

describe('linear invite-user', () => {
  const originalFetch = global.fetch;
  // The member pick is read through readline only when stdin is not a terminal, which it is
  // when one file is run from a shell. Pinned, so that the test does not wait for keys.
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  afterEach(() => {
    if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    global.fetch = originalFetch;
  });

  test('asks the Identity vault first for a workspace that is on it', async () => {
    // The command carries its own copy of the rule `list-projects` and `onboard-project` take
    // from resolveWorkspaceAccessToken: the bundle of such a workspace holds no token.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
          { OutputKey: 'LinearUserMappingTableName', OutputValue: 'user-mapping-table' },
          { OutputKey: 'LinearVaultWorkloadName', OutputValue: 'wl-of-this-stack' },
        ],
      }],
    });
    ddbSend.mockReset().mockResolvedValue({
      Items: [{
        workspace_slug: 'acme',
        linear_workspace_id: 'org-acme',
        oauth_secret_arn: 'arn:acme',
        status: 'active',
        provider_name: 'bgagent-linear-oauth-acme',
        vault_user_id: 'linear-ws-acme',
      }],
    });
    smSend.mockReset().mockResolvedValue({ SecretString: JSON.stringify({ refresh_token: '' }) });
    mintLinearTokenFromVaultMock.mockReset().mockResolvedValue({ kind: 'token', accessToken: 'vault-tok' });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { users: { nodes: [{ id: 'user-maya', name: 'Maya K' }] } } }),
    })) as unknown as typeof fetch;
    const idToken = `x.${Buffer.from(JSON.stringify({ sub: 'sub-abc' })).toString('base64url')}.y`;
    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue({ id_token: idToken } as ReturnType<typeof configMod.loadCredentials>);
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    // The progress line goes to stdout and the prompt to stderr, without console.log.
    const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const readline = jest.requireActual<typeof import('readline')>('readline');
    const rlSpy = jest.spyOn(readline, 'createInterface').mockReturnValue({
      once: (event: string, cb: (line: string) => void) => {
        if (event === 'line') cb('1');
      },
      close: jest.fn(),
    } as unknown as ReturnType<typeof readline.createInterface>);
    try {
      await makeLinearCommand().parseAsync(['node', 'bgagent', 'invite-user', 'acme']);
    } finally {
      cfgSpy.mockRestore();
      credSpy.mockRestore();
      logSpy.mockRestore();
      outSpy.mockRestore();
      errSpy.mockRestore();
      rlSpy.mockRestore();
    }

    expect(mintLinearTokenFromVaultMock).toHaveBeenCalledWith({
      region: 'us-west-2',
      workloadName: 'wl-of-this-stack',
      providerName: 'bgagent-linear-oauth-acme',
      userId: 'linear-ws-acme',
    });
    expect(global.fetch).toHaveBeenCalledWith('https://api.linear.app/graphql', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer vault-tok' }),
    }));
    const invite = ddbSend.mock.calls.map(([cmd]) => cmd).find((cmd) => cmd instanceof PutCommand);
    expect(invite?.input.Item).toMatchObject({ linear_workspace_id: 'org-acme', linear_user_id: 'user-maya', status: 'pending' });
  });
});

describe('linear backfill-secret-provenance', () => {
  const STACK_WIDE_ARN = 'arn:stack-wide-webhook-secret';
  let out: string[];
  let cfgSpy: jest.SpiedFunction<typeof configMod.loadConfig>;
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
          { OutputKey: 'LinearWebhookSecretArn', OutputValue: STACK_WIDE_ARN },
        ],
      }],
    });
    // Each workspace stores a signing secret of its own: none equals the stack-wide one.
    smSend.mockReset().mockImplementation(async (cmd: GetSecretValueCommand) => (
      cmd.input.SecretId === STACK_WIDE_ARN
        ? { SecretString: 'lin_wh_stackWide' }
        : { SecretString: JSON.stringify({ webhook_signing_secret: `lin_wh_${cmd.input.SecretId}` }) }
    ));
    out = [];
    cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => { out.push(String(line)); });
  });

  afterEach(() => {
    cfgSpy.mockRestore();
    logSpy.mockRestore();
  });

  /**
   * Run the command on a registry of active workspaces; `update` answers the write for each.
   * The rows of `recorded` already say that the workspace owns its secret.
   */
  async function backfill(
    slugs: string[],
    update: (slug: string) => Promise<unknown>,
    { recorded = [], flags = [] }: { recorded?: string[]; flags?: string[] } = {},
  ): Promise<void> {
    ddbSend.mockReset().mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ScanCommand) {
        return {
          Items: slugs.map((slug) => ({
            workspace_slug: slug,
            linear_workspace_id: `org-${slug}`,
            oauth_secret_arn: `arn:${slug}`,
            status: 'active',
            ...(recorded.includes(slug) && { webhook_secret_owned: true }),
          })),
        };
      }
      if (cmd instanceof UpdateCommand) return update(String(cmd.input.Key?.linear_workspace_id).slice('org-'.length));
      throw new Error('unexpected command');
    });
    await makeLinearCommand().parseAsync(['node', 'bgagent', 'backfill-secret-provenance', ...flags]);
  }

  test('reports a workspace whose row disappeared during the run as skipped, and does not count it', async () => {
    // `remove-workspace --purge` between the scan and the write. The write is conditional on
    // the row still being there, so that it is not put back; the command printed "skipped"
    // and then "recorded" for that workspace, and counted it.
    const rowGone = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

    await backfill(['alpha', 'gamma'], (slug) => (slug === 'gamma' ? Promise.reject(rowGone) : Promise.resolve({})));

    expect(out.filter((line) => /alpha|gamma|Recorded/.test(line))).toEqual([
      '  ✓ alpha: recorded as owning its secret',
      '  · gamma: row changed underneath the backfill — skipped',
      '✓ Recorded 1 workspace(s).',
    ]);
  });

  test('stops on any other failure of the write', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

    await expect(backfill(['alpha'], () => Promise.reject(throttled))).rejects.toThrow('Rate exceeded');

    expect(out.filter((line) => line.includes('recorded as owning'))).toEqual([]);
  });

  describe('on a registry where one workspace of four is known to own its secret', () => {
    // alpha stores a secret of its own. beta stores a copy of the stack-wide one, from a release
    // that copied it into the bundles. gamma stores none. delta was recorded by an earlier run.
    // A workspace recorded as owning a secret it shares is accepted by the webhook receiver for
    // deliveries that another workspace signed: the one outcome this command exists to prevent.
    const SLUGS = ['alpha', 'beta', 'gamma', 'delta'];
    const recorded = ['delta'];
    const written = async () => ({});
    /** The registry updates the run sent. */
    const updates = () => ddbSend.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof UpdateCommand).map((cmd) => cmd.input);

    beforeEach(() => {
      smSend.mockImplementation(async (cmd: GetSecretValueCommand) => {
        switch (cmd.input.SecretId) {
          case STACK_WIDE_ARN: return { SecretString: 'lin_wh_stackWide' };
          case 'arn:beta': return { SecretString: JSON.stringify({ webhook_signing_secret: 'lin_wh_stackWide' }) };
          case 'arn:gamma': return { SecretString: JSON.stringify({ access_token: 'tok-gamma' }) };
          default: return { SecretString: JSON.stringify({ webhook_signing_secret: `lin_wh_${cmd.input.SecretId}` }) };
        }
      });
    });

    test('records that one, and names the others that need a secret of their own', async () => {
      await backfill(SLUGS, written, { recorded });

      expect(updates()).toEqual([{
        TableName: 'registry-table',
        Key: { linear_workspace_id: 'org-alpha' },
        UpdateExpression: 'SET webhook_secret_owned = :t, updated_at = :u',
        ConditionExpression: 'attribute_exists(linear_workspace_id)',
        ExpressionAttributeValues: { ':t': true, ':u': expect.any(String) },
      }]);
      expect(out.filter((line) => /alpha|beta|gamma|delta|workspace\(s\)/.test(line))).toEqual([
        '4 active workspace(s). Stack-wide secret: set',
        '  ✓ alpha: recorded as owning its secret',
        '  ⚠ beta: holds the stack-wide secret, so ownership cannot be established',
        '  ⚠ gamma: has no signing secret of its own',
        '  · delta: already recorded as owning its secret',
        '✓ Recorded 1 workspace(s).',
        '⚠ 2 workspace(s) need a signing secret of their own.',
        '    bgagent linear update-webhook-secret beta',
        '    bgagent linear update-webhook-secret gamma',
      ]);
    });

    test('writes nothing with --dry-run, and says what it would record', async () => {
      await backfill(SLUGS, written, { recorded, flags: ['--dry-run'] });

      expect(updates()).toEqual([]);
      expect(out).toEqual(expect.arrayContaining([
        '  would record alpha as owning its secret',
        'Dry run: 1 workspace(s) would be recorded.',
      ]));
    });

    test('records nothing when the stack-wide secret cannot be read', async () => {
      // Every bundle holds a copy here. With nothing to compare it against, each copy would
      // pass for a secret of the workspace's own.
      smSend.mockImplementation(async (cmd: GetSecretValueCommand) => {
        if (cmd.input.SecretId !== STACK_WIDE_ARN) return { SecretString: JSON.stringify({ webhook_signing_secret: 'lin_wh_stackWide' }) };
        throw Object.assign(new Error('not authorized to perform secretsmanager:GetSecretValue'), { name: 'AccessDeniedException' });
      });

      await expect(backfill(SLUGS, written, { recorded })).rejects.toThrow(/Could not read the stack-wide webhook secret/);

      expect(updates()).toEqual([]);
    });
  });
});

describe('linear update-webhook-secret', () => {
  /** What the bundle of `acme` holds before the command runs. */
  const stored = sampleToken({ webhook_signing_secret: 'lin_wh_old' });
  let cfgSpy: jest.SpiedFunction<typeof configMod.loadConfig>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let promptSpy: jest.SpiedFunction<typeof promptSecretMod.promptSecret>;

  beforeEach(() => {
    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{ Outputs: [{ OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' }] }],
    });
    // The bundle exists, so it is written with PutSecretValue after CreateSecret is refused.
    smSend.mockReset().mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateSecretCommand) throw new ResourceExistsException({ message: 'exists', $metadata: {} });
      if (cmd instanceof PutSecretValueCommand) return { ARN: 'arn:acme' };
      return { SecretString: JSON.stringify(stored) };
    });
    ddbSend.mockReset().mockResolvedValue({});
    cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    promptSpy = jest.spyOn(promptSecretMod, 'promptSecret').mockResolvedValue('lin_wh_new');
  });

  afterEach(() => {
    cfgSpy.mockRestore();
    logSpy.mockRestore();
    promptSpy.mockRestore();
  });

  const run = (): Promise<unknown> => makeLinearCommand().parseAsync(['node', 'bgagent', 'update-webhook-secret', 'acme']);
  /** The bundle writes the run sent. */
  const bundleWrites = () => smSend.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof PutSecretValueCommand);
  /** The registry updates the run sent. */
  const registryUpdates = () => ddbSend.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof UpdateCommand).map((cmd) => cmd.input);

  test('replaces the signing secret in the bundle, keeps the rest of it, and records that the workspace owns it', async () => {
    // The repair takes both writes. The webhook receiver verifies a delivery against the bundle,
    // and on a stack with two workspaces only for a workspace whose row says the secret is its own.
    await run();

    expect(bundleWrites().map((put) => put.input.SecretId)).toEqual(['bgagent-linear-oauth-acme']);
    const written = JSON.parse(String(bundleWrites()[0].input.SecretString)) as typeof stored;
    expect(written).toEqual({ ...stored, webhook_signing_secret: 'lin_wh_new', updated_at: expect.any(String) });
    expect(Date.parse(written.updated_at)).toBeGreaterThan(Date.parse(stored.updated_at));
    expect(registryUpdates()).toEqual([{
      TableName: 'registry-table',
      Key: { linear_workspace_id: stored.workspace_id },
      UpdateExpression: 'SET webhook_secret_owned = :t, updated_at = :u',
      ConditionExpression: 'attribute_exists(linear_workspace_id)',
      ExpressionAttributeValues: { ':t': true, ':u': expect.any(String) },
    }]);
  });

  test.each([
    ['the workspace has no registry row', 'ConditionalCheckFailedException', /has no registry row/],
    ['the registry cannot be written', 'ThrottlingException', /could not record its provenance/],
  ])('fails when %s: the secret alone is half the repair', async (_why, name, failure) => {
    ddbSend.mockRejectedValue(Object.assign(new Error('refused'), { name }));

    await expect(run()).rejects.toThrow(failure);
  });

  test('fails when the stack publishes no registry table, instead of leaving the registry out', async () => {
    cfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });

    await expect(run()).rejects.toThrow(/could not find LinearWorkspaceRegistryTableName/);
    expect(registryUpdates()).toEqual([]);
  });

  test.each([
    ['is empty', '', /signing secret is required/],
    ['is not a signing secret', 'not-a-signing-secret', /start with 'lin_wh_'/],
  ])('stores nothing when what was pasted %s', async (_what, pasted, refusal) => {
    promptSpy.mockResolvedValue(pasted);

    await expect(run()).rejects.toThrow(refusal);
    expect(bundleWrites()).toEqual([]);
    expect(registryUpdates()).toEqual([]);
  });
});
