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

// #612 review B2 (issue #611 AC#3): end-to-end `linear setup` regression test
// for the SECOND-WORKSPACE RE-RUN case. The fail-closed pre-read
// (`readExistingWebhookSecret`) is unit-tested in linear-oauth.test.ts; this
// file closes the remaining gap by driving the `setup` ACTION through
// `parseAsync` (with a mocked OAuth flow) and asserting the per-workspace
// `PutSecretValue` payload — i.e. a re-run keeps THIS workspace's `lin_wh_`
// secret and never clobbers it with the stack-wide (other workspace's) one.
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

// ─── Mocks: external I/O the setup wizard touches before the secret logic ───

// OAuth callback server — never bind a real localhost socket. Resolves with the
// SAME `state` the wizard generated: we capture it from the authorization URL
// the wizard prints under --no-browser (see captureState below).
let capturedState = '';
// Resolve LAZILY: the wizard starts this promise (linear.ts) BEFORE it prints
// the authorization URL we scrape `state` from, so read capturedState after a
// macrotask — by which point the synchronous URL print has run.
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

// linear-oauth: PARTIAL mock — keep the real code under test
// (readExistingWebhookSecret + name/expiry/PKCE/URL helpers), stub only the
// network OAuth-code exchange.
const exchangeAuthorizationCodeMock = jest.fn();
jest.mock('../../src/linear-oauth', () => {
  const actual = jest.requireActual('../../src/linear-oauth');
  return {
    ...actual,
    exchangeAuthorizationCode: (...args: unknown[]) => exchangeAuthorizationCodeMock(...args),
  };
});

// linear-vault: PARTIAL mock of the two calls that reach AgentCore. Only a stack that
// publishes a consent page takes the vault path; one test below sets that up.
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

// The visible prompts read one line through readline when stdin is not a terminal. These are
// the lines the operator types, in order; Enter once they run out.
let typed: string[] = [];
jest.mock('readline', () => ({
  createInterface: () => ({
    once: (event: string, cb: (line: string) => void) => {
      if (event === 'line') cb(typed.shift() ?? '');
    },
    close: () => undefined,
  }),
}));

// A syntactically-valid id_token whose payload carries a `sub` claim, so
// cognitoSubFromSession() (JWT base64url decode) resolves without real creds.
const FAKE_ID_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'sub-abc' })).toString('base64url')}.y`;

const WEBHOOK_ARN = 'arn:aws:secretsmanager:us-west-2:111122223333:secret:LinearWebhookSecret-abc';
const PER_WORKSPACE_NAME = 'bgagent-linear-oauth-demo';
const THIS_WS_SECRET = 'lin_wh_thisWorkspace';
const OTHER_WS_SECRET = 'lin_wh_otherWorkspace';

/** The prior per-workspace OAuth bundle for `demo` — already carries ITS OWN
 *  webhook signing secret (the value a re-run must preserve, not clobber). */
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

    // Linear GraphQL (identity + team keys + self-link picker) all go through
    // fetch — benign viewer/org, empty team + member lists.
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
    // Skipping here is exactly how a workspace ended up holding the stack-wide
    // secret and 401ing on every delivery while looking installed. With nothing
    // legitimate to keep there is nothing to skip TO, so it is refused rather than
    // warned about — and refused BEFORE consent, so no browser work is wasted.
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        const id = (cmd as GetSecretValueCommand).input.SecretId ?? '';
        if (String(id).includes('bgagent-linear-oauth-')) {
          // No prior bundle at all — a genuine first install for this workspace.
          return Promise.reject(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
        }
        return Promise.resolve({ SecretString: 'lin_wh_stackWideOther' });
      }
      return Promise.resolve({});
    });

    // Stub the CLI config: without it this passes only on a machine that happens to
    // have `bgagent configure` run, and fails on a clean runner with "Not
    // configured" — which is what CI caught.
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
    // SM.send routing by command + target:
    //  1. pre-read GetSecretValue(per-workspace bundle) → prior bundle carrying
    //     lin_wh_thisWorkspace (the value a re-run must preserve).
    //  2. upsertOauthSecret: CreateSecret → ResourceExists → PutSecretValue
    //     (per-workspace) ← the write we assert.
    //  3. readStackWideWebhookSecret GetSecretValue(stack-wide ARN) → lin_wh_other
    //     (a DIFFERENT workspace's secret — the clobber source #611 lifted in).
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
    // Under --no-browser the wizard prints the authorization URL (which carries
    // ?state=…). Capture it so awaitOauthCallback echoes the SAME state and the
    // wizard's state check passes.
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
        // Empty webhook secret = keep the stored one, which is the PRESERVE path
        // this test is about. Passed as a flag so the run stays non-interactive.
        '--client-id', 'cid', '--client-secret', 'csecret', '--webhook-secret', '', '--no-browser',
      ]);
    } finally {
      cfgSpy.mockRestore();
      credSpy.mockRestore();
      logSpy.mockRestore();
    }

    // Sanity: the wizard actually reached the OAuth callback (state captured).
    expect(capturedState).not.toBe('');
    expect(awaitOauthCallbackMock).toHaveBeenCalled();

    // Every per-workspace PutSecretValue payload must carry THIS workspace's
    // secret and NEVER the stack-wide other's — the #611 clobber regression.
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

    // The stack-wide ARN is never overwritten by setup (rotation is
    // update-webhook-secret's job) — no PutSecretValue targets it.
    const stackWidePuts = smSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd instanceof PutSecretValueCommand && cmd.input.SecretId === WEBHOOK_ARN);
    expect(stackWidePuts).toHaveLength(0);

    // The registry row was still written (setup completed end-to-end).
    const registryPut = ddbSend.mock.calls
      .map((c) => c[0])
      .find((cmd) => cmd instanceof PutCommand && cmd.input.TableName === 'registry-table');
    expect(registryPut).toBeDefined();

    // Provenance: this workspace kept a `lin_wh_` secret that differs from the
    // stack-wide value, which is what proves the secret is its own. Recording it is
    // what later lets verification tell this workspace from one carrying an inherited
    // copy — and the flag must be a literal `true`, since the reader accepts nothing
    // else as proof.
    expect((registryPut as InstanceType<typeof PutCommand>).input.Item?.webhook_secret_owned).toBe(true);
  });

  test.each([
    ['with nothing stored', undefined],
    ['in place of the one stored', priorWorkspaceBundle()],
  ])('records ownership when the operator supplies this workspace\'s own secret (%s)', async (_stored, bundle) => {
    // The other reachable provenance path: the operator pastes the secret read off the
    // app being onboarded, on a first install or over the one an earlier run stored.
    // Ownership is proven by where the value came from, so it must be recorded here
    // too — otherwise a first install looks indistinguishable from one that inherited
    // its secret.
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

    // The bundle is written once, with the secret in it. It used to be written without the
    // secret, then the registry row above, then the bundle again: a second write that failed
    // left a row that says the workspace owns a secret its bundle did not hold.
    const bundleWrites = smSend.mock.calls
      .map((c) => c[0])
      .filter((cmd): cmd is InstanceType<typeof PutSecretValueCommand> => cmd instanceof PutSecretValueCommand)
      .map((put) => [put.input.SecretId, (JSON.parse(String(put.input.SecretString)) as { webhook_signing_secret?: string }).webhook_signing_secret]);
    expect(bundleWrites).toEqual([[PER_WORKSPACE_NAME, 'lin_wh_suppliedByOperator']]);
    expect(printed).toContain('  ✓ Using the webhook signing secret you entered');
  });

  test('ends by linking the admin to the member they pick, never to the app\'s own user', async () => {
    // With actor=app the token belongs to the app's bot user, so `setup` cannot tell who ran
    // it: it lists the members and asks. The row it then writes is the only user mapping the
    // CLI writes itself, under the key the webhook processor looks a Linear user up by.
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        if (cmd.input.SecretId === WEBHOOK_ARN) return Promise.resolve({ SecretString: OTHER_WS_SECRET });
        return Promise.reject(new ResourceNotFoundException({ message: 'no', $metadata: {} }));
      }
      if (cmd instanceof CreateSecretCommand) return Promise.resolve({ ARN: 'arn:x' });
      return Promise.resolve({});
    });
    // The bot comes first in Linear's answer: unfiltered, it would be choice 1.
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
    // The picker reads through readline only when stdin is not a terminal. Pinned, so that
    // the test does not wait for keys when this file is run from a shell.
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
    // The visible prompts read through readline only when stdin is not a terminal, which it is
    // when one file is run from a shell. Pinned, so that the tests do not wait for keys.
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    /** The CLI's configuration directory, where a consent that spans two runs is kept. */
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

    /** The consent an earlier run of `setup demo` saved, to be finished with `--code`. */
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

    /** A stack deployed with the Identity vault: it publishes the hosted consent page. */
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

    /** Secrets Manager as `setup` meets it: the bundle of `demo`, if it has one, and the stack-wide secret. */
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

    /** The registry as a Scan returns it; every other DynamoDB call succeeds. */
    function stubRegistry(scan: () => Promise<unknown>): void {
      ddbSend.mockImplementation((cmd: unknown) => (cmd instanceof ScanCommand ? scan() : Promise.resolve({})));
    }

    /** The workspace Linear reports for the token, which is the one the browser authorized. */
    function authorize(organization: { id: string; urlKey: string }): void {
      fetchMock.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: { viewer: { id: 'viewer-1' }, organization, teams: { nodes: [] }, users: { nodes: [] } },
        }),
      }));
    }

    /** `bgagent linear <argv>`, with the config, the login and the console stubbed as the tests above do by hand. */
    async function runLinear(...argv: string[]): Promise<void> {
      const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
        { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
      );
      const credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
        { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
      );
      // The callback double answers with the `state` of the authorization URL the run prints.
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

    /** `setup demo`, with the app's credentials and the signing secret given as flags. */
    function runSetup(webhookSecret: string, ...more: string[]): Promise<void> {
      return runLinear(
        'setup', 'demo',
        '--client-id', 'cid', '--client-secret', 'csecret', '--webhook-secret', webhookSecret, '--no-browser',
        ...more,
      );
    }

    /** What the run sent that changes Secrets Manager or DynamoDB. */
    const writes = (): string[] => [...smSend.mock.calls, ...ddbSend.mock.calls]
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof CreateSecretCommand || cmd instanceof PutSecretValueCommand || cmd instanceof PutCommand)
      .map((cmd) => cmd.constructor.name);

    test('a registry that cannot be read', async () => {
      // The registry row is what says that a workspace is on the Identity vault. A failed read
      // used to count as "no row", so the run went on with Secrets Manager and rewrote the row
      // without its vault binding.
      stubSecrets(undefined);
      stubRegistry(() => Promise.reject(throttled()));

      await expect(runSetup('lin_wh_suppliedByOperator')).rejects.toThrow('Rate exceeded');
      expect(writes()).toEqual([]);
    });

    test('a registry that cannot be read, before `--code` uses up the saved consent', async () => {
      // The consent a first run saved can be taken once. The registry is read before it is
      // taken, so the same command can be run again when the read has failed.
      saveConsent();
      stubSecrets(undefined);
      stubRegistry(() => Promise.reject(throttled()));

      await expect(runSetup('lin_wh_suppliedByOperator', '--code', 'code=abc&state=state-1'))
        .rejects.toThrow('Rate exceeded');
      expect(takePendingConsent('demo').codeVerifier).toBe('verifier-1');
    });

    describe('an answer whose OAuth state is not the one this machine sent', () => {
      // The state ties an answer to the authorization this machine started. One that carries
      // another state was not asked for here, and its code must not be exchanged for a token.

      test('to the loopback listener of `setup`', async () => {
        // The listener answers a request on any path, so any page open in the browser can send one.
        stubSecrets(undefined);
        stubRegistry(() => Promise.resolve({ Items: [] }));
        awaitOauthCallbackMock.mockResolvedValueOnce({ kind: 'direct-oauth', code: 'auth-code', state: 'not-the-state' });

        await expect(runSetup('lin_wh_suppliedByOperator')).rejects.toThrow(/OAuth state mismatch/);
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });

      test('to the loopback listener of `add-workspace`', async () => {
        // `demo` is onboarded and its bundle holds the app's client id and secret: Enter reuses them.
        stubSecrets(priorWorkspaceBundle());
        stubRegistry(() => Promise.resolve({ Items: [{ ...DEMO_ROW, oauth_secret_arn: PER_WORKSPACE_NAME }] }));
        awaitOauthCallbackMock.mockResolvedValueOnce({ kind: 'direct-oauth', code: 'auth-code', state: 'not-the-state' });

        await expect(runLinear('add-workspace', 'beta', '--no-browser')).rejects.toThrow(/OAuth state mismatch/);
        expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      });

      test('pasted from the consent page', async () => {
        // A stack with the consent page, in a region without AgentCore Identity: `setup` goes on
        // with Secrets Manager, sends the browser to the page and asks for the value it shows.
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
      // `setup` rewrites the registry row whole. A run on Secrets Manager would drop the vault
      // binding of the row, put a stored long-lived token in the place of minted short-lived
      // ones and leave the AgentCore provider behind, all under "Setup complete".
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
      // An older release copied the stack-wide secret into this bundle. Telling the copy from a
      // secret of the workspace's own takes the stack-wide value, which used to come from a
      // second read whose failure was swallowed: the copy then counted as the workspace's own
      // and was recorded as owned. A second read must not be able to decide that.
      const readStackWide = jest.fn()
        .mockResolvedValueOnce({ SecretString: OTHER_WS_SECRET })
        .mockRejectedValue(throttled());
      stubSecrets(priorWorkspaceBundle(OTHER_WS_SECRET), readStackWide);
      stubRegistry(() => Promise.resolve({ Items: [DEMO_ROW] }));

      await expect(runSetup('')).rejects.toThrow(/no webhook signing secret of its own/);
      expect(writes()).toEqual([]);
    });

    test('a value that is not a signing secret, without telling a first install to skip it', async () => {
      // Nothing is stored for this workspace, so an empty value is refused as well, and
      // `update-webhook-secret`, which the message used to name for later, refuses a
      // workspace that is not installed: the advice led from one refusal to the next.
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
      // The operator runs `setup demo` and clicks Authorize while Linear is on workspace
      // `alpha`. Going on would store alpha's token in the bundle of `demo` and point alpha's
      // registry row at it.
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: rows }));
      authorize({ id: 'org-alpha', urlKey: 'alpha' });

      await expect(runSetup('')).rejects.toThrow(/does not match Linear's urlKey 'alpha'/);
      expect(writes()).toEqual([]);
    });

    test('but not a workspace renamed in Linear, under the slug it is registered with', async () => {
      // Same workspace, new urlKey: the bundle and the row the run rewrites are its own.
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: [DEMO_ROW] }));
      authorize({ id: 'org-demo', urlKey: 'demo-renamed' });

      await runSetup('');

      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });

    test('and not a workspace whose URL key cannot be a slug, under a slug that is free', async () => {
      // The CLI accepts slugs of 4 to 50 characters and Linear has shorter URL keys
      // (linear.app/n8n). Such a workspace can only be set up under another slug: refusing
      // that would leave it no way in, and the advice to re-run with the correct slug
      // could not be followed.
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
      // `demo` is registered to org-demo, and Linear now reports `demo` as the URL key of
      // org-other: org-demo gave the key up, or was set up under a slug that is not its key.
      // The bundle is named by the slug, so going on would put the token of org-other where
      // the row of org-demo reads its own, next to the signing secret of org-demo kept here.
      stubSecrets(priorWorkspaceBundle());
      stubRegistry(() => Promise.resolve({ Items: rows }));
      authorize({ id: 'org-other', urlKey: 'demo' });

      await expect(runSetup('')).rejects.toThrow(
        'Slug \'demo\' is registered to another Linear workspace (org-demo)',
      );
      expect(writes()).toEqual([]);
    });

    test('but not a slug whose registration `remove-workspace` ended', async () => {
      // That command deletes the bundle and keeps the row as a record, which it does not take
      // a second time: nothing is left to overwrite, and a refusal could not be lifted.
      stubSecrets(undefined);
      stubRegistry(() => Promise.resolve({ Items: [{ ...DEMO_ROW, ...REMOVED }] }));
      authorize({ id: 'org-other', urlKey: 'demo' });

      await runSetup('lin_wh_suppliedByOperator');

      expect(writes()).toEqual(expect.arrayContaining(['PutSecretValueCommand', 'PutCommand']));
    });

    test('and not on the Identity vault, where a refusal would repeat on every later run', async () => {
      // A known gap, pinned so that it is not closed by half. On the vault path AgentCore has
      // stored the consent under this slug before the workspace can be known, and `setup`
      // reuses a stored consent instead of asking again: once refused, `setup demo` would be
      // refused on every run, with no way to authorize the right workspace. Until it can ask
      // for a new consent, this path keeps the warning it had.
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
