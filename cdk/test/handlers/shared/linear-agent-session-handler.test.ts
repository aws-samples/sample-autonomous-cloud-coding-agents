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
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
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

const screenWithGuardrailMock = jest.fn();
jest.mock('../../../src/handlers/shared/context-hydration', () => ({
  screenWithGuardrail: (...args: unknown[]) => screenWithGuardrailMock(...args),
}));

const cancelTaskMock = jest.fn();
const stopTaskComputeMock = jest.fn();
jest.mock('../../../src/handlers/shared/cancel-task-core', () => ({
  cancelTask: (...args: unknown[]) => cancelTaskMock(...args),
  stopTaskCompute: (...args: unknown[]) => stopTaskComputeMock(...args),
}));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.ORCHESTRATION_TABLE_NAME = 'Orchestrations';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.NUDGES_TABLE_NAME = 'Nudges';
process.env.NUDGE_RATE_LIMIT_PER_MINUTE = '4';
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = 'LinearDedup';
process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';

const recordApprovalMock = jest.fn();
const recordDenialMock = jest.fn();
jest.mock('../../../src/handlers/approve-task', () => ({ recordApprovalForUser: (...a: unknown[]) => recordApprovalMock(...a) }));
jest.mock('../../../src/handlers/deny-task', () => ({ recordDenialForUser: (...a: unknown[]) => recordDenialMock(...a) }));

import { SESSION_STOP_CANCELLED_VIA } from '../../../src/handlers/shared/linear-agent-session-event';
import { handleAgentSessionEvent } from '../../../src/handlers/shared/linear-agent-session-handler';
import { resetSessionWorkspaceCacheForTests } from '../../../src/handlers/shared/linear-channel-metadata';

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
    if (cmd.input.TableName === 'Approvals') return approvalRow ? { Item: approvalRow } : {};
    if (cmd.input.TableName === 'LinearDedup' && (cmd as unknown as { _type: string })._type === 'Get') {
      return sessionPointer ? { Item: { task_id: sessionPointer, ttl: Math.floor(Date.now() / 1000) + 600 } } : {};
    }
    return {};
  });
}

/** Task id the (strongly consistent) session → task pointer names, if any. */
let sessionPointer: string | null = null;
/** The approval request row the handler reads for a whole-task approval. */
let approvalRow: Record<string, unknown> | null = null;

/** Commands sent to one table, by type. */
function sent(table: string, type: string): Array<{ input: Record<string, any> }> {
  return ddbSend.mock.calls.map((c) => c[0]).filter((c) => c.input.TableName === table && c._type === type);
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

async function screeningFailedMetricsOf(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await run();
    return stdout.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('"WebhookScreeningFailed"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map(({ WebhookScreeningFailed, source }) => ({ WebhookScreeningFailed, source }));
  } finally {
    stdout.mockRestore();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  taskRecords.clear();
  sessionPointer = null;
  approvalRow = null;
  resetSessionWorkspaceCacheForTests();
  stopTaskComputeMock.mockResolvedValue(undefined);
  screenWithGuardrailMock.mockResolvedValue({ action: 'NONE' });
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

  test('refuses an unlinked actor with a response and creates nothing', async () => {
    ddbWith({ linked: false });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'response' }));
    expect(String(activities().at(-1)!.body)).toContain('linked ABCA user');
  });

  test('refusing an unlinked teammate does not turn the owner\'s running session red', async () => {
    ddbWith({ linked: false });
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ content: { body: 'also fix the footer' } }));
    expect(submitNudgeMock).not.toHaveBeenCalled();
    // Session state follows the last activity: a thought keeps it "working".
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'thought' }));
    expect(activities().some((a) => a.type === 'error')).toBe(false);
  });

  test('records on the registry row that this workspace delivers agent sessions', async () => {
    await handleAgentSessionEvent(created());
    const [marker] = sent('LinearWorkspaceRegistry', 'Update');
    expect(marker!.input.Key).toEqual({ linear_workspace_id: 'org-1' });
    expect(marker!.input.UpdateExpression).toContain('agent_sessions_seen_at');
    expect(marker!.input.ConditionExpression).toContain('attribute_not_exists(agent_sessions_seen_at)');
  });

  test('the acknowledgement does not wait for the workspace marker', async () => {
    // The marker write hangs until released; the ack must already be out.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const route = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: { TableName: string } }) => {
      if (cmd.input.TableName === 'LinearWorkspaceRegistry' && cmd._type === 'Update') { await held; return {}; }
      return route(cmd);
    });
    const handled = handleAgentSessionEvent(created());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(activities()[0]).toEqual(expect.objectContaining({ type: 'thought' }));
    release();
    await handled;
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  describe('session context (promptContext) is screened on its own', () => {
    test('clean context joins the description and counts no screening failure', async () => {
      const metrics = await screeningFailedMetricsOf(() => handleAgentSessionEvent(created()));
      expect(screenWithGuardrailMock).toHaveBeenCalledWith(expect.stringContaining('<issue identifier="ENG-7">'), expect.any(String));
      expect(createTaskCoreMock.mock.calls[0][0].task_description).toContain('## Linear session context');
      expect(metrics).toEqual([]);
    });

    test.each([
      ['a comment in it trips the guardrail', async () => ({ action: 'GUARDRAIL_INTERVENED' }), []],
      ['screening is unavailable', async () => { throw new Error('bedrock down'); }, [{ WebhookScreeningFailed: 1, source: 'linear-session-context' }]],
      ['no guardrail is configured', async () => undefined, []],
    ])('when %s, the context is dropped, the task still starts from the issue and only a failed screening call is counted (#794)', async (_name, screen, countedFailures) => {
      screenWithGuardrailMock.mockImplementation(screen);
      const metrics = await screeningFailedMetricsOf(() => handleAgentSessionEvent(created()));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const description = createTaskCoreMock.mock.calls[0][0].task_description;
      expect(description).not.toContain('## Linear session context');
      // Falls back to the issue as fetched; createTaskCore screens that fail-closed.
      expect(description).toContain('Users cannot log in.');
      expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'action', action: 'Started coding task' }));
      expect(metrics).toEqual(countedFailures);
    });

    test('a PR iteration carries no session context and screens none', async () => {
      priorTask({ task_id: 't-1', status: 'COMPLETED', user_id: 'platform-user-1', repo: 'acme/web', pr_number: 7, linear_workspace_id: 'org-1' });
      await handleAgentSessionEvent(created({
        agentSession: { id: 'session-1', issueId: 'issue-1', creatorId: 'linear-user-1', comment: { id: 'c-1', body: '@bgagent add tests' } },
      }));
      expect(screenWithGuardrailMock).not.toHaveBeenCalled();
    });
  });

  test('a project mapping that predates the owning-workspace field is accepted, like the label path', async () => {
    ddbWith({ mapping: { linear_project_id: 'project-1', repo: 'acme/web', status: 'active' } });
    await handleAgentSessionEvent(created());
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][0].repo).toBe('acme/web');
  });

  test('points the issue at the new task only once it exists', async () => {
    const order: string[] = [];
    createTaskCoreMock.mockImplementation(async () => { order.push('create'); return { statusCode: 201, body: '{}' }; });
    const route = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: { TableName: string } }) => {
      if (cmd.input.TableName === 'LinearDedup' && cmd._type === 'Put') order.push('pointer');
      return route(cmd);
    });
    await handleAgentSessionEvent(created());
    expect(order).toEqual(['create', 'pointer']);
    const [pointer] = sent('LinearDedup', 'Put');
    expect(pointer!.input.Item).toEqual(expect.objectContaining({
      dedup_key: 'agent-session-task#issue-1',
      task_id: createTaskCoreMock.mock.calls[0][1].taskId,
    }));
  });

  test('a rejected create leaves no pointer behind', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 429, body: '{}' });
    await handleAgentSessionEvent(created());
    expect(sent('LinearDedup', 'Put')).toEqual([]);
  });

  test('a redelivered `created` points at the ORIGINAL task, not the id generated for the replay', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ data: { task_id: 't-original' } }) });
    await handleAgentSessionEvent(created());
    const puts = sent('LinearDedup', 'Put');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.input.Item.task_id).toBe('t-original');
    expect(puts[0]!.input.Item.task_id).not.toBe(createTaskCoreMock.mock.calls[0][1].taskId);
  });

  test('a replay whose body names no task writes no pointer rather than a wrong one', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 200, body: '{}' });
    await handleAgentSessionEvent(created());
    expect(sent('LinearDedup', 'Put')).toEqual([]);
  });

  test('an unlinked user\'s new session closes with a response even while another session\'s task runs', async () => {
    ddbWith({ linked: false });
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-other' });
    await handleAgentSessionEvent(created());
    // This session will never hear t-1's outcome: a thought would leave it open forever.
    expect(activities().at(-1)).toEqual(expect.objectContaining({ type: 'response' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a task with no recorded workspace (older row) is still this issue\'s task', async () => {
    priorTask({ task_id: 't-old', status: 'RUNNING', user_id: 'platform-user-1' });
    await handleAgentSessionEvent(created());
    // Treating it as "no task" would start a second run beside the live one.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
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

  test('stop cancels the running task, stops its compute, and confirms with a response', async () => {
    priorTask({
      task_id: 't-1',
      status: 'RUNNING',
      user_id: 'platform-user-1',
      linear_workspace_id: 'org-1',
      session: 'session-1',
      session_id: 'runtime-session-1',
      compute_type: 'ecs',
      compute_metadata: { taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/c/t' },
    });
    cancelTaskMock.mockResolvedValue('cancelled');
    await handleAgentSessionEvent(prompted({ signal: 'stop', content: { body: 'Stop' } }));

    // Transition and event are one call (one transaction), tagged as a session stop.
    expect(cancelTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskTableName: 'Tasks', taskEventsTableName: 'TaskEvents' }),
      't-1', 'platform-user-1', expect.any(String), { cancelled_via: SESSION_STOP_CANCELLED_VIA },
    );
    // Same compute stop as DELETE /tasks/{id}, decided on the row as it was before the cancel.
    expect(stopTaskComputeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ task_id: 't-1', status: 'RUNNING', session_id: 'runtime-session-1', compute_type: 'ecs' }),
      expect.any(String),
    );
    // No "thought" ack before a stop: Linear requires no further actions, only the final confirmation.
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('stop with nothing running still confirms', async () => {
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });

  test('stop that loses the race to a terminal state stops no compute', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    cancelTaskMock.mockResolvedValue('already_terminal');
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(stopTaskComputeMock).not.toHaveBeenCalled();
    expect(String(activities()[0]!.body)).toContain('already finished');
  });

  test('a failed cancel throws so the delivery is retried, and confirms nothing', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    cancelTaskMock.mockRejectedValue(new Error('throttled'));
    await expect(handleAgentSessionEvent(prompted({ signal: 'stop' }))).rejects.toThrow('throttled');
    expect(stopTaskComputeMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([]);
  });

  test('a non-owner\'s stop in the running task\'s own session cancels nothing and leaves that session running', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'someone-else', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'thought' })]);
    expect(String(activities()[0]!.body)).toContain('Only the person who started');
  });

  test.each([
    ['another session', 'session-other'],
    ['no session (label-triggered)', undefined],
  ])('a non-owner\'s stop when the running task reports to %s is confirmed with a response', async (_name, session) => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'someone-else', linear_workspace_id: 'org-1', ...(session && { session }) });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).not.toHaveBeenCalled();
    // A stop must end on a response; this session hears nothing more about t-1.
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });

  test('an unlinked user\'s stop from another session is confirmed with a response', async () => {
    ddbWith({ linked: false });
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-other' });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });

  test('stop on an orchestration child is deferred to the epic', async () => {
    loadOrchestrationMock.mockResolvedValueOnce({ meta: { parent_issue_ref: 'issue-1' }, children: [] });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).not.toHaveBeenCalled();
    expect(lookupTaskByLinearIssueMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });

  test('stop from an unlinked user cancels nothing and leaves the session running', async () => {
    ddbWith({ linked: false });
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).not.toHaveBeenCalled();
    expect(activities()).toEqual([expect.objectContaining({ type: 'thought' })]);
  });

  test('stop from an unlinked user with nothing running closes with a response', async () => {
    ddbWith({ linked: false });
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(activities()).toEqual([expect.objectContaining({ type: 'response' })]);
  });
});

describe('handleAgentSessionEvent — task created moments ago (issue index not caught up)', () => {
  const justCreated = { task_id: 't-new', status: 'SUBMITTED', user_id: 'platform-user-1', created_at: '2026-11-20T10:00:05Z' };

  beforeEach(() => {
    // The GSI has not seen the task yet; only the pointer names it.
    taskRecords.set('t-new', { ...justCreated, channel_metadata: { linear_workspace_id: 'org-1', linear_agent_session_id: 'session-1' } });
    sessionPointer = 't-new';
  });

  test('a prompt steers the new task instead of starting a second one', async () => {
    submitNudgeMock.mockResolvedValue({ kind: 'accepted' });
    await handleAgentSessionEvent(prompted({ content: { body: 'use the v2 API' } }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(submitNudgeMock).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't-new', rateLimitPerMinute: 4 }));
  });

  test('a stop cancels the new task rather than answering "nothing was running"', async () => {
    cancelTaskMock.mockResolvedValue('cancelled');
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).toHaveBeenCalledWith(expect.anything(), 't-new', 'platform-user-1', expect.any(String), expect.anything());
  });

  test('the newer of the index\'s task and the pointer\'s task wins', async () => {
    priorTask({ task_id: 't-older', status: 'COMPLETED', user_id: 'platform-user-1', linear_workspace_id: 'org-1', created_at: '2026-11-20T09:00:00Z' });
    cancelTaskMock.mockResolvedValue('cancelled');
    await handleAgentSessionEvent(prompted({ signal: 'stop' }));
    expect(cancelTaskMock).toHaveBeenCalledWith(expect.anything(), 't-new', expect.anything(), expect.any(String), expect.anything());
  });

  test('a pointer to a task that was never created falls back to the index', async () => {
    taskRecords.delete('t-new');
    await handleAgentSessionEvent(prompted({ content: { body: 'go' } }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
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

describe('handleAgentSessionEvent — approval requests in the session (#1066)', () => {
  const waiting = (user = 'platform-user-1') => priorTask({
    task_id: 't-1',
    status: 'AWAITING_APPROVAL',
    awaiting_approval_request_id: 'req-1',
    user_id: user,
    linear_workspace_id: 'org-1',
    session: 'session-1',
  });
  const lastEmit = () => emitAgentActivityMock.mock.calls.at(-1)!;

  beforeEach(() => {
    recordApprovalMock.mockResolvedValue({ statusCode: 202 });
    recordDenialMock.mockResolvedValue({ statusCode: 202 });
  });

  test('the owner\'s Approve decides the open request through the API path, not as a nudge', async () => {
    waiting();
    await handleAgentSessionEvent(prompted({ content: { body: 'approve' } }));
    expect(recordApprovalMock).toHaveBeenCalledWith({
      userId: 'platform-user-1',
      taskId: 't-1',
      decisionSource: JSON.stringify(['linear_session', 'org-1', 'activity-9']),
      body: JSON.stringify({ request_id: 'req-1', decision: 'approve' }),
    });
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(lastEmit()[2]).toEqual({ type: 'thought', body: 'Approved. The agent continues with this action.' });
  });

  test('a deny with a reason passes the reason on', async () => {
    waiting();
    await handleAgentSessionEvent(prompted({ content: { body: 'deny use the staging config' } }));
    expect(JSON.parse(recordDenialMock.mock.calls[0][0].body)).toEqual({ request_id: 'req-1', decision: 'deny', reason: 'use the staging config' });
    expect(String(lastEmit()[2].body)).toContain('your reason: use the staging config');
  });

  test('a request that was already answered or timed out changes nothing, and says so', async () => {
    waiting();
    recordApprovalMock.mockResolvedValue({ statusCode: 409 });
    await handleAgentSessionEvent(prompted({ content: { body: 'approve' } }));
    expect(String(lastEmit()[2].body)).toContain('already answered or timed out');
  });

  test('someone other than the owner gets the choice again, and nothing is decided', async () => {
    waiting('someone-else');
    await handleAgentSessionEvent(prompted({ content: { body: 'approve' } }));
    expect(recordApprovalMock).not.toHaveBeenCalled();
    const [, , content, options] = lastEmit();
    expect(content.type).toBe('elicitation');
    expect(String(content.body)).toMatch(/^Only the task owner can decide this request\./);
    expect(options).toEqual(expect.objectContaining({ signal: 'select' }));
  });

  test('anything else keeps the request open: the choice comes back, nothing is nudged', async () => {
    waiting();
    await handleAgentSessionEvent(prompted({ content: { body: 'what does this command do?' } }));
    expect(recordApprovalMock).not.toHaveBeenCalled();
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(lastEmit()[2].type).toBe('elicitation');
  });

  test('"Approve for this task" approves the request\'s one rule for the rest of the task', async () => {
    waiting();
    approvalRow = { task_id: 't-1', request_id: 'req-1', matching_rule_ids: ['write_env_files'] };
    await handleAgentSessionEvent(prompted({ content: { body: 'approve for this task' } }));
    expect(JSON.parse(recordApprovalMock.mock.calls[0][0].body)).toEqual({ request_id: 'req-1', decision: 'approve', scope: 'rule:write_env_files' });
    expect(String(lastEmit()[2].body)).toContain('won\'t ask again for `rule:write_env_files`');
  });

  test('a whole-task answer to a request that matched several rules approves this action only', async () => {
    waiting();
    approvalRow = { task_id: 't-1', request_id: 'req-1', matching_rule_ids: ['force_push_any', 'force_push_main'] };
    await handleAgentSessionEvent(prompted({ content: { body: 'approve for this task' } }));
    expect(JSON.parse(recordApprovalMock.mock.calls[0][0].body)).toEqual({ request_id: 'req-1', decision: 'approve' });
    expect(String(lastEmit()[2].body)).toMatch(/^Approved this action only/);
  });

  test('a late Approve after the task finished starts nothing', async () => {
    priorTask({ task_id: 't-1', status: 'COMPLETED', repo: 'acme/web', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ content: { body: 'approve' } }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(lastEmit()[2]).toEqual(expect.objectContaining({ type: 'response', body: expect.stringContaining('Nothing is waiting for your approval') }));
  });

  test('an Approve while the task runs without a request is not passed to the agent', async () => {
    priorTask({ task_id: 't-1', status: 'RUNNING', user_id: 'platform-user-1', linear_workspace_id: 'org-1', session: 'session-1' });
    await handleAgentSessionEvent(prompted({ content: { body: 'deny' } }));
    expect(submitNudgeMock).not.toHaveBeenCalled();
    expect(lastEmit()[2]).toEqual(expect.objectContaining({ type: 'thought', body: expect.stringContaining('Nothing is waiting') }));
  });
});
