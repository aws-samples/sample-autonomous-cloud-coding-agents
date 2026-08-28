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
 * Tests for the revoked-authorization alerter (#812).
 *
 * The two properties worth locking down are behavioural, not cosmetic:
 *  - ANNOUNCE ONCE. A revoked workspace keeps producing events; alerting on
 *    detection would page per event. The registry latch is the dedup key.
 *  - STAY ACTIONABLE AND NON-FATAL. The message must name the workspace and the
 *    fix command, and a failed announcement must never escalate into a thrown
 *    handler — recording a diagnosis cannot be allowed to break token resolution.
 */

const snsSend = jest.fn();
jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn(() => ({ send: snsSend })),
  PublishCommand: jest.fn((input: unknown) => ({ _type: 'Publish', input })),
}));

import type { RevocationDetail } from '../../../src/handlers/shared/linear-oauth-resolver';
import { makeRevocationAlerter } from '../../../src/handlers/shared/linear-revocation-alert';

interface Published { readonly _type: string; readonly input: Record<string, string> }

const TABLE = 'TestLinearWorkspaceRegistry';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:alerts';

function detail(overrides: Partial<RevocationDetail> = {}): RevocationDetail {
  return {
    linearWorkspaceId: 'org-abc',
    workspaceSlug: 'acme',
    installedAt: '2026-08-01T00:00:00Z',
    source: 'secrets-manager-refresh',
    ...overrides,
  };
}

/** A doc client whose conditional update either applies or fails the condition. */
function ddbThat(outcome: 'latches' | 'already-revoked') {
  const send = jest.fn().mockImplementation(() => {
    if (outcome === 'already-revoked') {
      const err = new Error('conditional');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    return {};
  });
  return { client: { send } as never, send };
}

beforeEach(() => {
  snsSend.mockReset();
  snsSend.mockResolvedValue({});
});

describe('makeRevocationAlerter', () => {
  test('latches the row and announces ONCE with the workspace and the fix command', async () => {
    const ddb = ddbThat('latches');
    await makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })(detail());

    expect(ddb.send).toHaveBeenCalledTimes(1);
    expect(snsSend).toHaveBeenCalledTimes(1);
    const published = snsSend.mock.calls[0][0] as Published;
    expect(published.input.TopicArn).toBe(TOPIC);
    // Actionable: names the workspace and the exact recovery command.
    expect(published.input.Subject).toContain('acme');
    expect(published.input.Message).toContain('bgagent linear setup acme');
    // And explains the consequence, so it is not just a status ping.
    expect(published.input.Message).toMatch(/dropped|appear to do nothing/i);
  });

  test('does NOT announce when the latch did not apply (dedup across a webhook burst)', async () => {
    // Second and subsequent events for the same dead grant hit the conditional
    // write and lose. Without this, one revocation pages once per inbound event.
    const ddb = ddbThat('already-revoked');
    await makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })(detail());

    expect(ddb.send).toHaveBeenCalledTimes(1);
    expect(snsSend).not.toHaveBeenCalled();
  });

  test('the vault source is named differently and points at vault-setup too', async () => {
    // The two failure shapes need different remedies: a Secrets-Manager rejection
    // is fixed by re-running setup, a vault consent by re-running vault-setup.
    const ddb = ddbThat('latches');
    await makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })(detail({ source: 'vault-consent-required' }));

    const published = snsSend.mock.calls[0][0] as Published;
    expect(published.input.Message).toContain('vault-setup acme');
    expect(published.input.Message).toMatch(/vault/i);
    // The registry reason must distinguish the two, or `platform doctor` cannot.
    const update = ddb.send.mock.calls[0][0] as { input: { ExpressionAttributeValues: Record<string, string> } };
    expect(update.input.ExpressionAttributeValues[':reason']).toBe('vault_consent_required');
  });

  test('scopes the latch to the installation diagnosed, never its successor', async () => {
    const ddb = ddbThat('latches');
    await makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })(detail({ installedAt: '2026-08-01T00:00:00Z' }));

    const update = ddb.send.mock.calls[0][0] as {
      input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(update.input.ConditionExpression).toContain('installed_at = :installed');
    expect(update.input.ExpressionAttributeValues[':installed']).toBe('2026-08-01T00:00:00Z');
  });

  test('a failed announcement does NOT throw — the latch still stands', async () => {
    // Announcing is best-effort by design: this runs inside token resolution, and
    // a notification outage must not turn into a broken webhook handler. The row
    // is already marked, so `platform doctor` can still explain the state.
    const ddb = ddbThat('latches');
    snsSend.mockRejectedValueOnce(new Error('KMSAccessDeniedException'));
    await expect(makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })(detail())).resolves.toBeUndefined();
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  test('with no topic configured it still latches, and does not pretend to notify', async () => {
    const ddb = ddbThat('latches');
    await makeRevocationAlerter({ ddb: ddb.client, registryTableName: TABLE })(detail());
    expect(ddb.send).toHaveBeenCalledTimes(1);
    expect(snsSend).not.toHaveBeenCalled();
  });

  test('falls back to the workspace id when no slug is known', async () => {
    const ddb = ddbThat('latches');
    await makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })({ linearWorkspaceId: 'org-xyz', source: 'secrets-manager-refresh' });

    const published = snsSend.mock.calls[0][0] as Published;
    expect(published.input.Subject).toContain('org-xyz');
  });

  test('the SNS Subject stays within the 100-character API limit', async () => {
    const ddb = ddbThat('latches');
    await makeRevocationAlerter({
      ddb: ddb.client, registryTableName: TABLE, alertTopicArn: TOPIC, snsClient: { send: snsSend } as never,
    })(detail({ workspaceSlug: 'x'.repeat(200) }));

    const published = snsSend.mock.calls[0][0] as Published;
    expect(published.input.Subject.length).toBeLessThanOrEqual(100);
  });
});
