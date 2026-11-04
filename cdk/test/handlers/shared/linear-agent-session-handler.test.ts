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

import * as fs from 'fs';
import * as path from 'path';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const emitAgentActivityMock = jest.fn();
const fetchAgentSessionIssueMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-agent-session', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/linear-agent-session');
  return {
    ...actual,
    emitAgentActivity: (...args: unknown[]) => emitAgentActivityMock(...args),
    fetchAgentSessionIssue: (...args: unknown[]) => fetchAgentSessionIssueMock(...args),
  };
});

const lookupTaskByLinearIssueMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-task-by-issue', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/linear-task-by-issue');
  return { ...actual, lookupTaskByLinearIssue: (...args: unknown[]) => lookupTaskByLinearIssueMock(...args) };
});

const fetchIssueParentIdMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-subissue-fetch', () => ({
  fetchIssueParentId: (...args: unknown[]) => fetchIssueParentIdMock(...args),
}));

const loadOrchestrationMock = jest.fn();
jest.mock('../../../src/handlers/shared/orchestration-store', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/orchestration-store');
  return { ...actual, loadOrchestration: (...args: unknown[]) => loadOrchestrationMock(...args) };
});

const submitNudgeMock = jest.fn();
jest.mock('../../../src/handlers/shared/nudge-core', () => ({
  submitNudge: (...args: unknown[]) => submitNudgeMock(...args),
}));

const transitionTaskToCancelledMock = jest.fn();
const writeTaskCancelledEventMock = jest.fn();
jest.mock('../../../src/handlers/shared/cancel-task-core', () => ({
  transitionTaskToCancelled: (...args: unknown[]) => transitionTaskToCancelledMock(...args),
  writeTaskCancelledEvent: (...args: unknown[]) => writeTaskCancelledEventMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.ORCHESTRATION_TABLE_NAME = 'Orchestrations';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.NUDGES_TABLE_NAME = 'Nudges';

import { SESSION_STOP_CANCELLED_VIA } from '../../../src/handlers/shared/linear-agent-session-event';
import { handleAgentSessionEvent } from '../../../src/handlers/shared/linear-agent-session-handler';

const RESOLVED = {
  accessToken: 'lin_tok',
  scope: 'read write app:assignable app:mentionable',
  workspaceSlug: 'acme',
  oauthSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:bgagent-linear-oauth-acme',
  providerName: 'linear-acme',
  vaultUserId: 'vault-user-1',
};

const ISSUE = {
  id: 'issue-1',
  identifier: 'ENG-7',
  title: 'Fix login',
  description: 'Users cannot log in.',
  projectId: 'project-1',
};

function created(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId: 'org-1',
    webhookTimestamp: 1_700_000_000_000,
    agentSession: {
      id: 'session-1',
      issueId: 'issue-1',
      creatorId: 'linear-user-1',
      comment: { id: 'c-1', body: '' },
    },
    promptContext: '<issue identifier="ENG-7"><title>Fix login</title></issue>',
    ...overrides,
  };
}

function prompted(activity: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'AgentSessionEvent',
    action: 'prompted',
    organizationId: 'org-1',
    webhookTimestamp: 1_700_000_000_500,
    agentSession: { id: 'session-1', issueId: 'issue-1' },
    agentActivity: { id: 'activity-9', userId: 'linear-user-1', ...activity },
  };
}

/** DDB Get router: user mapping (linked unless overridden) + project mapping. */
function ddbWith(opts: { linked?: boolean; mapping?: Record<string, unknown> | null } = {}): void {
  const linked = opts.linked ?? true;
  const mapping = opts.mapping === undefined
    ? { linear_project_id: 'project-1', repo: 'acme/web', status: 'active', linear_workspace_id: 'org-1' }
    : opts.mapping;
  ddbSend.mockImplementation(async (cmd: { input: { TableName: string } }) => {
    if (cmd.input.TableName === 'LinearUsers') {
      return linked ? { Item: { platform_user_id: 'platform-user-1', status: 'active' } } : {};
    }
    if (cmd.input.TableName === 'LinearProjects') return mapping ? { Item: mapping } : {};
    if (cmd.input.TableName === 'Tasks') {
      const key = (cmd.input as unknown as { Key: { task_id: string } }).Key.task_id;
      return { Item: taskRecords.get(key) };
    }
    return {};
  });
}

/** Base-table rows the handler re-reads (ConsistentRead) after a GSI hit. */
const taskRecords = new Map<string, Record<string, unknown>>();

/**
 * Script the issue's newest task: the GSI hit plus the base-table row. Fields
 * are given in GSI shape (top-level `linear_workspace_id`); `session` sets the
 * row's `channel_metadata.linear_agent_session_id`.
 */
function priorTask(task: Record<string, unknown> & { session?: string }): void {
  const { session, linear_workspace_id: ws, ...rest } = task;
  lookupTaskByLinearIssueMock.mockResolvedValue({ kind: 'found', task: { ...rest, linear_workspace_id: ws } });
  taskRecords.set(String(task.task_id), {
    ...rest,
    channel_metadata: { linear_workspace_id: ws, ...(session && { linear_agent_session_id: session }) },
  });
}

function activities(): Array<{ type: string; [k: string]: unknown }> {
  return emitAgentActivityMock.mock.calls.map((c) => c[2]);
}

beforeEach(() => {
  jest.clearAllMocks();
  taskRecords.clear();
  resolveLinearOauthTokenMock.mockResolvedValue(RESOLVED);
  emitAgentActivityMock.mockResolvedValue({ ok: true });
  fetchAgentSessionIssueMock.mockResolvedValue({ ok: true, value: ISSUE });
  lookupTaskByLinearIssueMock.mockResolvedValue({ kind: 'none' });
  fetchIssueParentIdMock.mockResolvedValue({ ok: false, absent: true });
  loadOrchestrationMock.mockResolvedValue(null);
  createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: '{}' });
  ddbWith();
});

describe('handleAgentSessionEvent — created', () => {
  test('acks with a thought first, then starts a coding task tied to the session', async () => {
    await handleAgentSessionEvent(created());

    expect(activities()[0]).toEqual(expect.objectContaining({ type: 'thought' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body).toEqual(expect.objectContaining({ repo: 'acme/web', workflow_ref: 'coding/new-task-v1' }));
    expect(body.task_description).toContain('ENG-7: Fix login');
    expect(body.task_description).toContain('## Linear session context');
    expect(ctx).toEqual(expect.objectContaining({
      userId: 'platform-user-1',
      channelSource: 'linear',
      idempotencyKey: 'linear-session-created-session-1',
    }));
    expect(ctx.channelMetadata).toEqual({
      linear_issue_id: 'issue-1',
      linear_workspace_id: 'org-1',
      linear_agent_session_id: 'session-1',
      linear_project_id: 'project-1',
      linear_issue_identifier: 'ENG-7',
      linear_oauth_secret_arn: RESOLVED.oauthSecretArn,
      linear_workspace_slug: 'acme',
      linear_provider_name: 'linear-acme',
      linear_vault_user_id: 'vault-user-1',
    });
    const last = activities().at(-1)!;
    expect(last).toEqual(expect.objectContaining({ type: 'action', action: 'Started coding task', parameter: 'acme/web' }));
  });

  test('the mention comment leads the task description', async () => {
    await handleAgentSessionEvent(created({
      agentSession: { id: 'session-1', issueId: 'issue-1', creatorId: 'linear-user-1', comment: { body: '  add a retry  ' } },
    }));
    expect(createTaskCoreMock.mock.calls[0][0].task_description.startsWith('add a retry\n')).toBe(true);
  });

  test('refuses an unlinked actor with an error activity and creates nothing', async () => {
    ddbWith({ linked: false });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'error' }));
    expect(String(activities().at(-1)!.body)).toContain('linked ABCA user');
  });

  test('a pending user link is treated as unlinked', async () => {
    ddbSend.mockImplementation(async (cmd: { input: { TableName: string } }) =>
      (cmd.input.TableName === 'LinearUsers' ? { Item: { platform_user_id: 'p', status: 'pending' } } : {}));
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an unmapped project yields an error activity', async () => {
    ddbWith({ mapping: null });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(String(activities().at(-1)!.body)).toContain('bgagent linear map');
  });

  test('a project mapping owned by another workspace is refused', async () => {
    ddbWith({ mapping: { repo: 'other/repo', status: 'active', linear_workspace_id: 'org-2' } });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'error' }));
  });

  test('an epic with its own orchestration defers to the comment path', async () => {
    loadOrchestrationMock.mockResolvedValueOnce({ meta: { parent_issue_ref: 'issue-1' }, children: [] });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'response' }));
    expect(String(activities().at(-1)!.body)).toContain('epic orchestration');
  });

  test('a started orchestration child defers to the comment path', async () => {
    fetchIssueParentIdMock.mockResolvedValue({ ok: true, value: 'epic-1' });
    loadOrchestrationMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ meta: {}, children: [{ sub_issue_id: 'issue-1', child_task_id: 't-child' }] });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a parent-lookup failure throws so the async invoke retries', async () => {
    fetchIssueParentIdMock.mockResolvedValue({ ok: false, error: new Error('linear down') });
    await expect(handleAgentSessionEvent(created())).rejects.toThrow('linear down');
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a task-lookup failure throws rather than risking a duplicate run', async () => {
    lookupTaskByLinearIssueMock.mockResolvedValue({ kind: 'error', message: 'throttled' });
    await expect(handleAgentSessionEvent(created())).rejects.toThrow('throttled');
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an issue-read failure throws; an unreadable issue errors the session', async () => {
    fetchAgentSessionIssueMock.mockResolvedValueOnce({ ok: false, error: new Error('boom') });
    await expect(handleAgentSessionEvent(created())).rejects.toThrow('boom');

    fetchAgentSessionIssueMock.mockResolvedValueOnce({ ok: false, absent: true });
    await handleAgentSessionEvent(created());
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'error' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('an idempotent replay (200) emits no second action', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 200, body: '{}' });
    await handleAgentSessionEvent(created());
    expect(activities().map((a) => a.type)).toEqual(['thought']);
  });

  test('a rejected task surfaces the API message as an error activity', async () => {
    createTaskCoreMock.mockResolvedValue({
      statusCode: 400, body: JSON.stringify({ error: { message: 'Repository not onboarded' } }),
    });
    await handleAgentSessionEvent(created());
    expect(activities().at(-1)).toEqual({ type: 'error', body: 'ABCA couldn\'t start this task: Repository not onboarded' });
  });

  test('a limit rejection is reported without echoing spend or team details', async () => {
    createTaskCoreMock.mockResolvedValue({
      statusCode: 429, body: JSON.stringify({ error: { message: 'Team team-42 spent $812.00 of $800.00' } }),
    });
    await handleAgentSessionEvent(created());
    const body = String(activities().at(-1)!.body);
    expect(body).toContain('concurrency or budget limit');
    expect(body).not.toContain('team-42');
    expect(body).not.toContain('$812');
  });

  test('an unresolvable workspace is dropped without any Linear call', async () => {
    resolveLinearOauthTokenMock.mockResolvedValue(null);
    await handleAgentSessionEvent(created());
    expect(emitAgentActivityMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a payload missing the session id is ignored', async () => {
    await handleAgentSessionEvent(created({ agentSession: { issueId: 'issue-1' } }));
    expect(resolveLinearOauthTokenMock).not.toHaveBeenCalled();
  });

  test('a prior task in another workspace is not treated as this issue\'s task', async () => {
    priorTask({ task_id: 't-x', status: 'RUNNING', linear_workspace_id: 'org-2' });
    await handleAgentSessionEvent(created());
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });
});

describe('handleAgentSessionEvent — prompted', () => {
  test('a follow-up after a finished PR task starts a PR iteration on the same repo', async () => {
    priorTask({ task_id: 't-1', status: 'COMPLETED', repo: 'acme/web', pr_number: 12, linear_workspace_id: 'org-1' });
    await handleAgentSessionEvent(prompted({ content: { type: 'prompt', body: 'rename the helper' } }));

    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body).toEqual({
      repo: 'acme/web', workflow_ref: 'coding/pr-iteration-v1', pr_number: 12, task_description: 'rename the helper',
    });
    expect(ctx.idempotencyKey).toBe('linear-session-prompted-activity-9');
    expect(ctx.channelMetadata.linear_agent_session_id).toBe('session-1');
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'action', parameter: 'acme/web#12' }));
  });

  test('a follow-up after a finished task without a PR starts new work from the issue', async () => {
    priorTask({ task_id: 't-1', status: 'FAILED', repo: 'acme/web', linear_workspace_id: 'org-1' });
    await handleAgentSessionEvent(prompted({ content: { body: 'try again with node 22' } }));
    const [body] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).toBe('coding/new-task-v1');
    expect(body.task_description.startsWith('try again with node 22')).toBe(true);
  });

  test('a follow-up while the task runs is forwarded as a nudge, not a new task', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    submitNudgeMock.mockResolvedValue({ kind: 'accepted', nudgeId: 'n-1', submittedAt: 'now' });
    await handleAgentSessionEvent(prompted({ content: { body: 'also update the README' } }));

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(submitNudgeMock).toHaveBeenCalledWith(expect.objectContaining({
      nudgesTableName: 'Nudges', taskId: 't-1', userId: 'platform-user-1', message: 'also update the README',
    }));
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'thought' }));
    expect(String(activities().at(-1)!.body)).toContain('Passed your message');
  });

  test.each([
    ['blocked', 'content policy'],
    ['rate_limited', 'Too many messages'],
    ['screening_unavailable', 'temporarily unavailable'],
  ])('a %s nudge is reported back without failing the session', async (kind, text) => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    submitNudgeMock.mockResolvedValue({ kind, reason: 'x', limitPerMinute: 10 });
    await handleAgentSessionEvent(prompted({ content: { body: 'hi' } }));
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'thought' }));
    expect(String(activities().at(-1)!.body)).toContain(text);
  });

  test('a follow-up from a non-owner is not forwarded to the running agent', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'someone-else', linear_workspace_id: 'org-1' });
    await handleAgentSessionEvent(prompted({ content: { body: 'change direction' } }));
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(String(activities().at(-1)!.body)).toContain('Only the person who started');
  });

  test('an empty follow-up while running just reassures', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ content: { body: '   ' } }));
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(String(activities().at(-1)!.body)).toContain('Already working');
  });

  test('stop cancels the running task, tags the event, and confirms with a response', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    transitionTaskToCancelledMock.mockResolvedValue('cancelled');
    await handleAgentSessionEvent(prompted({ signal: 'stop', content: { body: 'Stop' } }));

    expect(transitionTaskToCancelledMock).toHaveBeenCalledWith(expect.objectContaining({ taskTableName: 'Tasks' }), 't-1', expect.any(String));
    expect(writeTaskCancelledEventMock).toHaveBeenCalledWith(
      expect.anything(), 't-1', 'platform-user-1', expect.any(String), { cancelled_via: SESSION_STOP_CANCELLED_VIA },
    );
    // No "thought" ack before a stop: Linear requires no further actions, only the final confirmation.
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('stop with nothing running still confirms', async () => {
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(transitionTaskToCancelledMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });

  test('stop that loses the race to a terminal state writes no event', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    transitionTaskToCancelledMock.mockResolvedValue('already_terminal');
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(writeTaskCancelledEventMock).not.toHaveBeenCalled();
    expect(String(activities()[0]!.body)).toContain('already finished');
  });

  test('stop from a linked user who does not own the task cancels nothing', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'someone-else', linear_workspace_id: 'org-1' });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(transitionTaskToCancelledMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'error' })]);
    expect(String(activities()[0]!.body)).toContain('Only the person who started');
  });

  test('stop on an orchestration child is deferred to the epic', async () => {
    loadOrchestrationMock.mockResolvedValueOnce({ meta: { parent_issue_ref: 'issue-1' }, children: [] });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(transitionTaskToCancelledMock).not.toHaveBeenCalled();
    expect(lookupTaskByLinearIssueMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });

  test('stop from an unlinked user cancels nothing', async () => {
    ddbWith({ linked: false });
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(transitionTaskToCancelledMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'error' })]);
  });
});

describe('handleAgentSessionEvent — review regressions', () => {
  const RUNNING = { task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1' };

  test('the ack thought is ephemeral so a retried delivery does not stack acks', async () => {
    await handleAgentSessionEvent(created());
    expect(emitAgentActivityMock.mock.calls[0][3]).toEqual({ ephemeral: true });
  });

  test('a new session on an issue whose task runs elsewhere gets a final response, not a thought', async () => {
    priorTask({ ...RUNNING, session: 'session-OTHER' });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'response' }));
  });

  test('a mention on a label-triggered running task (no session) closes with a response', async () => {
    priorTask(RUNNING);
    submitNudgeMock.mockResolvedValue({ kind: 'accepted', nudgeId: 'n', submittedAt: 'now' });
    await handleAgentSessionEvent(created({
      agentSession: { id: 'session-1', issueId: 'issue-1', creatorId: 'linear-user-1', comment: { body: '@bgagent also fix lint' } },
    }));
    expect(submitNudgeMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'also fix lint' }));
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'response' }));
  });

  test('a bare @bgagent mention on an issue with a finished PR is not an iteration', async () => {
    priorTask({ task_id: 't-1', status: 'COMPLETED', repo: 'acme/web', pr_number: 3, linear_workspace_id: 'org-1' });
    await handleAgentSessionEvent(created({
      agentSession: { id: 'session-1', issueId: 'issue-1', creatorId: 'linear-user-1', comment: { body: '@bgagent' } },
    }));
    expect(createTaskCoreMock.mock.calls[0][0].workflow_ref).toBe('coding/new-task-v1');
    expect(createTaskCoreMock.mock.calls[0][0].task_description.startsWith('ENG-7: Fix login')).toBe(true);
  });

  test('a reply to a clarifying question resumes the original request with the answer', async () => {
    priorTask({
      task_id: 't-1',
      status: 'COMPLETED',
      repo: 'acme/web',
      linear_workspace_id: 'org-1',
      code_changed: false,
      answer_text: 'Postgres or MySQL?',
      task_description: 'Add a DB layer',
      workflow_ref: 'coding/new-task-v1',
    });
    await handleAgentSessionEvent(prompted({ content: { body: 'Postgres' } }));
    const [body] = createTaskCoreMock.mock.calls[0];
    expect(body.repo).toBe('acme/web');
    expect(body.workflow_ref).toBe('coding/new-task-v1');
    expect(body.task_description).toContain('Add a DB layer');
    expect(body.task_description).toContain('You asked: Postgres or MySQL?');
    expect(body.task_description).toContain('The reviewer answered: Postgres');
  });

  test('status is decided on the base-table row, not the lagging index', async () => {
    // Index still says RUNNING; the row already finished → a follow-up is new work, not a nudge.
    lookupTaskByLinearIssueMock.mockResolvedValue({ kind: 'found', task: { ...RUNNING } });
    taskRecords.set('t-1', { ...RUNNING, status: 'COMPLETED', repo: 'acme/web', channel_metadata: { linear_workspace_id: 'org-1' } });
    await handleAgentSessionEvent(prompted({ content: { body: 'one more thing' } }));
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const getCall = ddbSend.mock.calls.find((c) => c[0].input.TableName === 'Tasks')![0];
    expect(getCall.input.ConsistentRead).toBe(true);
  });

  test('an over-long follow-up is truncated and the user is told', async () => {
    priorTask({ ...RUNNING, session: 'session-1' });
    submitNudgeMock.mockResolvedValue({ kind: 'accepted', nudgeId: 'n', submittedAt: 'now' });
    await handleAgentSessionEvent(prompted({ content: { body: 'x'.repeat(5000) } }));
    expect(String(activities().at(-1)!.body)).toContain('Only the first');
  });
});

describe('channel_metadata builders', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/handlers/shared/linear-agent-session-handler.ts'), 'utf8');

  test('each builder that writes the workspace slug also spreads vaultMetadata (#879)', () => {
    const lines = src.split('\n');
    const offenders: number[] = [];
    lines.forEach((line, i) => {
      if (line.trim() !== 'linear_workspace_slug: resolved.workspaceSlug,') return;
      for (let j = i + 1; j < lines.length; j += 1) {
        const cur = lines[j]!.trim();
        if (cur === '...vaultMetadata(resolved),') return;
        if (cur === '};' || cur === '});') break;
      }
      offenders.push(i + 1);
    });
    expect(lines.some((l) => l.trim() === 'linear_workspace_slug: resolved.workspaceSlug,')).toBe(true);
    expect(offenders).toEqual([]);
  });
});
