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
 * Tests for the revoked-authorization announcement (#812).
 *
 * The latch — and therefore the dedup — lives in the resolver, which owns the
 * conditional write. This module is only the operator-facing message, so what
 * matters here is that the message is ACTIONABLE, and that failing to send it can
 * never escalate: it runs inside token resolution, where a throw would turn a
 * notification outage into a broken webhook handler.
 */

const snsSend = jest.fn();
jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn(() => ({ send: snsSend })),
  PublishCommand: jest.fn((input: unknown) => ({ _type: 'Publish', input })),
}));

import {
  announceRevocation,
  revocationAlertTopicArn,
  type AnnounceableRevocation,
} from '../../../src/handlers/shared/linear-revocation-alert';

interface Published { readonly _type: string; readonly input: Record<string, string> }

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:alerts';
const opts = () => ({ topicArn: TOPIC, snsClient: { send: snsSend } as never });

function detail(overrides: Partial<AnnounceableRevocation> = {}): AnnounceableRevocation {
  return {
    linearWorkspaceId: 'org-abc',
    workspaceSlug: 'acme',
    source: 'secrets-manager-refresh',
    ...overrides,
  };
}

const published = (): Published => snsSend.mock.calls[0][0] as Published;

beforeEach(() => {
  snsSend.mockReset();
  snsSend.mockResolvedValue({});
});

describe('revocationAlertTopicArn', () => {
  test('is undefined when the stack wired no topic, so the caller can say "recorded only"', () => {
    const saved = process.env.OPERATIONAL_ALERT_TOPIC_ARN;
    delete process.env.OPERATIONAL_ALERT_TOPIC_ARN;
    expect(revocationAlertTopicArn()).toBeUndefined();
    process.env.OPERATIONAL_ALERT_TOPIC_ARN = TOPIC;
    expect(revocationAlertTopicArn()).toBe(TOPIC);
    if (saved === undefined) delete process.env.OPERATIONAL_ALERT_TOPIC_ARN;
    else process.env.OPERATIONAL_ALERT_TOPIC_ARN = saved;
  });
});

describe('announceRevocation', () => {
  test('names the workspace and the exact recovery command', async () => {
    await announceRevocation(detail(), opts());
    expect(snsSend).toHaveBeenCalledTimes(1);
    expect(published().input.TopicArn).toBe(TOPIC);
    expect(published().input.Subject).toContain('acme');
    expect(published().input.Message).toContain('bgagent linear setup acme');
    // Explains the consequence, so it is not merely a status ping.
    expect(published().input.Message).toMatch(/dropped|appear to do nothing/i);
  });

  test('the vault source names a remedy that EXISTS, and says it is the vault', async () => {
    // Both failure shapes are repaired by the same command now that onboarding is one
    // command; the message must still say WHICH credential died, or an operator
    // cannot tell a dead vault consent from a rejected Secrets-Manager refresh.
    //
    // This test previously demanded `vault-setup`, which was removed when onboarding
    // was consolidated — so it was pinning an instruction that would fail with an
    // unknown command. A remedy nobody can run is worse than none.
    await announceRevocation(detail({ source: 'vault-consent-required' }), opts());
    const message = published().input.Message as string;
    expect(message).toContain('bgagent linear setup acme');
    expect(message).not.toContain('vault-setup');
    expect(message).toMatch(/vault/i);
  });

  test('a failed publish REPORTS false rather than throwing', async () => {
    // Not throwing, because this runs inside token resolution and an exception would
    // turn a notification outage into a broken webhook handler. But not silent
    // either: swallowing the failure and returning void made the caller believe the
    // operator had been told, which — with the caller latching the row `revoked` and
    // then never re-detecting the dead grant — meant permanent silence. The boolean
    // is what lets the caller release its claim and retry on a later event.
    snsSend.mockRejectedValueOnce(new Error('KMSAccessDeniedException'));
    await expect(announceRevocation(detail(), opts())).resolves.toBe(false);
  });

  test('a successful publish reports true', async () => {
    await expect(announceRevocation(detail(), opts())).resolves.toBe(true);
  });

  test('falls back to the workspace id when no slug is known', async () => {
    await announceRevocation({ linearWorkspaceId: 'org-xyz', source: 'secrets-manager-refresh' }, opts());
    expect(published().input.Subject).toContain('org-xyz');
  });

  test('the SNS Subject stays within the 100-character API limit', async () => {
    await announceRevocation(detail({ workspaceSlug: 'x'.repeat(200) }), opts());
    expect(published().input.Subject.length).toBeLessThanOrEqual(100);
  });

  // The assertions above all use `toContain`, which cannot see a command rendered
  // TWICE — and the vault branch did render it twice, appending an annotated copy
  // under the plain one. These pin the shape of the message an operator reads, not
  // just its substrings.
  test.each([
    ['secrets-manager-refresh'],
    ['vault-consent-required'],
  ] as const)('%s names the recovery command exactly once', async (source) => {
    await announceRevocation(detail({ source }), opts());
    const lines = (published().input.Message as string).split('\n');
    expect(lines.filter((l) => l.includes('bgagent linear setup'))).toHaveLength(1);
  });

  test('paragraph breaks survive into the delivered message', async () => {
    // The lines were assembled with `''` separators and then run through a
    // `.filter(line => line !== '')`, which stripped every one of them — collapsing
    // the whole email into an unreadable block. Invisible in the source; obvious the
    // moment the message is rendered.
    await announceRevocation(detail(), opts());
    expect(published().input.Message as string).toContain('\n\n');
  });
});
