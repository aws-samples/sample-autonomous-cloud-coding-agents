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
// for the SECOND-WORKSPACE RE-RUN case. The pure decision
// (`resolveWebhookSecretAction`) and the fail-closed pre-read
// (`readExistingWebhookSecret`) are unit-tested in linear-oauth.test.ts; this
// file closes the remaining gap by driving the `setup` ACTION through
// `parseAsync` (with a mocked OAuth flow) and asserting the FINAL per-workspace
// `PutSecretValue` payload — i.e. a re-run keeps THIS workspace's `lin_wh_`
// secret and never clobbers it with the stack-wide (other workspace's) one.
// Covers linear.ts's secretAction branch + mirror-back guard.
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
  awaitOauthCallback: (...args: Parameters<typeof awaitOauthCallbackMock>) => awaitOauthCallbackMock(...args),
  CALLBACK_URL: 'http://localhost:8080/oauth/callback',
}));

// linear-oauth: PARTIAL mock — keep the real code under test
// (readExistingWebhookSecret + resolveWebhookSecretAction + name/expiry/PKCE/URL
// helpers), stub only the network OAuth-code exchange.
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

// A syntactically-valid id_token whose payload carries a `sub` claim, so
// extractCognitoSub() (JWT base64url decode) resolves without real creds.
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
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      const m = line.match(/[?&]state=([^&\s]+)/);
      if (m) capturedState = decodeURIComponent(m[1]);
    });
    try {
      const program = makeLinearCommand();
      await program.parseAsync([
        'node', 'bgagent', 'setup', 'demo',
        // Empty webhook secret = "skip", which is what exercises the PRESERVE path
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

  test('records ownership when the operator supplies this workspace\'s own secret', async () => {
    // The other reachable provenance path: nothing stored, operator pastes the secret
    // read off the app being onboarded. Ownership is proven by where the value came
    // from, so it must be recorded here too — otherwise a first install looks
    // indistinguishable from one that inherited its secret.
    smSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        const id = (cmd as GetSecretValueCommand).input.SecretId;
        if (id === WEBHOOK_ARN) return Promise.resolve({ SecretString: OTHER_WS_SECRET });
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
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
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
  });

  describe('refuses before anything is written', () => {
    const DEMO_ROW = { linear_workspace_id: 'org-demo', workspace_slug: 'demo', status: 'active' };
    const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

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

    /** `setup demo`, with the config, the login and the console stubbed as the tests above do by hand. */
    async function runSetup(webhookSecret: string, ...more: string[]): Promise<void> {
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
        await makeLinearCommand().parseAsync([
          'node', 'bgagent', 'setup', 'demo',
          '--client-id', 'cid', '--client-secret', 'csecret', '--webhook-secret', webhookSecret, '--no-browser',
          ...more,
        ]);
      } finally {
        cfgSpy.mockRestore();
        credSpy.mockRestore();
        logSpy.mockRestore();
      }
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
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-linear-setup-'));
      process.env.BGAGENT_CONFIG_DIR = configDir;
      try {
        savePendingConsent({
          slug: 'demo',
          state: 'state-1',
          codeVerifier: 'verifier-1',
          clientId: 'cid',
          redirectUri: 'https://consent.example.test/',
          createdAt: new Date().toISOString(),
        });
        stubSecrets(undefined);
        stubRegistry(() => Promise.reject(throttled()));

        await expect(runSetup('lin_wh_suppliedByOperator', '--code', 'code=abc&state=state-1'))
          .rejects.toThrow('Rate exceeded');
        expect(takePendingConsent('demo').codeVerifier).toBe('verifier-1');
      } finally {
        delete process.env.BGAGENT_CONFIG_DIR;
        fs.rmSync(configDir, { recursive: true, force: true });
      }
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

    test('and not on the Identity vault, where a refusal would repeat on every later run', async () => {
      // A known gap, pinned so that it is not closed by half. On the vault path AgentCore has
      // stored the consent under this slug before the workspace can be known, and `setup`
      // reuses a stored consent instead of asking again: once refused, `setup demo` would be
      // refused on every run, with no way to authorize the right workspace. Until it can ask
      // for a new consent, this path keeps the warning it had.
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
