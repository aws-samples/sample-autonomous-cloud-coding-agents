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
      headers: { get: () => null },
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

  test('logs Retry-After header on rate-limited Slack responses (PR #79 review #4)', async () => {
    // Slack returns the Retry-After header (in seconds) on
    // ``ratelimited`` so callers know when to retry. Surfacing it in
    // the warn log means operators reading CloudWatch can see the
    // expected recovery time instead of guessing from sustained warn
    // rate.
    ddbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '30' : null) },
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });

    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb),
      ).rejects.toThrow(/ratelimited/);

      const retryWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.retryable_api_error',
      );
      expect(retryWarn).toBeDefined();
      expect((retryWarn?.[1] as Record<string, unknown>).retry_after_seconds).toBe('30');
      expect((retryWarn?.[1] as Record<string, unknown>).slack_error_code).toBe('ratelimited');
    } finally {
      warnSpy.mockRestore();
    }
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

  // ---------------------------------------------------------------------
  // PR #79 test gap #31 — conditional UpdateItem race + dup-delete
  // ---------------------------------------------------------------------

  test('task_created persist ConditionalCheckFailed → posts duplicate then deletes it', async () => {
    // Race: a sibling retry already wrote ``slack_created_msg_ts``.
    // Our POST landed in Slack first, the conditional UpdateItem
    // failed, and we must clean up the duplicate root message via
    // ``chat.delete``. Without this, the channel accumulates ghost
    // task_created posts on every retry-after-success-write race.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );
    // Default fetchMock returns ok=true with ts; fine for the post +
    // best-effort reaction calls. The chat.delete call uses the same
    // default which is also ``ok: true`` — perfect for the success path.

    await dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb);

    // Find the chat.delete invocation by URL — the duplicate cleanup
    // is the load-bearing assertion. Reaction add/remove calls fall
    // through to the default mock and don't carry test signal here.
    const deleteCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.delete',
    );
    expect(deleteCall).toBeDefined();
    const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
    expect(deleteBody.ts).toBe('1234.0001');
  });

  test('session_started persist ConditionalCheckFailed → posts duplicate then deletes it', async () => {
    // Same race as task_created but for session_started; uses
    // ``slack_session_msg_ts`` as the conditional attribute. Without
    // delete, terminal cleanup would orphan the duplicate session
    // message (terminal cleanup deletes a single session_msg_ts, not
    // the duplicate that was never persisted).
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_thread_ts: '999.000', // session_started threads under task_created
          },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );

    await dispatchSlackEvent(mkEvent('t1', 'session_started'), ddb);

    const deleteCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.delete',
    );
    expect(deleteCall).toBeDefined();
    const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
    expect(deleteBody.ts).toBe('1234.0001');
  });

  test('dup-delete failure emits fanout.slack.dup_delete_failed with error_id (PR #79 review #6)', async () => {
    // The conditional persist hit a sibling retry; we tried to delete
    // the duplicate Slack message but ``chat.delete`` failed. The
    // duplicate is now permanent in the thread — operators need a
    // dedicated alarmable signal so they can detect ghost-message
    // accumulation. We override the default mock for chat.delete
    // specifically by URL-routing the fetch implementation rather
    // than relying on call-order, so reactions can fall through to
    // the default without consuming our scripted responses.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://slack.com/api/chat.delete') {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: false, error: 'cant_delete_message' }),
        };
      }
      // Default: chat.postMessage / reactions.* succeed.
      return {
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ ok: true, ts: '1234.0001' }),
      };
    });

    const loggerModule = await import('../../src/handlers/shared/logger');
    const errorSpy = jest.spyOn(loggerModule.logger, 'error').mockImplementation(() => undefined);
    try {
      await dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb);

      const ghostError = errorSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.dup_delete_failed',
      );
      expect(ghostError).toBeDefined();
      expect((ghostError?.[1] as Record<string, unknown>).error_id).toBe('FANOUT_SLACK_DUP_DELETE_FAILED');
      expect((ghostError?.[1] as Record<string, unknown>).duplicate_ts).toBe('1234.0001');
      expect((ghostError?.[1] as Record<string, unknown>).event_type).toBe('task_created');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('chat.delete returning message_not_found is treated as success (no dup_delete_failed)', async () => {
    // ``message_not_found`` means the duplicate already got cleaned
    // up by something else (e.g. a previous retry's delete). The
    // dup_delete_failed alarm must NOT fire on this benign case, or
    // operators will see false positives whenever the race resolves
    // cleanly.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://slack.com/api/chat.delete') {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: false, error: 'message_not_found' }),
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ ok: true, ts: '1234.0001' }),
      };
    });

    const loggerModule = await import('../../src/handlers/shared/logger');
    const errorSpy = jest.spyOn(loggerModule.logger, 'error').mockImplementation(() => undefined);
    try {
      await dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb);

      const ghostError = errorSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.dup_delete_failed',
      );
      expect(ghostError).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------
  // PR #79 test gap #33 — agent_error dedup (review finding #4)
  // -------------------------------------------------------------------

  test('agent_error claims its own dedup attribute (slack_dispatched_agent_error)', async () => {
    // Pre-PR-#79 review #4 fix: agent_error had no dedup, so a
    // sibling-channel-failure retry could double-page operators.
    // Post-fix: agent_error writes ``channel_metadata.slack_dispatched_agent_error``
    // via a conditional UpdateItem before posting. This test pins
    // the *attribute name* in the UpdateExpression so a future
    // refactor that renames the attribute breaks loudly here.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}); // dedup UpdateItem succeeds

    await dispatchSlackEvent(mkEvent('t1', 'agent_error'), ddb);

    // Second DDB call is the dedup UpdateItem — pin its shape.
    const updateInput = ddbSend.mock.calls[1][0]._type === 'Update'
      ? ddbSend.mock.calls[1][0].input
      : null;
    expect(updateInput).toBeTruthy();
    expect(updateInput.UpdateExpression).toContain('slack_dispatched_agent_error');
    expect(updateInput.ConditionExpression).toContain(
      'attribute_not_exists(channel_metadata.slack_dispatched_agent_error)',
    );
  });

  test('agent_error retry hits the dedup guard and skips the post (sibling-channel-failure scenario)', async () => {
    // The actual scenario PR #79 review #4 is about: GitHub fails on
    // the first run, the record retries, and the Slack agent_error
    // dispatcher fires AGAIN. Without the per-event-type dedup, we
    // would post a duplicate :rotating_light: line. With it, the
    // ConditionalCheckFailedException short-circuits before
    // chat.postMessage is ever called.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_dispatched_agent_error: true, // already posted on the first try
          },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );

    await dispatchSlackEvent(mkEvent('t1', 'agent_error'), ddb);

    // No fetch — the dedup guard short-circuited.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('terminal dedup attribute is per-class (any first terminal claims; subsequent terminals dedup)', async () => {
    // Defense-in-depth for the SLACK_DEDUP_ATTRIBUTE map: a
    // ``task_completed`` followed by a sibling-failure-retry's
    // ``task_failed`` (e.g. orchestrator wrote both because of a
    // late-arriving failure) must dedup against the same
    // ``slack_notified_terminal`` slot. Otherwise a flaky retry
    // could post both a ✅ and an ❌ for the same task.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_notified_terminal: true, // task_completed already posted
          },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );

    // Simulate an orchestrator-emitted task_failed arriving after
    // task_completed already claimed the terminal slot.
    await dispatchSlackEvent(mkEvent('t1', 'task_failed'), ddb);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('agent_error and terminals use distinct dedup slots (do not collide)', async () => {
    // An agent_error followed by a task_completed must both be
    // delivered — they live in different slots
    // (slack_dispatched_agent_error vs slack_notified_terminal).
    // This test pins the separation so a future refactor can't
    // accidentally collapse them and silently drop terminals after
    // an agent_error.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_dispatched_agent_error: true, // agent_error already posted
            // slack_notified_terminal is NOT set
          },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}); // terminal dedup UpdateItem succeeds

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    // Reaches chat.postMessage — the agent_error slot did not
    // shadow the terminal slot.
    expect(fetchMock).toHaveBeenCalled();
    const postCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.postMessage',
    );
    expect(postCall).toBeDefined();
  });

  // -------------------------------------------------------------------
  // PR #79 test gap #35 — task_stranded through terminal dedup
  // -------------------------------------------------------------------

  test('task_stranded posts and writes the terminal dedup marker on first arrival', async () => {
    // task_stranded is one of the 5 terminals that share
    // ``slack_notified_terminal``. The reconciler emits
    // task_stranded + task_failed back-to-back when a heartbeat
    // expires (handlers/reconcile-stranded-tasks.ts:170+); whichever
    // arrives first claims the slot and posts a Slack message.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}); // dedup UpdateItem succeeds

    await dispatchSlackEvent(
      mkEvent('t1', 'task_stranded', { code: 'STRANDED_NO_HEARTBEAT', prior_status: 'RUNNING' }),
      ddb,
    );

    // Dedup wrote against the shared terminal slot.
    const updateInput = ddbSend.mock.calls[1][0]._type === 'Update'
      ? ddbSend.mock.calls[1][0].input
      : null;
    expect(updateInput).toBeTruthy();
    expect(updateInput.UpdateExpression).toContain('slack_notified_terminal');

    // chat.postMessage fired with the stranded warning.
    const postCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.postMessage',
    );
    expect(postCall).toBeDefined();
    const postBody = JSON.parse((postCall![1] as { body: string }).body);
    expect(postBody.text).toContain('Task stranded');
  });

  test('terminal cleanup re-reads TaskRecord so it sees msg_ts attrs persisted on earlier stream batches (orphan-message fix)', async () => {
    // Fast-task orphan scenario observed live during PR #79 review:
    //   1. task_created stream batch posts the rocket message and
    //      writes ``slack_created_msg_ts``.
    //   2. task_completed stream batch runs ~30s later. Its initial
    //      GetItem races the prior UpdateItem and sees stale
    //      channel_metadata WITHOUT slack_created_msg_ts.
    //   3. Without the re-read, the terminal cleanup branch sees
    //      ``channelMeta.slack_created_msg_ts === undefined`` and
    //      silently skips. The rocket message stays in the thread.
    // Fix: a fresh GetItem inside the terminal-cleanup branch
    // (after the dedup UpdateItem has linearized our view) sees the
    // newly-written attribute and triggers the chat.delete.
    ddbSend
      .mockResolvedValueOnce({ // dispatch-entry GetItem — STALE (no msg_ts)
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}) // dedup UpdateItem succeeds
      .mockResolvedValueOnce({ // terminal cleanup re-read — FRESH
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_created_msg_ts: '1234.0001', // landed via the prior batch
          },
          repo: 'org/repo',
        },
      });

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    // The chat.delete fires against the freshly-read msg_ts.
    const deleteCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.delete',
    );
    expect(deleteCall).toBeDefined();
    const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
    expect(deleteBody.ts).toBe('1234.0001');
  });

  test('terminal cleanup falls back to dispatch-entry snapshot when re-read fails', async () => {
    // Defense-in-depth: a transient DDB failure on the re-read GetItem
    // must NOT break terminal delivery. Falls back to the snapshot we
    // already had, logs a warn, and continues.
    ddbSend
      .mockResolvedValueOnce({ // dispatch-entry GetItem — has msg_ts
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_created_msg_ts: '9999.0001',
          },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({}) // dedup
      .mockRejectedValueOnce(new Error('throttled')); // re-read fails

    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

      // Cleanup still ran with the original snapshot's msg_ts.
      const deleteCall = fetchMock.mock.calls.find(
        ([url]) => url === 'https://slack.com/api/chat.delete',
      );
      expect(deleteCall).toBeDefined();
      const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
      expect(deleteBody.ts).toBe('9999.0001');

      // The fallback was observable.
      const fallbackWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.cleanup_reread_failed',
      );
      expect(fallbackWarn).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('task_stranded after a sibling task_failed dedups (no double-page on the reconciler twin)', async () => {
    // Real-world scenario: the reconciler writes BOTH task_stranded
    // and task_failed for a heartbeat-expired task (one for the
    // operator signal, one to drive the FAILED status transition).
    // If both fan out to Slack, the slot must dedup the second
    // arrival so operators see exactly one alert per stranded task,
    // not a paired ``Task stranded`` + ``Task failed`` storm.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_notified_terminal: true, // task_failed already claimed
          },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );

    await dispatchSlackEvent(mkEvent('t1', 'task_stranded'), ddb);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
