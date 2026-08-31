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

import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  autoLinkTokenOwner,
  findReusableOauthAppCredentials,
  findWorkspaceRowBySlug,
  isWebhookSecretConfigured,
  queryLinearTeamKeys,
  renderLinearAppTemplate,
} from '../../src/commands/linear';
import * as config from '../../src/config';
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

// Build a fake JWT with a `sub` claim; the CLI only base64url-decodes the payload.
function fakeIdToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('autoLinkTokenOwner', () => {
  const originalFetch = global.fetch;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let loadCredentialsSpy: jest.SpiedFunction<typeof config.loadCredentials>;

  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    loadCredentialsSpy = jest.spyOn(config, 'loadCredentials');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    loadCredentialsSpy.mockRestore();
  });

  test('writes an active mapping row when Linear responds and user is authenticated', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          viewer: { id: 'linear-user-uuid', name: 'Jean', email: 'jean@example.com' },
          organization: { id: 'linear-org-uuid', name: 'ACME' },
        },
      }),
    }) as unknown as typeof fetch;
    loadCredentialsSpy.mockReturnValue({
      id_token: fakeIdToken('cognito-sub-123'),
      refresh_token: 'r',
      token_expiry: new Date(Date.now() + 60_000).toISOString(),
    });

    await autoLinkTokenOwner({
      region: 'us-east-1',
      apiToken: 'lin_api_xyz',
      userMappingTable: 'test-LinearUserMappingTable',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'lin_api_xyz' }),
      }),
    );
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const putCmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(putCmd.input.TableName).toBe('test-LinearUserMappingTable');
    expect(putCmd.input.Item).toEqual(expect.objectContaining({
      linear_identity: 'linear-org-uuid#linear-user-uuid',
      platform_user_id: 'cognito-sub-123',
      linear_workspace_id: 'linear-org-uuid',
      linear_user_id: 'linear-user-uuid',
      status: 'active',
      link_method: 'auto_setup',
    }));
  });

  test('skips gracefully with a warning when Linear API errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    loadCredentialsSpy.mockReturnValue({
      id_token: fakeIdToken('cognito-sub-123'),
      refresh_token: 'r',
      token_expiry: new Date(Date.now() + 60_000).toISOString(),
    });

    await autoLinkTokenOwner({
      region: 'us-east-1',
      apiToken: 'lin_api_bad',
      userMappingTable: 'test-LinearUserMappingTable',
    });

    expect(ddbSend).not.toHaveBeenCalled();
    const msgs = consoleLogSpy.mock.calls.map(c => String(c[0]));
    expect(msgs.some(m => m.includes('Could not auto-link'))).toBe(true);
  });

  test('skips gracefully when user is not logged in', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          viewer: { id: 'linear-user-uuid' },
          organization: { id: 'linear-org-uuid' },
        },
      }),
    }) as unknown as typeof fetch;
    loadCredentialsSpy.mockReturnValue(null);

    await autoLinkTokenOwner({
      region: 'us-east-1',
      apiToken: 'lin_api_xyz',
      userMappingTable: 'test-LinearUserMappingTable',
    });

    expect(ddbSend).not.toHaveBeenCalled();
    const msgs = consoleLogSpy.mock.calls.map(c => String(c[0]));
    expect(msgs.some(m => m.includes('Could not resolve your platform user'))).toBe(true);
    expect(msgs.some(m => m.includes('bgagent login'))).toBe(true);
  });
});

describe('renderLinearAppTemplate', () => {
  // Every expectation below was checked against Linear's ACTUAL app-creation form.
  // The template previously asserted a GitHub-username field and a placeholder
  // webhook URL that do not and should not exist there, which cost two onboarding
  // attempts — so these tests pin the form's real field names and values.

  test('uses sane defaults when no options are passed', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('Application name:    bgagent');
    expect(out).toContain('Developer name:      ABCA');
    expect(out).toContain('actor=app');
  });

  test('names the field "Redirect URIs", as Linear\'s form does', () => {
    // It is not called "Callback URLs" anywhere in the form; an operator scanning
    // for the label we printed would not find it.
    const out = renderLinearAppTemplate();
    expect(out).toContain('Redirect URIs');
    expect(out).not.toContain('Callback URLs');
  });

  test('does NOT ask for a GitHub username — the form has no such field', () => {
    // Verified against the live form: icon, Application name, Developer name,
    // Developer URL, Description, Redirect URIs. No GitHub username. Printing one
    // sent operators to fix a field that does not exist while the real cause of
    // "Invalid redirect_uri" (an unregistered URI) stayed broken.
    const out = renderLinearAppTemplate({ appName: 'Acme Agent' });
    expect(out).not.toMatch(/GitHub username/i);
    expect(out).not.toMatch(/\[bot\]/);
  });

  test('warns that redirect URIs match EXACTLY, including the trailing slash', () => {
    // The live cause of a real dead-end: the consent page URL ends in "/" and an
    // operator registered it without. Exact-string matching then rejects it.
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/trailing slash/);
    expect(out).toMatch(/match EXACTLY/);
    // Wraps across lines in the rendered output, so match the leading phrase.
    expect(out).toMatch(/Invalid redirect_uri/);
  });

  test('keeps the line-wrap and wildcard traps, which are real', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/line-wrapped/);
    expect(out).toMatch(/wildcard/);
  });

  test('prints the REAL webhook URL when it can resolve one', () => {
    // It used to print https://example.com/placeholder and say no events were
    // needed, which left operators with an app that could never deliver an event.
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
    // Issues alone yields label-triggered tasks only. This is silent when wrong:
    // labels keep working, so nothing looks broken until an @mention is ignored.
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
    expect(out).toMatch(/OFF/);
    expect(out).toMatch(/comment thread/);
  });

  test('configures the webhook ON THE APP, so there is only one thing to set up', () => {
    // The receiver routes on the payload's organizationId and verifies the HMAC
    // against whichever secret it was given, so it does not care which surface the
    // webhook was created on — one webhook on the app is the least to configure.
    const out = renderLinearAppTemplate({ webhookUrl: 'https://x.example.com/v1/linear/webhook' });
    expect(out).toMatch(/Webhooks:\s+ON/);
    expect(out).toContain('https://x.example.com/v1/linear/webhook');
    expect(out).toMatch(/Data change events:\s+Issues \+ Comments/);
  });

  test('warns that a second webhook on the app duplicates every event', () => {
    // Two subscriptions to one endpoint means two signing secrets, and ABCA stores
    // one per workspace — so the duplicate both doubles the work and fails to
    // verify. Worth stating because pasting the URL in both places looks harmless.
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
    // The trigger is a hardcoded @bgagent token in the platform, not the app name.
    // Without this, renaming yields an agent that looks right and answers nothing.
    const out = renderLinearAppTemplate({ appName: 'Alan Turing' });
    expect(out).toContain('@bgagent <request>');
    expect(out).toMatch(/not the trigger/);
  });

  test('a blank or whitespace name falls back to the default', () => {
    expect(renderLinearAppTemplate({ appName: '   ' })).toContain('Application name:    bgagent');
  });

  test('lists exactly the URIs the single setup command uses — no menu', () => {
    // One command means one set of URIs. Listing per-command alternatives was the
    // menu that got the wrong subset registered and produced an opaque
    // "Invalid redirect_uri".
    const out = renderLinearAppTemplate({
      hostedConsentUrl: 'https://d2ud1woydykuxp.cloudfront.net/',
      vaultCallbackUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/f88',
    });
    expect(out).toContain('https://d2ud1woydykuxp.cloudfront.net/');
    expect(out).toContain('https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/f88');
    // The loopback is NOT listed when a hosted page exists — setup will not use it.
    expect(out).not.toContain('http://localhost:8080/oauth/callback');
    // And no vault-setup: that command no longer exists.
    expect(out).not.toContain('vault-setup');
  });

  test('falls back to the loopback URI only when there is no hosted page', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('http://localhost:8080/oauth/callback');
    expect(out).toMatch(/only works when your browser runs on the/);
    expect(out).toContain('enableLinearIdentityVault=true');
  });

  test('the hosted URI REPLACES the loopback rather than joining it', () => {
    // Two URIs for two flows was the confusion; setup picks one substrate, so the
    // template lists one.
    const out = renderLinearAppTemplate({ hostedConsentUrl: 'https://d2ud1woydykuxp.cloudfront.net/' });
    expect(out).toContain('https://d2ud1woydykuxp.cloudfront.net/');
    expect(out).not.toContain('localhost:8080');
  });

  test('lists the hosted URI EXACTLY once, as the CLI sends it', () => {
    // An earlier version printed a second slashless variant as insurance against a
    // typo. Linear validates the whole Redirect URIs field on save, so an extra bad
    // line loses the good ones with it — and the failure then reads as though it
    // were about the line just added. One entry, matching what the CLI sends.
    const hosted = 'https://d2ud1woydykuxp.cloudfront.net/';
    const slashless = hosted.replace(/\/$/, '');
    const out = renderLinearAppTemplate({ hostedConsentUrl: hosted });
    // Exact equality, not a prefix test: a prefix test on a URL reads as (incomplete)
    // sanitization to static analysis, and equality is the stronger assertion anyway —
    // it would also catch a THIRD variant being printed.
    const lines = out.split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l === hosted || l === slashless)).toEqual([hosted]);
  });

  test('with a hosted page but no vault callback, it says setup will print one', () => {
    // The vault callback id does not exist until the provider is created, which
    // `setup` does on its first run — so the template promises it rather than
    // pretending it is unavailable.
    const out = renderLinearAppTemplate({ hostedConsentUrl: 'https://d2ud1woydykuxp.cloudfront.net/' });
    expect(out).toMatch(/prints one more URI the first time it runs/);
  });

  test('without a hosted URL it explains the loopback limitation and the fix', () => {
    const out = renderLinearAppTemplate();
    expect(out).toMatch(/same machine as the CLI/);
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
    // It grew to the point the operator stopped reading and missed real fields.
    expect(renderLinearAppTemplate().split('\n').length).toBeLessThanOrEqual(50);
  });
});

describe('isWebhookSecretConfigured', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof isWebhookSecretConfigured>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns true for a Linear-shaped lin_wh_ secret', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'lin_wh_AbCdEfGhIjKlMnOpQrStUvWxYz' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(true);
  });

  test('returns false for the CDK-autogenerated placeholder', async () => {
    // CDK's default Secret value is a JSON-encoded random string — does
    // NOT start with lin_wh_. The check is a heuristic, not authoritative,
    // but good enough to avoid re-prompting on every setup re-run.
    mockSend.mockResolvedValueOnce({ SecretString: '{"":"abcd"}' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('returns false on ResourceNotFoundException (secret has not been created yet)', async () => {
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
});

describe('findWorkspaceRowBySlug', () => {
  // Regression: `bgagent linear vault-setup maguireb` reported an already-
  // onboarded workspace as "not onboarded". Cause: the filtered Scan passed
  // `Limit: 1`, and DynamoDB applies `Limit` to the items READ *before* the
  // FilterExpression runs — so it read one arbitrary row (demo-abca), filtered
  // it out, and returned nothing. Live-caught on a two-workspace registry.
  beforeEach(() => {
    ddbSend.mockReset();
  });

  const ddbClient = () => ({ send: ddbSend }) as unknown as Parameters<typeof findWorkspaceRowBySlug>[0];

  test('finds a workspace that is NOT the first row scanned', async () => {
    // Mirrors the live table: demo-abca first, maguireb second.
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
    // A Limit here silently breaks the lookup — see the describe comment.
    expect(scanCmd.input.Limit).toBeUndefined();
  });

  test('returns undefined when the workspace is genuinely absent', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 'demo-abca', linear_workspace_id: 'ws-demo' }],
    });
    expect(await findWorkspaceRowBySlug(ddbClient(), 'TestRegistry', 'maguireb')).toBeUndefined();
  });
});

describe('findReusableOauthAppCredentials', () => {
  // The helper is the linchpin of `bgagent linear add-workspace`: if it
  // returns the wrong (or no) values, the operator either gets a confusing
  // re-prompt or — worse — installs a workspace against an OAuth app that
  // doesn't match the existing workspaces' refresh-token rotations.
  const smSend = jest.fn();
  const smClient = { send: smSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[1];

  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
  });

  test('returns null when registry has no active rows', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    expect(await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry')).toBeNull();
    // Verify the scan filter is the active-status one, not a full table scan.
    const scanCmd = ddbSend.mock.calls[0][0] as ScanCommand;
    expect(scanCmd.input.FilterExpression).toBe('#status = :active');
    expect(scanCmd.input.Limit).toBe(1);
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

  test('throws CliError on corrupted SecretString JSON (distinct from "no active workspace")', async () => {
    // Reviewer flagged: a corrupt secret value used to fall through as
    // null and surface the same message as "no active workspace, run
    // setup", nudging the operator toward a duplicate install. The
    // distinct error tells them which workspace's secret needs repair.
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
    // Same rationale as above: a registered workspace whose SM secret
    // has no value is a broken state, not an absence of installs.
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
    // The third "broken state" branch covered before by null-return.
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
  // The invite code is the security boundary between admin and teammate
  // in the link handshake — admin shares it, teammate redeems it. The
  // properties we care about: prefix, length, ambiguous-glyph
  // exclusion, and that the consumer-side regex (`linear-link.ts`)
  // accepts what we produce.
  test('emits "link-" prefix followed by exactly 8 alphabet characters', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^link-[a-z0-9]{8}$/);
    expect(code).toHaveLength(13);
  });

  test('only uses characters from the unambiguous alphabet', () => {
    // The alphabet excludes 0, O, 1, l, I to make codes safe to
    // copy-paste across fonts. A regression that pulls a forbidden
    // character in (e.g. broken Math.random or alphabet typo) would
    // get caught here statistically over 200 runs.
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      const chars = code.slice('link-'.length);
      for (const c of chars) {
        expect(INVITE_CODE_ALPHABET).toContain(c);
      }
    }
  });

  test('produces distinct codes across many runs (no static seed)', () => {
    // Not a true uniqueness proof, but a single duplicate in 200 runs
    // would mean roughly 8-bit-of-entropy generation rather than the
    // expected ~40-bit (8 chars from a 31-char alphabet).
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(generateInviteCode());
    }
    expect(seen.size).toBe(200);
  });
});

describe('queryLinearTeamKeys', () => {
  // Returned keys are persisted on the registry row at install time and
  // drive prefix-routing inside the screenshot processor — see #96. The
  // helper intentionally swallows every failure path (returns []) so a
  // transient Linear outage during `setup` doesn't abort the OAuth
  // dance. Coverage verifies (a) the happy-path normalization and (b)
  // every failure mode collapses to [].
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
              { key: 'PLAT' }, // dedup case-insensitive
              { key: 'web' },
            ],
          },
        },
      }),
    }) as unknown as typeof fetch;

    const keys = await queryLinearTeamKeys('Bearer tok');

    expect(keys).toEqual(['ABCA', 'PLAT', 'WEB']);
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
              {}, // missing key entirely
            ],
          },
        },
      }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual(['ABCA']);
  });

  test('returns [] when Linear responds non-2xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual([]);
  });

  test('returns [] when fetch itself throws (network failure)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual([]);
  });

  test('returns [] when GraphQL response shape is missing teams.nodes', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    }) as unknown as typeof fetch;

    expect(await queryLinearTeamKeys('Bearer tok')).toEqual([]);
  });
});
