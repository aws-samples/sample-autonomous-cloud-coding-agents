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
    ddbSend.mockResolvedValueOnce({
      Item: { task_id: 't1', channel_source: 'api', channel_metadata: {} },
    });

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('dedup write only runs after channel_source is confirmed slack', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({});

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
    'channel_not_found',
    'not_in_channel',
    'is_archived',
    'message_not_found',
    'not_authed',
    'invalid_auth',
    'token_revoked',
    'token_expired',
    'account_inactive',
    'no_permission',
    'missing_scope',
    'restricted_action',
    'ekm_access_denied',
    'team_access_not_granted',
    'posting_to_general_channel_denied',
    'as_user_not_supported',
    'invalid_blocks',
    'invalid_blocks_format',
    'invalid_arguments',
    'msg_too_long',
    'too_many_attachments',
  ])('throws a tagged SlackApiError on terminal Slack code %s (router swallows)', async (slackErrorCode) => {
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
    'unknown_method',
  ])('throws a plain Error (NOT SlackApiError) on retryable code %s', async (slackErrorCode) => {
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
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error('throttle'), { name: 'ProvisionedThroughputExceededException' }),
    );

    await expect(
      dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb),
    ).rejects.toThrow('throttle');
  });

  test('throws when TASK_TABLE_NAME env var is missing (PR #79 review #3)', async () => {
    const original = process.env.TASK_TABLE_NAME;
    delete process.env.TASK_TABLE_NAME;
    try {
      await expect(
        dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb),
      ).rejects.toThrow(/TASK_TABLE_NAME env var not set/);
      expect(ddbSend).not.toHaveBeenCalled();
    } finally {
      process.env.TASK_TABLE_NAME = original;
    }
  });

  test('ignores event types not in the Slack render set', async () => {
    await dispatchSlackEvent(mkEvent('t1', 'agent_heartbeat'), ddb);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('uses pre-parsed metadata without a JSON re-parse', async () => {
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

  test('task_created persist ConditionalCheckFailed → posts duplicate then deletes it', async () => {
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

    await dispatchSlackEvent(mkEvent('t1', 'task_created'), ddb);

    const deleteCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.delete',
    );
    expect(deleteCall).toBeDefined();
    const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
    expect(deleteBody.ts).toBe('1234.0001');
  });

  test('session_started persist ConditionalCheckFailed → posts duplicate then deletes it', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_thread_ts: '999.000',
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

  test('agent_error claims its own dedup attribute (slack_dispatched_agent_error)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({});

    await dispatchSlackEvent(mkEvent('t1', 'agent_error'), ddb);

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
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_dispatched_agent_error: true,
          },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );

    await dispatchSlackEvent(mkEvent('t1', 'agent_error'), ddb);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('terminal dedup attribute is per-class (any first terminal claims; subsequent terminals dedup)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_notified_terminal: true,
          },
          repo: 'org/repo',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond fail'), { name: 'ConditionalCheckFailedException' }),
      );

    await dispatchSlackEvent(mkEvent('t1', 'task_failed'), ddb);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('agent_error and terminals use distinct dedup slots (do not collide)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_dispatched_agent_error: true,
          },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({});

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    expect(fetchMock).toHaveBeenCalled();
    const postCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.postMessage',
    );
    expect(postCall).toBeDefined();
  });

  test('task_stranded posts and writes the terminal dedup marker on first arrival', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({});

    await dispatchSlackEvent(
      mkEvent('t1', 'task_stranded', { code: 'STRANDED_NO_HEARTBEAT', prior_status: 'RUNNING' }),
      ddb,
    );

    const updateInput = ddbSend.mock.calls[1][0]._type === 'Update'
      ? ddbSend.mock.calls[1][0].input
      : null;
    expect(updateInput).toBeTruthy();
    expect(updateInput.UpdateExpression).toContain('slack_notified_terminal');

    const postCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.postMessage',
    );
    expect(postCall).toBeDefined();
    const postBody = JSON.parse((postCall![1] as { body: string }).body);
    expect(postBody.text).toContain('Task stranded');
  });

  test('terminal cleanup re-reads TaskRecord so it sees msg_ts attrs persisted on earlier stream batches (orphan-message fix)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_created_msg_ts: '1234.0001',
          },
          repo: 'org/repo',
        },
      });

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    const deleteCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://slack.com/api/chat.delete',
    );
    expect(deleteCall).toBeDefined();
    const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
    expect(deleteBody.ts).toBe('1234.0001');
  });

  test('terminal cleanup falls back to dispatch-entry snapshot when re-read fails', async () => {
    ddbSend
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('throttled'));

    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

      const deleteCall = fetchMock.mock.calls.find(
        ([url]) => url === 'https://slack.com/api/chat.delete',
      );
      expect(deleteCall).toBeDefined();
      const deleteBody = JSON.parse((deleteCall![1] as { body: string }).body);
      expect(deleteBody.ts).toBe('9999.0001');

      const fallbackWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.cleanup_reread_failed',
      );
      expect(fallbackWarn).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('task_stranded after a sibling task_failed dedups (no double-page on the reconciler twin)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_notified_terminal: true,
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

  test('the retry of a terminal event whose post was rate-limited posts the message', async () => {
    const channelMetadata: Record<string, unknown> = { slack_team_id: 'T1', slack_channel_id: 'C1' };
    ddbSend.mockImplementation(async (cmd: { _type: string; input: { UpdateExpression: string } }) => {
      if (cmd._type === 'Get') {
        return { Item: { task_id: 't1', channel_source: 'slack', repo: 'org/repo', channel_metadata: { ...channelMetadata } } };
      }
      const attr = /channel_metadata\.(\w+)/.exec(cmd.input.UpdateExpression)![1];
      if (cmd.input.UpdateExpression.startsWith('REMOVE')) {
        delete channelMetadata[attr];
      } else if (attr in channelMetadata) {
        throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      } else {
        channelMetadata[attr] = true;
      }
      return {};
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });

    await expect(
      dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb),
    ).rejects.toThrow(/ratelimited/);
    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    const posts = fetchMock.mock.calls.filter(
      ([url]) => url === 'https://slack.com/api/chat.postMessage',
    );
    expect(posts).toHaveLength(2);

    fetchMock.mockClear();
    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['a network error', 'slack_notified_terminal', 'task_completed', () => Promise.reject(new Error('socket hang up'))],
    [
      'an unparsable Slack answer', 'slack_dispatched_agent_error', 'agent_error',
      () => Promise.resolve({ ok: false, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
    ],
  ])('%s on the post gives the %s claim back (%s)', async (_failure, dedupAttr, eventType, failingFetch) => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    fetchMock.mockImplementationOnce(failingFetch);

    let caught: unknown;
    try {
      await dispatchSlackEvent(mkEvent('t1', eventType), ddb);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SlackApiError);

    expect(ddbSend).toHaveBeenCalledTimes(3);
    const release = ddbSend.mock.calls[2][0];
    expect(release._type).toBe('Update');
    expect(release.input.UpdateExpression).toBe(`REMOVE channel_metadata.${dedupAttr}`);
  });

  test('a terminal Slack error keeps the dedup claim (no retry is coming)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({});
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });

    await expect(
      dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb),
    ).rejects.toBeInstanceOf(SlackApiError);

    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  test('a bot-token read that fails leaves no dedup claim behind', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: { slack_team_id: 'T_THROTTLED', slack_channel_id: 'C1' },
        repo: 'org/repo',
      },
    });
    smSend.mockRejectedValueOnce(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
    );

    await expect(
      dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb),
    ).rejects.toThrow('Rate exceeded');

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a workspace whose bot token is scheduled for deletion is skipped, not retried', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: { slack_team_id: 'T_REMOVED', slack_channel_id: 'C1' },
        repo: 'org/repo',
      },
    });
    smSend.mockRejectedValueOnce(Object.assign(
      new Error("You can't perform this operation on the secret because it was marked for deletion."),
      { name: 'InvalidRequestException' },
    ));

    await dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a claim that cannot be given back is logged and does not hide the post failure', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1' },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('ddb throttle'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });

    const loggerModule = await import('../../src/handlers/shared/logger');
    const errorSpy = jest.spyOn(loggerModule.logger, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        dispatchSlackEvent(mkEvent('t1', 'task_completed'), ddb),
      ).rejects.toThrow(/ratelimited/);

      const releaseError = errorSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.dedup_release_failed',
      );
      expect(releaseError).toBeDefined();
      expect((releaseError?.[1] as Record<string, unknown>).error_id).toBe('FANOUT_SLACK_DEDUP_RELEASE_FAILED');
      expect((releaseError?.[1] as Record<string, unknown>).dedup_attr).toBe('slack_notified_terminal');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test.each([
    ['the mention itself when the task records it', { slack_thread_ts: '100.0001', slack_message_ts: '200.0002' }, '200.0002'],
    ['the thread root when the task records no message of its own', { slack_thread_ts: '100.0001' }, '100.0001'],
  ])('reactions go on %s, the post into the thread', async (_target, timestamps, reactionTs) => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't1',
          channel_source: 'slack',
          channel_metadata: { slack_team_id: 'T1', slack_channel_id: 'C1', ...timestamps },
          repo: 'org/repo',
        },
      })
      .mockResolvedValueOnce({});

    await dispatchSlackEvent(mkEvent('t1', 'session_started'), ddb);

    const bodies = (method: string) => fetchMock.mock.calls
      .filter(([url]) => url === `https://slack.com/api/${method}`)
      .map(([, opts]) => JSON.parse((opts as { body: string }).body));
    expect(bodies('chat.postMessage')).toEqual([expect.objectContaining({ channel: 'C1', thread_ts: '100.0001' })]);
    expect(bodies('reactions.remove')).toEqual([{ channel: 'C1', timestamp: reactionTs, name: 'eyes' }]);
    expect(bodies('reactions.add')).toEqual([{ channel: 'C1', timestamp: reactionTs, name: 'hourglass_flowing_sand' }]);
  });

  test.each([
    ['task_created', 'slack_created_msg_ts'],
    ['session_started', 'slack_session_msg_ts'],
  ])('a replayed %s does not post again when %s is already recorded', async (eventType, postedAttr) => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't1',
        channel_source: 'slack',
        channel_metadata: {
          slack_team_id: 'T1',
          slack_channel_id: 'C1',
          slack_thread_ts: '999.000',
          [postedAttr]: '111.222',
        },
        repo: 'org/repo',
      },
    });

    await dispatchSlackEvent(mkEvent('t1', eventType), ddb);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });
});
