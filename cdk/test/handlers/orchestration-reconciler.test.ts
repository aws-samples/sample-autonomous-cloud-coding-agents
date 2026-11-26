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

const rollupTaskCostMock = jest.fn();
jest.mock('../../src/handlers/budget-rollup', () => ({
  rollupTaskCost: (...args: unknown[]) => rollupTaskCostMock(...args),
}));

const publishTaskMetricsMock = jest.fn();
jest.mock('../../src/handlers/scoreboard-metrics', () => ({
  publishTaskMetrics: (...args: unknown[]) => publishTaskMetricsMock(...args),
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

const jiraPostIssueCommentMock = jest.fn();
const jiraUpdateIssueCommentMock = jest.fn();
const jiraPostIssueCommentAdfMock = jest.fn();
const jiraUpdateIssueCommentAdfMock = jest.fn();
const jiraBuildAdfDocumentMock = jest.fn(
  (paragraphs: ReadonlyArray<ReadonlyArray<{ text: string }>>) => ({ _adf: paragraphs }),
);
const jiraTransitionIssueStateMock = jest.fn();
const mockIterationStatus = jest.fn();
afterEach(() => {
  for (const [status] of mockIterationStatus.mock.calls) {
    expect(status).toEqual(expect.objectContaining({ terminal: true }));
  }
  mockIterationStatus.mockClear();
});
jest.mock('../../src/handlers/shared/jira-iteration-comment', () => ({
  updateJiraIterationComment: (_ddb: unknown, _table: string, _task: string,
    ctx: unknown, issue: string, comment: string, status: { body: unknown; terminal: boolean }) => {
    mockIterationStatus(status);
    return jiraUpdateIssueCommentAdfMock(ctx, issue, comment, status.body);
  },
}));

jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  postIssueComment: (...args: unknown[]) => jiraPostIssueCommentMock(...args),
  updateIssueComment: (...args: unknown[]) => jiraUpdateIssueCommentMock(...args),
  postIssueCommentAdf: (...args: unknown[]) => jiraPostIssueCommentAdfMock(...args),
  updateIssueCommentAdf: (...args: unknown[]) => jiraUpdateIssueCommentAdfMock(...args),
  buildAdfDocument: (...args: Parameters<typeof jiraBuildAdfDocumentMock>) => jiraBuildAdfDocumentMock(...args),
  parseMarkdownBlocks: jest.requireActual('../../src/handlers/shared/jira-feedback').parseMarkdownBlocks,
  transitionIssueState: (...args: unknown[]) => jiraTransitionIssueStateMock(...args),
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'WorkspaceRegistry';
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';
process.env.ARTIFACTS_BUCKET_NAME = 'ArtifactsBucket';

import { TERMINAL_STATUSES } from '../../src/constructs/task-status';
import { handler, parseTerminalTaskRecord, refreshPanelAndSettle } from '../../src/handlers/orchestration-reconciler';
import type { Channel } from '../../src/handlers/shared/orchestration-channel';
import { registerChannelFactory } from '../../src/handlers/shared/orchestration-channel-factory';

beforeEach(() => {
  rollupTaskCostMock.mockReset().mockResolvedValue(false);
  publishTaskMetricsMock.mockReset().mockResolvedValue(false);
});

function taskRecord(fields: {
  task_id?: string;
  status?: string;
  build_passed?: boolean;
  orchestration_id?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  orchestration_sub_issue_id?: string;
  restack_predecessor_sub_issue_id?: string;
  orchestration_iteration?: boolean;
  trigger_comment_id?: string;
  trigger_comment_issue_id?: string;
  error_message?: string;
  code_changed?: boolean;
  answer_text?: string;
  iteration_reply_comment_id?: string;
  cost_usd?: number;
  duration_s?: number;
  turns_attempted?: number;
  max_turns?: number;
  sequenceNumber?: string;
  written_at?: string;
  completed_at?: string;
  updated_at?: string;
}): DynamoDBRecord {
  const img: Record<string, unknown> = {};
  if (fields.task_id) img.task_id = { S: fields.task_id };
  if (fields.status) img.status = { S: fields.status };
  if (fields.completed_at) img.completed_at = { S: fields.completed_at };
  if (fields.updated_at) img.updated_at = { S: fields.updated_at };
  if (fields.build_passed !== undefined) img.build_passed = { BOOL: fields.build_passed };
  if (fields.code_changed !== undefined) img.code_changed = { BOOL: fields.code_changed };
  if (fields.answer_text) img.answer_text = { S: fields.answer_text };
  if (fields.cost_usd !== undefined) img.cost_usd = { N: String(fields.cost_usd) };
  if (fields.duration_s !== undefined) img.duration_s = { N: String(fields.duration_s) };
  if (fields.turns_attempted !== undefined) img.turns_attempted = { N: String(fields.turns_attempted) };
  if (fields.max_turns !== undefined) img.max_turns = { N: String(fields.max_turns) };
  if (fields.error_message) img.error_message = { S: fields.error_message };
  const cm: Record<string, unknown> = {};
  if (fields.orchestration_id) cm.orchestration_id = { S: fields.orchestration_id };
  if (fields.orchestration_sub_issue_id) cm.orchestration_sub_issue_id = { S: fields.orchestration_sub_issue_id };
  if (fields.restack_predecessor_sub_issue_id) {
    cm.restack_predecessor_sub_issue_id = { S: fields.restack_predecessor_sub_issue_id };
  }
  if (fields.orchestration_iteration) cm.orchestration_iteration = { S: 'true' };
  if (fields.trigger_comment_id) cm.trigger_comment_id = { S: fields.trigger_comment_id };
  if (fields.trigger_comment_issue_id) cm.trigger_comment_issue_id = { S: fields.trigger_comment_issue_id };
  if (fields.iteration_reply_comment_id) {
    cm.iteration_reply_comment_id = { S: fields.iteration_reply_comment_id };
  }
  if (Object.keys(cm).length > 0) img.channel_metadata = { M: cm };
  return {
    eventName: fields.eventName ?? 'MODIFY',
    dynamodb: {
      NewImage: img as never,
      ...(fields.sequenceNumber !== undefined && { SequenceNumber: fields.sequenceNumber }),
      ...(fields.written_at !== undefined && { ApproximateCreationDateTime: Date.parse(fields.written_at) / 1000 }),
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
    expect(parseTerminalTaskRecord(plainTerminalRecord({ task_id: 'P1', status: 'COMPLETED' }))).toBeNull();
  });

  test.each(TERMINAL_STATUSES)('acts on %s — every status the stream filter admits', (status) => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status, orchestration_id: 'orch_1',
    }));
    expect(evt).not.toBeNull();
    expect(evt?.status).toBe(status);
  });

  test('a non-terminal status is NOT acted on, so the guard above cannot pass by accepting everything', () => {
    for (const status of ['RUNNING', 'PENDING', 'AWAITING_APPROVAL']) {
      expect(parseTerminalTaskRecord(taskRecord({
        task_id: 'T1', status, orchestration_id: 'orch_1',
      }))).toBeNull();
    }
  });
});

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

function mockOrchestration(opts: {
  subIssueId: string;
  children: Array<{ sub_issue_id: string; depends_on?: string[]; child_status: string }>;
  meta?: Record<string, unknown>;
}): void {
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
    if (_type === 'Query') {
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

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const ctx = createTaskCoreMock.mock.calls[0][1];
    expect(ctx.idempotencyKey).toBe('orch_1_B');
  });

  test('the panel shows a dependent it has just started as running, not as blocked', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('- ✅ A — succeeded');
    expect(body).toContain('- 🔄 B — running');
    expect(body).not.toContain('blocked');
  });

  test('rolls up a terminal task even when it does not belong to an orchestration', async () => {
    rollupTaskCostMock.mockResolvedValueOnce(true);
    const record = taskRecord({ task_id: 'standalone', status: 'COMPLETED' });

    const result = await handler({ Records: [record] } as never);

    expect(rollupTaskCostMock).toHaveBeenCalledWith(record);
    expect(result.batchItemFailures).toEqual([]);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('releases orchestration dependents before reporting a budget-rollup retry', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    rollupTaskCostMock.mockRejectedValueOnce(new Error('budget table unavailable'));
    const record = taskRecord({
      task_id: 'TA',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      sequenceNumber: 'seq-budget',
    });

    const result = await handler({ Records: [record] } as never);

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][1].idempotencyKey).toBe('orch_1_B');
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'seq-budget' }]);
  });

  test('rolls up spend even when orchestration reconciliation needs a retry', async () => {
    ddbSend.mockRejectedValueOnce(new Error('orchestration table unavailable'));
    rollupTaskCostMock.mockResolvedValueOnce(true);
    const record = taskRecord({
      task_id: 'TA',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      sequenceNumber: 'seq-orchestration',
    });

    const result = await handler({ Records: [record] } as never);

    expect(rollupTaskCostMock).toHaveBeenCalledWith(record);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'seq-orchestration' }]);
  });

  describe('the scoreboard metrics step', () => {
    const BATCH_LINE = 'Orchestration reconciler batch processed';
    const STEP_FAILED = 'Scoreboard metrics step failed: task not counted';

    test('runs for every record, after the budget rollup, and the batch line counts the lines written', async () => {
      publishTaskMetricsMock.mockResolvedValueOnce(true);
      const first = taskRecord({ task_id: 'T1', status: 'COMPLETED' });
      const second = taskRecord({ task_id: 'T2', status: 'FAILED' });

      const result = await handler({ Records: [first, second] } as never);

      expect(publishTaskMetricsMock.mock.calls).toEqual([[first], [second]]);
      const [rollupOfFirst, rollupOfSecond] = rollupTaskCostMock.mock.invocationCallOrder;
      const [metricsOfFirst] = publishTaskMetricsMock.mock.invocationCallOrder;
      expect(rollupOfFirst).toBeLessThan(metricsOfFirst);
      expect(metricsOfFirst).toBeLessThan(rollupOfSecond);
      expect(result.batchItemFailures).toEqual([]);
      expect(loggerMock.info).toHaveBeenCalledWith(BATCH_LINE, {
        records: 2, reconciled: 0, budget_rolled_up: 0, metrics_published: 1, metrics_failed: 0, failed: 0,
      });
    });

    test('a failure is logged and counted, and the record is not reported for retry', async () => {
      publishTaskMetricsMock.mockRejectedValueOnce(new Error('claim throttled'));
      const record = taskRecord({ task_id: 'T1', status: 'COMPLETED', sequenceNumber: 'seq-metrics' });

      const result = await handler({ Records: [record] } as never);

      expect(result.batchItemFailures).toEqual([]);
      expect(loggerMock.error.mock.calls).toEqual([
        [STEP_FAILED, { sequence_number: 'seq-metrics', task_id: 'T1', error: 'claim throttled' }],
      ]);
      expect(loggerMock.info).toHaveBeenCalledWith(BATCH_LINE, {
        records: 1, reconciled: 0, budget_rolled_up: 0, metrics_published: 0, metrics_failed: 1, failed: 0,
      });
    });

    test('a failure does not fail the batch of a record without a sequence number', async () => {
      publishTaskMetricsMock.mockRejectedValueOnce('claim throttled');
      const record = taskRecord({ task_id: 'T1', status: 'COMPLETED' });

      await expect(handler({ Records: [record] } as never)).resolves.toEqual({ batchItemFailures: [] });

      expect(loggerMock.error.mock.calls).toEqual([
        [STEP_FAILED, { sequence_number: undefined, task_id: 'T1', error: 'claim throttled' }],
      ]);
    });

    test('a failure leaves the other steps of its record, and the records after it, alone', async () => {
      mockOrchestration({
        subIssueId: 'A',
        children: [
          { sub_issue_id: 'A', child_status: 'released' },
          { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
        ],
      });
      rollupTaskCostMock.mockResolvedValue(true);
      publishTaskMetricsMock.mockRejectedValueOnce(new Error('claim throttled')).mockResolvedValueOnce(true);
      const first = taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1' });
      const second = taskRecord({ task_id: 'standalone', status: 'COMPLETED', sequenceNumber: 'seq-2' });

      const result = await handler({ Records: [first, second] } as never);

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(createTaskCoreMock.mock.calls[0][1].idempotencyKey).toBe('orch_1_B');
      expect(rollupTaskCostMock.mock.calls).toEqual([[first], [second]]);
      expect(publishTaskMetricsMock.mock.calls).toEqual([[first], [second]]);
      expect(result.batchItemFailures).toEqual([]);
      expect(loggerMock.info).toHaveBeenCalledWith(BATCH_LINE, {
        records: 2, reconciled: 1, budget_rolled_up: 2, metrics_published: 1, metrics_failed: 1, failed: 0,
      });
    });

    test('a failure does not hide the failure of another step of the same record', async () => {
      ddbSend.mockRejectedValue(new Error('orchestration table unavailable'));
      publishTaskMetricsMock.mockRejectedValue(new Error('claim throttled'));
      const reportable = taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1' });
      const unreportable = taskRecord({ task_id: 'TB', status: 'COMPLETED', orchestration_id: 'orch_2' });

      await expect(handler({ Records: [reportable] } as never)).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
      expect(loggerMock.info).toHaveBeenCalledWith(BATCH_LINE, {
        records: 1, reconciled: 0, budget_rolled_up: 0, metrics_published: 0, metrics_failed: 1, failed: 1,
      });
      await expect(handler({ Records: [unreportable] } as never)).rejects.toThrow('orchestration table unavailable');
    });
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

  test('A succeeds → B released but its create is guardrail-blocked (400) → B failed + dependent C skipped', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'succeeded' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
        { sub_issue_id: 'C', depends_on: ['B'], child_status: 'blocked' },
      ],
    });
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 400,
      body: '{"error":{"message":"Task description was blocked by content policy."}}',
    });

    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const updates = ddbSend.mock.calls
      .map((c) => c[0] as { _type: string; input: Record<string, unknown> })
      .filter((c) => c._type === 'Update');
    const wrote = (sk: string, status: string) => updates.some((u) =>
      (u.input.Key as { sub_issue_id?: string }).sub_issue_id === sk
      && (u.input.ExpressionAttributeValues as Record<string, unknown>)[':s'] === status
      || (sk === 'B' && (u.input.Key as { sub_issue_id?: string }).sub_issue_id === 'B'
        && (u.input.ExpressionAttributeValues as Record<string, unknown>)[':failed'] === 'failed'));
    expect(updates.some((u) =>
      (u.input.Key as { sub_issue_id?: string }).sub_issue_id === 'B'
      && (u.input.ExpressionAttributeValues as Record<string, unknown>)[':failed'] === 'failed')).toBe(true);
    expect(wrote('C', 'skipped')).toBe(true);
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

  test('a write made long after the task ended leaves the failed child\'s issue alone: a person may have taken it over (#1073)', async () => {
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    const ended = Date.parse('2026-11-24T10:00:00Z');
    const minutesAfterEnd = (minutes: number) => new Date(ended + minutes * 60_000).toISOString();
    const write = (writtenAt: string, times: Record<string, unknown> = { completed_at: { S: minutesAfterEnd(0) } }) => {
      const record = taskRecord({
        task_id: 'TA',
        status: 'COMPLETED',
        build_passed: false,
        orchestration_id: 'orch_1',
        written_at: writtenAt,
      });
      Object.assign(record.dynamodb!.NewImage!, times);
      return { Records: [record] } as never;
    };
    const settled = () => [revertIssueToNotStartedMock, swapIssueReactionMock]
      .map((mock) => mock.mock.calls.filter((call) => call[1] === 'A').length);

    await handler(write(minutesAfterEnd(0)));
    expect(settled()).toEqual([1, 1]);

    await handler(write(minutesAfterEnd(4)));
    expect(settled()).toEqual([2, 2]);

    await handler(write(minutesAfterEnd(6), {
      completed_at: { S: minutesAfterEnd(0) },
      updated_at: { S: minutesAfterEnd(6) },
      screenshot_url: { S: 'https://cdn.example/later-push.png' },
    }));
    expect(settled()).toEqual([2, 2]);

    await handler(write(minutesAfterEnd(6), { updated_at: { S: minutesAfterEnd(6) } }));
    expect(settled()).toEqual([2, 2]);

    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(4);
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
        taskRecord({ task_id: 'T2', status: 'COMPLETED' }),
      ],
    } as never);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('unresolvable sub_issue_id (GSI miss) → skip, no throw', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test.each(['linear', 'jira'])('an all-terminal %s epic embeds the integration preview on its parent', async (source) => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    const meta = {
      channel_source: source,
      parent_issue_ref: 'PARENT',
      credentials_ref: 'WS',
      sub_issue_id: '#meta',
      orchestration_id: 'orch_1',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
      repo: 'o/r',
      child_count: 2,
      platform_user_id: 'u1',
      status_comment_id: 'panel-1',
    };
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
        return { Items: [{ ...rows[1] }] };
      }
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') {
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>;
        const tbl = Object.keys(keys)[0];
        return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
      }
      if (cmd._type === 'Get') {
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

    const calls = source === 'jira' ? jiraUpdateIssueCommentMock.mock.calls : upsertStatusCommentMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('PARENT');
    const body = calls[0][source === 'jira' ? 3 : 2] as string;
    if (source === 'jira') expect(jiraPostIssueCommentMock).not.toHaveBeenCalled();
    expect(body).toContain('✅');
    expect(body).toContain('[![combined preview](https://cdn.example/combined.png)](https://combined.vercel.app)');
    expect(body).toContain('[Open the combined preview](https://combined.vercel.app)');
  });

  test('a FAILED integration node surfaces its build-failure reason + CloudWatch pointer on the panel', async () => {
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
        return { Items: [{ ...rows[1] }] };
      }
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') {
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }>; ProjectionExpression?: string }>;
        const tbl = Object.keys(keys)[0];
        const proj = keys[tbl].ProjectionExpression ?? '';
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
    expect(body).toMatch(/↳ Combined build failed after merging the sub-issue branches/);
    expect(body).toContain('CloudWatch for task `task-int`');
    expect(body).not.toContain('build_ok');
  });

  test('a record that throws is reported in batchItemFailures, not rethrown; a healthy sibling still commits', async () => {
    ddbSend.mockRejectedValue(new Error('DDB throttled'));
    const rec1 = taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1' });
    const rec2 = taskRecord({ task_id: 'TB', status: 'COMPLETED', orchestration_id: 'orch_2', sequenceNumber: 'seq-2' });

    const res = (await handler({ Records: [rec1, rec2] } as never)) as { batchItemFailures: { itemIdentifier: string }[] };
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
    const rec = taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' });
    await expect(handler({ Records: [rec] } as never)).rejects.toThrow('DDB throttled');
  });
});

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

function mockCascade(children: Array<{
  sub_issue_id: string;
  depends_on?: string[];
  child_status: string;
  child_task_id?: string;
  child_branch_name?: string;
  linear_identifier?: string;
  channel_metadata?: Record<string, string>;
}>, metaOverrides: Record<string, unknown> = {}): void {
  const meta = {
    sub_issue_id: '#meta',
    orchestration_id: 'orch_1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: children.length,
    platform_user_id: 'user-1',
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
    ...(c.channel_metadata && { channel_metadata: c.channel_metadata }),
  }));
  ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Query') return { Items: [meta, ...rows] };
    if (cmd._type === 'Get') {
      const tid = (cmd.input.Key as { task_id: string }).task_id;
      return { Item: { task_id: tid, pr_url: `https://github.com/o/r/pull/${tid.length}` } };
    }
    if (cmd._type === 'BatchGet') {
      const keys = (cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>);
      const tbl = Object.keys(keys)[0];
      return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
    }
    return {};
  });
}

describe('feedback surface is chosen from the orchestration row, not assumed', () => {
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
    });
    await handler(completed());
    expect(upsertStatusCommentMock).toHaveBeenCalled();
  });

  test('a Jira row drives the Jira adapter instead of posting to Linear', async () => {
    jiraPostIssueCommentMock.mockResolvedValue('jira-panel-1');
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
      meta: {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    });
    await handler(completed());
    expect(upsertStatusCommentMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(jiraPostIssueCommentMock).toHaveBeenCalled();
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

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).toBe('coding/restack-v1');
    expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('C');
    expect(ctx.channelMetadata.restack_predecessor_sub_issue_id).toBe('B');
    expect(ctx.channelMetadata.orchestration_merge_branches).toBe(JSON.stringify(['branch-B']));
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

  test('an iteration that only answered a question re-stacks nothing and does not re-open the epic', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-question',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
        code_changed: false,
      })],
    } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reopened = ddbSend.mock.calls
      .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd._type === 'Update' && /REMOVE rollup_posted_at/.test(cmd.input?.UpdateExpression ?? ''));
    expect(reopened).toHaveLength(0);
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/complete/i);
    expect(body).not.toMatch(/updating/i);
  });

  test('a re-stack that had nothing to merge does not re-stack the next dependent', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
      { sub_issue_id: 'C', depends_on: ['B'], child_status: 'succeeded', child_task_id: 'task-C', child_branch_name: 'branch-C' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
        code_changed: false,
      })],
    } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).not.toMatch(/updating/i);
  });

  test('cascade source with no started dependents → no restack', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
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
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
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

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/complete/i);
    expect(body).not.toMatch(/updating/i);
    expect(transitionIssueStateMock).toHaveBeenCalled();
  });

  test('a recorded retry comment is settled to ✅ when the re-run epic ends clean', async () => {
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

    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'retry-cmt-1', 'white_check_mark');
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
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
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
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/ENG-2.*updating per ENG-1's comment/);
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('idempotent replay (200, NOT 201) does NOT re-mark the panel as updating', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 200, body: '{}' });
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler(iterEvent('A'));
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
    jiraPostIssueCommentMock.mockReset().mockResolvedValue('jira-reply-1');
    jiraUpdateIssueCommentMock.mockReset().mockResolvedValue(true);
    jiraPostIssueCommentAdfMock.mockReset().mockResolvedValue({
      ok: true,
      commentId: 'jira-result-1',
    });
    jiraUpdateIssueCommentAdfMock.mockReset().mockResolvedValue({ ok: true });
    jiraBuildAdfDocumentMock.mockClear();
    jiraTransitionIssueStateMock.mockReset().mockResolvedValue(true);
  });

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
    const [, issueId, parentCommentId, body] = upsertThreadedReplyMock.mock.calls[0];
    expect(issueId).toBe('A');
    expect(parentCommentId).toBe('human-cmt-1');
    expect(body).toMatch(/^✅ Updated — \[PR #\d+\]\(https:\/\/.*\)\./);
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'white_check_mark');
    expect(transitionIssueStateMock).toHaveBeenCalledWith(expect.anything(), 'A', 'started', ['In Review'], false);
  });

  test('a Jira orchestration iteration finishes its progress comment and posts metrics separately', async () => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );

    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
        cost_usd: 1.25,
        duration_s: 125,
        turns_attempted: 12,
        max_turns: 100,
      })],
    } as never);

    const statusUpdate = jiraUpdateIssueCommentAdfMock.mock.calls.find(
      (([, , commentId]) => commentId === 'jira-status-1'),
    );
    expect(statusUpdate).toBeDefined();
    const [ctx, issueKey, commentId, body] = statusUpdate!;
    expect(ctx).toEqual({
      cloudId: 'cloud-1',
      registryTableName: 'JiraWorkspaceRegistry',
    });
    expect(issueKey).toBe('KAN-2');
    expect(commentId).toBe('jira-status-1');
    expect(body).toEqual({
      _adf: [[{ text: '✅ Finished — result posted below.', strong: true }]],
    });
    const finalPost = jiraPostIssueCommentAdfMock.mock.calls.find(
      (([, postedIssueKey, postedBody]) => {
        const text = (postedBody._adf as Array<Array<{ text: string }>>)
          .flat()
          .map((run) => run.text)
          .join('');
        return postedIssueKey === 'KAN-2'
          && text.includes('cost: $1.25 • turns: 12 / 100 • duration: 2m 5s');
      }),
    );
    expect(finalPost).toBeDefined();
    const finalRuns = (finalPost![2]._adf as Array<Array<{ text: string; href?: string }>>).flat();
    expect(finalRuns.map((run) => run.text).join('')).toContain('task iter-task-1');
    expect(finalRuns).toContainEqual(expect.objectContaining({
      text: expect.stringContaining('/pull/'),
      href: expect.stringContaining('/pull/'),
    }));
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });

  test('a Jira orchestration iteration that answered a question posts the answer in its result', async () => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );

    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
        code_changed: false,
        answer_text: 'Because the queue already retries.',
      })],
    } as never);

    const pointer = jiraUpdateIssueCommentAdfMock.mock.calls.find(
      (([, , commentId]) => commentId === 'jira-status-1'),
    );
    expect(pointer![3]).toEqual({
      _adf: [[{ text: '💬 Finished — answer posted below.', strong: true }]],
    });
    expect(jiraPostIssueCommentAdfMock).toHaveBeenCalledTimes(1);
    const [, issueKey, result] = jiraPostIssueCommentAdfMock.mock.calls[0];
    expect(issueKey).toBe('KAN-2');
    const lines = (result._adf as Array<Array<{ text: string }>>)
      .map((runs) => runs.map((run) => run.text).join(''));
    expect(lines.slice(0, 2)).toEqual(['✅ Task completed', 'Because the queue already retries.']);
  });

  test('a Jira orchestration iteration that completes with a red build names the reason in its result', async () => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );

    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        build_passed: false,
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
      })],
    } as never);

    const pointer = jiraUpdateIssueCommentAdfMock.mock.calls.find(
      (([, , commentId]) => commentId === 'jira-status-1'),
    );
    expect(pointer![3]).toEqual({
      _adf: [[{ text: '❌ Finished — details posted below.', strong: true }]],
    });
    expect(jiraPostIssueCommentAdfMock).toHaveBeenCalledTimes(1);
    const [, , result] = jiraPostIssueCommentAdfMock.mock.calls[0];
    const header = (result._adf as Array<Array<{ text: string }>>)[0].map((run) => run.text).join('');
    expect(header).toBe(
      '⚠️ Shipped a PR but stopped early — Build or tests did not pass — review and decide if more work is needed',
    );
  });

  test('a Jira iteration advances the sub-issue with the review status of its own project mapping', async () => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
        channel_metadata: { jira_issue_key: 'KAN-2', jira_status_on_pr: 'QA Review' },
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );

    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
      })],
    } as never);

    expect(jiraTransitionIssueStateMock).toHaveBeenCalledWith(
      { cloudId: 'cloud-1', registryTableName: 'JiraWorkspaceRegistry' },
      'KAN-2',
      'in_review',
      { inReview: 'QA Review' },
      undefined,
    );
  });

  test('a failed Jira terminal update releases the claim for redelivery', async () => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );
    jiraUpdateIssueCommentAdfMock.mockImplementation(
      (_ctx, _issueKey, commentId) => Promise.resolve(
        commentId === 'jira-status-1'
          ? { ok: false, retryable: false }
          : { ok: true },
      ),
    );

    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
      })],
    } as never);

    const claims = ddbSend.mock.calls
      .map(([command]) => command as {
        _type?: string;
        input?: {
          UpdateExpression?: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        };
      })
      .filter(command =>
        command._type === 'Update'
        && /ack_replied_at/.test(command.input?.UpdateExpression ?? ''),
      );
    expect(claims[0].input?.UpdateExpression).toBe('SET ack_replied_at = :now');
    expect(claims[1].input?.UpdateExpression).toContain('REMOVE ack_replied_at');
    expect(claims[1].input?.ExpressionAttributeValues?.[':ours'])
      .toBe(claims[0].input?.ExpressionAttributeValues?.[':now']);
    expect(jiraPostIssueCommentAdfMock).not.toHaveBeenCalled();
  });

  test.each([false, true])('Jira result-post failure folds the outcome into the status comment (retry budget exhausted: %s)', async (exhausted) => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );
    jiraPostIssueCommentAdfMock.mockResolvedValue({
      ok: false,
      retryable: exhausted,
    });

    if (exhausted) {
      const base = ddbSend.getMockImplementation()!;
      ddbSend.mockImplementation(async (command: { _type: string; input: Record<string, unknown> }) => {
        if (String(command.input.UpdateExpression).includes('REMOVE ack_replied_at')) {
          throw Object.assign(new Error('attempts exhausted'), { name: 'ConditionalCheckFailedException' });
        }
        if (command.input.ProjectionExpression === 'ack_reply_attempts') return { Item: { ack_reply_attempts: 3 } };
        return base(command);
      });
    }

    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
        cost_usd: 1.25,
      })],
    } as never);

    expect(jiraUpdateIssueCommentAdfMock).toHaveBeenCalledTimes(2);
    const [, , commentId, fallbackBody] = jiraUpdateIssueCommentAdfMock.mock.calls[1];
    expect(commentId).toBe('jira-status-1');
    const runs = (fallbackBody._adf as Array<Array<{ text: string; href?: string }>>).flat();
    expect(runs.map((run) => run.text).join('')).toContain('cost: $1.25');
    expect(runs).toContainEqual(expect.objectContaining({
      href: expect.stringContaining('/pull/'),
    }));
    const releases = ddbSend.mock.calls
      .map(([command]) => command as {
        _type?: string;
        input?: { UpdateExpression?: string };
      })
      .filter(command =>
        command._type === 'Update'
        && /REMOVE ack_replied_at/.test(command.input?.UpdateExpression ?? ''),
      );
    expect(releases).toHaveLength(exhausted ? 1 : 0);
  });

  test('redelivered Jira iteration matures its status comment once', async () => {
    mockCascade(
      [{
        sub_issue_id: 'KAN-2',
        child_status: 'succeeded',
        child_task_id: 'task-A',
        child_branch_name: 'branch-A',
      }],
      {
        channel_source: 'jira',
        parent_issue_ref: 'KAN-1',
        credentials_ref: 'cloud-1',
      },
    );
    let ackClaims = 0;
    const base = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation(async (command: {
      _type: string;
      input: Record<string, unknown>;
    }) => {
      if (
        command._type === 'Update'
        && String(command.input.UpdateExpression).includes('ack_replied_at')
      ) {
        ackClaims += 1;
        if (ackClaims > 1) {
          throw Object.assign(new Error('claimed'), {
            name: 'ConditionalCheckFailedException',
          });
        }
        return {};
      }
      return base(command);
    });
    const event = {
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'KAN-2',
        orchestration_iteration: true,
        trigger_comment_id: 'human-cmt-1',
        trigger_comment_issue_id: 'KAN-2',
        iteration_reply_comment_id: 'jira-status-1',
      })],
    } as never;

    await handler(event);
    await handler(event);

    const statusUpdates = jiraUpdateIssueCommentAdfMock.mock.calls.filter(
      (([, , commentId]) => commentId === 'jira-status-1'),
    );
    expect(statusUpdates).toHaveLength(1);
    const resultPosts = jiraPostIssueCommentAdfMock.mock.calls.filter(
      (([, issueKey, body]) => {
        const text = (body._adf as Array<Array<{ text: string }>>)
          .flat()
          .map((run) => run.text)
          .join('');
        return issueKey === 'KAN-2' && text.includes('task iter-task-1');
      }),
    );
    expect(resultPosts).toHaveLength(1);
  });

  test('a no-change iteration (a question) settles 💬 and leaves the sub-issue state alone', async () => {
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
        code_changed: false,
      })],
    } as never);

    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'question');
    expect(transitionIssueStateMock).not.toHaveBeenCalledWith(
      expect.anything(), 'A', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  test('a PARENT-routed iteration replies on the PARENT issue, not the sub-issue', async () => {
    // Linear's commentCreate rejects a reply whose parent comment belongs to a different issue.
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
        trigger_comment_issue_id: 'PARENT',
      })],
    } as never);

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, issueId, parentCommentId] = upsertThreadedReplyMock.mock.calls[0];
    expect(issueId).toBe('PARENT');
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
    expect(body).toMatch(/Exceeded max turns/i);
    expect(body).toMatch(/CloudWatch for task `iter-task-1`/);
    expect(body).toMatch(/reply here with any extra guidance/i);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'x');
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
  });

  test('a COMPLETED-but-build-failed iteration → ❌ build/test reply pointing at the build log in CloudWatch', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED', 'human-cmt-1', false));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
    expect(body).toMatch(/build\/tests didn't pass/i);
    expect(body).toMatch(/build log in CloudWatch/i);
    expect(body).not.toMatch(/PR's checks/i);
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
    await handler(iterEventWithComment('COMPLETED'));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
  });

  test('the terminal settle asks the surface to restore the outcome if it gets overwritten', async () => {
    // The surface offers no conditional update, so a progress write can still land on top of the outcome.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED'));

    const options = upsertThreadedReplyMock.mock.calls[0][5] as Record<string, unknown>;
    expect(options).toMatchObject({ preservePreview: true, repairIfOverwritten: true });
    expect(options.skipIfSettled).toBeFalsy();
  });

  test('a FAILED reply hands the claim back and defers the settle while attempts remain', async () => {
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
    expect(acks[1].input?.ExpressionAttributeValues?.[':ours'])
      .toBe(acks[0].input?.ExpressionAttributeValues?.[':now']);
    expect(swapCommentReactionMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalledWith(
      expect.anything(), 'A', 'started', ['In Review'], false,
    );
  });

  test('once the retry budget is spent it settles the REACTION anyway, rather than leaving 👀', async () => {
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
      if (cmd._type === 'Get' && cmd.input?.ProjectionExpression === 'ack_reply_attempts') {
        return { Item: { ack_reply_attempts: 3 } };
      }
      return base(cmd);
    });

    await handler(iterEventWithComment('COMPLETED'));

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

describe('the panel preview on a CHAIN (no integration node)', () => {
  test('reads the preview off the final node instead of showing none', async () => {
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
    const base = { orchestration_id: 'orch_1', repo: 'o/r', parent_linear_issue_id: 'PARENT', linear_workspace_id: 'WS' };
    const rows = [
      { ...base, sub_issue_id: 'A', depends_on: [], child_status: 'succeeded', child_task_id: 'task-A', linear_identifier: 'ENG-1' },
      { ...base, sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', linear_identifier: 'ENG-2' },
    ];
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'ChildTaskIndex') return { Items: [{ ...rows[1] }] };
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') {
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>;
        const tbl = Object.keys(keys)[0];
        return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
      }
      if (cmd._type === 'Get') {
        const tid = (cmd.input.Key as { task_id: string }).task_id;
        return {
          Item: tid === 'task-B'
            ? { screenshot_url: 'https://cdn.example/final.png', screenshot_preview_url: 'https://final.vercel.app' }
            : { screenshot_url: 'https://cdn.example/WRONG-first-child.png' },
        };
      }
      return {};
    });

    await handler({
      Records: [{
        eventName: 'MODIFY',
        dynamodb: {
          NewImage: {
            task_id: { S: 'task-B' },
            status: { S: 'COMPLETED' },
            orchestration_id: { S: 'orch_1' },
            build_passed: { BOOL: true },
          } as never,
        },
      }],
    } as never);

    const panel = upsertStatusCommentMock.mock.calls.map((c) => String(c[2])).join('\n');
    expect(panel).toContain('https://cdn.example/final.png');
    expect(panel).not.toContain('WRONG-first-child');
    expect(panel).toContain('https://final.vercel.app');
    expect(panel).toContain('🖼️ **Preview**');
    expect(panel).not.toContain('Combined preview');
  });
});

type StoreRow = Record<string, unknown>;
type StoreCommand = { _type: string; input: Record<string, unknown> };

function conditionHolds(row: StoreRow, expression: unknown, vals: StoreRow): boolean {
  if (expression === undefined) return true;
  const nested = /^(.+) AND \((.+)\)$/.exec(String(expression));
  if (nested) return conditionHolds(row, nested[1], vals) && conditionHolds(row, nested[2], vals);
  return String(expression).split(' OR ').some((alternative) => alternative.split(' AND ').every((clause) => {
    const absent = /^attribute_not_exists\((\w+)\)$/.exec(clause);
    if (absent) return row[absent[1]] === undefined;
    const [, attr, op, rhs] = /^(\w+) (=|<>|IN) (.+)$/.exec(clause)!;
    if (op === 'IN') return rhs.slice(1, -1).split(', ').some((v) => row[attr] === vals[v]);
    return (row[attr] === vals[rhs]) === (op === '=');
  }));
}

function orchestrationStore(
  children: Array<{
    sub_issue_id: string;
    depends_on?: string[];
    child_status: string;
    child_task_id?: string;
    child_branch_name?: string;
    failure_reason?: string;
    unsettled_task_id?: string;
  }>,
  meta: StoreRow = {},
) {
  const rows = new Map<string, StoreRow>([['#meta', {
    sub_issue_id: '#meta',
    orchestration_id: 'orch_1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: children.length,
    platform_user_id: 'user-1',
    status_comment_id: 'panel-1',
    ...meta,
  }]]);
  for (const c of children) {
    rows.set(c.sub_issue_id, {
      orchestration_id: 'orch_1',
      repo: 'o/r',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
      depends_on: [],
      ...c,
    });
  }
  const tasks = new Map<string, StoreRow>();
  let pending: { when: (cmd: StoreCommand) => boolean; run: () => unknown } | undefined;

  ddbSend.mockImplementation(async (cmd: StoreCommand) => {
    if (pending?.when(cmd)) {
      const { run } = pending;
      pending = undefined;
      await run();
    }
    const { _type, input } = cmd;
    if (_type === 'BatchGet') {
      const [[table, { Keys }]] = Object.entries(input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>);
      return { Responses: { [table]: Keys.flatMap((k) => tasks.get(k.task_id) ?? []) } };
    }
    if (input.TableName !== 'OrchestrationTable') return {};
    if (_type === 'Query') {
      const taskId = (input.ExpressionAttributeValues as StoreRow)[':tid'];
      const items = [...rows.values()].filter((r) => input.IndexName === undefined || r.child_task_id === taskId);
      return { Items: items.map((r) => ({ ...r })) };
    }
    const row = rows.get((input.Key as { sub_issue_id: string }).sub_issue_id)!;
    const vals = (input.ExpressionAttributeValues ?? {}) as StoreRow;
    if (!conditionHolds(row, input.ConditionExpression, vals)) {
      throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    }
    const expression = String(input.UpdateExpression);
    for (const assignment of /SET (.+?)(?= REMOVE |$)/.exec(expression)?.[1].split(', ') ?? []) {
      const [attr, value] = assignment.split(' = ');
      row[attr] = vals[value];
    }
    for (const attr of /REMOVE (.+?)(?= SET |$)/.exec(expression)?.[1].split(', ') ?? []) delete row[attr];
    return {};
  });

  return {
    row: (subIssueId: string) => rows.get(subIssueId)!,
    status: (subIssueId: string) => rows.get(subIssueId)?.child_status,
    meta: rows.get('#meta')!,
    tasks,
    before(when: (cmd: StoreCommand) => boolean, run: () => unknown): void {
      pending = { when, run };
    },
  };
}

const LEFT_ALONE_AS_LATE = 'Reconciler left the issue of a failed child alone: a late write on its task record';

describe('orchestration-reconciler handler — an event of a task that no longer decides its row', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 201, body: JSON.stringify({ data: { task_id: 'T-new', branch_name: 'branch-new' } }),
    });
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
  });

  const lateFailure = () => ({
    Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })],
  }) as never;
  const repair = () => ({
    Records: [taskRecord({
      task_id: 'TI',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A',
      orchestration_iteration: true,
      code_changed: true,
    })],
  }) as never;

  test('after a comment repaired the child, it stays succeeded and its issue is not reverted', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
    ]);
    await handler(lateFailure());

    expect(store.status('A')).toBe('succeeded');
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).not.toHaveBeenCalledWith(expect.anything(), 'A', 'x');
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(store.status('B')).toBe('released');
  });

  test('the repair is processed between the read and the write of the late event: it still stands', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'failed', child_task_id: 'TA', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'skipped' },
    ]);
    store.before((cmd) => cmd._type === 'Update', () => handler(repair()));

    await handler(lateFailure());

    expect(store.status('A')).toBe('succeeded');
    expect(store.status('B')).toBe('released');
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalled();
  });

  test('the late event is processed before the repair: the repair still stands', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'failed', child_task_id: 'TA', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'skipped' },
    ]);
    await handler(lateFailure());
    await handler(repair());

    expect(store.status('A')).toBe('succeeded');
    expect(store.status('B')).toBe('released');
  });

  test.each(['blocked', 'releasing', 'skipped'])('after a retry reset the child to %s, the old failure is not written back', async (status) => {
    const store = orchestrationStore([
      { sub_issue_id: 'P', child_status: 'released', child_task_id: 'TP' },
      { sub_issue_id: 'A', depends_on: ['P'], child_status: status, child_task_id: 'TA' },
    ]);
    await handler(lateFailure());

    expect(store.status('A')).toBe(status);
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalled();
  });

  test('after the child was released again, an event of its earlier task is not applied to the new run', async () => {
    // The index that maps a task to its row lags behind the row: for a moment
    // after the new release it still resolves the earlier task to the row.
    const store = orchestrationStore([{ sub_issue_id: 'A', child_status: 'ready', child_task_id: 'TA' }]);
    store.before(
      (cmd) => cmd._type === 'Query' && cmd.input.IndexName === undefined,
      () => Object.assign(store.row('A'), { child_status: 'released', child_task_id: 'T2' }),
    );
    await handler(lateFailure());

    expect(store.row('A')).toMatchObject({ child_status: 'released', child_task_id: 'T2' });
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalled();
  });

  test('a child that a retry left ready is started by the late event, not failed again', async () => {
    const store = orchestrationStore([{ sub_issue_id: 'A', child_status: 'ready', child_task_id: 'TA' }]);
    await handler(lateFailure());

    expect(store.status('A')).toBe('released');
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalled();
  });

  test('a late write that is the first to reach the row fails the child and skips its dependents: only the issue is left alone', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'released', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
    ]);
    const record = taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1', written_at: '2026-11-24T10:06:00Z' });
    Object.assign(record.dynamodb!.NewImage!, { completed_at: { S: '2026-11-24T10:00:00Z' } });
    await handler({ Records: [record] } as never);

    expect(store.status('A')).toBe('failed');
    expect(store.status('B')).toBe('skipped');
    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).not.toHaveBeenCalledWith(expect.anything(), 'A', 'x');
    expect(loggerMock.warn).toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, {
      orchestration_id: 'orch_1',
      sub_issue_id: 'A',
      task_id: 'TA',
      completed_at: '2026-11-24T10:00:00Z',
      written_at: '2026-11-24T10:06:00.000Z',
      brought_verdict: true,
    });
  });

  test.each([
    ['the first delivery', 'released'],
    ['a redelivery, after the first one died before it skipped the dependents,', 'failed'],
  ])('%s of a failure fails the child, skips its dependents and reverts its issue', async (_name, status) => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: status, child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'TA',
        status: 'FAILED',
        orchestration_id: 'orch_1',
        completed_at: '2026-11-24T10:00:00Z',
        written_at: '2026-11-24T10:00:00Z',
      })],
    } as never);

    expect(store.status('A')).toBe('failed');
    expect(store.status('B')).toBe('skipped');
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'A');
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('a dependent that was released since the rows were read is not skipped; the rest of the failure still applies', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'released', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      { sub_issue_id: 'C', depends_on: ['A'], child_status: 'blocked' },
    ]);
    store.before(
      (cmd) => cmd._type === 'Update' && (cmd.input.Key as { sub_issue_id: string }).sub_issue_id === 'B',
      () => { store.row('B').child_status = 'released'; },
    );
    await handler(lateFailure());

    expect(store.status('A')).toBe('failed');
    expect(store.status('B')).toBe('released');
    expect(store.status('C')).toBe('skipped');
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'A');
  });
});

describe('orchestration-reconciler handler — the issue of a failed sub-issue and the time of the write (#1073)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
  });

  const ENDED = '2026-11-24T10:00:00Z';
  const DAY = 24 * 3600;
  const after = (seconds: number) => new Date(Date.parse(ENDED) + seconds * 1000).toISOString();
  const childA = (row: { child_status: string; unsettled_task_id?: string }, meta: StoreRow = {}) =>
    orchestrationStore([{ sub_issue_id: 'A', child_task_id: 'TA', ...row }], meta);
  const write = (seconds: number, times: { completed_at?: string; updated_at?: string } = { completed_at: ENDED }) => ({
    Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1', written_at: after(seconds), ...times })],
  }) as never;
  const settled = () => [revertIssueToNotStartedMock, swapIssueReactionMock]
    .map((mock) => mock.mock.calls.filter((call) => call[1] === 'A').length);
  const isMarkWrite = (cmd: StoreCommand) => String(cmd.input.UpdateExpression).includes('unsettled_task_id');
  const markWrites = () => ddbSend.mock.calls.map(([cmd]) => cmd as StoreCommand).filter(isMarkWrite).map((cmd) => cmd.input);
  const OWED = 'Settle of a failed child did not land: owed to the next record of its task';
  const NO_LONGER_OWED = 'Settle of a failed child is no longer owed';
  const MARK_NOT_WRITTEN = 'Could not record whether the settle of a failed child is owed (non-fatal)';
  const LAST_TRY_DID_NOT_LAND = 'Settle of a failed child did not land on its last try: its issue can contradict the graph';
  const IDS = { orchestration_id: 'orch_1', sub_issue_id: 'A', task_id: 'TA' };

  test('the write that ends the task settles the issue, the next one 30 s later settles it again, one made days later does not', async () => {
    const store = childA({ child_status: 'released' });
    revertIssueToNotStartedMock.mockResolvedValueOnce(true).mockResolvedValue(false);

    await handler(write(0));
    expect(settled()).toEqual([1, 1]);
    await handler(write(30));
    expect(settled()).toEqual([2, 2]);
    await handler(write(3 * DAY));
    expect(settled()).toEqual([2, 2]);

    expect(store.status('A')).toBe('failed');
    expect(markWrites()).toEqual([]);
    expect(loggerMock.info).toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, {
      orchestration_id: 'orch_1',
      sub_issue_id: 'A',
      task_id: 'TA',
      completed_at: ENDED,
      written_at: after(3 * DAY),
      brought_verdict: false,
    });
    expect(loggerMock.warn).not.toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, expect.anything());
  });

  test.each([
    ['exactly five minutes after the end is not late: the issue is settled', 300, [1, 1]],
    // The stream stamps the write in whole seconds.
    ['five minutes and one second after the end is late: the issue is left alone', 301, [0, 0]],
  ])('a record written %s', async (_name, seconds, expected) => {
    childA({ child_status: 'failed' });
    await handler(write(seconds));

    expect(settled()).toEqual(expected);
  });

  test.each([
    ['no time of its write', undefined],
    // The stream writes a number of seconds. Some tools turn it into a date string.
    ['a date string for the time of its write', after(0)],
    ['null for the time of its write', null],
  ])('a record with completed_at and %s is judged by the row: it settles the issue when it brings the verdict and leaves it alone once the row holds it', async (_name, stamp) => {
    const store = childA({ child_status: 'released' });
    const record = taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1', completed_at: ENDED });
    if (stamp !== undefined) Object.assign(record.dynamodb!, { ApproximateCreationDateTime: stamp });

    await handler({ Records: [record] } as never);
    expect(store.status('A')).toBe('failed');
    expect(settled()).toEqual([1, 1]);

    await handler({ Records: [record] } as never);
    expect(settled()).toEqual([1, 1]);
    expect(loggerMock.info).toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, { ...IDS, completed_at: ENDED, written_at: null, brought_verdict: false });
  });

  test('a time of its write that comes as text is read as the number of seconds it is', async () => {
    // The example record of the Lambda guide on event filtering carries the stamp as "1678831218.0".
    childA({ child_status: 'failed' });
    const written = (seconds: number) => {
      const record = taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1', completed_at: ENDED });
      Object.assign(record.dynamodb!, { ApproximateCreationDateTime: `${Date.parse(after(seconds)) / 1000}.0` });
      return { Records: [record] } as never;
    };

    await handler(written(30));
    expect(settled()).toEqual([1, 1]);
    await handler(written(301));
    expect(settled()).toEqual([1, 1]);
  });

  test('a record without completed_at leaves the issue alone once the row holds the verdict, also when its write moved updated_at', async () => {
    childA({ child_status: 'failed' });
    await handler(write(3 * DAY, { updated_at: after(3 * DAY) }));

    expect(settled()).toEqual([0, 0]);
    expect(loggerMock.info).toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, expect.objectContaining({
      completed_at: null,
      written_at: after(3 * DAY),
      brought_verdict: false,
    }));
  });

  test('a late record that carries neither time is logged with null for both', async () => {
    childA({ child_status: 'failed' });
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })] } as never);

    expect(settled()).toEqual([0, 0]);
    expect(loggerMock.info).toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, { ...IDS, completed_at: null, written_at: null, brought_verdict: false });
  });

  test('a completed_at that is not a time counts as none: the row decides, not the time of the write', async () => {
    childA({ child_status: 'failed' });
    await handler(write(30, { completed_at: 'not a time' }));

    expect(settled()).toEqual([0, 0]);
  });

  test('a record without completed_at settles the issue when it is the one that brings the verdict to the row', async () => {
    const store = childA({ child_status: 'released' });
    await handler(write(3 * DAY, { updated_at: after(3 * DAY) }));

    expect(store.status('A')).toBe('failed');
    expect(settled()).toEqual([1, 1]);
  });

  test('a settle that did not land is owed: the next write settles the issue however late it is, and the one after it leaves the issue alone', async () => {
    const store = childA({ child_status: 'released' });
    revertIssueToNotStartedMock.mockResolvedValue(false);
    swapIssueReactionMock.mockResolvedValue(false);
    await handler(write(0));
    await handler(write(30));
    expect(settled()).toEqual([2, 2]);
    expect(store.row('A').unsettled_task_id).toBe('TA');
    expect(loggerMock.warn).toHaveBeenCalledWith(OWED, IDS);

    revertIssueToNotStartedMock.mockResolvedValue(true);
    swapIssueReactionMock.mockResolvedValue(true);
    await handler(write(3 * DAY));
    expect(settled()).toEqual([3, 3]);
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
    expect(loggerMock.info).toHaveBeenCalledWith(NO_LONGER_OWED, IDS);
    expect(loggerMock.info).not.toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, expect.anything());
    expect(loggerMock.warn).not.toHaveBeenCalledWith(LAST_TRY_DID_NOT_LAND, expect.anything());

    await handler(write(4 * DAY));
    expect(settled()).toEqual([3, 3]);

    const row = { TableName: 'OrchestrationTable', Key: { orchestration_id: 'orch_1', sub_issue_id: 'A' } };
    expect(markWrites()).toEqual([
      {
        ...row,
        UpdateExpression: 'SET unsettled_task_id = :tid',
        ConditionExpression: 'child_task_id = :tid',
        ExpressionAttributeValues: { ':tid': 'TA' },
      },
      {
        ...row,
        UpdateExpression: 'REMOVE unsettled_task_id',
        ConditionExpression: 'unsettled_task_id = :tid',
        ExpressionAttributeValues: { ':tid': 'TA' },
      },
    ]);
  });

  test('a try inside the window that lands removes the mark: a later write leaves the issue alone', async () => {
    const store = childA({ child_status: 'released' });
    swapIssueReactionMock.mockResolvedValueOnce(false);
    await handler(write(0));
    expect(store.row('A').unsettled_task_id).toBe('TA');

    await handler(write(30));
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
    await handler(write(3 * DAY));
    expect(settled()).toEqual([2, 2]);
  });

  test.each([
    ['the tracker is still down', false],
    ['a marker stays that cannot be removed', true],
  ])('a late try is the last one whatever the surface answers (%s): a warning says that it did not land', async (_name, reverted) => {
    const store = childA({ child_status: 'failed', unsettled_task_id: 'TA' });
    revertIssueToNotStartedMock.mockResolvedValue(reverted);
    swapIssueReactionMock.mockResolvedValue(false);
    await handler(write(3 * DAY));
    expect(settled()).toEqual([1, 1]);
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
    expect(loggerMock.warn).toHaveBeenCalledWith(LAST_TRY_DID_NOT_LAND, { ...IDS, state_reverted: reverted });

    await handler(write(4 * DAY));
    expect(settled()).toEqual([1, 1]);
  });

  test.each([
    ['the state call', revertIssueToNotStartedMock, [1, 0], [2, 1]],
    ['the reaction call', swapIssueReactionMock, [1, 1], [2, 2]],
  ])('a throw of %s inside the window leaves the settle owed, and the next try makes both calls', async (_name, call, first, second) => {
    const store = childA({ child_status: 'released' });
    call.mockRejectedValueOnce(new Error('surface unavailable'));
    await handler(write(0));
    expect(settled()).toEqual(first);
    expect(store.row('A').unsettled_task_id).toBe('TA');
    expect(loggerMock.warn).not.toHaveBeenCalledWith(LAST_TRY_DID_NOT_LAND, expect.anything());

    await handler(write(3 * DAY));
    expect(settled()).toEqual(second);
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
  });

  test.each([
    ['the state call', revertIssueToNotStartedMock, [1, 0], null],
    ['the reaction call', swapIssueReactionMock, [1, 1], true],
    ['the reaction call, after a state call that moved nothing,', swapIssueReactionMock, [1, 1], false],
  ])('a late try is the last one also when %s throws: the mark is removed, a warning says that it did not land, and the next late write leaves the issue alone', async (_name, call, calls, stateReverted) => {
    const store = childA({ child_status: 'failed', unsettled_task_id: 'TA' });
    if (stateReverted === false) revertIssueToNotStartedMock.mockResolvedValue(false);
    call.mockRejectedValue(new Error('surface unavailable'));
    await handler(write(3 * DAY));
    expect(settled()).toEqual(calls);
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
    expect(loggerMock.warn).toHaveBeenCalledWith(LAST_TRY_DID_NOT_LAND, { ...IDS, state_reverted: stateReverted });

    await handler(write(4 * DAY));
    expect(settled()).toEqual(calls);
  });

  test('a mark that names another task is not this task\'s: a late write leaves the issue alone', async () => {
    const store = childA({ child_status: 'failed', unsettled_task_id: 'T-earlier' });
    await handler(write(3 * DAY));

    expect(settled()).toEqual([0, 0]);
    expect(store.row('A').unsettled_task_id).toBe('T-earlier');
  });

  test.each([
    ['repaired by a comment', 'succeeded'],
    ['skipped again after a retry of its predecessor', 'skipped'],
  ])('a settle that is owed is not tried once the sub-issue was %s: the task no longer decides its row', async (_name, status) => {
    const store = childA({ child_status: status, unsettled_task_id: 'TA' });
    await handler(write(3 * DAY));

    expect(settled()).toEqual([0, 0]);
    expect(store.row('A').unsettled_task_id).toBe('TA');
  });

  test('a surface without a reaction on the issue owes nothing', async () => {
    childA({ child_status: 'released' }, { channel_source: 'jira' });
    await handler(write(0));

    expect(markWrites()).toEqual([]);
  });

  test('a surface that has neither call is not logged as left alone: the step does nothing there for any record', async () => {
    childA({ child_status: 'released' }, { channel_source: 'jira' });
    await handler(write(6 * 60));
    await handler(write(3 * DAY));

    expect(loggerMock.warn).not.toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, expect.anything());
    expect(loggerMock.info).not.toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, expect.anything());
  });

  test.each<[string, Partial<Channel>]>([
    ['the state call alone', { revertState: () => Promise.resolve(true) }],
    ['the reaction call alone', { replaceIssueReaction: () => Promise.resolve(true) }],
  ])('a surface that has %s is logged as left alone, like one that has both', async (_name, calls) => {
    const restore = registerChannelFactory('jira', () => ({
      kind: 'another-tracker',
      postComment: () => Promise.resolve(null),
      upsertComment: () => Promise.resolve({ commentId: 'panel-1' }),
      reportFailure: () => Promise.resolve(),
      ...calls,
    }));
    try {
      childA({ child_status: 'failed' }, { channel_source: 'jira' });
      await handler(write(3 * DAY));
    } finally {
      restore();
    }

    expect(loggerMock.info).toHaveBeenCalledWith(LEFT_ALONE_AS_LATE, expect.objectContaining({ brought_verdict: false }));
  });

  test('a mark that cannot be written is a warning: the record is processed to its end and not reported for retry', async () => {
    const store = childA({ child_status: 'released' });
    swapIssueReactionMock.mockResolvedValue(false);
    store.before(isMarkWrite, () => { throw new Error('table unavailable'); });
    const record = taskRecord({
      task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1', completed_at: ENDED, written_at: ENDED,
    });

    await expect(handler({ Records: [record] } as never)).resolves.toEqual({ batchItemFailures: [] });

    expect(loggerMock.warn).toHaveBeenCalledWith(MARK_NOT_WRITTEN, { ...IDS, owed: true, error: 'table unavailable' });
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
    expect(upsertStatusCommentMock).toHaveBeenCalledTimes(1);
  });

  test('a mark that cannot be removed stays: a warning, no retry of the record, and the next late write tries once more', async () => {
    const store = childA({ child_status: 'failed', unsettled_task_id: 'TA' });
    store.before(isMarkWrite, () => { throw new Error('table unavailable'); });
    const record = taskRecord({
      task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1', completed_at: ENDED, written_at: after(3 * DAY),
    });

    await expect(handler({ Records: [record] } as never)).resolves.toEqual({ batchItemFailures: [] });

    expect(settled()).toEqual([1, 1]);
    expect(loggerMock.warn).toHaveBeenCalledWith(MARK_NOT_WRITTEN, { ...IDS, owed: false, error: 'table unavailable' });
    expect(store.row('A').unsettled_task_id).toBe('TA');

    await handler(write(4 * DAY));
    expect(settled()).toEqual([2, 2]);
    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
  });

  test('the mark is not set on a row that was released again while the surface was called', async () => {
    const store = childA({ child_status: 'released' });
    swapIssueReactionMock.mockResolvedValue(false);
    store.before(isMarkWrite, () => Object.assign(store.row('A'), { child_status: 'released', child_task_id: 'T2' }));
    await handler(write(0));

    expect(store.row('A')).not.toHaveProperty('unsettled_task_id');
    expect(loggerMock.warn).not.toHaveBeenCalledWith(OWED, expect.anything());
    expect(loggerMock.warn).not.toHaveBeenCalledWith(MARK_NOT_WRITTEN, expect.anything());
  });

  test('a mark that has become another task\'s since the row was read is not removed', async () => {
    const store = childA({ child_status: 'failed', unsettled_task_id: 'TA' });
    store.before(isMarkWrite, () => Object.assign(store.row('A'), { child_task_id: 'T2', unsettled_task_id: 'T2' }));
    await handler(write(3 * DAY));

    expect(settled()).toEqual([1, 1]);
    expect(store.row('A').unsettled_task_id).toBe('T2');
    expect(loggerMock.info).not.toHaveBeenCalledWith(NO_LONGER_OWED, expect.anything());
    expect(loggerMock.warn).not.toHaveBeenCalledWith(MARK_NOT_WRITTEN, expect.anything());
  });
});

describe('orchestration-reconciler handler — an iteration on a failed sub-issue', () => {
  const SETTLED_AT = '2026-01-01T00:00:00.000Z';
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 201, body: JSON.stringify({ data: { task_id: 'T-new', branch_name: 'branch-new' } }),
    });
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
  });

  const settledWithFailure = () => orchestrationStore([
    { sub_issue_id: 'A', child_status: 'failed', child_task_id: 'TA', child_branch_name: 'branch-A' },
    { sub_issue_id: 'B', depends_on: ['A'], child_status: 'skipped' },
  ], { rollup_posted_at: SETTLED_AT });
  const iteration = (codeChanged?: boolean) => ({
    Records: [taskRecord({
      task_id: 'TI',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A',
      orchestration_iteration: true,
      ...(codeChanged !== undefined && { code_changed: codeChanged }),
    })],
  }) as never;

  test.each([
    ['pushed a commit', true],
    ['comes from an agent that does not say whether it pushed', undefined],
  ])('one that %s recovers the node, starts its skipped dependent and re-opens the epic', async (_name, codeChanged) => {
    const store = settledWithFailure();
    await handler(iteration(codeChanged));

    expect(store.status('A')).toBe('succeeded');
    expect(store.status('B')).toBe('released');
    expect(store.meta.rollup_posted_at).toBeUndefined();
  });

  test('one that only answered a question leaves the node failed, its dependent skipped and the epic settled', async () => {
    const store = settledWithFailure();
    await handler(iteration(false));

    expect(store.status('A')).toBe('failed');
    expect(store.status('B')).toBe('skipped');
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    expect(store.meta.rollup_posted_at).toBe(SETTLED_AT);
  });
});

describe('orchestration-reconciler handler — the once-only claim of the final status', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    swapCommentReactionMock.mockReset().mockResolvedValue(true);
  });

  const lastChildCompleted = () => ({
    Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })],
  }) as never;
  const lastChild = [{ sub_issue_id: 'A', child_status: 'released', child_task_id: 'TA' }];
  const parentSettled = () => [
    transitionIssueStateMock.mock.calls.some((c) => c[1] === 'PARENT'),
    swapIssueReactionMock.mock.calls.some((c) => c[1] === 'PARENT' && c[2] === 'white_check_mark'),
  ];

  test('a final panel edit that fails gives the claim back, and the next settle posts the final status', async () => {
    const store = orchestrationStore(lastChild);
    upsertStatusCommentMock.mockResolvedValueOnce(null);
    transitionIssueStateMock.mockResolvedValueOnce(false);
    swapIssueReactionMock.mockResolvedValueOnce(false);

    await handler(lastChildCompleted());
    expect(store.meta.rollup_posted_at).toBeUndefined();

    transitionIssueStateMock.mockClear();
    swapIssueReactionMock.mockClear();
    await handler(lastChildCompleted());
    expect(store.meta.rollup_posted_at).toEqual(expect.any(String));
    expect(upsertStatusCommentMock.mock.calls.at(-1)![2]).toContain('✅ **ABCA orchestration complete**');
    expect(parentSettled()).toEqual([true, true]);
  });

  test('a final panel edit that lands keeps the claim: a later settle leaves the parent alone', async () => {
    const store = orchestrationStore(lastChild);
    await handler(lastChildCompleted());
    const stamp = store.meta.rollup_posted_at;
    expect(stamp).toEqual(expect.any(String));
    expect(parentSettled()).toEqual([true, true]);

    transitionIssueStateMock.mockClear();
    swapIssueReactionMock.mockClear();
    await handler(lastChildCompleted());
    expect(store.meta.rollup_posted_at).toBe(stamp);
    expect(parentSettled()).toEqual([false, false]);
  });

  test('a settle that arrives while the failing one holds the claim leaves the parent to the next one', async () => {
    const store = orchestrationStore(lastChild);
    let secondSettledTheParent: boolean[] = [];
    upsertStatusCommentMock.mockImplementationOnce(async () => {
      await handler(lastChildCompleted());
      secondSettledTheParent = parentSettled();
      return null;
    });
    transitionIssueStateMock.mockResolvedValueOnce(false);
    swapIssueReactionMock.mockResolvedValueOnce(false);

    await handler(lastChildCompleted());
    expect(secondSettledTheParent).toEqual([false, false]);
    expect(store.meta.rollup_posted_at).toBeUndefined();

    transitionIssueStateMock.mockClear();
    swapIssueReactionMock.mockClear();
    await handler(lastChildCompleted());
    expect(store.meta.rollup_posted_at).toEqual(expect.any(String));
    expect(parentSettled()).toEqual([true, true]);
  });

  test('a claim that another settle has taken since is not given back', async () => {
    const store = orchestrationStore(lastChild);
    upsertStatusCommentMock.mockResolvedValueOnce(null);
    store.before(
      (cmd) => cmd._type === 'Update' && String(cmd.input.UpdateExpression).includes('REMOVE rollup_posted_at'),
      () => { store.meta.rollup_posted_at = 'stamp-of-the-later-settle'; },
    );

    await handler(lastChildCompleted());
    expect(store.meta.rollup_posted_at).toBe('stamp-of-the-later-settle');
  });

  test('a settle that lost the claim leaves it alone, even when it carries the timestamp of the winner', async () => {
    const store = orchestrationStore([{ sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'TA' }]);
    const now = '2026-06-09T12:00:00.000Z';
    const settle = () => refreshPanelAndSettle(
      'orch_1',
      [{
        orchestration_id: 'orch_1',
        sub_issue_id: 'A',
        parent_issue_ref: 'PARENT',
        credentials_ref: 'WS',
        repo: 'o/r',
        depends_on: [],
        child_status: 'succeeded',
        child_task_id: 'TA',
        created_at: now,
        updated_at: now,
      }],
      { credentials_ref: 'WS', parent_issue_ref: 'PARENT', status_comment_id: 'panel-1' },
      now,
    );

    await settle();
    upsertStatusCommentMock.mockResolvedValueOnce(null);
    await settle();

    expect(store.meta.rollup_posted_at).toBe(now);
  });

  test('an epic whose panel has no comment yet keeps the claim', async () => {
    const store = orchestrationStore(lastChild, { status_comment_id: undefined });
    upsertStatusCommentMock.mockResolvedValueOnce(null);

    await handler(lastChildCompleted());
    expect(store.meta.rollup_posted_at).toEqual(expect.any(String));
  });

  test('a claim that cannot be given back does not fail the record', async () => {
    const store = orchestrationStore(lastChild);
    upsertStatusCommentMock.mockResolvedValueOnce(null);
    store.before(
      (cmd) => cmd._type === 'Update' && String(cmd.input.UpdateExpression).includes('REMOVE rollup_posted_at'),
      () => { throw new Error('throttled'); },
    );

    const result = await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1', sequenceNumber: 'seq-1' })],
    } as never);
    expect(result.batchItemFailures).toEqual([]);
    expect(store.meta.rollup_posted_at).toEqual(expect.any(String));
  });

  test('the retry comment gets its outcome from the settle that lands, not from the one that failed', async () => {
    const store = orchestrationStore(lastChild, { retry_comment_id: 'retry-cmt-1' });
    upsertStatusCommentMock.mockResolvedValueOnce(null);

    await handler(lastChildCompleted());
    expect(swapCommentReactionMock).not.toHaveBeenCalled();
    expect(store.meta.retry_comment_id).toBe('retry-cmt-1');

    await handler(lastChildCompleted());
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'retry-cmt-1', 'white_check_mark');
    expect(store.meta.retry_comment_id).toBeUndefined();
  });

  describe('for one day after the epic ended', () => {
    const ENDED = Date.parse('2026-06-08T12:00:00.000Z');
    const settleAfter = (store: ReturnType<typeof orchestrationStore>, minutes: number, reopenedAt?: string) => {
      const now = new Date(ENDED + minutes * 60_000).toISOString();
      return refreshPanelAndSettle(
        'orch_1',
        [{
          orchestration_id: 'orch_1',
          sub_issue_id: 'A',
          parent_issue_ref: 'PARENT',
          credentials_ref: 'WS',
          repo: 'o/r',
          depends_on: [],
          child_status: 'succeeded',
          child_task_id: 'TA',
          created_at: new Date(ENDED).toISOString(),
          updated_at: new Date(ENDED).toISOString(),
        }],
        {
          credentials_ref: 'WS',
          parent_issue_ref: 'PARENT',
          status_comment_id: 'panel-1',
          ...(typeof store.meta.retry_comment_id === 'string' && { retry_comment_id: store.meta.retry_comment_id }),
          ...(reopenedAt !== undefined && { updated_at: reopenedAt }),
        },
        now,
      ).then(() => now);
    };
    const finished = () => orchestrationStore(
      [{ sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'TA' }],
      { retry_comment_id: 'retry-cmt-1' },
    );

    test('a final edit that fails 25 hours after the end keeps the claim and answers the retry comment', async () => {
      const store = finished();
      upsertStatusCommentMock.mockResolvedValue(null);

      const now = await settleAfter(store, 25 * 60);

      expect(store.meta.rollup_posted_at).toBe(now);
      expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'retry-cmt-1', 'white_check_mark');
      expect(store.meta.retry_comment_id).toBeUndefined();
    });

    test('the sweep stops trying an edit that never lands', async () => {
      const store = finished();
      upsertStatusCommentMock.mockResolvedValue(null);

      for (const minutes of [10, 20, 23 * 60 + 50]) {
        await settleAfter(store, minutes);
        expect(store.meta.rollup_posted_at).toBeUndefined();
      }
      expect(swapCommentReactionMock).not.toHaveBeenCalled();

      const kept = await settleAfter(store, 24 * 60 + 10);
      expect(store.meta.rollup_posted_at).toBe(kept);
      expect(swapCommentReactionMock).toHaveBeenCalledTimes(1);

      transitionIssueStateMock.mockClear();
      swapIssueReactionMock.mockClear();
      await settleAfter(store, 24 * 60 + 20);
      expect(store.meta.rollup_posted_at).toBe(kept);
      expect(parentSettled()).toEqual([false, false]);
      expect(swapCommentReactionMock).toHaveBeenCalledTimes(1);
    });

    test('an epic that was re-opened since gets its claim back for a day after the re-open', async () => {
      const store = finished();
      upsertStatusCommentMock.mockResolvedValue(null);
      const reopened = new Date(ENDED + (48 * 60 - 10) * 60_000).toISOString();

      await settleAfter(store, 48 * 60, reopened);
      expect(store.meta.rollup_posted_at).toBeUndefined();
      expect(swapCommentReactionMock).not.toHaveBeenCalled();

      const kept = await settleAfter(store, 72 * 60, reopened);
      expect(store.meta.rollup_posted_at).toBe(kept);
      expect(swapCommentReactionMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('orchestration-reconciler handler — the reason shown for a failed sub-issue', () => {
  const REFUSED = "Couldn't start — a monthly budget is exhausted. Adjust the budget or wait for the next UTC "
    + 'month, then reply `@bgagent retry` on the epic to re-run.';
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({
      statusCode: 201, body: JSON.stringify({ data: { task_id: 'T2', branch_name: 'branch-2' } }),
    });
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
  });

  const event = (taskId: string, status: string) => ({
    Records: [taskRecord({ task_id: taskId, status, orchestration_id: 'orch_1' })],
  }) as never;
  const lastPanel = () => upsertStatusCommentMock.mock.calls.at(-1)![2] as string;

  test('after a retry that could not start, the panel says why, not how the earlier run failed', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'failed', child_task_id: 'T1', failure_reason: REFUSED },
    ]);
    store.tasks.set('T1', { task_id: 'T1', build_passed: false });

    await handler(event('TA', 'COMPLETED'));

    expect(lastPanel()).toContain('a monthly budget is exhausted');
    expect(lastPanel()).not.toContain('Build/tests failed');
  });

  test('a start that is refused in the pass that renders the panel is reported by that pass', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'released', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked', child_task_id: 'T1' },
    ]);
    store.tasks.set('T1', { task_id: 'T1', build_passed: false });
    createTaskCoreMock.mockResolvedValue({ statusCode: 429, body: '{"error":{"code":"BUDGET_EXCEEDED"}}' });

    await handler(event('TA', 'COMPLETED'));

    expect(store.row('B')).toMatchObject({ child_status: 'failed', child_task_id: 'T1', failure_reason: REFUSED });
    expect(lastPanel()).toContain('a monthly budget is exhausted');
    expect(lastPanel()).not.toContain('Build/tests failed');
  });

  test('a late event of the earlier task, processed while the retry is refused, shows the refusal', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'failed', child_task_id: 'T1' },
    ]);
    store.tasks.set('T1', { task_id: 'T1', build_passed: false });
    store.before((cmd) => cmd._type === 'Update', () => { store.row('B').failure_reason = REFUSED; });

    await handler(event('T1', 'FAILED'));

    expect(store.row('B')).toMatchObject({ child_status: 'failed', child_task_id: 'T1', failure_reason: REFUSED });
    expect(lastPanel()).toContain('a monthly budget is exhausted');
    expect(lastPanel()).not.toContain('Build/tests failed');
  });

  test('after a later retry that did start and then failed, the panel says how that run failed', async () => {
    const store = orchestrationStore([
      { sub_issue_id: 'A', child_status: 'released', child_task_id: 'TA' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked', child_task_id: 'T1', failure_reason: REFUSED },
    ]);
    store.tasks.set('T2', { task_id: 'T2', build_passed: false });

    await handler(event('TA', 'COMPLETED'));
    expect(store.row('B')).toMatchObject({ child_status: 'released', child_task_id: 'T2' });
    expect(store.row('B').failure_reason).toBeUndefined();
    await handler(event('T2', 'FAILED'));

    expect(store.status('B')).toBe('failed');
    expect(lastPanel()).toContain('Build/tests failed — see the build log in CloudWatch for task `T2`');
    expect(lastPanel()).not.toContain('a monthly budget is exhausted');
  });
});
