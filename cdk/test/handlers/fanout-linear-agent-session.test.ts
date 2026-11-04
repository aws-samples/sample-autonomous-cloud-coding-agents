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

// Fan-out Linear dispatcher for agent-session tasks (ADR-018 Phase 2). A
// separate file from fanout-task-events.test.ts because the flag is read when
// the module builds CHANNEL_DEFAULTS, so it must be set before import.

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

const mockPostIssueComment = jest.fn().mockResolvedValue({ ok: true });
const mockResolveToken = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => mockPostIssueComment(...args),
  replyToComment: jest.fn(),
  upsertThreadedReply: jest.fn(),
  swapCommentReaction: jest.fn(),
  resolveToken: (...args: unknown[]) => mockResolveToken(...args),
}));

const mockEmitAgentActivity = jest.fn();
const mockAddAgentSessionExternalUrl = jest.fn();
jest.mock('../../src/handlers/shared/linear-agent-session', () => ({
  emitAgentActivity: (...args: unknown[]) => mockEmitAgentActivity(...args),
  addAgentSessionExternalUrl: (...args: unknown[]) => mockAddAgentSessionExternalUrl(...args),
}));

process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

import {
  CHANNEL_DEFAULTS,
  linearSessionTerminalActivity,
  routeEvent,
  type FanOutEvent,
  type TaskNotificationsConfig,
} from '../../src/handlers/fanout-task-events';
import { SESSION_STOP_CANCELLED_VIA } from '../../src/handlers/shared/linear-agent-session-event';

/** Route to the Linear dispatcher only, so the other channels stay out of the assertions. */
const LINEAR_ONLY: TaskNotificationsConfig = {
  slack: { enabled: false },
  github: { enabled: false },
  jira: { enabled: false },
  email: { enabled: false },
} as TaskNotificationsConfig;

const SESSION_TASK = {
  task_id: 't-sess',
  user_id: 'u-1',
  status: 'RUNNING',
  repo: 'acme/web',
  channel_source: 'linear',
  channel_metadata: {
    linear_issue_id: 'issue-1',
    linear_workspace_id: 'org-1',
    linear_agent_session_id: 'session-1',
  },
  cost_usd: 0.5,
  turns_attempted: 12,
  max_turns: 100,
  duration_s: 300,
};

function ev(eventType: string, metadata?: Record<string, unknown>): FanOutEvent {
  return { task_id: 't-sess', event_id: `e-${eventType}`, event_type: eventType, timestamp: '2026-11-04T00:00:00Z', metadata };
}

/** Get → the given task; Update → succeeds unless `updateError` is set. */
function mockTask(task: Record<string, unknown>, updateError?: Error): void {
  mockDdbSend.mockReset().mockImplementation(async (cmd: { _type: string }) => {
    if (cmd._type === 'Get') return { Item: task };
    if (cmd._type === 'Update' && updateError) throw updateError;
    return {};
  });
}

function updates(): Array<{ UpdateExpression: string; ConditionExpression?: string }> {
  return mockDdbSend.mock.calls.filter((c) => c[0]._type === 'Update').map((c) => c[0].input);
}

beforeEach(() => {
  mockPostIssueComment.mockClear();
  mockResolveToken.mockReset().mockResolvedValue('lin_tok');
  mockEmitAgentActivity.mockReset().mockResolvedValue({ ok: true });
  mockAddAgentSessionExternalUrl.mockReset().mockResolvedValue({ ok: true });
});

test('the flag subscribes the Linear channel to per-turn events', () => {
  expect(CHANNEL_DEFAULTS.linear.has('agent_turn')).toBe(true);
});

test('pr_created attaches the PR to the session and announces it, post-once', async () => {
  mockTask({ ...SESSION_TASK, pr_url: 'https://github.com/acme/web/pull/7', pr_number: 7 });
  const outcome = await routeEvent(ev('agent_milestone', { milestone: 'pr_created' }), LINEAR_ONLY);

  expect(outcome.infraRejections).toEqual([]);
  expect(mockAddAgentSessionExternalUrl).toHaveBeenCalledWith('lin_tok', 'session-1', {
    label: 'Pull request #7', url: 'https://github.com/acme/web/pull/7',
  });
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1', {
    type: 'action', action: 'Opened pull request', parameter: 'https://github.com/acme/web/pull/7',
  });
  expect(updates()[0].UpdateExpression).toContain('linear_pr_comment_event_id');
  // Session tasks never fall through to issue comments.
  expect(mockPostIssueComment).not.toHaveBeenCalled();
});

test('pr_created after a stop stays quiet (the final status carries the link)', async () => {
  mockTask({ ...SESSION_TASK, status: 'CANCELLED', pr_url: 'https://github.com/acme/web/pull/7' });
  await routeEvent(ev('agent_milestone', { milestone: 'pr_created' }), LINEAR_ONLY);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
  expect(mockAddAgentSessionExternalUrl).not.toHaveBeenCalled();
});

test('pr_created is skipped once its marker is set', async () => {
  mockTask({ ...SESSION_TASK, pr_url: 'https://github.com/acme/web/pull/7', linear_pr_comment_event_id: 'e-old' });
  await routeEvent(ev('agent_milestone', { milestone: 'pr_created' }), LINEAR_ONLY);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
});

test.each([
  ['task_completed', { status: 'COMPLETED', pr_url: 'https://github.com/acme/web/pull/7' }, 'response'],
  ['task_completed', { status: 'COMPLETED', code_changed: false, answer_text: 'Which DB?' }, 'elicitation'],
  ['task_cancelled', { status: 'CANCELLED' }, 'response'],
  ['task_failed', { status: 'FAILED', error_message: 'boom' }, 'error'],
  ['task_timed_out', { status: 'TIMED_OUT' }, 'error'],
  ['task_stranded', { status: 'FAILED' }, 'error'],
])('%s (%j) emits a final %s activity with the status body', async (eventType, fields, expectedType) => {
  mockTask({ ...SESSION_TASK, ...fields });
  await routeEvent(ev(eventType), LINEAR_ONLY);

  expect(mockEmitAgentActivity).toHaveBeenCalledTimes(1);
  const [, sessionId, content] = mockEmitAgentActivity.mock.calls[0];
  expect(sessionId).toBe('session-1');
  expect(content.type).toBe(expectedType);
  expect(content.body).toContain('t-sess');
  expect(updates()[0].UpdateExpression).toContain('linear_final_comment_event_id');
  expect(mockPostIssueComment).not.toHaveBeenCalled();
});

test('a final activity already emitted is not repeated', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED', linear_final_comment_event_id: 'e-old' });
  await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
});

test('a cancel that came from the session stop signal is not confirmed twice', async () => {
  mockTask({ ...SESSION_TASK, status: 'CANCELLED' });
  await routeEvent(ev('task_cancelled', { cancelled_via: SESSION_STOP_CANCELLED_VIA }), LINEAR_ONLY);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
});

test('a retryable emit failure rejects for a batch retry and persists no marker', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED' });
  mockEmitAgentActivity.mockResolvedValue({ ok: false, retryable: true });
  const outcome = await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(outcome.infraRejections).toEqual(['linear']);
  expect(updates()).toEqual([]);
});

test('a terminal emit failure is logged, not retried', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED' });
  mockEmitAgentActivity.mockResolvedValue({ ok: false, retryable: false });
  const outcome = await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(outcome.infraRejections).toEqual([]);
  expect(updates()).toEqual([]);
});

test('no token: skips without emitting', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED' });
  mockResolveToken.mockResolvedValue(null);
  await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
});

describe('keep-alive heartbeat', () => {
  test('claims the window, then emits an ephemeral thought', async () => {
    mockTask(SESSION_TASK);
    await routeEvent(ev('agent_turn', { turn: 4 }), LINEAR_ONLY);

    const [claim] = updates();
    expect(claim.UpdateExpression).toBe('SET linear_session_heartbeat_at = :now');
    expect(claim.ConditionExpression).toContain('linear_session_heartbeat_at < :cutoff');
    expect(mockEmitAgentActivity).toHaveBeenCalledWith(
      'lin_tok', 'session-1', { type: 'thought', body: 'Still working (turn 4).' }, { ephemeral: true },
    );
  });

  test('a recent heartbeat on the loaded record skips the write entirely', async () => {
    mockTask({ ...SESSION_TASK, linear_session_heartbeat_at: new Date().toISOString() });
    await routeEvent(ev('agent_turn', { turn: 5 }), LINEAR_ONLY);
    expect(updates()).toEqual([]);
    expect(mockEmitAgentActivity).not.toHaveBeenCalled();
  });

  test('a lost claim (window not elapsed) emits nothing', async () => {
    const ccf = Object.assign(new Error('cc'), { name: 'ConditionalCheckFailedException' });
    mockTask(SESSION_TASK, ccf);
    await routeEvent(ev('agent_turn', { turn: 5 }), LINEAR_ONLY);
    expect(mockEmitAgentActivity).not.toHaveBeenCalled();
  });

  test('a heartbeat failure never rejects the record', async () => {
    mockTask(SESSION_TASK, new Error('throttled'));
    const outcome = await routeEvent(ev('agent_turn', { turn: 5 }), LINEAR_ONLY);
    expect(outcome.infraRejections).toEqual([]);
    mockTask(SESSION_TASK);
    mockEmitAgentActivity.mockResolvedValue({ ok: false, retryable: true });
    expect((await routeEvent(ev('agent_turn', { turn: 6 }), LINEAR_ONLY)).infraRejections).toEqual([]);
  });

  test('no heartbeat once the task is terminal', async () => {
    mockTask({ ...SESSION_TASK, status: 'COMPLETED' });
    await routeEvent(ev('agent_turn', { turn: 9 }), LINEAR_ONLY);
    expect(updates()).toEqual([]);
    expect(mockEmitAgentActivity).not.toHaveBeenCalled();
  });

  test('non-session Linear tasks ignore per-turn events', async () => {
    mockTask({ ...SESSION_TASK, channel_metadata: { linear_issue_id: 'issue-1', linear_workspace_id: 'org-1' } });
    await routeEvent(ev('agent_turn', { turn: 1 }), LINEAR_ONLY);
    expect(updates()).toEqual([]);
    expect(mockEmitAgentActivity).not.toHaveBeenCalled();
    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });
});

test('linearSessionTerminalActivity maps a needs-input completion to an elicitation', () => {
  const content = linearSessionTerminalActivity(
    { ...SESSION_TASK, status: 'COMPLETED', code_changed: false, answer_text: 'Which DB?' } as never,
    ev('task_completed'),
  );
  expect(content.type).toBe('elicitation');
});
