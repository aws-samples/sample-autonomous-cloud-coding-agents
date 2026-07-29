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
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

const s3SendMock = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: s3SendMock })),
  GetObjectCommand: jest.fn((input: unknown) => ({ _type: 'S3Get', input })),
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const postIssueCommentMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
const swapIssueReactionMock = jest.fn();
const swapCommentReactionMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const revertIssueToNotStartedMock = jest.fn();
const replyToCommentMock = jest.fn();
const upsertThreadedReplyMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  swapCommentReaction: (...args: unknown[]) => swapCommentReactionMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  revertIssueToNotStarted: (...args: unknown[]) => revertIssueToNotStartedMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  upsertThreadedReply: (...args: unknown[]) => upsertThreadedReplyMock(...args),
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';
// Cascade surfacing: the cascade posts Linear comments only when the
// workspace registry is configured. Set it so the surfacing path is exercised.
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'WorkspaceRegistry';
process.env.ARTIFACTS_BUCKET_NAME = 'ArtifactsBucket';

import { handler, parseTerminalTaskRecord } from '../../src/handlers/orchestration-reconciler';

/** Build a TaskTable stream MODIFY record. */
function taskRecord(fields: {
  task_id?: string;
  status?: string;
  build_passed?: boolean;
  orchestration_id?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  // Cascade markers (channel_metadata fields on an iteration/restack task).
  orchestration_sub_issue_id?: string;
  restack_predecessor_sub_issue_id?: string;
  orchestration_iteration?: boolean;
  // The human comment that triggered an iteration.
  trigger_comment_id?: string;
  // The issue that trigger comment lives on (the parent epic when routed).
  trigger_comment_issue_id?: string;
  // Raw agent error_message (drives the failure-reply detail).
  error_message?: string;
  // Whether the agent actually edited code; false marks a question/answer run.
  code_changed?: boolean;
  // Stream sequence number (itemIdentifier for partial-batch reporting).
  sequenceNumber?: string;
}): DynamoDBRecord {
  const img: Record<string, unknown> = {};
  if (fields.task_id) img.task_id = { S: fields.task_id };
  if (fields.status) img.status = { S: fields.status };
  if (fields.build_passed !== undefined) img.build_passed = { BOOL: fields.build_passed };
  if (fields.code_changed !== undefined) img.code_changed = { BOOL: fields.code_changed };
  if (fields.error_message) img.error_message = { S: fields.error_message };
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
  if (fields.trigger_comment_issue_id) cm.trigger_comment_issue_id = { S: fields.trigger_comment_issue_id };
  if (Object.keys(cm).length > 0) img.channel_metadata = { M: cm };
  return {
    eventName: fields.eventName ?? 'MODIFY',
    dynamodb: {
      NewImage: img as never,
      ...(fields.sequenceNumber !== undefined && { SequenceNumber: fields.sequenceNumber }),
    },
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

  test('skips a terminal task carrying no orchestration_id (not an orchestration child)', () => {
    // The gate is the presence of orchestration_id, not the workflow: a task that
    // is not part of a graph must fall through rather than be mis-gated as a child
    // and released against a graph it has nothing to do with.
    expect(parseTerminalTaskRecord(plainTerminalRecord({ task_id: 'P1', status: 'COMPLETED' }))).toBeNull();
  });
});

/** Build a terminal task stream record that carries NO orchestration_id. */
function plainTerminalRecord(fields: { task_id?: string; status?: string }): DynamoDBRecord {
  return {
    eventName: 'MODIFY',
    dynamodb: {
      NewImage: {
        task_id: { S: fields.task_id ?? 'T1' },
        status: { S: fields.status ?? 'COMPLETED' },
        resolved_workflow: { M: { id: { S: 'coding/new-task-v1' }, version: { S: '1.0.0' } } },
        user_id: { S: 'user-1' },
        repo: { S: 'o/r' },
      } as never,
    },
  } as DynamoDBRecord;
}

/** Mock the GSI lookup + loadOrchestration Query for a child set. */
function mockOrchestration(opts: {
  subIssueId: string;
  children: Array<{ sub_issue_id: string; depends_on?: string[]; child_status: string }>;
  /** Extra meta-row attributes, e.g. the recorded ``channel_source``. */
  meta?: Record<string, unknown>;
}): void {
  // Stateful, query-type-aware mock (robust to the reconciler's read
  // pattern: GSI lookup + possibly-repeated loadOrchestration + status
  // Updates). Status Updates mutate the in-memory rows so a subsequent
  // fresh loadOrchestration reflects them — which is exactly what the
  // concurrency-safe re-read relies on.
  const meta = {
    sub_issue_id: '#meta',
    orchestration_id: 'orch_1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: opts.children.length,
    platform_user_id: 'user-1',
    ...opts.meta,
  };
  const rows: Record<string, Record<string, unknown>> = {};
  for (const c of opts.children) {
    rows[c.sub_issue_id] = {
      orchestration_id: 'orch_1',
      sub_issue_id: c.sub_issue_id,
      depends_on: c.depends_on ?? [],
      child_status: c.child_status,
      repo: 'o/r',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
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

  // A child that fails DETERMINISTICALLY at release (guardrail 400) must not
  // only terminally-fail itself but ALSO transitively skip its dependents —
  // else a mid-graph guardrail failure hangs the epic at the blocked dependent
  // instead of looping. Failing only the leaf is not enough; the transitive
  // skip has to run too.
  test('A succeeds → B released but its create is guardrail-blocked (400) → B failed + dependent C skipped', async () => {
    // Graph: A (done) → B (about to release, will be guardrail-blocked) → C.
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'succeeded' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
        { sub_issue_id: 'C', depends_on: ['B'], child_status: 'blocked' },
      ],
    });
    // B's task creation is deterministically blocked (guardrail); every other
    // create (there is none here) would 201. releaseReadyChildren releases B →
    // createTaskCore(B) → 400 → create_failed_terminal.
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 400,
      body: '{"error":{"message":"Task description was blocked by content policy."}}',
    });

    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);

    // The reconciler tried to release B (one createTaskCore for the ready node).
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    // B was written terminally 'failed' (failClaimTerminal) AND C was written
    // 'skipped' (transitive skip) — both via conditional Updates on the store.
    const updates = ddbSend.mock.calls
      .map((c) => c[0] as { _type: string; input: Record<string, unknown> })
      .filter((c) => c._type === 'Update');
    const wrote = (sk: string, status: string) => updates.some((u) =>
      (u.input.Key as { sub_issue_id?: string }).sub_issue_id === sk
      && (u.input.ExpressionAttributeValues as Record<string, unknown>)[':s'] === status
      || (sk === 'B' && (u.input.Key as { sub_issue_id?: string }).sub_issue_id === 'B'
        && (u.input.ExpressionAttributeValues as Record<string, unknown>)[':failed'] === 'failed'));
    // B → failed (failClaimTerminal uses :failed), C → skipped (:s).
    expect(updates.some((u) =>
      (u.input.Key as { sub_issue_id?: string }).sub_issue_id === 'B'
      && (u.input.ExpressionAttributeValues as Record<string, unknown>)[':failed'] === 'failed')).toBe(true);
    expect(wrote('C', 'skipped')).toBe(true);
    // The epic settled (panel posted) — not left hanging on a blocked C.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
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

  test('a build-gate-failed child (COMPLETED, build_passed=false) reverts state AND swaps its ✅ reaction to ❌', async () => {
    // The agent moves a writeable child to "In Review" + reacts ✅ on agent-success
    // (regression-only build gate), but the platform gate independently marks it
    // failed. Left alone, the graph says failed while Linear reads "In Review" with
    // a ✅ reaction + PR link (the user's inconsistency). The reconciler pulls the
    // child back to not-started AND settles the reaction ✅→❌.
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', build_passed: false, orchestration_id: 'orch_1' })],
    } as never);
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'A');
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), 'A', 'x');
  });

  test('a genuinely FAILED child also reverts state + swaps reaction to ❌', async () => {
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })],
    } as never);
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'A');
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), 'A', 'x');
  });

  test('a SUCCEEDING child is never reverted or ❌-reacted (leaves ✅ + In Review intact)', async () => {
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })],
    } as never);
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalledWith(expect.anything(), 'A');
    expect(swapIssueReactionMock).not.toHaveBeenCalledWith(expect.anything(), 'A', 'x');
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

  test('an all-terminal epic with an integration node → embeds its combined screenshot in the panel', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    const meta = {
      sub_issue_id: '#meta',
      orchestration_id: 'orch_1',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
      repo: 'o/r',
      child_count: 2,
      platform_user_id: 'u1',
      status_comment_id: 'panel-1',
    };
    // A (real leaf) + integration node, BOTH succeeded → all-terminal. The
    // integration node's task record carries a screenshot_url.
    const rows = [
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'A',
        depends_on: [],
        child_status: 'succeeded',
        child_task_id: 'task-A',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
        linear_identifier: 'ENG-1',
      },
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'orch_1__integration',
        depends_on: ['A'],
        child_status: 'succeeded',
        child_task_id: 'task-int',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
      },
    ];
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'ChildTaskIndex') {
        return { Items: [{ ...rows[1] }] }; // the integration node just completed
      }
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') { // resolveChildPrUrls
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>;
        const tbl = Object.keys(keys)[0];
        return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
      }
      if (cmd._type === 'Get') { // resolveCombinedScreenshotUrl(task-int)
        const tid = (cmd.input.Key as { task_id: string }).task_id;
        return {
          Item: tid === 'task-int'
            ? { screenshot_url: 'https://cdn.example/combined.png', screenshot_preview_url: 'https://combined.vercel.app' }
            : {},
        };
      }
      return {};
    });

    await handler({
      Records: [taskRecord({
        task_id: 'task-int', status: 'COMPLETED', orchestration_id: 'orch_1',
      })],
    } as never);

    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('✅'); // complete
    // The panel embeds the image AND deep-links to the live combined deploy.
    expect(body).toContain('[![combined preview](https://cdn.example/combined.png)](https://combined.vercel.app)');
    expect(body).toContain('[Open the combined preview](https://combined.vercel.app)');
  });

  test('a FAILED integration node surfaces its build-failure reason + CloudWatch pointer on the panel', async () => {
    // the synthetic integration node has no Linear sub-issue,
    // so a failed combined build previously surfaced as a bare "❌ … failed" with
    // NO reason and NO log pointer. The reconciler must now resolve the reason
    // from the failed task's record and render it as a panel sub-line.
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    const meta = {
      sub_issue_id: '#meta',
      orchestration_id: 'orch_1',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
      repo: 'o/r',
      child_count: 2,
      platform_user_id: 'u1',
      status_comment_id: 'panel-1',
    };
    // A succeeded leaf + a FAILED integration node → all-terminal (with failures).
    const rows = [
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'A',
        depends_on: [],
        child_status: 'succeeded',
        child_task_id: 'task-A',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
        linear_identifier: 'ENG-1',
      },
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'orch_1__integration',
        depends_on: ['A'],
        child_status: 'failed',
        child_task_id: 'task-int',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
      },
    ];
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'ChildTaskIndex') {
        return { Items: [{ ...rows[1] }] }; // the integration node just went terminal (failed)
      }
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') {
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }>; ProjectionExpression?: string }>;
        const tbl = Object.keys(keys)[0];
        const proj = keys[tbl].ProjectionExpression ?? '';
        // resolveChildFailureReasons projects error_message/build_passed; the
        // failed integration task carries the real build-gate error shape.
        if (proj.includes('error_message')) {
          return {
            Responses: {
              [tbl]: keys[tbl].Keys.map((k) => (
                k.task_id === 'task-int'
                  ? { task_id: k.task_id, error_message: "Task did not succeed (agent_status='success', build_ok=False)" }
                  : { task_id: k.task_id }
              )),
            },
          };
        }
        // resolveChildPrUrls projects task_id/pr_url.
        return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
      }
      return {};
    });

    await handler({
      Records: [taskRecord({ task_id: 'task-int', status: 'FAILED', orchestration_id: 'orch_1' })],
    } as never);

    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('⚠️ **ABCA orchestration finished with failures**');
    // The diagnostic sub-line: names the combined merge build + points at CloudWatch by task id.
    expect(body).toMatch(/↳ Combined build failed after merging the sub-issue branches/);
    expect(body).toContain('CloudWatch for task `task-int`');
    // Never leaks raw build output (untrusted repo content).
    expect(body).not.toContain('build_ok');
  });

  // Partial-batch failure reporting. A record whose processing throws must be
  // reported by its sequence number (so only IT retries), not throw out of the
  // handler (which fails + re-drives the whole batch, re-reconciling healthy
  // siblings).
  test('a record that throws is reported in batchItemFailures, not rethrown; a healthy sibling still commits', async () => {
    // Make every DDB read throw so processing the FIRST record errors. The
    // second record (no sequence number) is processed after — with the throwing
    // mock it also errors, but has no seq, so it would rethrow; give BOTH a seq.
    ddbSend.mockRejectedValue(new Error('DDB throttled'));
    const rec1 = taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1' });
    const rec2 = taskRecord({ task_id: 'TB', status: 'COMPLETED', orchestration_id: 'orch_2', sequenceNumber: 'seq-2' });

    const res = (await handler({ Records: [rec1, rec2] } as never)) as { batchItemFailures: { itemIdentifier: string }[] };
    // Both failed → both reported; the handler did NOT throw.
    expect(res.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual(['seq-1', 'seq-2']);
  });

  test('a happy batch returns an empty batchItemFailures (nothing retried)', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    const res = (await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1' })],
    } as never)) as { batchItemFailures: { itemIdentifier: string }[] };
    expect(res.batchItemFailures).toEqual([]);
  });

  test('a throwing record with NO sequence number rethrows (cannot isolate — fail the batch, never silently drop)', async () => {
    ddbSend.mockRejectedValue(new Error('DDB throttled'));
    const rec = taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' }); // no sequenceNumber
    await expect(handler({ Records: [rec] } as never)).rejects.toThrow('DDB throttled');
  });
});

/** Detect a cascade marker in parseTerminalTaskRecord. */
describe('parseTerminalTaskRecord — the cascade marker', () => {
  test('a restack task (carries restack_predecessor) → cascadeSubIssueId set', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'TR',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'B',
      restack_predecessor_sub_issue_id: 'A',
    }));
    expect(evt?.cascadeSubIssueId).toBe('B');
  });

  test('an iteration task (orchestration_iteration=true) → cascadeSubIssueId set', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'TI',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A',
      orchestration_iteration: true,
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
  sub_issue_id: string;
  depends_on?: string[];
  child_status: string;
  child_task_id?: string;
  child_branch_name?: string;
  linear_identifier?: string;
}>, metaOverrides: Record<string, unknown> = {}): void {
  const meta = {
    sub_issue_id: '#meta',
    orchestration_id: 'orch_1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: children.length,
    platform_user_id: 'user-1',
    // A panel comment exists → the cascade EDITS it, rather than posting fresh.
    status_comment_id: 'panel-cmt-1',
    ...metaOverrides,
  };
  const rows = children.map((c) => ({
    orchestration_id: 'orch_1',
    sub_issue_id: c.sub_issue_id,
    depends_on: c.depends_on ?? [],
    child_status: c.child_status,
    repo: 'o/r',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
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

describe('feedback surface is chosen from the orchestration row, not assumed', () => {
  // The reconciler is event-driven: it acts on an orchestration it LOADED, so the
  // surface is a property of that row. Picking the wrong one would address a
  // different tenant's API entirely.
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
  });

  const completed = () => ({
    Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })],
  }) as never;

  test('a row recording the Linear channel drives the Linear surface', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
      meta: { channel_source: 'linear' },
    });
    await handler(completed());
    expect(upsertStatusCommentMock).toHaveBeenCalled();
  });

  test('a row with NO recorded channel still drives Linear (rows seeded before the field existed)', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    }); // no channel_source at all
    await handler(completed());
    expect(upsertStatusCommentMock).toHaveBeenCalled();
  });

  test('a row whose surface has no configured registry skips feedback instead of posting to Linear', async () => {
    // The Jira tenant registry is unset in this handler's env, so a Jira-sourced
    // orchestration has no adapter. It must stay silent — NOT fall through and
    // address the Linear workspace, which is a different tenant's data.
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
      meta: { channel_source: 'jira' },
    });
    await handler(completed());
    expect(upsertStatusCommentMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
  });
});

describe('orchestration-reconciler handler — cascading onto dependents', () => {
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
    await handler({
      Records: [taskRecord({
        task_id: 'restack-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

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
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][1].channelMetadata.orchestration_sub_issue_id).toBe('B');
  });

  test('a cascade that RE-OPENS the epic clears rollup_posted_at (so parent state can re-settle)', async () => {
    // A comment on an already-completed epic re-opens it. The first
    // completion's rollup_posted_at stamp must be cleared, or claimRollup stays
    // failed forever and the parent reaction/state never re-mirror (👀→✅).
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    // An Update issued a `REMOVE rollup_posted_at` on the meta row.
    const clears = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?._type === 'Update'
        && typeof cmd.input?.UpdateExpression === 'string'
        && cmd.input.UpdateExpression.includes('REMOVE rollup_posted_at'));
    expect(clears.length).toBeGreaterThan(0);
  });

  test('FAILED iteration → no cascade', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-fail',
        status: 'FAILED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('cascade source with no started dependents → no restack', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' }, // not started
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a re-stack of a NO-DEPENDENTS node still refreshes the panel + settles (not stuck)', async () => {
    // The hang this closes: a cascade source with no dependents returned
    // early without refreshing → the node's '🔄 updating' row never cleared and
    // the epic never re-settled to ✅. Here every child is already terminal, so
    // the completion settle must fire: panel edited + parent state mirrored.
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      // B is a leaf (nothing depends on it) AND has no dependents → planDirectRestack=0.
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    // A re-stack of B (the no-dependents leaf) completes.
    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    // No further restack (B has no dependents).
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // But the panel WAS refreshed (settle) — and since all children are
    // terminal, it shows complete + mirrors parent state.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/complete/i);
    expect(body).not.toMatch(/updating/i); // the stale updating row is gone
    expect(transitionIssueStateMock).toHaveBeenCalled(); // parent settled
  });

  test('a recorded retry comment is settled to ✅ when the re-run epic ends clean', async () => {
    // The gap this closes: the retry path can only ack the comment (👀) — it
    // returns the moment the work is dispatched — so nothing ever told the user
    // whether their retry worked. Observed in practice: the comment sat on 👀
    // with no reply while the panel showed the finished epic right above it.
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ], { retry_comment_id: 'retry-cmt-1' });

    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    // The marker moves off 👀 — it is the whole answer, since the retry path posts
    // no maturing reply.
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'retry-cmt-1', 'white_check_mark');
    // And the record is cleared, so a later settle can't re-swap an answered comment.
    const cleared = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update' && /REMOVE retry_comment_id/.test(cmd.input?.UpdateExpression ?? ''));
    expect(cleared).toHaveLength(1);
  });

  test('a retry that ends with failures settles the comment to ❌, matching the panel header', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'failed', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ], { retry_comment_id: 'retry-cmt-1' });

    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'retry-cmt-1', 'x');
  });

  test('an epic still in flight does NOT settle the retry comment yet', async () => {
    // Premature settling would tell the user "done" while children are still
    // running. The cascade source here is a LEAF (nothing depends on it), which is
    // the shape that routes through the settle path — a source WITH dependents
    // refreshes the panel from the cascade branch instead and never reaches it, so
    // that fixture would pass this assertion without exercising anything.
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      // B: the leaf whose restack just completed. C is still running, so the epic
      // as a whole is NOT terminal.
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
      { sub_issue_id: 'C', child_status: 'released', child_task_id: 'task-C', child_branch_name: 'branch-C', linear_identifier: 'ENG-3' },
    ], { retry_comment_id: 'retry-cmt-1' });

    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    // The settle path DID run — the panel shows the in-flight header (🔄 · n/m),
    // not a settled one — so it reached the gate and declined, rather than this
    // test never reaching the code.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    expect(upsertStatusCommentMock.mock.calls.at(-1)![2] as string).toMatch(/^🔄/);
    expect(swapCommentReactionMock).not.toHaveBeenCalledWith(expect.anything(), 'retry-cmt-1', expect.anything());
  });

  test('an epic with NO recorded retry comment settles nothing extra', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);

    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    const cleared = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update' && /retry_comment_id/.test(cmd.input?.UpdateExpression ?? ''));
    expect(cleared).toHaveLength(0);
  });

  test('a cascade source does NOT run normal child gating (no GSI sub-issue lookup)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    // Never queried ChildTaskIndex (that's the normal-gating path).
    const gsiCalls = ddbSend.mock.calls.filter(
      (c) => c[0]?._type === 'Query' && c[0]?.input?.IndexName === 'ChildTaskIndex');
    expect(gsiCalls).toHaveLength(0);
  });
});

describe('orchestration-reconciler handler — cascade surfacing via the panel', () => {
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
      task_id: 'iter-task-1',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: sub,
      orchestration_iteration: true,
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
    await handler({
      Records: [taskRecord({
        task_id: 'restack-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        restack_predecessor_sub_issue_id: 'Z',
      })],
    } as never);
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/ENG-2.*updating to include ENG-1's change/);
  });
});

describe('orchestration-reconciler handler — the iteration ack reply', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    swapCommentReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    replyToCommentMock.mockReset().mockResolvedValue('reply-1');
    upsertThreadedReplyMock.mockReset().mockResolvedValue('reply-1');
  });

  /** An iteration event carrying the human comment id that triggered it. */
  const iterEventWithComment = (status: string, commentId = 'human-cmt-1', buildPassed?: boolean, errorMessage?: string) => ({
    Records: [taskRecord({
      task_id: 'iter-task-1',
      status,
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A',
      orchestration_iteration: true,
      trigger_comment_id: commentId,
      ...(buildPassed !== undefined && { build_passed: buildPassed }),
      ...(errorMessage !== undefined && { error_message: errorMessage }),
    })],
  }) as never;

  test('successful iteration → ✅ threaded reply to the triggering comment, linking the PR', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED'));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    // Signature: replyToComment(ctx, issueId, parentCommentId, body).
    const [, issueId, parentCommentId, body] = upsertThreadedReplyMock.mock.calls[0];
    expect(issueId).toBe('A'); // the sub-issue the comment lives on
    expect(parentCommentId).toBe('human-cmt-1');
    // The PR ref is a clickable markdown link when the URL resolves.
    expect(body).toMatch(/^✅ Updated — \[PR #\d+\]\(https:\/\/.*\)\./);
    // The trigger comment's 👀 swaps to ✅, and the sub-issue
    // advances to In Review (platform-owned settle, not agent-flapped).
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'white_check_mark');
    // The channel passes the same-category-regression flag explicitly; a plain
    // advance never allows one.
    expect(transitionIssueStateMock).toHaveBeenCalledWith(expect.anything(), 'A', 'started', ['In Review'], false);
  });

  test('a no-change iteration (a question) settles 💬 and leaves the sub-issue state alone', async () => {
    // An answer is neither a success-edit nor a failure. ✅ would imply "PR
    // updated, merge-worthy" and advancing the sub-issue would claim work landed
    // — nothing changed, so the comment gets ❓ and the state is untouched.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        code_changed: false, // the agent answered without editing anything
      })],
    } as never);

    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'question');
    // The SUB-ISSUE is not advanced. (The parent epic still settles on its own,
    // since every child is terminal — that's the panel mirror, not this answer.)
    expect(transitionIssueStateMock).not.toHaveBeenCalledWith(
      expect.anything(), 'A', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  test('a PARENT-routed iteration replies on the PARENT issue, not the sub-issue', async () => {
    // The human commented on the parent epic and the router resolved it to
    // sub-issue A. The ✅/❌ reply must use the PARENT issue id as
    // commentCreate's issueId — else Linear rejects the reply (parentId belongs
    // to a different issue) and the human sees 👀 then silence.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
        trigger_comment_id: 'parent-cmt-1',
        trigger_comment_issue_id: 'PARENT', // comment lives on the parent epic
      })],
    } as never);

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, issueId, parentCommentId] = upsertThreadedReplyMock.mock.calls[0];
    expect(issueId).toBe('PARENT'); // NOT 'A' — the reply targets the parent comment's issue
    expect(parentCommentId).toBe('parent-cmt-1');
  });

  test('a FAILED iteration (agent crash) → ❌ reply with a classified reason + the CloudWatch task id', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('FAILED', 'human-cmt-1', undefined, 'agent_status="error_max_turns"'));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
    expect(body).toMatch(/^❌/);
    expect(body).toMatch(/Exceeded max turns/i); // classified
    expect(body).toMatch(/CloudWatch for task `iter-task-1`/);
    // retryable agent/timeout → plain reply-to-retry next step (retryGuidance).
    expect(body).toMatch(/reply here with any extra guidance/i);
    // A failed iteration still does not cascade onto dependents.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // The trigger comment's 👀 swaps to ❌, but the sub-issue state
    // is LEFT in place on failure (the ❌ + reply convey it; never demote).
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'x');
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
  });

  test('a COMPLETED-but-build-failed iteration → ❌ build/test reply pointing at the build log in CloudWatch', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    // COMPLETED, build_passed=false, NO error_message → build/test failure shape.
    await handler(iterEventWithComment('COMPLETED', 'human-cmt-1', false));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
    expect(body).toMatch(/build\/tests didn't pass/i);
    // Build-gate failures point at the agent's CloudWatch build log
    // (the build ran in the microVM), not the PR's GitHub checks.
    expect(body).toMatch(/build log in CloudWatch/i);
    expect(body).not.toMatch(/PR's checks/i);
    // build_passed=false ⇒ not a success ⇒ no cascade onto dependents.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('build_passed=false → ❌ reply (treated as not-successful)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED', 'human-cmt-1', false));
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
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
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
  });

  test('the terminal settle asks the surface to restore the outcome if it gets overwritten', async () => {
    // The progress writers avoid clobbering by reading the body first, but that is
    // a read then a separate write, and the surface offers no conditional update
    // to close the gap — so the writer holding the outcome verifies afterwards.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED'));

    const options = upsertThreadedReplyMock.mock.calls[0][5] as Record<string, unknown>;
    expect(options).toMatchObject({ preservePreview: true, repairIfOverwritten: true });
    // A terminal render must never yield to progress; only the reverse.
    expect(options.skipIfSettled).toBeFalsy();
  });

  test('a FAILED reply hands the claim back and defers the settle while attempts remain', async () => {
    // Two hazards if the claim is kept: no redelivery can retry the reply, and the
    // progress + heartbeat writers treat the claim as "an outcome landed" and stand
    // down — so the reply stalls on its last progress text. Settling the comment to
    // ✅ on top of that would be worse still: the reaction would say done while the
    // reply says working.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    upsertThreadedReplyMock.mockReset().mockResolvedValue(null);

    await handler(iterEventWithComment('COMPLETED'));

    const acks = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } })
      .filter((cmd) => cmd?._type === 'Update' && /ack_replied_at/.test(cmd.input?.UpdateExpression ?? ''));
    expect(acks[0].input?.UpdateExpression).toBe('SET ack_replied_at = :now');
    expect(acks[1].input?.UpdateExpression).toContain('REMOVE ack_replied_at');
    // Released conditionally on this run's own stamp, so a concurrent delivery that
    // has already claimed and replied keeps its claim.
    expect(acks[1].input?.ExpressionAttributeValues?.[':ours'])
      .toBe(acks[0].input?.ExpressionAttributeValues?.[':now']);
    expect(swapCommentReactionMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalledWith(
      expect.anything(), 'A', 'started', ['In Review'], false,
    );
  });

  test('once the retry budget is spent it settles the REACTION anyway, rather than leaving 👀', async () => {
    // Observed in practice: with a reply that could never succeed, the release
    // re-woke this handler (it writes to the task record, whose stream feeds it)
    // ~900 times, and the trigger comment sat on 👀 with no reply at all. A
    // permanent "still working" is worse than an outcome carried by the marker
    // alone.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    upsertThreadedReplyMock.mockReset().mockResolvedValue(null);
    const base = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      const expr = String(cmd.input?.UpdateExpression ?? '');
      if (cmd._type === 'Update' && expr.includes('REMOVE ack_replied_at')) {
        const err = new Error('conditional');
        (err as { name?: string }).name = 'ConditionalCheckFailedException';
        throw err;
      }
      // The budget re-read that distinguishes "spent" from "not ours".
      if (cmd._type === 'Get' && cmd.input?.ProjectionExpression === 'ack_reply_attempts') {
        return { Item: { ack_reply_attempts: 3 } };
      }
      return base(cmd);
    });

    await handler(iterEventWithComment('COMPLETED'));

    // The outcome still reaches the human, as a reaction.
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'white_check_mark');
  });

  test('a SUCCESSFUL reply keeps the claim, so the once-only guarantee survives the fix', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED'));

    const released = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update' && /REMOVE ack_replied_at/.test(cmd.input?.UpdateExpression ?? ''));
    expect(released).toHaveLength(0);
    expect(swapCommentReactionMock).toHaveBeenCalled();
  });

  test('a restack (no trigger_comment_id) → no ack reply', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'restack-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        restack_predecessor_sub_issue_id: 'Z',
      })],
    } as never);
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });
});
