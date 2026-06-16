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

import type { DynamoDBRecord } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  BatchGetCommand: jest.fn((input: unknown) => ({ _type: 'BatchGet', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const postIssueCommentMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
const swapIssueReactionMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const replyToCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';
// A6 surfacing (#34/#35): the cascade posts Linear comments only when the
// workspace registry is configured. Set it so the surfacing path is exercised.
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'WorkspaceRegistry';

import { handler, parseTerminalTaskRecord } from '../../src/handlers/orchestration-reconciler';

/** Build a TaskTable stream MODIFY record. */
function taskRecord(fields: {
  task_id?: string;
  status?: string;
  build_passed?: boolean;
  orchestration_id?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  // A6 cascade markers (channel_metadata fields on an iteration/restack task).
  orchestration_sub_issue_id?: string;
  restack_predecessor_sub_issue_id?: string;
  orchestration_iteration?: boolean;
  // #247 UX.3: the human comment that triggered an iteration.
  trigger_comment_id?: string;
}): DynamoDBRecord {
  const img: Record<string, unknown> = {};
  if (fields.task_id) img.task_id = { S: fields.task_id };
  if (fields.status) img.status = { S: fields.status };
  if (fields.build_passed !== undefined) img.build_passed = { BOOL: fields.build_passed };
  // PRODUCTION SHAPE: createTaskCore persists orchestration_id INSIDE the
  // nested channel_metadata MAP, not as a top-level attribute. The stream
  // image must mirror that or the reconciler skips every orchestration
  // child. (Regression: the first dev smoke had orchestration_id only in
  // channel_metadata and the reconciler — reading it top-level — ignored
  // all completions, so dependents never released.)
  const cm: Record<string, unknown> = {};
  if (fields.orchestration_id) cm.orchestration_id = { S: fields.orchestration_id };
  if (fields.orchestration_sub_issue_id) cm.orchestration_sub_issue_id = { S: fields.orchestration_sub_issue_id };
  if (fields.restack_predecessor_sub_issue_id) {
    cm.restack_predecessor_sub_issue_id = { S: fields.restack_predecessor_sub_issue_id };
  }
  if (fields.orchestration_iteration) cm.orchestration_iteration = { S: 'true' };
  if (fields.trigger_comment_id) cm.trigger_comment_id = { S: fields.trigger_comment_id };
  if (Object.keys(cm).length > 0) img.channel_metadata = { M: cm };
  return {
    eventName: fields.eventName ?? 'MODIFY',
    dynamodb: { NewImage: img as never },
  } as DynamoDBRecord;
}

describe('parseTerminalTaskRecord', () => {
  test('extracts a terminal orchestration child event', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', build_passed: true, orchestration_id: 'orch_1',
    }));
    expect(evt).toEqual({ taskId: 'T1', status: 'COMPLETED', buildPassed: true, orchestrationId: 'orch_1' });
  });

  test('skips non-terminal status', () => {
    expect(parseTerminalTaskRecord(taskRecord({ task_id: 'T1', status: 'RUNNING', orchestration_id: 'orch_1' }))).toBeNull();
  });

  test('skips tasks with no orchestration_id (non-orchestration tasks)', () => {
    expect(parseTerminalTaskRecord(taskRecord({ task_id: 'T1', status: 'COMPLETED' }))).toBeNull();
  });

  test('skips REMOVE events', () => {
    expect(parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', orchestration_id: 'orch_1', eventName: 'REMOVE',
    }))).toBeNull();
  });

  test('skips records with no NewImage', () => {
    expect(parseTerminalTaskRecord({ eventName: 'MODIFY', dynamodb: {} } as DynamoDBRecord)).toBeNull();
  });
});

/** Mock the GSI lookup + loadOrchestration Query for a child set. */
function mockOrchestration(opts: {
  subIssueId: string;
  children: Array<{ sub_issue_id: string; depends_on?: string[]; child_status: string }>;
}): void {
  // Stateful, query-type-aware mock (robust to the reconciler's read
  // pattern: GSI lookup + possibly-repeated loadOrchestration + status
  // Updates). Status Updates mutate the in-memory rows so a subsequent
  // fresh loadOrchestration reflects them — which is exactly what the
  // concurrency-safe re-read relies on.
  const meta = {
    sub_issue_id: '#meta', orchestration_id: 'orch_1', parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS', repo: 'o/r', child_count: opts.children.length, platform_user_id: 'user-1',
  };
  const rows: Record<string, Record<string, unknown>> = {};
  for (const c of opts.children) {
    rows[c.sub_issue_id] = {
      orchestration_id: 'orch_1', sub_issue_id: c.sub_issue_id, depends_on: c.depends_on ?? [],
      child_status: c.child_status, repo: 'o/r', parent_linear_issue_id: 'PARENT', linear_workspace_id: 'WS',
    };
  }
  ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
    const { _type, input } = cmd;
    if (_type === 'Query' && input.IndexName === 'ChildTaskIndex') {
      return { Items: [{ ...rows[opts.subIssueId], sub_issue_id: opts.subIssueId }] };
    }
    if (_type === 'Query') { // loadOrchestration
      return { Items: [meta, ...Object.values(rows)] };
    }
    if (_type === 'Update') {
      const sk = (input.Key as { sub_issue_id: string }).sub_issue_id;
      const vals = input.ExpressionAttributeValues as Record<string, unknown>;
      const row = rows[sk];
      if (row) {
        if (vals[':s'] !== undefined) row.child_status = vals[':s'];
        if (vals[':released'] !== undefined) { row.child_status = 'released'; row.child_task_id = vals[':tid']; }
      }
      return {};
    }
    return {};
  });
}

describe('orchestration-reconciler handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child-task' } }) });
  });

  test('A succeeds → releases blocked dependent B', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);

    // B released via createTaskCore.
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const ctx = createTaskCoreMock.mock.calls[0][1];
    expect(ctx.idempotencyKey).toBe('orch_1_B');
  });

  test('A fails → no release, B skipped (createTaskCore not called)', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });

    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })] } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('COMPLETED with build_passed=false → treated as failure, B not released', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });

    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', build_passed: false, orchestration_id: 'orch_1' })],
    } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('non-orchestration / non-terminal records are skipped entirely', async () => {
    await handler({
      Records: [
        taskRecord({ task_id: 'T1', status: 'RUNNING', orchestration_id: 'orch_1' }),
        taskRecord({ task_id: 'T2', status: 'COMPLETED' }), // no orchestration_id
      ],
    } as never);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('unresolvable sub_issue_id (GSI miss) → skip, no throw', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] }); // GSI miss
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });
});

/** Detect a cascade marker in parseTerminalTaskRecord. */
describe('parseTerminalTaskRecord — A6 cascade marker', () => {
  test('a restack task (carries restack_predecessor) → cascadeSubIssueId set', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'TR', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'B', restack_predecessor_sub_issue_id: 'A',
    }));
    expect(evt?.cascadeSubIssueId).toBe('B');
  });

  test('an iteration task (orchestration_iteration=true) → cascadeSubIssueId set', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'TI', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', orchestration_iteration: true,
    }));
    expect(evt?.cascadeSubIssueId).toBe('A');
  });

  test('a normal child task (no markers) → cascadeSubIssueId undefined', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', orchestration_id: 'orch_1',
    }));
    expect(evt?.cascadeSubIssueId).toBeUndefined();
  });
});

/** Mock for the cascade path: loadOrchestration + per-dependent GetCommand pr_url. */
function mockCascade(children: Array<{
  sub_issue_id: string; depends_on?: string[]; child_status: string;
  child_task_id?: string; child_branch_name?: string; linear_identifier?: string;
}>): void {
  const meta = {
    sub_issue_id: '#meta', orchestration_id: 'orch_1', parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS', repo: 'o/r', child_count: children.length, platform_user_id: 'user-1',
    // A panel comment exists → the cascade EDITS it (UX.2), rather than posting fresh.
    status_comment_id: 'panel-cmt-1',
  };
  const rows = children.map((c) => ({
    orchestration_id: 'orch_1', sub_issue_id: c.sub_issue_id, depends_on: c.depends_on ?? [],
    child_status: c.child_status, repo: 'o/r', parent_linear_issue_id: 'PARENT', linear_workspace_id: 'WS',
    ...(c.child_task_id && { child_task_id: c.child_task_id }),
    ...(c.child_branch_name && { child_branch_name: c.child_branch_name }),
    ...(c.linear_identifier && { linear_identifier: c.linear_identifier }),
  }));
  ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Query') return { Items: [meta, ...rows] }; // loadOrchestration
    if (cmd._type === 'Get') { // resolvePrNumber for a dependent task
      const tid = (cmd.input.Key as { task_id: string }).task_id;
      return { Item: { task_id: tid, pr_url: `https://github.com/o/r/pull/${tid.length}` } };
    }
    if (cmd._type === 'BatchGet') { // resolveChildPrUrls for the panel
      const keys = (cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>);
      const tbl = Object.keys(keys)[0];
      return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
    }
    return {};
  });
}

describe('orchestration-reconciler handler — A6 cascade', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
  });

  test('restack on B completes → re-stacks B\'s direct dependent C (one hop)', async () => {
    // chain A→B→C, all started; the just-completed task re-stacked B.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
      { sub_issue_id: 'C', depends_on: ['B'], child_status: 'succeeded', child_task_id: 'task-C', child_branch_name: 'branch-C' },
    ]);
    await handler({ Records: [taskRecord({
      task_id: 'restack-task-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'B', restack_predecessor_sub_issue_id: 'A',
    })] } as never);

    // Exactly one restack spawned — for C (B's direct dependent), NOT A.
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).toBe('coding/restack-v1');
    expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('C');
    expect(ctx.channelMetadata.restack_predecessor_sub_issue_id).toBe('B');
    expect(ctx.channelMetadata.orchestration_merge_branches).toBe(JSON.stringify(['branch-B']));
    // Idempotency keyed on the SOURCE task id (converges, no loop).
    expect(ctx.idempotencyKey).toContain('restack-task-1');
  });

  test('iteration on A completes → re-stacks A\'s direct dependent B', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({ Records: [taskRecord({
      task_id: 'iter-task-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', orchestration_iteration: true,
    })] } as never);
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][1].channelMetadata.orchestration_sub_issue_id).toBe('B');
  });

  test('FAILED iteration → no cascade', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({ Records: [taskRecord({
      task_id: 'iter-fail', status: 'FAILED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', orchestration_iteration: true,
    })] } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('cascade source with no started dependents → no restack', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' }, // not started
    ]);
    await handler({ Records: [taskRecord({
      task_id: 'iter-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', orchestration_iteration: true,
    })] } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a cascade source does NOT run normal child gating (no GSI sub-issue lookup)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({ Records: [taskRecord({
      task_id: 'iter-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', orchestration_iteration: true,
    })] } as never);
    // Never queried ChildTaskIndex (that's the normal-gating path).
    const gsiCalls = ddbSend.mock.calls.filter(
      (c) => c[0]?._type === 'Query' && c[0]?.input?.IndexName === 'ChildTaskIndex');
    expect(gsiCalls).toHaveLength(0);
  });
});

describe('orchestration-reconciler handler — A6 cascade surfacing via the panel (#247 UX.2)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
  });

  const iterEvent = (sub: string) => ({
    Records: [taskRecord({
      task_id: 'iter-task-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: sub, orchestration_iteration: true,
    })],
  }) as never;

  test('refreshes the panel with the impacted row as "updating per comment" — NO standalone parent/sub-issue comments', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler(iterEvent('A'));
    // The panel is edited (upsertStatusComment), NOT a stream of new comments.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    // Impacted dependent B shows '🔄 … updating per ENG-1's comment'.
    expect(body).toMatch(/ENG-2.*updating per ENG-1's comment/);
    // The retired standalone '🔄 Re-stacked' / 'revised' parent comments are GONE.
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('idempotent replay (200, NOT 201) does NOT re-mark the panel as updating', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 200, body: '{}' });
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler(iterEvent('A'));
    // No NEW restack task created → no panel "updating" refresh from the cascade.
    expect(upsertStatusCommentMock).not.toHaveBeenCalled();
  });

  test('integration-node dependent renders friendly in the panel (never raw id)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'orch_1__integration', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-int', child_branch_name: 'branch-int' },
    ]);
    await handler(iterEvent('A'));
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('Integration — combined result');
    expect(body).not.toContain('orch_1__integration');
  });

  test('a restack from a PREDECESSOR change (not a comment) says "updating to include … change"', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    // restack source (carries restack_predecessor, NOT orchestration_iteration).
    await handler({ Records: [taskRecord({
      task_id: 'restack-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', restack_predecessor_sub_issue_id: 'Z',
    })] } as never);
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/ENG-2.*updating to include ENG-1's change/);
  });
});

describe('orchestration-reconciler handler — A6 iteration ack reply (#247 UX.3)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    replyToCommentMock.mockReset().mockResolvedValue('reply-1');
  });

  /** An iteration event carrying the human comment id that triggered it. */
  const iterEventWithComment = (status: string, commentId = 'human-cmt-1', buildPassed?: boolean) => ({
    Records: [taskRecord({
      task_id: 'iter-task-1', status, orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', orchestration_iteration: true,
      trigger_comment_id: commentId,
      ...(buildPassed !== undefined && { build_passed: buildPassed }),
    })],
  }) as never;

  test('successful iteration → ✅ threaded reply to the triggering comment, linking the PR', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED'));

    expect(replyToCommentMock).toHaveBeenCalledTimes(1);
    const [, parentCommentId, body] = replyToCommentMock.mock.calls[0];
    expect(parentCommentId).toBe('human-cmt-1');
    expect(body).toMatch(/^✅ Updated — PR #\d+\./);
  });

  test('FAILED iteration → ❌ threaded reply inviting a retry (still replies)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('FAILED'));

    expect(replyToCommentMock).toHaveBeenCalledTimes(1);
    const [, , body] = replyToCommentMock.mock.calls[0];
    expect(body).toMatch(/^❌/);
    expect(body).toMatch(/reply with guidance/i);
    // A failed iteration still does not cascade onto dependents.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('build_passed=false → ❌ reply (treated as not-successful)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED', 'human-cmt-1', false));
    const [, , body] = replyToCommentMock.mock.calls[0];
    expect(body).toMatch(/^❌/);
  });

  test('idempotent: redelivery loses the claim → no duplicate reply', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    // First Update (the ack claim) wins; a second Update with the same key is
    // rejected by the conditional → simulate the redelivery losing the claim.
    let ackClaims = 0;
    const base = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Update' && (cmd.input.UpdateExpression as string)?.includes('ack_replied_at')) {
        ackClaims += 1;
        if (ackClaims > 1) {
          const err = new Error('conditional');
          (err as { name?: string }).name = 'ConditionalCheckFailedException';
          throw err;
        }
        return {};
      }
      return base(cmd);
    });

    await handler(iterEventWithComment('COMPLETED'));
    await handler(iterEventWithComment('COMPLETED')); // redelivery

    // Replied exactly once across both deliveries.
    expect(replyToCommentMock).toHaveBeenCalledTimes(1);
  });

  test('a restack (no trigger_comment_id) → no ack reply', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler({ Records: [taskRecord({
      task_id: 'restack-1', status: 'COMPLETED', orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A', restack_predecessor_sub_issue_id: 'Z',
    })] } as never);
    expect(replyToCommentMock).not.toHaveBeenCalled();
  });
});
