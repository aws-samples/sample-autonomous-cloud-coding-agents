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

const ddbSend = jest.fn();
jest.mock('../src/dynamo-clients', () => ({
  documentClient: () => ({ send: (...a: unknown[]) => ddbSend(...a) }),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: (...a: unknown[]) => smSend(...a) })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecret', input })),
  PutSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'PutSecret', input })),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
}));

import { checkLinearWorkspaceAuth, classifyAuthState, isExpired } from '../src/linear-auth-health';

const NOW = new Date('2026-07-25T13:00:00.000Z');
const FUTURE = '2026-07-25T14:00:00.000Z';
const PAST = '2026-07-25T12:00:00.000Z';

describe('isExpired', () => {
  test('a future expiry is not expired', () => {
    expect(isExpired(FUTURE, NOW)).toBe(false);
  });

  test('a past expiry is expired', () => {
    expect(isExpired(PAST, NOW)).toBe(true);
  });

  test('absent or unparseable expiry counts as expired', () => {
    // Matches the platform resolver: prefer an unnecessary refresh over
    // assuming a token nobody can date is still good.
    expect(isExpired(undefined, NOW)).toBe(true);
    expect(isExpired('not-a-date', NOW)).toBe(true);
  });
});

describe('classifyAuthState — expired vs revoked is the point of this check', () => {
  test('an accepted token is active', () => {
    expect(classifyAuthState('accepted', { hasRefreshToken: true, expiresAt: FUTURE }, NOW)).toBe('active');
  });

  test('rejected + already expired + a refresh token = INDETERMINATE, never healthy', () => {
    // This shape is genuinely ambiguous: it is what a quiet-but-healthy workspace
    // looks like AND what a revoked one looks like. The classifier must refuse to
    // guess — failing every idle workspace would train operators to ignore the
    // check, and passing them hides a real outage.
    expect(classifyAuthState('rejected', { hasRefreshToken: true, expiresAt: PAST }, NOW))
      .toBe('expired_indeterminate');
  });

  test('rejected while NOT expired = the authorization itself is gone', () => {
    // A token that the surface refuses even though it should still be valid
    // means the grant was revoked upstream — every event is being dropped.
    expect(classifyAuthState('rejected', { hasRefreshToken: true, expiresAt: FUTURE }, NOW))
      .toBe('revoked');
  });

  test('rejected with NO refresh token = revoked, since nothing can recover it', () => {
    // Even if it merely expired, without a refresh token there is no path back
    // without a human, so it must not be reported as self-healing.
    expect(classifyAuthState('rejected', { hasRefreshToken: false, expiresAt: PAST }, NOW))
      .toBe('revoked');
  });

  test('a probe that could not complete is unknown, never a verdict', () => {
    // A network blip must not be reported as a revoked authorization — that
    // would send an operator to re-authorize a healthy workspace.
    expect(classifyAuthState('error', { hasRefreshToken: true, expiresAt: FUTURE }, NOW)).toBe('unknown');
    expect(classifyAuthState('error', { hasRefreshToken: false, expiresAt: PAST }, NOW)).toBe('unknown');
  });

  test('the live 2026-07-25 incident is INDETERMINATE from the shallow probe alone', () => {
    // The REAL shape, not a convenient variant: the maguireb workspace had a
    // refresh token present and only ~25h old, and an access token that had
    // expired ~48 minutes earlier. Linear rejected both, but the shallow probe
    // only sees the access token, so it CANNOT tell this from a healthy idle
    // workspace. Pinning it as `revoked` here (by passing hasRefreshToken:false)
    // is what let the real bug hide: the check reported that workspace as needing
    // no action while every one of its events was being dropped. The honest
    // classification is indeterminate — and `verifyRefresh` is what settles it.
    const liveIncident = { hasRefreshToken: true, expiresAt: '2026-07-25T12:12:48.012Z' };
    expect(classifyAuthState('rejected', liveIncident, NOW)).toBe('expired_indeterminate');
    // And critically: indeterminate must NOT be treated as healthy by the caller.
    expect(classifyAuthState('rejected', liveIncident, NOW)).not.toBe('active');
  });
});

describe('checkLinearWorkspaceAuth — the real function, end to end', () => {
  /** The live-incident secret: refresh token present, access token long expired. */
  const INDETERMINATE_SECRET = JSON.stringify({
    access_token: 'lin_dead',
    refresh_token: 'rt-present',
    expires_at: '2026-07-25T12:12:48.012Z',
    workspace_slug: 'maguireb',
    client_id: 'cid',
    client_secret: 'sec',
  });

  const row = (extra: Record<string, unknown> = {}) => ({
    linear_workspace_id: 'ws-1',
    workspace_slug: 'maguireb',
    oauth_secret_arn: 'arn:secret:maguireb',
    status: 'active',
    ...extra,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    smSend.mockResolvedValue({ SecretString: INDETERMINATE_SECRET });
  });

  test('WITHOUT a verifier the live-incident workspace is indeterminate, not active', async () => {
    ddbSend.mockResolvedValue({ Items: [row()] });
    const health = await checkLinearWorkspaceAuth({
      region: 'us-east-1',
      registryTableName: 'Reg',
      probe: async () => 'rejected',
    });
    expect(health).toHaveLength(1);
    expect(health[0].state).toBe('expired_indeterminate');
    expect(health[0].detail).toMatch(/INDETERMINATE/);
  });

  test('WITH a verifier that rejects, the same workspace is reported REVOKED', async () => {
    // This is the bug the review caught: previously this workspace read as
    // "no action needed" while every one of its events was being dropped.
    ddbSend.mockResolvedValue({ Items: [row()] });
    const health = await checkLinearWorkspaceAuth({
      region: 'us-east-1',
      registryTableName: 'Reg',
      probe: async () => 'rejected',
      verifyRefresh: async () => 'rejected',
    });
    expect(health[0].state).toBe('revoked');
    expect(health[0].detail).toMatch(/REVOKED/);
  });

  test('WITH a verifier that refreshes, it is reported active', async () => {
    ddbSend.mockResolvedValue({ Items: [row()] });
    const health = await checkLinearWorkspaceAuth({
      region: 'us-east-1',
      registryTableName: 'Reg',
      probe: async () => 'rejected',
      verifyRefresh: async () => 'refreshed',
    });
    expect(health[0].state).toBe('active');
  });

  test('a verifier ERROR leaves it indeterminate — never a revoked verdict', async () => {
    ddbSend.mockResolvedValue({ Items: [row()] });
    const health = await checkLinearWorkspaceAuth({
      region: 'us-east-1',
      registryTableName: 'Reg',
      probe: async () => 'rejected',
      verifyRefresh: async () => 'error',
    });
    expect(health[0].state).toBe('expired_indeterminate');
  });

  test('the verifier is NOT invoked for a workspace already known healthy', async () => {
    // Rotating a live workspace's token merely to produce a report would be a
    // side-effect nobody asked for.
    ddbSend.mockResolvedValue({ Items: [row()] });
    const verify = jest.fn<Promise<'refreshed'>, unknown[]>().mockResolvedValue('refreshed');
    const health = await checkLinearWorkspaceAuth({
      region: 'us-east-1',
      registryTableName: 'Reg',
      probe: async () => 'accepted',
      verifyRefresh: verify as never,
    });
    expect(health[0].state).toBe('active');
    expect(verify).not.toHaveBeenCalled();
  });

  test('the registry scan is PAGINATED — a revoked workspace on page 2 is still reported', async () => {
    // Past DynamoDB's 1MB page a single Scan silently truncates, and an omitted
    // revoked workspace would make the whole report read as clean.
    ddbSend
      .mockResolvedValueOnce({ Items: [row({ linear_workspace_id: 'ws-page1' })], LastEvaluatedKey: { k: 'next' } })
      .mockResolvedValueOnce({ Items: [row({ linear_workspace_id: 'ws-page2', status: 'revoked' })] });
    const health = await checkLinearWorkspaceAuth({
      region: 'us-east-1',
      registryTableName: 'Reg',
      probe: async () => 'accepted',
    });
    // Asserted on the workspace id, not the slug: for a live workspace the slug
    // is taken from the stored secret, so it would not distinguish the two rows.
    expect(health.map((w) => w.workspaceId)).toEqual(['ws-page1', 'ws-page2']);
    expect(health[1].state).toBe('revoked');
    // The second Scan must carry the continuation key.
    expect((ddbSend.mock.calls[1][0] as { input: Record<string, unknown> }).input.ExclusiveStartKey)
      .toEqual({ k: 'next' });
  });
  describe('a vault-managed workspace must not be judged by an empty bundle', () => {
    // A fresh vault onboarding deliberately stores NO access token — the vault holds
    // the grant. Reading only the Secrets Manager bundle therefore reported every
    // healthy vault workspace as `revoked`, and this report is precisely what an
    // operator opens to decide whether a latched row is genuinely dead.
    const TOKENLESS_BUNDLE = JSON.stringify({
      access_token: '',
      refresh_token: '',
      workspace_slug: 'cloud-dev',
      client_id: 'cid',
      client_secret: 'sec',
    });
    const vaultRow = (extra: Record<string, unknown> = {}) => row({
      workspace_slug: 'cloud-dev',
      provider_name: 'bgagent-linear-oauth-cloud-dev',
      vault_user_id: 'linear-ws-cloud-dev',
      ...extra,
    });

    beforeEach(() => {
      smSend.mockResolvedValue({ SecretString: TOKENLESS_BUNDLE });
    });

    test('a vault workspace whose minted token Linear accepts is ACTIVE, not revoked', async () => {
      ddbSend.mockResolvedValue({ Items: [vaultRow()] });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: async () => ({ kind: 'token' as const, accessToken: 'lin_oauth_from_vault' }),
      });
      expect(health[0].state).toBe('active');
      expect(health[0].detail).toMatch(/AgentCore Identity token vault/);
    });

    test('the RECORDED subject is what gets minted under, not a derived one', async () => {
      // The subject is slug-derived and stored precisely because it cannot be derived
      // from the organization UUID at onboarding time. Minting under the wrong one
      // does not fail loudly — it returns no token, which reads as a dead workspace.
      ddbSend.mockResolvedValue({ Items: [vaultRow()] });
      const mint = jest.fn().mockResolvedValue({ kind: 'token', accessToken: 'lin_oauth_from_vault' });
      await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: mint,
      });
      expect(mint).toHaveBeenCalledWith(expect.objectContaining({ userId: 'linear-ws-cloud-dev' }));
    });

    test('a vault workspace the vault will not mint for is revoked', async () => {
      ddbSend.mockResolvedValue({ Items: [vaultRow()] });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: async () => ({ kind: 'consent-required' as const }),
      });
      expect(health[0].state).toBe('revoked');
      expect(health[0].detail).toMatch(/needs a\s+fresh consent/);
    });

    test.each([
      ['AccessDeniedException'],
      ['ThrottlingException'],
    ])('a vault we could not ASK (%s) is unknown, NOT revoked', async (reason) => {
      // The remedy attached to `revoked` is `bgagent linear setup`, and a re-consent can
      // replace the Linear installation — so a throttled or unauthorized probe reported
      // as revoked sends an operator to destroy a grant that is working. `platform doctor`
      // renders revoked as a hard fail, unknown as a warn.
      ddbSend.mockResolvedValue({ Items: [vaultRow()] });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: async () => ({ kind: 'unavailable' as const, reason }),
      });
      expect(health[0].state).toBe('unknown');
      expect(health[0].state).not.toBe('revoked');
      expect(health[0].detail).toContain(reason);
    });

    test('a latch is NOT overturned by a vault we could not ask', async () => {
      // The conservative direction: the row already says revoked, and a failed re-probe
      // is no evidence against it. Only a minted token overturns the record.
      ddbSend.mockResolvedValue({
        Items: [vaultRow({ status: 'revoked', revoked_reason: 'vault_consent_required' })],
      });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: async () => ({ kind: 'unavailable' as const, reason: 'ThrottlingException' }),
      });
      expect(health[0].state).toBe('revoked');
    });

    test('with no way to query the vault the verdict is unknown, NOT revoked', async () => {
      // Reporting `revoked` here would send an operator to re-authorize a workspace
      // that is working. `unknown` is a warn, which is the honest signal.
      ddbSend.mockResolvedValue({ Items: [vaultRow()] });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
      });
      expect(health[0].state).toBe('unknown');
    });

    test('never reports expired_indeterminate — that would point at a refresh it cannot do', async () => {
      // `--verify-refresh` only knows how to rotate a Secrets Manager bundle, which a
      // vault-managed workspace does not have.
      ddbSend.mockResolvedValue({ Items: [vaultRow()] });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'rejected',
        mintVaultToken: async () => ({ kind: 'token' as const, accessToken: 'lin_oauth_from_vault' }),
      });
      expect(health[0].state).toBe('revoked');
      expect(health[0].state).not.toBe('expired_indeterminate');
    });

    test('a vault_consent_required latch is re-probed, and a live grant is reported STALE', async () => {
      // That latch is an inference from a token-less vault response, not Linear
      // refusing anything, and the resolver already re-probes it. Taking it at face
      // value here is what makes a wrong latch look confirmed.
      ddbSend.mockResolvedValue({
        Items: [vaultRow({ status: 'revoked', revoked_reason: 'vault_consent_required', revoked_at: 'T0' })],
      });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: async () => ({ kind: 'token' as const, accessToken: 'lin_oauth_from_vault' }),
      });
      expect(health[0].state).toBe('active');
      expect(health[0].detail).toMatch(/stale/);
    });

    test('a refresh_token_rejected latch is NOT re-probed — Linear already refused', async () => {
      ddbSend.mockResolvedValue({
        Items: [vaultRow({ status: 'revoked', revoked_reason: 'refresh_token_rejected' })],
      });
      const mint = jest.fn();
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: mint,
      });
      expect(health[0].state).toBe('revoked');
      expect(mint).not.toHaveBeenCalled();
    });

    test('a re-probe that still needs consent leaves the revoked verdict standing', async () => {
      ddbSend.mockResolvedValue({
        Items: [vaultRow({ status: 'revoked', revoked_reason: 'vault_consent_required' })],
      });
      const health = await checkLinearWorkspaceAuth({
        region: 'us-east-1',
        registryTableName: 'Reg',
        probe: async () => 'accepted',
        mintVaultToken: async () => ({ kind: 'consent-required' as const }),
      });
      expect(health[0].state).toBe('revoked');
    });
  });
});
