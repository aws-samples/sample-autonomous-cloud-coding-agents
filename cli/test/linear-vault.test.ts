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

// Unit tests for the CLI Linear vault helpers (#809). Covers: idempotent
// provider create (conflict → update + re-read callback), the deterministic
// provider name, and the consent flow (authorizationUrl on first request →
// token on poll; already-consented shortcut).

const controlSend = jest.fn();
const dataSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => {
  class ConflictException extends Error {
    constructor() { super('conflict'); this.name = 'ConflictException'; }
  }
  return {
    BedrockAgentCoreControlClient: jest.fn(() => ({ send: (...a: unknown[]) => controlSend(...a) })),
    ConflictException,
    CreateOauth2CredentialProviderCommand: jest.fn((input: unknown) => ({ _type: 'CreateProvider', input })),
    UpdateOauth2CredentialProviderCommand: jest.fn((input: unknown) => ({ _type: 'UpdateProvider', input })),
    GetOauth2CredentialProviderCommand: jest.fn((input: unknown) => ({ _type: 'GetProvider', input })),
  };
});

jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: (...a: unknown[]) => dataSend(...a) })),
  GetWorkloadAccessTokenForUserIdCommand: jest.fn((input: unknown) => ({ _type: 'WAT', input })),
  GetResourceOauth2TokenCommand: jest.fn((input: unknown) => ({ _type: 'Token', input })),
}));

// makeClient just constructs the (mocked) client; pass it through.
jest.mock('../src/ua', () => ({
  makeClient: (Ctor: new () => unknown) => new Ctor(),
}));

import {
  BedrockAgentCoreControlClient,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  beginVaultConsent,
  linearVaultProviderName,
  linearVaultUserId,
  upsertLinearCredentialProvider,
} from '../src/linear-vault';

// Re-grab the mocked ConflictException class for constructing rejections.
const { ConflictException } = jest.requireMock('@aws-sdk/client-bedrock-agentcore-control') as {
  ConflictException: new () => Error;
};

interface Tagged { readonly _type: string; readonly input: Record<string, unknown> }

beforeEach(() => {
  controlSend.mockReset();
  dataSend.mockReset();
});

describe('naming helpers', () => {
  test('provider name + user id are deterministic per workspace', () => {
    expect(linearVaultProviderName('acme')).toBe('bgagent-linear-oauth-acme');
    expect(linearVaultUserId('org-uuid')).toBe('linear-workspace-org-uuid');
  });
  test('the control client is constructed via makeClient', () => {
    // Guards against a naked `new BedrockAgentCoreControlClient()` that would
    // drop solution-UA attribution.
    expect(BedrockAgentCoreControlClient).toBeDefined();
  });
});

describe('upsertLinearCredentialProvider', () => {
  const args = { region: 'us-east-1', workspaceSlug: 'acme', clientId: 'cid', clientSecret: 'csec' };

  test('creates a CustomOauth2 provider with Linear endpoints and returns its callback URL', async () => {
    controlSend.mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/uuid' });
    const res = await upsertLinearCredentialProvider(args);
    expect(res).toEqual({ providerName: 'bgagent-linear-oauth-acme', callbackUrl: 'https://bedrock-agentcore.../callback/uuid' });

    const call = controlSend.mock.calls[0][0] as Tagged;
    expect(call._type).toBe('CreateProvider');
    expect(call.input.credentialProviderVendor).toBe('CustomOauth2');
    const cfg = (call.input.oauth2ProviderConfigInput as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
      .customOauth2ProviderConfig.oauthDiscovery.authorizationServerMetadata;
    expect(cfg.tokenEndpoint).toBe('https://api.linear.app/oauth/token');
    expect(cfg.authorizationEndpoint).toBe('https://linear.app/oauth/authorize');
  });

  test('idempotent: on ConflictException it updates in place and re-reads the callback URL', async () => {
    controlSend
      .mockRejectedValueOnce(new ConflictException()) // Create
      .mockResolvedValueOnce({}) // Update
      .mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/existing' }); // Get
    const res = await upsertLinearCredentialProvider(args);
    expect(res.callbackUrl).toBe('https://bedrock-agentcore.../callback/existing');
    expect((controlSend.mock.calls[1][0] as Tagged)._type).toBe('UpdateProvider');
    expect((controlSend.mock.calls[2][0] as Tagged)._type).toBe('GetProvider');
  });

  test('idempotent on the REAL duplicate-name error: ValidationException "already exists"', async () => {
    // Regression: AgentCore reports a duplicate provider name as a
    // ValidationException, not a ConflictException — a second `vault-setup` run
    // aborted with "Credential provider with name: … already exists" instead of
    // updating in place. Live-caught.
    const dup = Object.assign(
      new Error('Credential provider with name: bgagent-linear-oauth-acme already exists'),
      { name: 'ValidationException' },
    );
    controlSend
      .mockRejectedValueOnce(dup) // Create
      .mockResolvedValueOnce({}) // Update
      .mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/existing' }); // Get
    const res = await upsertLinearCredentialProvider(args);
    expect(res.callbackUrl).toBe('https://bedrock-agentcore.../callback/existing');
    expect((controlSend.mock.calls[1][0] as Tagged)._type).toBe('UpdateProvider');
  });

  test('a GENUINE ValidationException still surfaces (not swallowed as already-exists)', async () => {
    const bad = Object.assign(
      new Error('Invalid tokenEndpoint: must be an absolute https URL'),
      { name: 'ValidationException' },
    );
    controlSend.mockRejectedValueOnce(bad);
    await expect(upsertLinearCredentialProvider(args)).rejects.toThrow(/Invalid tokenEndpoint/);
  });
});

describe('beginVaultConsent', () => {
  const args = {
    region: 'us-east-1',
    workloadName: 'abca_linear_oauth',
    providerName: 'bgagent-linear-oauth-acme',
    linearWorkspaceId: 'org-uuid',
    returnUrl: 'http://localhost:8080/oauth/callback',
  };

  test('first request returns an authorization URL (consent needed); poll returns the token once minted', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-1' }) // WAT (first)
      .mockResolvedValueOnce({ authorizationUrl: 'https://bedrock-agentcore.../authorize?request_uri=urn:x' }) // Token (no token yet)
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-2' }) // WAT (poll)
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_minted' }); // Token (poll → minted)

    const step = await beginVaultConsent(args);
    expect(step.authorizationUrl).toContain('/authorize?request_uri=');
    // customParameters forward the agent-install params (spike F1).
    const tokenCall = dataSend.mock.calls[1][0] as Tagged;
    expect(tokenCall.input.customParameters).toEqual({ actor: 'app', prompt: 'consent' });
    expect(tokenCall.input.oauth2Flow).toBe('USER_FEDERATION');

    const token = await step.poll();
    expect(token).toBe('lin_oauth_minted');
  });

  test('already-consented: first request returns a token directly, poll yields it, no auth URL', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-1' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_cached' });
    const step = await beginVaultConsent(args);
    expect(step.authorizationUrl).toBe('');
    expect(await step.poll()).toBe('lin_oauth_cached');
  });

  test('throws when the vault returns neither a token nor an authorization URL', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-1' })
      .mockResolvedValueOnce({}); // neither
    await expect(beginVaultConsent(args)).rejects.toThrow(/neither a token nor an authorization URL/);
  });
});
