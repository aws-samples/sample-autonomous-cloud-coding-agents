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

/**
 * Unit tests for the AgentCore Identity vault token resolver (#809). The vault
 * path must: mint a USER-BOUND workload token then exchange it (happy path);
 * bind the per-workspace user id; and degrade to null (never throw) on a
 * consent-required response OR any API error, so the caller falls back to the
 * Secrets-Manager token.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockSend })),
  GetWorkloadAccessTokenForUserIdCommand: jest.fn((input: unknown) => ({ _type: 'WAT', input })),
  GetResourceOauth2TokenCommand: jest.fn((input: unknown) => ({ _type: 'Token', input })),
}));

import {
  resolveLinearTokenViaVault,
  workspaceUserId,
  isVaultEnabled,
  vaultWorkloadIdentityName,
} from '../../../src/handlers/shared/linear-vault-token';

interface Tagged {
  readonly _type: string;
  readonly input: Record<string, unknown>;
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('workspaceUserId', () => {
  test('is one bot identity per workspace (matches registry-table convention)', () => {
    expect(workspaceUserId('org-abc')).toBe('linear-workspace-org-abc');
  });
});

describe('isVaultEnabled / vaultWorkloadIdentityName', () => {
  test('read from env', () => {
    const savedE = process.env.LINEAR_VAULT_ENABLED;
    const savedW = process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
    process.env.LINEAR_VAULT_ENABLED = 'true';
    process.env.LINEAR_WORKLOAD_IDENTITY_NAME = 'abca_linear_oauth';
    expect(isVaultEnabled()).toBe(true);
    expect(vaultWorkloadIdentityName()).toBe('abca_linear_oauth');
    delete process.env.LINEAR_VAULT_ENABLED;
    delete process.env.LINEAR_WORKLOAD_IDENTITY_NAME;
    expect(isVaultEnabled()).toBe(false);
    expect(vaultWorkloadIdentityName()).toBeNull();
    if (savedE !== undefined) process.env.LINEAR_VAULT_ENABLED = savedE;
    if (savedW !== undefined) process.env.LINEAR_WORKLOAD_IDENTITY_NAME = savedW;
  });
});

describe('resolveLinearTokenViaVault', () => {
  const input = { linearWorkspaceId: 'org-abc', providerName: 'bgagent-linear-oauth-acme' };

  test('happy path: mints user-bound workload token, exchanges it, returns the access token', async () => {
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' }) // GetWorkloadAccessTokenForUserId
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' }); // GetResourceOauth2Token

    const result = await resolveLinearTokenViaVault(input, 'abca_linear_oauth');
    expect(result).toEqual({ kind: 'token', accessToken: 'lin_oauth_vault' });

    const watCall = mockSend.mock.calls[0][0] as Tagged;
    expect(watCall._type).toBe('WAT');
    expect(watCall.input).toEqual({ workloadName: 'abca_linear_oauth', userId: 'linear-workspace-org-abc' });

    const tokCall = mockSend.mock.calls[1][0] as Tagged;
    expect(tokCall._type).toBe('Token');
    expect(tokCall.input).toMatchObject({
      workloadIdentityToken: 'wat-xyz',
      resourceCredentialProviderName: 'bgagent-linear-oauth-acme',
      oauth2Flow: 'USER_FEDERATION',
      scopes: ['read', 'write', 'app:assignable', 'app:mentionable'],
      // Part of the vault's cache key: omitting these made every resolve a cache
      // miss ("needs consent") even with a valid cached grant — live-proven.
      customParameters: { actor: 'app', prompt: 'consent' },
    });
  });

  test('reports consent-required (not a vague failure) when the exchange yields an authorizationUrl', async () => {
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ authorizationUrl: 'https://bedrock-agentcore.../authorize?request_uri=urn:...', sessionStatus: undefined });
    // The distinction matters: consent-required means the grant is DEAD and an
    // operator must act (#812), where an unavailable result is transient.
    const result = await resolveLinearTokenViaVault(input, 'abca_linear_oauth');
    expect(result).toEqual({ kind: 'consent-required' });
  });

  test('reports unavailable (transient) when no workload token is minted', async () => {
    mockSend.mockResolvedValueOnce({}); // no workloadAccessToken
    const result = await resolveLinearTokenViaVault(input, 'abca_linear_oauth');
    expect(result).toEqual({ kind: 'unavailable', reason: 'no_workload_access_token' });
    // Did not attempt the exchange.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('never throws — an API error degrades to unavailable, NOT consent-required', async () => {
    // A throttle or permission error must not be mistaken for a dead grant, or
    // #812 would page an operator for a transient blip.
    mockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));
    await expect(resolveLinearTokenViaVault(input, 'abca_linear_oauth'))
      .resolves.toEqual({ kind: 'unavailable', reason: 'Error' });
  });
});
