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

// Issue #64: SlackNotifyFn migrated off the direct DynamoDB Streams
// event-source mapping onto FanOutConsumer as a per-channel dispatcher.
// The tests here cover ``dispatchSlackEvent`` directly — the unit of
// behaviour the fan-out router invokes. End-to-end coverage through the
// router lives in ``fanout-task-events.test.ts``.

const ddbSend = jest.fn();
const ddbClient = { send: ddbSend };
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.TASK_TABLE_NAME = 'Tasks';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dispatchSlackEvent, SlackApiError, type SlackDispatchEvent } from '../../src/handlers/slack-notify';

const ddb = ddbClient as unknown as DynamoDBDocumentClient;

function mkEvent(
  taskId: string,
  eventType: string,
  metadata?: Record<string, unknown>,
): SlackDispatchEvent {
  return {
    task_id: taskId,
    event_id: `evt-${taskId}-${eventType}`,
    event_type: eventType,
    timestamp: '2026-05-05T00:00:00Z',
    metadata,
  };
}

describe('dispatchSlackEvent', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    smSend.mockResolvedValue({ SecretString: 'xoxb-test' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, ts: '1234.0001' }),
    });
  });

  test('skips non-slack tasks without touching Slack', async () => {
    // A Slack-subscribed event on a non-Slack task must still short-
    // circuit cheaply — one DDB Get, no dedup write, no API call.
    // This is the ``channel_source === 'slack'`` gate.
    ddbSend.mockResolvedValueOnce({
      Item: { task_id: 't1', channel_source: 'api', channel_metadata: {} },
    });

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('dedup write only runs after channel_source is confirmed slack', async () => {
    // Order matters: we must not write the dedup marker on a task we
    // are about to skip.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}); // UpdateCommand for dedup

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    expect(ddbSend.mock.calls[0][0]._type).toBe('Get');
    expect(ddbSend.mock.calls[1][0]._type).toBe('Update');
    expect(fetchMock).toHaveBeenCalled();
  });

  test('skips terminal notification when dedup marker already exists', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
        },
      })
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));

    await dispatchSlackEvent(mkEvent('t1', 'task_failed'), ddb);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    // Channel + message shape.
    'channel_not_found',
    'not_in_channel',
    'is_archived',
    'message_not_found',
    // Auth.
    'not_authed',
    'invalid_auth',
    'token_revoked',
    'token_expired',
    'account_inactive',
    // Permission / scope (PR #79 review #8).
    'no_permission',
    'missing_scope',
    'restricted_action',
    'ekm_access_denied',
    'team_access_not_granted',
    'posting_to_general_channel_denied',
    'as_user_not_supported',
    // Payload shape.
    'invalid_blocks',
    'invalid_blocks_format',
    'invalid_arguments',
    'msg_too_long',
    'too_many_attachments',
  ])('throws a tagged SlackApiError on terminal Slack code %s (router swallows)', async (slackErrorCode) => {
    // Pre-PR-#79-review the set was narrower; permission/scope
    // codes (ekm_access_denied, missing_scope, etc.) used to be
    // classified retryable and would burn 3 retries before DLQ on
    // a misconfiguration that no retry can fix.
    ddbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: slackErrorCode }),
    });

    await expect(
      dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb),
    ).rejects.toBeInstanceOf(SlackApiError);
  });

  test.each([
    'ratelimited',
    'service_unavailable',
    'internal_error',
    'fatal_error',
    'request_timeout',
    'unknown_method', // anything not in TERMINAL_SLACK_API_ERRORS counts as retryable
  ])('throws a plain Error (NOT SlackApiError) on retryable code %s', async (slackErrorCode) => {
    // Post-issue-#64-review Cat 3 fix: retryable Slack errors must
    // propagate as plain Error so the router classifies them as
    // infra rejections and Lambda replays the record. Without this
    // split, a transient ratelimited or service_unavailable would
    // get permanently dropped under the SlackApiError swallow.
    ddbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: slackErrorCode }),
    });

    let caught: unknown;
    try {
      await dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SlackApiError);
    expect((caught as Error).message).toContain(slackErrorCode);
  });

  test('rethrows infra errors so the router records a dispatcher-rejected warn', async () => {
    // DDB throttling and Secrets Manager outages must surface to the
    // router — Promise.allSettled records them as rejections and batch
    // telemetry reflects that the record didn't dispatch.
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error('throttle'), { name: 'ProvisionedThroughputExceededException' }),
    );

    await expect(
      dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb),
    ).rejects.toThrow('throttle');
  });

  test('throws when TASK_TABLE_NAME env var is missing (PR #79 review #3)', async () => {
    // Pre-fix: missing env returned silently, so the router counted
    // Slack as "dispatched" and a broken stack quietly dropped every
    // Slack notification. Post-fix: throw so the rejection lands in
    // ``infraRejections`` and Lambda retries / DLQs.
    const original = process.env.TASK_TABLE_NAME;
    delete process.env.TASK_TABLE_NAME;
    try {
      await expect(
        dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb),
      ).rejects.toThrow(/TASK_TABLE_NAME env var not set/);
      // No DDB call attempted — the env-var guard fires first.
      expect(ddbSend).not.toHaveBeenCalled();
    } finally {
      process.env.TASK_TABLE_NAME = original;
    }
  });

  test('ignores event types not in the Slack render set', async () => {
    // Defence-in-depth: even if the fanout filter drifts and sends us
    // an event the renderer doesn't know how to format, we must
    // short-circuit without touching DDB or Slack.
    await dispatchSlackEvent(mkEvent('t1', 'agent_heartbeat'), ddb);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('uses pre-parsed metadata without a JSON re-parse', async () => {
    // The fan-out router hands us a parsed metadata map — the
    // dispatcher must not insist on the old ``metadata: { S: ... }``
    // JSON string shape.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
          error_message: 'agent crashed',
        },
      })
      .mockResolvedValueOnce({});

    await dispatchSlackEvent(
      mkEvent('t1', 'task_failed', { error: 'oom killed' }),
      ddb,
    );

    expect(fetchMock).toHaveBeenCalled();
    const postBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(postBody.text).toContain('org/repo');
  });
});
