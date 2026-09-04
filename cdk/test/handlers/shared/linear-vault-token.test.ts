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
  legacyWorkspaceUserId,
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

describe('legacyWorkspaceUserId', () => {
  test('keeps the pre-vault_user_id form, which existing grants are bound under', () => {
    // Pinned, not merely exercised: workspaces onboarded before `vault_user_id` was
    // recorded have grants under this exact string, so changing it orphans them.
    expect(legacyWorkspaceUserId('org-abc')).toBe('linear-workspace-org-abc');
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

  test('uses the RECORDED vault user id when the row has one', async () => {
    // The grant is bound at consent time to a slug-derived subject, because the
    // organization UUID is not knowable until a token exists. Deriving the subject
    // here instead of reading it would look up a grant that was never created, and
    // every mint would fail "consent required" on a correctly onboarded workspace.
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' });

    await resolveLinearTokenViaVault({ ...input, vaultUserId: 'linear-ws-acme' }, 'abca_linear_oauth');
    const watCall = mockSend.mock.calls[0][0] as Tagged;
    expect(watCall.input).toEqual({ workloadName: 'abca_linear_oauth', userId: 'linear-ws-acme' });
  });

  test('falls back to the DERIVED id for workspaces onboarded before it was recorded', async () => {
    // Their grant really is under linear-workspace-<orgId>; preferring the recorded
    // id must not orphan them.
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' });

    await resolveLinearTokenViaVault(input, 'abca_linear_oauth');
    const watCall = mockSend.mock.calls[0][0] as Tagged;
    expect(watCall.input).toEqual({ workloadName: 'abca_linear_oauth', userId: 'linear-workspace-org-abc' });
  });

  test('a blank recorded id falls back rather than binding to an empty subject', async () => {
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' });

    await resolveLinearTokenViaVault({ ...input, vaultUserId: '   ' }, 'abca_linear_oauth');
    const watCall = mockSend.mock.calls[0][0] as Tagged;
    expect(watCall.input).toEqual({ workloadName: 'abca_linear_oauth', userId: 'linear-workspace-org-abc' });
  });

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
    expect(result).toEqual({
      kind: 'consent-required',
      authorizationUrl: 'https://bedrock-agentcore.../authorize?request_uri=urn:...',
    });
  });

  test('a token-less response with NO authorization URL is transient, not a revocation', async () => {
    // The verdict that latches a workspace `revoked` must rest on evidence. Any
    // token-less response used to fall through to consent-required, so an empty
    // body, a truncated response or an unrecognised sessionStatus all reported
    // "this workspace is dead" — and once #812 granted the registry write, that
    // verdict stopped being advisory and took the workspace offline until a human
    // re-consented.
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({});
    expect(await resolveLinearTokenViaVault(input, 'abca_linear_oauth'))
      .toEqual({ kind: 'unavailable', reason: 'no_token_no_auth_url' });
  });

  test('an empty-string authorization URL is also transient, not a revocation', async () => {
    // Guards the truthiness check specifically: `authorizationUrl in resp` or a
    // `!== undefined` test would accept '' and reinstate the evidence-free verdict.
    mockSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ authorizationUrl: '', sessionStatus: 'FAILED' });
    expect(await resolveLinearTokenViaVault(input, 'abca_linear_oauth'))
      .toEqual({ kind: 'unavailable', reason: 'no_token_no_auth_url' });
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
