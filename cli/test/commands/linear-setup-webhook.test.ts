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
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeLinearCommand } from '../../src/commands/linear';
import * as configMod from '../../src/config';

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
  awaitOauthCallback: (...args: unknown[]) => awaitOauthCallbackMock(...args),
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
function priorWorkspaceBundle(): string {
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
    webhook_signing_secret: THIS_WS_SECRET,
  });
}

describe('linear setup — second-workspace re-run preserves the per-workspace webhook secret (#611/#612 B2)', () => {
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    capturedState = '';
    awaitOauthCallbackMock.mockClear();
    exchangeAuthorizationCodeMock.mockReset();
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

  test('the final per-workspace PutSecretValue keeps THIS workspace secret, not the stack-wide other', async () => {
    // SM.send routing by command + target:
    //  1. pre-read GetSecretValue(per-workspace bundle) → prior bundle carrying
    //     lin_wh_thisWorkspace (the value a re-run must preserve).
    //  2. upsertOauthSecret: CreateSecret → ResourceExists → PutSecretValue
    //     (per-workspace) ← the write we assert.
    //  3. isWebhookSecretConfigured GetSecretValue(stack-wide ARN) → lin_wh_other
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
        '--client-id', 'cid', '--client-secret', 'csecret', '--no-browser',
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
  });
});
