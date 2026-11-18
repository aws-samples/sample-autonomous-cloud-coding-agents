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

// `add-workspace`, `invite-user` and `update-webhook-secret` on a stack whose registry already
// holds a workspace, driven through `parseAsync` with the OAuth flow, Linear and AWS replaced
// by doubles.
//
// The commands find a workspace by scanning the registry. DynamoDB applies a Scan's `Limit`
// to the rows it reads, before the filter, and the registry double below answers the same
// way: a lookup that only works for the first row of the table fails here as it does on AWS.
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { PutCommand, ScanCommand, type ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { makeLinearCommand } from '../../src/commands/linear';
import * as configMod from '../../src/config';

// The callback server answers with the `state` of the authorization URL the command prints,
// one macrotask later: the command starts listening before it prints the URL.
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

const promptSecretMock = jest.fn();
jest.mock('../../src/prompt-secret', () => ({
  ...jest.requireActual('../../src/prompt-secret'),
  promptSecret: (...args: unknown[]) => promptSecretMock(...args),
}));

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

// A syntactically valid id_token whose payload carries a `sub` claim.
const FAKE_ID_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'sub-abc' })).toString('base64url')}.y`;

type Row = Record<string, unknown>;

/** The registry row of an onboarded workspace. Its bundle is stored under `bgagent-linear-oauth-<slug>`. */
function workspaceRow(slug: string, extra: Row = {}): Row {
  return {
    linear_workspace_id: `org-${slug}`,
    workspace_slug: slug,
    oauth_secret_arn: `arn:bgagent-linear-oauth-${slug}`,
    status: 'active',
    ...extra,
  };
}

/**
 * Answer a Scan of the registry the way DynamoDB does: read `Limit` rows, then apply the
 * filter to the rows read. Knows the one filter shape the CLI uses, `name = :value` clauses
 * joined by AND, and refuses any other.
 */
function scanRegistry(rows: Row[], input: ScanCommandInput): { Items: Row[] } {
  const values = input.ExpressionAttributeValues ?? {};
  const clauses = (input.FilterExpression?.split(' AND ') ?? []).map((clause) => {
    const [name, value] = clause.split(' = ');
    if (!(value in values)) throw new Error(`scanRegistry cannot evaluate the filter clause '${clause}'`);
    return { name: input.ExpressionAttributeNames?.[name] ?? name, value: values[value] };
  });
  return {
    Items: rows.slice(0, input.Limit).filter((row) => clauses.every(({ name, value }) => row[name] === value)),
  };
}

describe('linear commands on a registry that already holds a workspace', () => {
  const originalFetch = global.fetch;
  let registry: Row[];
  /** Secrets Manager, by secret name. */
  let secrets: Record<string, string>;
  /** Every bundle the command stored, in order. */
  let bundleWrites: Array<Record<string, unknown>>;
  /** What Linear answers for the workspace `beta`. */
  let linear: { members: Row[]; teams: unknown };
  let cfgSpy: jest.SpiedFunction<typeof configMod.loadConfig>;
  let credSpy: jest.SpiedFunction<typeof configMod.loadCredentials>;
  // The visible prompts take the readline branch only when stdin is not a terminal, which it
  // is when one file is run from a shell. Pinned, so that the tests do not wait for keys.
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    capturedState = '';
    registry = [workspaceRow('alpha')];
    secrets = { 'bgagent-linear-oauth-alpha': JSON.stringify({ access_token: 'tok-alpha', client_id: 'cid', client_secret: 'csecret' }) };
    bundleWrites = [];
    linear = { members: [], teams: { data: { teams: { nodes: [{ key: 'bet' }] } } } };
    typed = [];

    cfnSend.mockReset().mockResolvedValue({
      Stacks: [{
        Outputs: [
          { OutputKey: 'LinearWorkspaceRegistryTableName', OutputValue: 'registry-table' },
          { OutputKey: 'LinearUserMappingTableName', OutputValue: 'user-mapping-table' },
        ],
      }],
    });

    const store = (name: string, secretString: string) => {
      secrets[name] = secretString;
      bundleWrites.push({ name, ...JSON.parse(secretString) });
      return { ARN: `arn:${name}` };
    };
    smSend.mockReset().mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetSecretValueCommand) {
        const value = secrets[String(cmd.input.SecretId).replace(/^arn:/, '')];
        if (value === undefined) throw new ResourceNotFoundException({ message: 'no such secret', $metadata: {} });
        return { SecretString: value };
      }
      if (cmd instanceof CreateSecretCommand) {
        if (String(cmd.input.Name) in secrets) throw new ResourceExistsException({ message: 'exists', $metadata: {} });
        return store(String(cmd.input.Name), String(cmd.input.SecretString));
      }
      if (cmd instanceof PutSecretValueCommand) return store(String(cmd.input.SecretId), String(cmd.input.SecretString));
      return {};
    });

    ddbSend.mockReset().mockImplementation(async (cmd: unknown) => (
      cmd instanceof ScanCommand ? scanRegistry(registry, cmd.input) : {}
    ));

    exchangeAuthorizationCodeMock.mockReset().mockResolvedValue({
      access_token: 'tok-beta', refresh_token: 'refresh-beta', expires_in: 3600, scope: 'read write',
    });
    promptSecretMock.mockReset().mockResolvedValue('lin_wh_beta');

    // Every Linear call of these commands is a GraphQL POST; tell them apart by the query.
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const query = String(init?.body);
      let body: unknown = { data: { users: { nodes: linear.members } } };
      if (query.includes('organization')) {
        body = { data: { viewer: { id: 'bot' }, organization: { id: 'org-beta', name: 'Beta', urlKey: 'beta' } } };
      } else if (query.includes('teams')) {
        body = linear.teams;
      }
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;

    cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue(
      { region: 'us-west-2', api_url: 'https://api.example.test' } as ReturnType<typeof configMod.loadConfig>,
    );
    credSpy = jest.spyOn(configMod, 'loadCredentials').mockReturnValue(
      { id_token: FAKE_ID_TOKEN } as ReturnType<typeof configMod.loadCredentials>,
    );
  });

  afterEach(() => {
    if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    global.fetch = originalFetch;
    cfgSpy.mockRestore();
    credSpy.mockRestore();
  });

  /** Run `bgagent linear <args>` and return the lines it printed. */
  async function run(...args: string[]): Promise<string[]> {
    const printed: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      const line = parts.map(String).join(' ');
      printed.push(line);
      const state = line.match(/[?&]state=([^&\s]+)/);
      if (state) capturedState = decodeURIComponent(state[1]);
    });
    try {
      await makeLinearCommand().parseAsync(['node', 'bgagent', ...args]);
    } finally {
      logSpy.mockRestore();
    }
    return printed;
  }

  /** The items the command put into a table. */
  const puts = (table: string): Row[] => ddbSend.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd) => cmd instanceof PutCommand && cmd.input.TableName === table)
    .map((cmd) => cmd.input.Item);

  describe('add-workspace', () => {
    test('stores the signing secret with the token and records that the workspace owns it', async () => {
      // With a second active workspace on the stack, the webhook receiver accepts a delivery
      // only from a workspace whose row says that its signing secret is its own. The operator
      // pastes that secret here, so the row has to say so: without the flag every delivery of
      // the workspace just added is answered 401.
      await run('add-workspace', 'beta', '--no-browser');

      expect(puts('registry-table')).toEqual([expect.objectContaining({
        linear_workspace_id: 'org-beta',
        workspace_slug: 'beta',
        oauth_secret_arn: 'arn:bgagent-linear-oauth-beta',
        status: 'active',
        webhook_secret_owned: true,
      })]);
      // One write, which already carries the secret: no moment at which the row is active
      // and its bundle has no signing secret.
      expect(bundleWrites).toEqual([expect.objectContaining({
        name: 'bgagent-linear-oauth-beta',
        workspace_id: 'org-beta',
        access_token: 'tok-beta',
        webhook_signing_secret: 'lin_wh_beta',
      })]);
    });

    test('dates the token from the exchange, however long the operator takes to paste the secret', async () => {
      // `expires_at` counts from the moment the bundle is built. Built after the prompt, it
      // would outlive the token by the time spent looking for the secret, and the platform
      // would go on using an access token that Linear has stopped accepting.
      // Only the clock is faked: the callback double still resolves on a real timer.
      jest.useFakeTimers({
        now: new Date('2026-06-17T00:00:00.000Z'),
        doNotFake: [
          'nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
          'setInterval', 'clearInterval', 'hrtime', 'performance',
        ],
      });
      promptSecretMock.mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-06-17T00:10:00.000Z'));
        return 'lin_wh_beta';
      });
      try {
        await run('add-workspace', 'beta', '--no-browser');
      } finally {
        jest.useRealTimers();
      }

      // One hour (`expires_in`) after the exchange, not after the paste.
      expect(bundleWrites).toEqual([expect.objectContaining({ expires_at: '2026-06-17T01:00:00.000Z' })]);
    });

    test.each([
      ['is not a signing secret', 'not-a-signing-secret', /start with 'lin_wh_'/],
      ['is empty', '', /signing secret is required/],
    ])('stores nothing when what was pasted %s', async (_what, pasted, refusal) => {
      promptSecretMock.mockResolvedValue(pasted);

      await expect(run('add-workspace', 'beta', '--no-browser')).rejects.toThrow(refusal);

      expect(bundleWrites).toEqual([]);
      expect(puts('registry-table')).toEqual([]);
    });

    test.each([
      ['first', ['beta', 'alpha']],
      ['second', ['alpha', 'beta']],
    ])('refuses a workspace that is already registered, when its row is the %s of the registry', async (_position, order) => {
      // `beta` is on the Identity vault. Adding it again would replace its row with one that
      // has neither the vault binding nor the proof that the signing secret is its own.
      const beta = workspaceRow('beta', { provider_name: 'bgagent-linear-oauth-beta', vault_user_id: 'linear-ws-beta', webhook_secret_owned: true });
      registry = order.map((slug) => (slug === 'beta' ? beta : workspaceRow(slug)));
      secrets['bgagent-linear-oauth-beta'] = JSON.stringify({ client_id: 'cid', client_secret: 'csecret' });

      await expect(run('add-workspace', 'beta', '--no-browser')).rejects.toThrow(/already in the registry/);

      expect(bundleWrites).toEqual([]);
      expect(puts('registry-table')).toEqual([]);
    });

    test('ends by linking the admin to the member they pick, never to the app\'s own user', async () => {
      // The same picker that ends `setup`, called with this command's own workspace, user
      // and table. The bot comes first in Linear's answer: unfiltered, it would be choice 1.
      linear.members = [
        { id: 'bot', name: 'bgagent', email: 'bot-uuid@oauthapp.linear.app' },
        { id: 'user-maya', name: 'Maya K', email: 'maya@example.test' },
      ];
      // Enter keeps the client id of the app already installed; then the first member listed.
      typed = ['', '1'];

      const printed = await run('add-workspace', 'beta', '--no-browser');

      expect(puts('user-mapping-table')).toEqual([{
        linear_identity: 'org-beta#user-maya',
        platform_user_id: 'sub-abc',
        linear_workspace_id: 'org-beta',
        linear_user_id: 'user-maya',
        linked_at: expect.any(String),
        status: 'active',
        link_method: 'add_workspace_oauth',
      }]);
      expect(printed).toContain('    1. Maya K (maya@example.test)');
      expect(printed.join('\n')).not.toContain('oauthapp.linear.app');
    });

    test('names `setup` as the command to run again, never itself', async () => {
      // Once this run has registered the workspace, `add-workspace` refuses it. Neither the
      // self-link picker (no member listed here) nor the team keys (query refused here) can
      // be retried with the command that just ran.
      linear.teams = { errors: [{ message: 'Authentication required' }] };

      const printed = await run('add-workspace', 'beta', '--no-browser');

      expect(printed).toContain('  1. Re-run `bgagent linear setup beta` to retry the self-link picker,');
      expect(printed).toContain(
        '    Re-run `bgagent linear setup beta` to retry the self-link picker, or label an issue and follow the warning.',
      );
      expect(printed.filter((line) => /re-run.*add-workspace/i.test(line))).toEqual([]);
    });
  });

  describe('invite-user', () => {
    beforeEach(() => {
      registry = [workspaceRow('alpha'), workspaceRow('beta')];
      secrets['bgagent-linear-oauth-beta'] = JSON.stringify({ access_token: 'tok-beta' });
      linear.members = [{ id: 'user-maya', name: 'Maya K', email: 'maya@example.test' }];
      typed = ['1'];
    });

    test('invites to a workspace that is not the first row of the registry', async () => {
      const before = Math.floor(Date.now() / 1000);

      const printed = await run('invite-user', 'beta');

      const [invite] = puts('user-mapping-table');
      expect(invite).toMatchObject({
        linear_identity: expect.stringMatching(/^pending#link-[a-z0-9]{8}$/),
        status: 'pending',
        linear_workspace_id: 'org-beta',
        linear_workspace_slug: 'beta',
        linear_user_id: 'user-maya',
        invited_by_platform_user_id: 'sub-abc',
      });
      const day = 24 * 60 * 60;
      expect(invite.ttl).toBeGreaterThanOrEqual(before + day);
      expect(invite.ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + day);
      expect(printed).toContain(`      bgagent linear link ${String(invite.linear_identity).slice('pending#'.length)}`);
    });

    test('still refuses a workspace that was removed, and sends it to `setup`', async () => {
      // Not to `add-workspace`: a removed workspace keeps its row, and that command refuses a
      // workspace that has one.
      registry = [workspaceRow('alpha'), workspaceRow('beta', { status: 'revoked' })];

      await expect(run('invite-user', 'beta')).rejects.toThrow(
        'Workspace \'beta\' is not in the registry (or status != \'active\'). Run `bgagent linear setup beta` first.',
      );

      expect(puts('user-mapping-table')).toEqual([]);
    });
  });

  describe('update-webhook-secret', () => {
    test('sends a workspace that has no credential bundle to `setup`', async () => {
      // `remove-workspace` deletes the bundle and keeps the row, so `add-workspace` would refuse.
      await expect(run('update-webhook-secret', 'beta')).rejects.toThrow(
        'Workspace \'beta\' is not installed (no Secrets Manager secret \'bgagent-linear-oauth-beta\'). '
        + 'Run `bgagent linear setup beta` first.',
      );
    });
  });
});
