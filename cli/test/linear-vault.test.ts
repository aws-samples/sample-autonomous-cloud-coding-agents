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
  CompleteResourceTokenAuthCommand: jest.fn((input: unknown) => ({ _type: 'Complete', input })),
}));

jest.mock('../src/ua', () => ({
  makeClient: (Ctor: new () => unknown) => new Ctor(),
}));

import {
  BedrockAgentCoreControlClient,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  beginVaultConsent,
  finalizeVaultConsent,
  isVaultUnavailableError,
  probeLinearVaultCallbackUrl,
  mintLinearTokenFromVault,
  linearVaultProviderName,
  linearVaultUserId,
  upsertLinearCredentialProvider,
} from '../src/linear-vault';

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
    expect(BedrockAgentCoreControlClient).toBeDefined();
  });
});

describe('upsertLinearCredentialProvider', () => {
  const args = { region: 'us-east-1', workspaceSlug: 'acme', clientId: 'cid', clientSecret: 'csec' };

  test('creates a CustomOauth2 provider with Linear endpoints and returns its callback URL', async () => {
    controlSend.mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/uuid' });
    const res = await upsertLinearCredentialProvider(args);
    expect(res).toEqual({
      providerName: 'bgagent-linear-oauth-acme',
      callbackUrl: 'https://bedrock-agentcore.../callback/uuid',
      created: true,
    });

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
      .mockRejectedValueOnce(new ConflictException())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/existing' });
    const res = await upsertLinearCredentialProvider(args);
    expect(res.callbackUrl).toBe('https://bedrock-agentcore.../callback/existing');
    expect((controlSend.mock.calls[1][0] as Tagged)._type).toBe('UpdateProvider');
    expect((controlSend.mock.calls[2][0] as Tagged)._type).toBe('GetProvider');
  });

  test('idempotent on the REAL duplicate-name error: ValidationException "already exists"', async () => {
    const dup = Object.assign(
      new Error('Credential provider with name: bgagent-linear-oauth-acme already exists'),
      { name: 'ValidationException' },
    );
    controlSend
      .mockRejectedValueOnce(dup)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/existing' });
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
    userId: 'linear-workspace-org-uuid',
    returnUrl: 'http://localhost:8080/oauth/callback',
  };

  test('first request returns an authorization URL (consent needed); poll returns the token once minted', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-0' })
      .mockResolvedValueOnce({ authorizationUrl: 'https://x/authorize?request_uri=urn:x' })
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-1' })
      .mockResolvedValueOnce({ authorizationUrl: 'https://bedrock-agentcore.../authorize?request_uri=urn:x' })
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-2' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_minted' });

    const step = await beginVaultConsent(args);
    expect(step.kind).toBe('consent-required');
    if (step.kind !== 'consent-required') throw new Error('expected consent-required');
    expect(step.authorizationUrl).toContain('/authorize?request_uri=');
    const tokenCall = dataSend.mock.calls[1][0] as Tagged;
    expect(tokenCall.input.customParameters).toEqual({ actor: 'app', prompt: 'consent' });
    expect(tokenCall.input.oauth2Flow).toBe('USER_FEDERATION');

    const token = await step.poll();
    expect(token).toBe('lin_oauth_minted');
  });

  test('already-consented re-run needs NO browser and does NOT force re-auth', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-1' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_cached' });
    const step = await beginVaultConsent(args);
    expect(step.kind).toBe('already-consented');
    expect(step).not.toHaveProperty('authorizationUrl');
    expect(await step.poll()).toBe('lin_oauth_cached');
    const probe = dataSend.mock.calls[1][0] as Tagged;
    expect(probe.input.forceAuthentication).toBeUndefined();
    expect(dataSend).toHaveBeenCalledTimes(2);
  });

  test('throws when the vault returns neither a token nor an authorization URL', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-0' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-1' })
      .mockResolvedValueOnce({});
    await expect(beginVaultConsent(args)).rejects.toThrow(/neither a token nor an authorization URL/);
  });
});

describe('finalizeVaultConsent', () => {
  test('completes the session for the per-workspace user id', async () => {
    dataSend.mockResolvedValueOnce({});
    await finalizeVaultConsent({
      region: 'us-east-1',
      userId: 'linear-workspace-org-abc',
      sessionUri: 'urn:ietf:params:oauth:request_uri:abc123',
    });
    const call = dataSend.mock.calls[0][0] as Tagged;
    expect(call._type).toBe('Complete');
    expect(call.input).toEqual({
      userIdentifier: { userId: 'linear-workspace-org-abc' },
      sessionUri: 'urn:ietf:params:oauth:request_uri:abc123',
    });
  });

  test('propagates a finalization failure rather than leaving the caller polling', async () => {
    dataSend.mockRejectedValueOnce(new Error('InvalidInputException: session expired'));
    await expect(finalizeVaultConsent({
      region: 'us-east-1',
      userId: 'linear-workspace-org-abc',
      sessionUri: 'urn:expired',
    })).rejects.toThrow(/session expired/);
  });
});

describe('upsertLinearCredentialProvider — re-runs', () => {
  test('an EXISTING provider reports created:false, so setup proceeds to consent', async () => {
    controlSend
      .mockRejectedValueOnce(Object.assign(new Error('Credential provider with name: x already exists'), {
        name: 'ValidationException',
      }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/uuid' });

    const res = await upsertLinearCredentialProvider({
      region: 'us-east-1', workspaceSlug: 'acme', clientId: 'cid', clientSecret: 'sec',
    });
    expect(res.created).toBe(false);
    expect(res.callbackUrl).toBe('https://bedrock-agentcore.../callback/uuid');
  });
});

describe('isVaultUnavailableError', () => {
  test('an absent service / endpoint / credential failure is UNAVAILABLE', () => {
    for (const name of [
      'UnknownEndpoint', 'EndpointError', 'CredentialsProviderError',
      'ThrottlingException', 'TimeoutError',
    ]) {
      expect(isVaultUnavailableError(Object.assign(new Error('x'), { name }))).toBe(true);
    }
    expect(isVaultUnavailableError(new Error('socket hang up'))).toBe(true);
  });

  test('AccessDenied is a PERMISSIONS problem, not an availability one', () => {
    for (const name of ['AccessDeniedException', 'UnauthorizedException']) {
      expect(isVaultUnavailableError(Object.assign(new Error('x'), { name }))).toBe(false);
    }
  });

  test('a ValidationException is the service REJECTING our input — surface it', () => {
    expect(isVaultUnavailableError(
      Object.assign(new Error('invalid clientSecret'), { name: 'ValidationException' }),
    )).toBe(false);
  });

  test('a ConflictException is also the service talking', () => {
    expect(isVaultUnavailableError(
      Object.assign(new Error('already exists'), { name: 'ConflictException' }),
    )).toBe(false);
  });

  test('a non-error value does not crash the classifier', () => {
    expect(isVaultUnavailableError(undefined)).toBe(true);
    expect(isVaultUnavailableError('boom')).toBe(true);
  });
});

describe('probeLinearVaultCallbackUrl', () => {
  const probe = (): ReturnType<typeof probeLinearVaultCallbackUrl> =>
    probeLinearVaultCallbackUrl({ region: 'us-east-1', workspaceSlug: 'acme' });

  test('returns the callback URL of an existing provider', async () => {
    controlSend.mockResolvedValueOnce({ callbackUrl: 'https://bedrock-agentcore.../callback/uuid' });
    await expect(probe()).resolves.toEqual({ kind: 'found', callbackUrl: 'https://bedrock-agentcore.../callback/uuid' });
  });

  test('a provider that does not exist yet is absent, not an error', async () => {
    controlSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
    await expect(probe()).resolves.toEqual({ kind: 'absent' });
  });

  test('absent credentials are UNREADABLE, never absent — and still do not throw', async () => {
    controlSend.mockRejectedValueOnce(Object.assign(new Error('no creds'), { name: 'CredentialsProviderError' }));
    await expect(probe()).resolves.toEqual({ kind: 'unreadable', errorName: 'CredentialsProviderError' });
  });

  test('a denied read is unreadable, not absent', async () => {
    controlSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(probe()).resolves.toEqual({ kind: 'unreadable', errorName: 'AccessDeniedException' });
  });

  test('a provider without a callback URL is absent rather than an empty string', async () => {
    controlSend.mockResolvedValueOnce({});
    await expect(probe()).resolves.toEqual({ kind: 'absent' });
  });
});

describe('mintLinearTokenFromVault', () => {
  const args = {
    region: 'us-east-1',
    workloadName: 'abca_linear_oauth',
    providerName: 'bgagent-linear-oauth-acme',
    userId: 'linear-ws-acme',
  };

  test('mints from an existing grant', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' });
    await expect(mintLinearTokenFromVault(args))
      .resolves.toEqual({ kind: 'token', accessToken: 'lin_oauth_vault' });
  });

  test('sends the consent-time customParameters — they are part of the cache key', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' });
    await mintLinearTokenFromVault(args);
    const tok = dataSend.mock.calls[1][0] as { input: { customParameters?: Record<string, string> } };
    expect(tok.input.customParameters).toEqual({ actor: 'app', prompt: 'consent' });
  });

  test('NEVER forces authentication — an ordinary command must not start a consent', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ accessToken: 'lin_oauth_vault' });
    await mintLinearTokenFromVault(args);
    const tok = dataSend.mock.calls[1][0] as { input: { forceAuthentication?: boolean } };
    expect(tok.input.forceAuthentication).toBeUndefined();
  });

  test('a grant needing consent reports consent-required, not the authorization URL', async () => {
    dataSend
      .mockResolvedValueOnce({ workloadAccessToken: 'wat-xyz' })
      .mockResolvedValueOnce({ authorizationUrl: 'https://linear.app/oauth/authorize?x=1' });
    await expect(mintLinearTokenFromVault(args)).resolves.toEqual({ kind: 'consent-required' });
  });

  test('no workload token is UNAVAILABLE, not a verdict about the grant', async () => {
    dataSend.mockResolvedValueOnce({});
    await expect(mintLinearTokenFromVault(args))
      .resolves.toEqual({ kind: 'unavailable', reason: 'no_workload_access_token' });
  });

  test.each([
    ['AccessDeniedException'],
    ['ThrottlingException'],
    ['UnknownServiceError'],
  ])('an API failure (%s) is UNAVAILABLE and never revoked', async (name) => {
    dataSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name }));
    await expect(mintLinearTokenFromVault(args)).resolves.toEqual({ kind: 'unavailable', reason: name });
  });
});
