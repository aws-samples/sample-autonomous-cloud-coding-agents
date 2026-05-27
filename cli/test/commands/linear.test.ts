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
  isWebhookSecretConfigured,
  renderLinearAppTemplate,
} from '../../src/commands/linear';
import * as config from '../../src/config';

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
  test('uses sane defaults when no options are passed', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('bgagent[bot]');
    expect(out).toContain('Webhooks:            ON');
    expect(out).toContain('REQUIRED for actor=app');
  });

  test('defaults the callback URL to the localhost endpoint that setup listens on', () => {
    // Phase 2.0b-O2 (shipped) uses an ephemeral localhost server during
    // `bgagent linear setup`. Printing the right URL by default
    // eliminates the "and now substitute the placeholder" step the
    // setup guide used to embed.
    const out = renderLinearAppTemplate();
    expect(out).toContain('http://localhost:8080/oauth/callback');
  });

  test('substitutes a different callback URL when supplied (parked AgentCore Identity flow)', () => {
    const url = 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/abc-123';
    const out = renderLinearAppTemplate({ awsCallbackUrl: url });
    expect(out).toContain(url);
    expect(out).not.toContain('http://localhost:8080/oauth/callback');
  });

  test('overrides bot name, developer fields, description', () => {
    const out = renderLinearAppTemplate({
      botName: 'acme-bot[bot]',
      developerName: 'Acme Corp',
      developerUrl: 'https://acme.com',
      description: 'Internal coding agent',
    });
    expect(out).toContain('acme-bot[bot]');
    expect(out).toContain('Acme Corp');
    expect(out).toContain('https://acme.com');
    expect(out).toContain('Internal coding agent');
  });

  test('explains why each gating field matters (actor=app context)', () => {
    const out = renderLinearAppTemplate();
    // The "why" explainer is the core differentiator of this command vs. raw
    // docs — without it operators paste blindly and hit the cryptic Linear
    // "Invalid redirect_uri" error documented in the 2.0b spike.
    expect(out).toContain('Invalid redirect_uri');
    expect(out).toContain('Wildcard callback URLs are not accepted');
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

  test('returns null when the secret is missing client_id/client_secret', async () => {
    // Phase 2.0a (parked) secrets only stored access_token + refresh_token —
    // a half-migrated install would hit this path. Returning null forces the
    // operator to pass --client-id explicitly rather than silently using
    // empty strings.
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 'old', oauth_secret_arn: 'arn:secret:old', status: 'active' }],
    });
    smSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    expect(await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry')).toBeNull();
  });

  test('returns null on corrupted SecretString JSON', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 's', oauth_secret_arn: 'arn:s', status: 'active' }],
    });
    smSend.mockResolvedValueOnce({ SecretString: '{not valid json' });
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    expect(await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry')).toBeNull();
  });

  test('returns null when SecretString is missing', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ workspace_slug: 's', oauth_secret_arn: 'arn:s', status: 'active' }],
    });
    smSend.mockResolvedValueOnce({});
    const ddbClient = { send: ddbSend } as unknown as Parameters<typeof findReusableOauthAppCredentials>[0];
    expect(await findReusableOauthAppCredentials(ddbClient, smClient, 'TestRegistry')).toBeNull();
  });
});
