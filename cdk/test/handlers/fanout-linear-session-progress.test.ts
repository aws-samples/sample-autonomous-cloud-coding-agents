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

// Session progress streamed by the fan-out Linear dispatcher (#1066). A separate file
// because the flag is read when the module builds CHANNEL_DEFAULTS, so it must be set
// before import.

import type { DynamoDBRecord } from 'aws-lambda';

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
jest.mock('../../src/handlers/shared/linear-agent-session', () => ({
  emitAgentActivity: (...args: unknown[]) => mockEmitAgentActivity(...args),
  addAgentSessionExternalUrl: jest.fn().mockResolvedValue({ ok: true }),
}));

process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

import {
  CHANNEL_DEFAULTS,
  resetLinearHeartbeatMemoForTests,
  routeEvent,
  supersededToolCallIds,
  type FanOutEvent,
  type TaskNotificationsConfig,
} from '../../src/handlers/fanout-task-events';
import { progressActivityId } from '../../src/handlers/shared/linear-session-progress';

const LINEAR_ONLY: TaskNotificationsConfig = {
  slack: { enabled: false }, github: { enabled: false }, jira: { enabled: false }, email: { enabled: false },
} as TaskNotificationsConfig;

const SESSION_TASK = {
  task_id: 't-sess',
  user_id: 'u-1',
  status: 'RUNNING',
  repo: 'acme/web',
  channel_source: 'linear',
  channel_metadata: { linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', linear_agent_session_id: 'session-1' },
};
const COMMENT_TASK = { ...SESSION_TASK, channel_metadata: { linear_issue_id: 'issue-1', linear_workspace_id: 'org-1' } };

function ev(eventType: string, metadata?: Record<string, unknown>, eventId = `e-${eventType}`): FanOutEvent {
  return { task_id: 't-sess', event_id: eventId, event_type: eventType, timestamp: '2026-11-20T00:00:00Z', metadata };
}

/** Get → the task; Update (the progress slot) → succeeds unless `updateError` is set. */
function mockTask(task: Record<string, unknown>, updateError?: Error): void {
  mockDdbSend.mockReset().mockImplementation(async (cmd: { _type: string }) => {
    if (cmd._type === 'Get') return { Item: task };
    if (cmd._type === 'Update' && updateError) throw updateError;
    return {};
  });
}
const updates = () => mockDdbSend.mock.calls.filter((c) => c[0]._type === 'Update').map((c) => c[0].input);

beforeEach(() => {
  mockPostIssueComment.mockClear();
  mockResolveToken.mockReset().mockResolvedValue('lin_tok');
  mockEmitAgentActivity.mockReset().mockResolvedValue({ ok: true });
  resetLinearHeartbeatMemoForTests();
});

test('the flag subscribes the Linear channel to the progress events', () => {
  for (const type of ['agent_turn', 'agent_tool_call', 'admission_queued', 'hydration_complete', 'repo_setup_complete', 'nudge_acknowledged', 'attachments_downloaded']) {
    expect(CHANNEL_DEFAULTS.linear.has(type)).toBe(true);
  }
});

test('a tool call is an ephemeral action with a deterministic id, and takes no persistent slot', async () => {
  mockTask(SESSION_TASK);
  const outcome = await routeEvent(ev('agent_tool_call', { tool_name: 'Read', tool_input_preview: "{'file_path': '/workspace/t-sess/src/app.ts'}" }), LINEAR_ONLY);
  expect(outcome.infraRejections).toEqual([]);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1',
    { type: 'action', action: 'Reading', parameter: '`src/app.ts`' },
    { ephemeral: true, id: progressActivityId('e-agent_tool_call') });
  expect(updates()).toEqual([]);
});

test("the agent's message is a persistent thought that claims one of the task's progress slots", async () => {
  mockTask(SESSION_TASK);
  await routeEvent(ev('agent_turn', { text_preview: 'Found it: the parser drops the last token.' }), LINEAR_ONLY);
  expect(updates()).toEqual([expect.objectContaining({ UpdateExpression: 'ADD linear_session_progress_count :one' })]);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1',
    { type: 'thought', body: 'Found it: the parser drops the last token.' }, expect.objectContaining({ ephemeral: false }));
});

test('past the cap, persistent progress is dropped; the stream never throws', async () => {
  mockTask(SESSION_TASK, Object.assign(new Error('cap'), { name: 'ConditionalCheckFailedException' }));
  const capped = await routeEvent(ev('hydration_complete'), LINEAR_ONLY);
  expect(capped.infraRejections).toEqual([]);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();

  mockTask(SESSION_TASK);
  mockEmitAgentActivity.mockResolvedValueOnce({ ok: false, retryable: true });
  const failed = await routeEvent(ev('agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'ls'}" }), LINEAR_ONLY);
  expect(failed.infraRejections).toEqual([]); // best effort: no batch retry
});

test('nothing is posted once the session has closed, so a late event cannot reopen it', async () => {
  for (const task of [{ ...SESSION_TASK, linear_final_comment_event_id: 'e-done' }, { ...SESSION_TASK, status: 'COMPLETED' }]) {
    mockTask(task);
    mockEmitAgentActivity.mockClear();
    await routeEvent(ev('agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'ls'}" }), LINEAR_ONLY);
    expect(mockEmitAgentActivity).not.toHaveBeenCalled();
  }
});

test('a comment-path Linear task ignores progress milestones (no PR-opened comment from nudge_acknowledged)', async () => {
  mockTask({ ...COMMENT_TASK, pr_url: 'https://github.com/acme/web/pull/7' });
  await routeEvent(ev('agent_milestone', { milestone: 'nudge_acknowledged' }), LINEAR_ONLY);
  expect(mockPostIssueComment).not.toHaveBeenCalled();
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
});

test('a task known not to be a session task skips the task read for later progress events', async () => {
  mockTask(COMMENT_TASK);
  await routeEvent(ev('agent_tool_call', { tool_name: 'Bash' }, 'e-1'), LINEAR_ONLY);
  const readsAfterFirst = mockDdbSend.mock.calls.filter((c) => c[0]._type === 'Get').length;
  await routeEvent(ev('agent_tool_call', { tool_name: 'Bash' }, 'e-2'), LINEAR_ONLY);
  expect(mockDdbSend.mock.calls.filter((c) => c[0]._type === 'Get').length).toBe(readsAfterFirst);
});

function toolCallRecord(taskId: string, eventId: string): DynamoDBRecord {
  return {
    eventID: eventId,
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    dynamodb: {
      SequenceNumber: `seq-${eventId}`,
      NewImage: {
        task_id: { S: taskId },
        event_id: { S: eventId },
        event_type: { S: 'agent_tool_call' },
        timestamp: { S: '2026-11-20T00:00:00Z' },
        metadata: { M: { tool_name: { S: 'Bash' } } },
      },
    },
  } as unknown as DynamoDBRecord;
}

test('only the newest tool call of each task in a batch is kept', () => {
  const records = [toolCallRecord('a', 'a1'), toolCallRecord('b', 'b1'), toolCallRecord('a', 'a2'), toolCallRecord('a', 'a3')];
  expect([...supersededToolCallIds(records)].sort()).toEqual(['a1', 'a2']);
});
