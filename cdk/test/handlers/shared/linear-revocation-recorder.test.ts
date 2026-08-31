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

// The DEFAULT revocation recorder — the one the resolver installs for itself when
// `LINEAR_REVOCATION_RECORDING` is on. Separate from linear-oauth-resolver.test.ts
// because it needs the SNS announcement module mocked, and that mock is file-wide.
//
// What is under test is an ORDERING, not a set of calls: announce, then latch. The
// latch seals the code path (a `revoked` row makes the resolver return before it can
// re-detect the dead grant), so latching first makes the notification a one-shot side
// effect of one write — and a single throttled publish then means "recorded dead,
// nobody told", permanently.
jest.mock('../../../src/handlers/shared/linear-revocation-alert', () => ({
  announceRevocation: jest.fn(),
  revocationAlertTopicArn: jest.fn(),
}));

import {
  _resetCachesForTesting,
  resolveLinearOauthToken,
  type StoredOauthToken,
} from '../../../src/handlers/shared/linear-oauth-resolver';
import {
  announceRevocation,
  revocationAlertTopicArn,
} from '../../../src/handlers/shared/linear-revocation-alert';

const announceMock = announceRevocation as jest.MockedFunction<typeof announceRevocation>;
const topicArnMock = revocationAlertTopicArn as jest.MockedFunction<typeof revocationAlertTopicArn>;

const REGISTRY_TABLE = 'TestLinearWorkspaceRegistry';
const WS = 'ws-uuid-1';
const INSTALLED = '2026-08-01T00:00:00.000Z';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:OperationalAlerts';

function storedToken(): StoredOauthToken {
  return {
    // Expiring, so resolution attempts the refresh that Linear then rejects.
    access_token: 'lin_oauth_old',
    refresh_token: 'lin_refresh_dead',
    expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
    scope: 'read write',
    client_id: 'cid',
    client_secret: 'csec',
    workspace_id: WS,
    workspace_slug: 'acme',
    installed_at: INSTALLED,
    updated_at: INSTALLED,
    installed_by_platform_user_id: 'cog-sub',
  };
}

/**
 * Drive one full resolve whose refresh is rejected, which is what makes the resolver
 * call its own recorder. `updateFailures` names the update kinds DynamoDB should
 * reject, keyed by a substring of the UpdateExpression.
 */
async function detectRevocation(opts: {
  publishSucceeds: boolean;
  claimAlreadyHeld?: boolean;
  latchFails?: boolean;
} ) {
  const updates: Array<{ UpdateExpression: string; ConditionExpression?: string }> = [];
  const ddbSend = jest.fn().mockImplementation((command: {
    constructor: { name: string };
    input: { UpdateExpression?: string; ConditionExpression?: string };
  }) => {
    if (command.constructor.name !== 'UpdateCommand') {
      return {
        Item: {
          workspace_slug: 'acme',
          oauth_secret_arn: 'arn:secret:acme',
          status: 'active',
          installed_at: INSTALLED,
        },
      };
    }
    const expression = command.input.UpdateExpression ?? '';
    updates.push({ UpdateExpression: expression, ConditionExpression: command.input.ConditionExpression });
    if (expression.includes('revocation_announced_at') && !expression.startsWith('REMOVE')
      && opts.claimAlreadyHeld) {
      throw Object.assign(new Error('claimed'), { name: 'ConditionalCheckFailedException' });
    }
    if (expression.includes('revoked_at') && opts.latchFails) {
      throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    }
    return {};
  });
  const smSend = jest.fn().mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'GetSecretValueCommand') {
      return { SecretString: JSON.stringify(storedToken()) };
    }
    return {};
  });
  announceMock.mockResolvedValue(opts.publishSucceeds);

  const result = await resolveLinearOauthToken(WS, REGISTRY_TABLE, {
    dynamoDbClient: { send: ddbSend } as never,
    secretsManagerClient: { send: smSend } as never,
    fetchImpl: (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_request', error_description: 'Refresh token revoked' }),
    })) as unknown as typeof fetch,
  });

  return { result, updates };
}

describe('the default revocation recorder announces BEFORE it latches', () => {
  let savedRecording: string | undefined;

  beforeEach(() => {
    _resetCachesForTesting();
    jest.clearAllMocks();
    savedRecording = process.env.LINEAR_REVOCATION_RECORDING;
    process.env.LINEAR_REVOCATION_RECORDING = 'true';
    topicArnMock.mockReturnValue(TOPIC);
  });
  afterEach(() => {
    if (savedRecording === undefined) delete process.env.LINEAR_REVOCATION_RECORDING;
    else process.env.LINEAR_REVOCATION_RECORDING = savedRecording;
  });

  test('happy path: claim, publish, then latch — in that order', async () => {
    const { result, updates } = await detectRevocation({ publishSucceeds: true });

    expect(result).toBeNull();
    expect(announceMock).toHaveBeenCalledTimes(1);
    // The claim is taken first and the status latch last. Asserted as an order, not a
    // set: the whole defect was that both writes happened but in the wrong sequence.
    expect(updates.map((u) => u.UpdateExpression)).toEqual([
      'SET revocation_announced_at = :now',
      'SET #s = :revoked, revoked_at = :now, revoked_reason = :reason',
    ]);
  });

  test('a failed publish releases the claim and leaves the row ACTIVE, so it retries', async () => {
    // The row staying active is the entire point. Latching a workspace whose
    // notification never went out is what made the silence permanent: the resolver
    // returns early on a `revoked` row, so nothing re-detects the dead grant.
    const { updates } = await detectRevocation({ publishSucceeds: false });

    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(updates.map((u) => u.UpdateExpression)).toEqual([
      'SET revocation_announced_at = :now',
      'REMOVE revocation_announced_at',
    ]);
    // No status write at all.
    expect(updates.some((u) => u.UpdateExpression.includes('revoked_at'))).toBe(false);
  });

  test('when the claim is already held it does not announce again, but still latches', async () => {
    // Retrying the latch has to be unconditional-ish: the claim may be held by an
    // invocation that published and then failed to record, and this write is
    // conditional and idempotent, so attempting it costs nothing and is the only
    // thing that eventually gets the row marked.
    const { updates } = await detectRevocation({ publishSucceeds: true, claimAlreadyHeld: true });

    expect(announceMock).not.toHaveBeenCalled();
    expect(updates.map((u) => u.UpdateExpression)).toEqual([
      'SET revocation_announced_at = :now',
      'SET #s = :revoked, revoked_at = :now, revoked_reason = :reason',
    ]);
  });

  test('a failed latch does not undo the announcement', async () => {
    const { updates } = await detectRevocation({ publishSucceeds: true, latchFails: true });

    expect(announceMock).toHaveBeenCalledTimes(1);
    // Notably NOT followed by a claim release: the operator has been told, and
    // re-announcing on every subsequent event would be a mail storm.
    expect(updates.map((u) => u.UpdateExpression)).toEqual([
      'SET revocation_announced_at = :now',
      'SET #s = :revoked, revoked_at = :now, revoked_reason = :reason',
    ]);
  });

  test('the claim is scoped to the installation, so a stale verdict cannot announce', async () => {
    const { updates } = await detectRevocation({ publishSucceeds: true });
    expect(updates[0].ConditionExpression)
      .toBe('attribute_not_exists(revocation_announced_at) AND installed_at = :installed');
  });

  test('with no alert topic it records without announcing, rather than skipping the record', async () => {
    topicArnMock.mockReturnValue(undefined);
    const { updates } = await detectRevocation({ publishSucceeds: true });

    expect(announceMock).not.toHaveBeenCalled();
    expect(updates.map((u) => u.UpdateExpression))
      .toEqual(['SET #s = :revoked, revoked_at = :now, revoked_reason = :reason']);
  });

  test('the recorded reason distinguishes Linear refusing from a vault inference', async () => {
    // `refresh_token_rejected` is a fact and is never re-probed;
    // `vault_consent_required` is an inference the resolver retries. Writing the wrong
    // one turns a self-healing latch into a permanent one, or the reverse.
    const { updates } = await detectRevocation({ publishSucceeds: true });
    const latch = updates.find((u) => u.UpdateExpression.includes('revoked_reason'))!;
    expect(latch.ConditionExpression).toContain('installed_at = :installed');
  });
});
