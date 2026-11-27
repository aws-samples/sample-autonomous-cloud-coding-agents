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
const mockTransitionIssueState = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  transitionIssueState: (...args: unknown[]) => mockTransitionIssueState(...args),
  postIssueComment: (...args: unknown[]) => mockPostIssueComment(...args),
  replyToComment: jest.fn(),
  upsertThreadedReply: jest.fn(),
  swapCommentReaction: jest.fn(),
  resolveToken: (...args: unknown[]) => mockResolveToken(...args),
}));

const mockEmitAgentActivity = jest.fn();
const mockSetPlan = jest.fn();
jest.mock('../../src/handlers/shared/linear-agent-session', () => ({
  setAgentSessionPlan: (...args: unknown[]) => mockSetPlan(...args),
  emitAgentActivity: (...args: unknown[]) => mockEmitAgentActivity(...args),
  addAgentSessionExternalUrl: jest.fn().mockResolvedValue({ ok: true }),
}));

process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

import {
  CHANNEL_DEFAULTS,
  handler,
  resetLinearHeartbeatMemoForTests,
  routeEvent,
  startLinearProgressBudget,
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
  mockSetPlan.mockReset().mockResolvedValue({ ok: true });
  mockTransitionIssueState.mockClear();
  resetLinearHeartbeatMemoForTests();
  startLinearProgressBudget();
});

test('the flag subscribes the Linear channel to the progress events', () => {
  for (const type of ['agent_turn', 'agent_tool_call', 'admission_queued', 'hydration_complete', 'repo_setup_complete', 'nudge_acknowledged', 'attachments_downloaded', 'agent_execution_complete']) {
    expect(CHANNEL_DEFAULTS.linear.has(type)).toBe(true);
  }
});

test('a tool call is an ephemeral action with a deterministic id, and takes no persistent slot', async () => {
  mockTask(SESSION_TASK);
  const outcome = await routeEvent(ev('agent_tool_call', { tool_name: 'Read', tool_input_preview: "{'file_path': '/workspace/t-sess/src/app.ts'}" }), LINEAR_ONLY);
  expect(outcome.infraRejections).toEqual([]);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1',
    { type: 'action', action: 'Reading', parameter: '`src/app.ts`' },
    { ephemeral: true, id: progressActivityId('e-agent_tool_call'), timeoutMs: 2000 });
  expect(updates()).toEqual([]);
});

test("the agent's message is a persistent thought that claims one of the task's progress slots", async () => {
  mockTask(SESSION_TASK);
  await routeEvent(ev('agent_turn', { text_preview: 'Found it: the parser drops the last token.' }), LINEAR_ONLY);
  expect(updates()).toEqual([expect.objectContaining({ UpdateExpression: 'ADD linear_session_progress_event_ids :id' })]);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1',
    { type: 'thought', body: 'Found it: the parser drops the last token.' }, expect.objectContaining({ ephemeral: false }));
});

test('a slot is held by the event id: a re-run claims the same slot, and a failed post gives its slot back', async () => {
  mockTask(SESSION_TASK);
  const turn = ev('agent_turn', { text_preview: 'Found it.' }, 'e-turn-1');
  await routeEvent(turn, LINEAR_ONLY);
  await routeEvent(turn, LINEAR_ONLY);
  const claim = {
    UpdateExpression: 'ADD linear_session_progress_event_ids :id',
    ConditionExpression: 'attribute_exists(task_id) AND (attribute_not_exists(linear_session_progress_event_ids)'
      + ' OR size(linear_session_progress_event_ids) < :cap OR contains(linear_session_progress_event_ids, :eid))',
    ExpressionAttributeValues: { ':id': new Set(['e-turn-1']), ':eid': 'e-turn-1', ':cap': 30 },
  };
  expect(updates()).toEqual([expect.objectContaining(claim), expect.objectContaining(claim)]);

  mockTask(SESSION_TASK);
  mockEmitAgentActivity.mockResolvedValueOnce({ ok: false, retryable: false });
  await routeEvent(ev('agent_turn', { text_preview: 'Found it.' }, 'e-turn-2'), LINEAR_ONLY);
  expect(updates().at(-1)).toEqual(expect.objectContaining({
    UpdateExpression: 'DELETE linear_session_progress_event_ids :id',
    ExpressionAttributeValues: { ':id': new Set(['e-turn-2']) },
  }));
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

test('nothing is streamed while the task waits for approval, so no activity lands after the request', async () => {
  mockTask({ ...SESSION_TASK, status: 'AWAITING_APPROVAL' });
  await routeEvent(ev('agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'git push --force'}" }), LINEAR_ONLY);
  await routeEvent(ev('agent_turn', { text_preview: 'Waiting for the push to be approved.' }), LINEAR_ONLY);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
  expect(updates()).toEqual([]);
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

// --- The session checklist, the closing line and In Review ---

const planStatuses = () => (mockSetPlan.mock.calls.at(-1)?.[2] as Array<{ status: string }>).map((s) => s.status);
const stageWrites = () => updates().filter((u) => String(u.UpdateExpression).includes('linear_checklist_stage'));

test('a step that moves the checklist forward records the stage, then replaces the session plan', async () => {
  mockTask(SESSION_TASK);
  await routeEvent(ev('agent_milestone', { milestone: 'repo_setup_complete' }), LINEAR_ONLY);
  expect(stageWrites()).toEqual([expect.objectContaining({ ExpressionAttributeValues: { ':s': 2 } })]);
  expect(mockSetPlan).toHaveBeenCalledWith('lin_tok', 'session-1', expect.any(Array), { timeoutMs: 2000 });
  expect(planStatuses()).toEqual(['completed', 'completed', 'inProgress', 'pending', 'pending']);
});

test('the checklist never moves back: a stale step loses the conditional write and is not shown', async () => {
  mockTask({ ...SESSION_TASK, linear_checklist_stage: 3 }, Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' }));
  await routeEvent(ev('hydration_complete'), LINEAR_ONLY);
  expect(mockSetPlan).not.toHaveBeenCalled();
});

test('the agent finishing moves the checklist to the pull request step, with no activity of its own', async () => {
  mockTask(SESSION_TASK);
  await routeEvent(ev('agent_milestone', { milestone: 'agent_execution_complete' }), LINEAR_ONLY);
  expect(planStatuses()).toEqual(['completed', 'completed', 'completed', 'inProgress', 'pending']);
  expect(mockEmitAgentActivity).not.toHaveBeenCalled();
});

test('a workflow without coding stages gets no checklist', async () => {
  mockTask({ ...SESSION_TASK, resolved_workflow: { id: 'review/pr-review-v1', version: '1' } });
  await routeEvent(ev('hydration_complete'), LINEAR_ONLY);
  expect(mockSetPlan).not.toHaveBeenCalled();
});

const PR_URL = 'https://github.com/acme/web/pull/7';

test('a task that ends with a pull request completes the checklist, says what is next, and moves the issue to In Review', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED', pr_url: PR_URL, linear_checklist_stage: 4 });
  await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(planStatuses()).toEqual(Array(5).fill('completed'));
  const final = mockEmitAgentActivity.mock.calls.at(-1)?.[2] as { type: string; body: string };
  expect(final.type).toBe('response');
  expect(final.body).toMatch(/_Your turn: review the pull request\. Reply here if it needs changes\._$/);
  expect(mockTransitionIssueState).toHaveBeenCalledWith(expect.anything(), 'issue-1', 'started', ['In Review'], false, true);
});

test('a failed task cancels what was left, offers a retry, and leaves the issue where it is', async () => {
  mockTask({ ...SESSION_TASK, status: 'FAILED', linear_checklist_stage: 2, error_message: 'boom' });
  await routeEvent(ev('task_failed'), LINEAR_ONLY);
  expect(planStatuses()).toEqual(['completed', 'completed', 'canceled', 'canceled', 'canceled']);
  expect((mockEmitAgentActivity.mock.calls.at(-1)?.[2] as { body: string }).body).toMatch(/_Reply here to try again\._$/);
  expect(mockTransitionIssueState).not.toHaveBeenCalled();
});

test('a run that stopped to ask a question waits on the reader, and the checklist says so', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED', code_changed: false, answer_text: 'Which page?', linear_checklist_stage: 2 });
  await routeEvent(ev('task_completed'), LINEAR_ONLY);
  const final = mockEmitAgentActivity.mock.calls.at(-1)?.[2] as { type: string; body: string };
  expect(final.type).toBe('elicitation');
  expect(final.body).toMatch(/\*\*Waiting on you\.\*\* Nothing continues until you reply here\.$/);
  const plan = mockSetPlan.mock.calls.at(-1)?.[2] as Array<{ content: string; status: string }>;
  expect(plan[2]).toEqual({ content: 'Write the code — waiting on your answer', status: 'inProgress' });
  expect(mockTransitionIssueState).not.toHaveBeenCalled();
});

test('a failed checklist write never blocks the final response', async () => {
  mockTask({ ...SESSION_TASK, status: 'COMPLETED', pr_url: PR_URL });
  mockSetPlan.mockRejectedValueOnce(new Error('linear down'));
  const outcome = await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(outcome.infraRejections).toEqual([]);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1', expect.objectContaining({ type: 'response' }));
});

test('a follow-up on a pull request that pushed nothing reads as no change: no review ask, no finished checklist, no move', async () => {
  mockTask({
    ...SESSION_TASK,
    status: 'COMPLETED',
    pr_url: PR_URL,
    code_changed: false,
    resolved_workflow: { id: 'coding/pr-iteration-v1', version: '1' },
    linear_checklist_stage: 3,
  });
  await routeEvent(ev('task_completed'), LINEAR_ONLY);
  const final = mockEmitAgentActivity.mock.calls.at(-1)?.[2] as { type: string; body: string };
  expect(final.type).toBe('response');
  expect(final.body).not.toMatch(/review the pull request/);
  expect(final.body).toMatch(/_Nothing needed from you\. Reply here if you want a change after all\._$/);
  expect(planStatuses()).toEqual(['completed', 'completed', 'completed', 'canceled', 'canceled']);
  expect(mockTransitionIssueState).not.toHaveBeenCalled();
});

test('a failed task that left a pull request stays where it is: only a completed task moves the issue to In Review', async () => {
  mockTask({ ...SESSION_TASK, status: 'FAILED', pr_url: PR_URL, linear_checklist_stage: 4, error_message: 'build failed' });
  await routeEvent(ev('task_failed'), LINEAR_ONLY);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1', expect.objectContaining({ type: 'error' }));
  expect(mockTransitionIssueState).not.toHaveBeenCalled();
});

// --- The progress budget: progress never puts the batch's lifecycle events at risk ---

function streamRecord(taskId: string, eventId: string, eventType: string, metadata: Record<string, string> = {}): DynamoDBRecord {
  return {
    eventID: eventId,
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    dynamodb: {
      SequenceNumber: `seq-${eventId}`,
      NewImage: {
        task_id: { S: taskId },
        event_id: { S: eventId },
        event_type: { S: eventType },
        timestamp: { S: '2026-11-20T00:00:00Z' },
        metadata: { M: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, { S: v }])) },
      },
    },
  } as unknown as DynamoDBRecord;
}

/** Get → the task of that id: `done` has finished with a pull request, any other is running. */
function mockTasks(): void {
  mockDdbSend.mockReset().mockImplementation(async (cmd: { _type: string; input: { Key?: { task_id: string } } }) => {
    if (cmd._type !== 'Get') return {};
    const taskId = cmd.input.Key!.task_id;
    return {
      Item: taskId === 'done'
        ? { ...SESSION_TASK, task_id: 'done', status: 'COMPLETED', pr_url: PR_URL }
        : { ...SESSION_TASK, task_id: taskId },
    };
  });
}
const progressEmits = () => mockEmitAgentActivity.mock.calls.filter((c) => (c[2] as { type: string }).type === 'thought');

test('progress and checklist writes use the short timeout; lifecycle posts keep the default', async () => {
  mockTask(SESSION_TASK);
  await routeEvent(ev('agent_turn', { text_preview: 'Found it.' }), LINEAR_ONLY);
  await routeEvent(ev('hydration_complete'), LINEAR_ONLY);
  expect(mockEmitAgentActivity.mock.calls[0][3]).toEqual(expect.objectContaining({ timeoutMs: 2000 }));
  expect(mockSetPlan.mock.calls[0][3]).toEqual({ timeoutMs: 2000 });

  mockTask({ ...SESSION_TASK, status: 'COMPLETED', pr_url: PR_URL });
  await routeEvent(ev('task_completed'), LINEAR_ONLY);
  expect(mockEmitAgentActivity.mock.calls.at(-1)).toHaveLength(3);
});

test('after the first progress timeout the batch skips the rest of its progress, and its lifecycle events still go out', async () => {
  mockTasks();
  mockEmitAgentActivity.mockImplementation(async (_t: string, _s: string, content: { type: string }) =>
    (content.type === 'thought' ? { ok: false, retryable: true } : { ok: true }));
  const records = [
    streamRecord('a', 'a1', 'agent_turn', { text_preview: 'one' }),
    streamRecord('b', 'b1', 'agent_turn', { text_preview: 'two' }),
    streamRecord('done', 'd1', 'task_completed'),
    streamRecord('c', 'c1', 'agent_turn', { text_preview: 'three' }),
  ];
  const result = await handler({ Records: records });
  expect(result.batchItemFailures).toEqual([]);
  expect(progressEmits()).toHaveLength(1);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1', expect.objectContaining({ type: 'response' }));

  // The next invocation starts with a fresh budget.
  mockEmitAgentActivity.mockClear();
  await handler({ Records: [streamRecord('e', 'e1', 'agent_turn', { text_preview: 'four' })] });
  expect(progressEmits()).toHaveLength(1);
});

test('progress stops once it has spent its share of the invocation', async () => {
  mockTasks();
  let now = 1_000_000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockEmitAgentActivity.mockImplementation(async () => {
    now += 6_000;
    return { ok: true };
  });
  try {
    const records = ['a', 'b', 'c', 'd', 'e'].map((t) => streamRecord(t, `${t}1`, 'agent_turn', { text_preview: t }));
    await handler({ Records: [...records, streamRecord('done', 'd1', 'task_completed')] });
  } finally {
    clock.mockRestore();
  }
  expect(progressEmits()).toHaveLength(3);
  expect(mockEmitAgentActivity).toHaveBeenCalledWith('lin_tok', 'session-1', expect.objectContaining({ type: 'response' }));
});
