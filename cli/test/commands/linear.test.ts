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

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  chooseSetupRedirect,
  findReusableOauthAppCredentials,
  findWorkspaceRowBySlug,
  readStackWideWebhookSecret,
  queryLinearTeamKeys,
  parsePastedAuthorization,
  renderLinearAppTemplate,
} from '../../src/commands/linear';
import { generateInviteCode, INVITE_CODE_ALPHABET } from '../../src/invite-code';

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: ddbSend })),
    },
  };
});

const ddbSend = jest.fn();

function redirectUriBlock(out: string): string {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.includes('Redirect URIs'));
  const end = lines.findIndex((l, i) => i > start && l.includes('Public:'));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end).join('\n');
}

describe('renderLinearAppTemplate', () => {
  test('uses sane defaults when no options are passed', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('Application name:    bgagent');
    expect(out).toContain('Developer name:      ABCA');
    expect(out).toContain('actor=app');
  });

  test('names the field "Redirect URIs", as Linear\'s form does', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('Redirect URIs');
    expect(out).not.toContain('Callback URLs');
  });

  test('does NOT ask for a GitHub username — the form has no such field', () => {
    const out = renderLinearAppTemplate({ appName: 'Acme Agent' });
    expect(out).not.toMatch(/GitHub username/i);
    expect(out).not.toMatch(/\[bot\]/);
  });

  // #914: the consent page is AgentCore's `resourceOauth2ReturnUrl`, not Linear's `redirect_uri`.
  // On the vault path Linear redirects to the AgentCore provider callback.
  const HOSTED_CONSENT = 'https://d111111abcdef8.cloudfront.net/';
  const VAULT_CALLBACK =
    'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/f8804c1b';

  test('on the vault path the field holds the AgentCore callback, not the consent page', () => {
    const block = redirectUriBlock(renderLinearAppTemplate({
      hostedConsentUrl: HOSTED_CONSENT,
      vaultCallbackUrl: VAULT_CALLBACK,
    }));
    expect(block).not.toContain(HOSTED_CONSENT);
    expect(block).toContain(VAULT_CALLBACK);
  });

  test('shows the consent page as a CONDITIONAL Redirect URI, outside the field', () => {
    const out = renderLinearAppTemplate({ hostedConsentUrl: HOSTED_CONSENT });
    expect(out).toContain(`Identity vault consent page: ${HOSTED_CONSENT}`);
    expect(out).toMatch(/Add it as a Redirect URI only if setup falls back to Secrets Manager/);
    expect(out).not.toMatch(/nothing to paste/);
    expect(redirectUriBlock(out)).not.toContain(HOSTED_CONSENT);
  });

  test('every redirect_uri setup can send on a vault stack is one the template tells you to register', () => {
    const fallback = chooseSetupRedirect({ vaultAccessToken: undefined, consentPageUrl: HOSTED_CONSENT });
    expect(fallback.redirectUri).toBe(HOSTED_CONSENT);
    const out = renderLinearAppTemplate({ hostedConsentUrl: HOSTED_CONSENT, vaultCallbackUrl: VAULT_CALLBACK });
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.includes(fallback.redirectUri));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toMatch(/Add it as a Redirect URI/);
    expect(redirectUriBlock(out)).toContain(VAULT_CALLBACK);
  });

  test('the vault leg sends no consent-page redirect', () => {
    const vault = chooseSetupRedirect({ vaultAccessToken: 'tok', consentPageUrl: HOSTED_CONSENT });
    expect(vault.hostedUrl).toBeUndefined();
    expect(vault.redirectUri).toBe('http://localhost:8080/oauth/callback');
  });

  test('a failed stack lookup is SAID, rather than rendering a vault stack as no-vault', () => {
    const out = renderLinearAppTemplate({ lookupWarning: 'Could not read stack st in us-east-1 (ExpiredToken).' });
    expect(out).toMatch(/⚠ Could not read stack st in us-east-1 \(ExpiredToken\)\./);
    expect(out).toMatch(/may be wrong — check credentials and --region/);
  });

  test('names the loopback for add-workspace when the vault hides it from the field', () => {
    const out = renderLinearAppTemplate({ hostedConsentUrl: HOSTED_CONSENT });
    expect(out).toMatch(/Using `add-workspace` instead of `setup`\? It redirects to http:\/\/localhost:8080\/oauth\/callback/);
    expect(renderLinearAppTemplate()).not.toMatch(/Using `add-workspace` instead/);
  });

  test('lists ONLY the AgentCore callback once the provider exists', () => {
    const block = redirectUriBlock(renderLinearAppTemplate({
      hostedConsentUrl: HOSTED_CONSENT,
      vaultCallbackUrl: VAULT_CALLBACK,
    }));
    expect(block).toContain(VAULT_CALLBACK);
    expect(block).not.toContain('http://localhost:8080/oauth/callback');
  });

  test('offers NO URI on a first vault run — the honest answer, not another flow\'s URI', () => {
    // The AgentCore callback id does not exist until `setup` creates the provider.
    const block = redirectUriBlock(renderLinearAppTemplate({ hostedConsentUrl: HOSTED_CONSENT }));
    expect(block).not.toContain('http://localhost:8080/oauth/callback');
    expect(block).toMatch(/Leave empty/);
    expect(block).toMatch(/setup <slug>` prints the URI to add/);
  });

  test('every URI sits alone on its line, so no entry can wrap', () => {
    const block = redirectUriBlock(renderLinearAppTemplate({
      hostedConsentUrl: HOSTED_CONSENT,
      vaultCallbackUrl: VAULT_CALLBACK,
    }));
    for (const line of block.split('\n').filter((l) => l.includes('://'))) {
      expect(line.trim()).not.toMatch(/←/);
      expect(line.trim().split(/\s+/)).toHaveLength(1);
    }
  });

  test('warns that redirect URIs match EXACTLY, including the trailing slash', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/trailing slash/);
    expect(out).toMatch(/match EXACTLY/);
    expect(out).toMatch(/Invalid redirect_uri/);
  });

  test('keeps the line-wrap and wildcard traps, which are real', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/line-wrapped/);
    expect(out).toMatch(/wildcard/);
  });

  test('prints the REAL webhook URL when it can resolve one', () => {
    const url = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/linear/webhook';
    const out = renderLinearAppTemplate({ webhookUrl: url });
    expect(out).toContain(url);
    expect(out).not.toContain('example.com/placeholder');
  });

  test('without a resolved webhook URL it names the command that prints one', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('webhook-info');
    expect(out).not.toContain('example.com/placeholder');
  });

  test('requires Comments as well as Issues, or the comment trigger never fires', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('Issues + Comments');
    expect(out).toMatch(/Tick Comments as well as Issues/);
  });

  test('tells the operator to keep the signing secret', () => {
    expect(renderLinearAppTemplate()).toMatch(/signing secret/i);
  });

  test('says to leave App events OFF, and why', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/App events \(agent session/);
    expect(out).toContain('enableLinearAgentSessions=true');
    expect(out).toMatch(/OFF/);
    expect(out).toMatch(/comment thread/);
  });

  test('configures the webhook ON THE APP, so there is only one thing to set up', () => {
    const out = renderLinearAppTemplate({ webhookUrl: 'https://x.example.com/v1/linear/webhook' });
    expect(out).toMatch(/Webhooks:\s+ON/);
    expect(out).toContain('https://x.example.com/v1/linear/webhook');
    expect(out).toMatch(/Data change events:\s+Issues \+ Comments/);
  });

  test('warns that a second webhook on the app duplicates every event', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/ONE webhook/);
    expect(out).toMatch(/workspace webhook pointing here/);
    expect(out).toMatch(/twice/);
  });

  test('names the agent whatever the operator chose', () => {
    expect(renderLinearAppTemplate({ appName: 'Alan Turing' }))
      .toContain('Application name:    Alan Turing');
  });

  test('states that renaming does NOT change the trigger phrase', () => {
    const out = renderLinearAppTemplate({ appName: 'Alan Turing' });
    expect(out).toContain('@bgagent <request>');
    expect(out).toMatch(/not the trigger/);
  });

  test('a blank or whitespace name falls back to the default', () => {
    expect(renderLinearAppTemplate({ appName: '   ' })).toContain('Application name:    bgagent');
  });

  test('lists exactly the one URI Linear redirects to on the operator\'s own path', () => {
    const out = renderLinearAppTemplate({
      hostedConsentUrl: 'https://d111111abcdef8.cloudfront.net/',
      vaultCallbackUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/f88',
    });
    const block = redirectUriBlock(out);
    expect(block).toContain('https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/f88');
    expect(block).not.toContain('http://localhost:8080/oauth/callback');
    expect(block).not.toContain('https://d111111abcdef8.cloudfront.net/');
    expect(out).not.toContain('vault-setup');
  });

  test('falls back to the loopback URI only when there is no hosted page', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('http://localhost:8080/oauth/callback');
    expect(out).toMatch(/needs the browser on this machine/);
    expect(out).toContain('enableLinearIdentityVault=true');
  });

  test('neither the consent page nor the loopback appears in the field on a vault first run', () => {
    const out = renderLinearAppTemplate({ hostedConsentUrl: 'https://d111111abcdef8.cloudfront.net/' });
    const block = redirectUriBlock(out);
    expect(block).not.toContain('https://d111111abcdef8.cloudfront.net/');
    expect(block).not.toContain('http://localhost:8080/oauth/callback');
  });

  test('prints the hosted consent URI EXACTLY once, with no slashless variant', () => {
    const hosted = 'https://d111111abcdef8.cloudfront.net/';
    const slashless = hosted.replace(/\/$/, '');
    const out = renderLinearAppTemplate({ hostedConsentUrl: hosted });
    expect(out.split(hosted)).toHaveLength(2);
    expect(out.split(`${slashless}\n`)).toHaveLength(1);
  });

  test('defers to setup in ONE line — the field is the only thing it talks about', () => {
    const out = renderLinearAppTemplate({ hostedConsentUrl: 'https://d111111abcdef8.cloudfront.net/' });
    expect(out).toMatch(/Leave empty — `bgagent linear setup <slug>` prints the URI to add, then stops\./);
    // Linear's form accepts an empty Redirect URIs field (observed).
    expect(out).not.toMatch(/If Linear will not save an empty field/);
    const block = redirectUriBlock(out).split('\n').filter((l) => l.trim());
    expect(block).toHaveLength(2);
  });

  test('without a hosted URL it explains the loopback limitation and the fix', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/needs the browser on this machine/);
    expect(out).toContain('enableLinearIdentityVault=true');
  });

  test('records that actor=app and the admin scope are mutually exclusive', () => {
    expect(renderLinearAppTemplate()).toMatch(/cannot also request the `admin` scope/);
  });

  test('overrides developer fields and description', () => {
    const out = renderLinearAppTemplate({
      developerName: 'Acme Corp',
      developerUrl: 'https://acme.com',
      description: 'Internal coding agent',
    });
    expect(out).toContain('Acme Corp');
    expect(out).toContain('https://acme.com');
    expect(out).toContain('Internal coding agent');
  });

  test('stays short enough to act on — it is a form to fill, not a manual', () => {
    expect(renderLinearAppTemplate().split('\n').length).toBeLessThanOrEqual(50);
  });
});

describe('readStackWideWebhookSecret', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof readStackWideWebhookSecret>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns a Linear-shaped lin_wh_ secret, trimmed', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'lin_wh_AbCdEfGhIjKlMnOpQrStUvWxYz\n' });
    expect(await readStackWideWebhookSecret(mockClient, 'arn:secret')).toBe('lin_wh_AbCdEfGhIjKlMnOpQrStUvWxYz');
  });

  test('returns undefined for the CDK-autogenerated placeholder', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: '{"":"abcd"}' });
    expect(await readStackWideWebhookSecret(mockClient, 'arn:secret')).toBeUndefined();
  });

  test('returns undefined on ResourceNotFoundException (secret has not been created yet)', async () => {
    const err = new Error('Secrets Manager cannot find the specified secret.');
    err.name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(err);
    expect(await readStackWideWebhookSecret(mockClient, 'arn:secret')).toBeUndefined();
  });

  test('throws on AccessDenied so operators see the IAM gap instead of the secret being read as absent', async () => {
    const err = new Error('User is not authorized to perform: secretsmanager:GetSecretValue');
    err.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(err);
    await expect(readStackWideWebhookSecret(mockClient, 'arn:secret')).rejects.toThrow(/IAM permission gap/);
  });

  test('returns undefined when SecretString is missing', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await readStackWideWebhookSecret(mockClient, 'arn:secret')).toBeUndefined();
  });
});

describe('findWorkspaceRowBySlug', () => {
  beforeEach(() => {
    ddbSend.mockReset();
  });

  const ddbClient = () => ({ send: ddbSend }) as unknown as Parameters<typeof findWorkspaceRowBySlug>[0];

  test('finds a workspace that is NOT the first row scanned', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { workspace_slug: 'demo-abca', linear_workspace_id: 'ws-demo', oauth_secret_arn: 'arn:demo' },
        { workspace_slug: 'maguireb', linear_workspace_id: 'ws-mag', oauth_secret_arn: 'arn:mag' },
      ],
    });
    const row = await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'maguireb');
    expect(row?.linear_workspace_id).toBe('ws-mag');
  });

  test('passes NO Limit on the filtered scan (the bug that broke the lookup)', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'maguireb');
    const scanCmd = ddbSend.mock.calls[0][0] as ScanCommand;
    expect(scanCmd.input.FilterExpression).toBe('workspace_slug = :s');
    // DynamoDB applies a Scan's `Limit` to the items it reads, before the FilterExpression.
    expect(scanCmd.input.Limit).toBeUndefined();
  });

  test('returns undefined when the workspace is genuinely absent', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 'demo-abca', linear_workspace_id: 'ws-demo' }],
    });
    expect(await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'maguireb')).toBeUndefined();
  });

  const removed = { workspace_slug: 'acme', linear_workspace_id: 'ws-gone', status: 'revoked', revoked_reason: 'admin_removed' };

  test('finds the workspace that is registered with the slug now, behind the row of one that was removed', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [removed, { workspace_slug: 'acme', linear_workspace_id: 'ws-now', status: 'active' }],
    });
    const row = await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'acme');
    expect(row?.linear_workspace_id).toBe('ws-now');
  });

  const dead = { workspace_slug: 'acme', linear_workspace_id: 'ws-dead', status: 'revoked', revoked_reason: 'refresh_token_rejected' };

  test.each([
    ['the active workspace, behind the row of one whose grant died', [dead, { workspace_slug: 'acme', linear_workspace_id: 'ws-now', status: 'active' }], 'ws-now'],
    ['a workspace whose grant died, behind the row of one that was removed', [removed, dead], 'ws-dead'],
  ])('finds %s', async (_which, Items, found) => {
    ddbSend.mockResolvedValueOnce({ Items });
    const row = await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'acme');
    expect(row?.linear_workspace_id).toBe(found);
  });

  test('still returns the row of a removed workspace when no other carries the slug', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [removed] });
    expect(await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'acme')).toEqual(removed);
  });
});

describe('findReusableOauthAppCredentials', () => {
  const smSend = jest.fn();
  const smClient = { send: smSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[1];

  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
  });

  test('returns null when registry has no active rows', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 'gone', oauth_secret_arn: 'arn:secret:gone', status: 'revoked' }],
    });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    expect(await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry')).toBeNull();
    expect(smSend).not.toHaveBeenCalled();
  });

  test('returns credentials from the first active workspace', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{
        workspace_slug: 'acme',
        oauth_secret_arn: 'arn:secret:acme',
        status: 'active',
      }],
    });
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({
        access_token: 'lin_at',
        refresh_token: 'lin_rt',
        client_id: 'cid-acme',
        client_secret: 'csec-acme',
        workspace_id: 'ws-1',
        workspace_slug: 'acme',
      }),
    });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    const result = await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry');
    expect(result).toEqual({
      clientId: 'cid-acme',
      clientSecret: 'csec-acme',
      sourceSlug: 'acme',
    });
  });

  test('finds the active workspace when a removed one is read first', async () => {
    // DynamoDB applies a Scan's `Limit` to the items it reads, before the FilterExpression.
    const rows = [
      { workspace_slug: 'gamma', oauth_secret_arn: 'arn:secret:gamma', status: 'revoked' },
      { workspace_slug: 'alpha', oauth_secret_arn: 'arn:secret:alpha', status: 'active' },
    ];
    ddbSend.mockImplementationOnce(async (cmd: ScanCommand) => ({
      Items: rows.slice(0, cmd.input.Limit).filter((row) => !cmd.input.FilterExpression || row.status === 'active'),
    }));
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ client_id: 'cid-alpha', client_secret: 'csec-alpha' }),
    });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    expect(await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry')).toEqual({
      clientId: 'cid-alpha',
      clientSecret: 'csec-alpha',
      sourceSlug: 'alpha',
    });
    expect(smSend.mock.calls[0][0].input.SecretId).toBe('arn:secret:alpha');
  });

  test('throws CliError on corrupted SecretString JSON (distinct from "no active workspace")', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 's', oauth_secret_arn: 'arn:s', status: 'active' }],
    });
    smSend.mockResolvedValueOnce({ SecretString: '{not valid json' });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    await expect(
      findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry'),
    ).rejects.toThrow(/not valid JSON/);
  });

  test('throws CliError when SecretString is missing on a registered workspace', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 's', oauth_secret_arn: 'arn:s', status: 'active' }],
    });
    smSend.mockResolvedValueOnce({});
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    await expect(
      findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry'),
    ).rejects.toThrow(/has no value/);
  });

  test('throws CliError when stored OAuth bundle is missing client_id/client_secret', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 's', oauth_secret_arn: 'arn:s', status: 'active' }],
    });
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    await expect(
      findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry'),
    ).rejects.toThrow(/client_id or client_secret/);
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

  test('produces distinct codes across many runs (no static seed)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(generateInviteCode());
    }
    expect(seen.size).toBe(200);
  });
});

describe('queryLinearTeamKeys', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('uppercases, dedupes, and sorts the team keys returned by Linear', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          teams: {
            nodes: [
              { key: 'plat' },
              { key: 'ABCA' },
              { key: 'PLAT' },
              { key: 'web' },
            ],
          },
        },
      }),
    }) as unknown as typeof fetch;

    const result = await queryLinearTeamKeys('Bearer tok');

    expect(result).toEqual({ ok: true, keys: ['ABCA', 'PLAT', 'WEB'] });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
  });

  test('drops empty / non-string key entries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          teams: {
            nodes: [
              { key: 'ABCA' },
              { key: '' },
              { key: undefined },
              {},
            ],
          },
        },
      }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual({ ok: true, keys: ['ABCA'] });
  });

  test('fails (ok: false) when Linear responds non-2xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const result = await queryLinearTeamKeys('Bearer tok');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(Error);
  });

  test('fails (ok: false) when fetch itself throws (network failure)', async () => {
    const err = new Error('ECONNRESET');
    global.fetch = jest.fn().mockRejectedValue(err) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual({ ok: false, error: err });
  });

  test('fails (ok: false) on HTTP 200 with a GraphQL errors array — an unscoped token', async () => {
    const errors = [{ message: 'Authentication required' }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual({ ok: false, error: errors });
  });

  test('fails (ok: false) when errors accompany a partial data payload', async () => {
    const errors = [{ message: 'Field "key" is restricted' }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { teams: { nodes: [{ key: 'ABCA' }] } }, errors }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual({ ok: false, error: errors });
  });

  // Linear always returns the `teams` connection, empty when the workspace has no teams.
  test('fails (ok: false) when the response carries no teams connection', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    }) as unknown as typeof fetch;

    const result = await queryLinearTeamKeys('Bearer tok');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(Error);
  });

  test('succeeds with no keys for a workspace that genuinely has no teams', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { teams: { nodes: [] } } }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual({ ok: true, keys: [] });
  });

  test('succeeds with no keys when the teams connection omits nodes', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { teams: {} } }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual({ ok: true, keys: [] });
  });
});

describe('parsePastedAuthorization', () => {
  test('splits the code and state the consent page returns', () => {
    expect(parsePastedAuthorization('code=abc123&state=st-9')).toEqual({ code: 'abc123', state: 'st-9' });
  });

  test('tolerates a leading question mark, as a copied URL fragment would have', () => {
    expect(parsePastedAuthorization('?code=abc123&state=st-9')).toEqual({ code: 'abc123', state: 'st-9' });
  });

  test('a bare code parses, with NO state — the caller must not imply the check ran', () => {
    expect(parsePastedAuthorization('abc123')).toEqual({ code: 'abc123' });
  });

  test('surrounding whitespace from a copy is stripped', () => {
    expect(parsePastedAuthorization('  code=abc123&state=st-9  ')).toEqual({ code: 'abc123', state: 'st-9' });
  });

  test('a pair with an empty code yields an empty code, so callers can refuse it', () => {
    expect(parsePastedAuthorization('code=&state=st-9').code).toBe('');
  });

  test('an empty state is reported as absent rather than as a value to compare', () => {
    expect(parsePastedAuthorization('code=abc123&state=')).toEqual({ code: 'abc123' });
  });
});
