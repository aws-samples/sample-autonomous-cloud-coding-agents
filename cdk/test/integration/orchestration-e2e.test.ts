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

interface Stored { [k: string]: unknown }
const tables: Record<string, Map<string, Stored>> = {};

function pk(item: Stored): string {
  if (item.orchestration_id !== undefined && item.sub_issue_id !== undefined) {
    return `${item.orchestration_id}\u0000${item.sub_issue_id}`;
  }
  return String(item.task_id);
}
function keyOf(key: Stored): string {
  if (key.orchestration_id !== undefined && key.sub_issue_id !== undefined) {
    return `${key.orchestration_id}\u0000${key.sub_issue_id}`;
  }
  return String(key.task_id);
}

const fakeSend = jest.fn(async (cmd: { _type: string; input: Record<string, unknown> }) => {
  const { _type, input } = cmd;
  const tn = input.TableName as string;
  tables[tn] = tables[tn] ?? new Map();
  const t = tables[tn];

  if (_type === 'Put') {
    const item = input.Item as Stored;
    if (input.ConditionExpression === 'attribute_not_exists(task_id)' && t.has(pk(item))) {
      const e = new Error('conditional'); e.name = 'ConditionalCheckFailedException'; throw e;
    }
    t.set(pk(item), item);
    return {};
  }
  if (_type === 'Get') {
    return { Item: t.get(keyOf(input.Key as Stored)) };
  }
  if (_type === 'BatchWrite') {
    const ri = input.RequestItems as Record<string, Array<{ PutRequest: { Item: Stored } }>>;
    for (const [table, reqs] of Object.entries(ri)) {
      tables[table] = tables[table] ?? new Map();
      for (const r of reqs) tables[table].set(pk(r.PutRequest.Item), r.PutRequest.Item);
    }
    return {};
  }
  if (_type === 'Query') {
    if (input.IndexName === 'IdempotencyIndex') {
      const key = (input.ExpressionAttributeValues as Stored)[':key'];
      const items = [...t.values()].filter((i) => i.idempotency_key === key);
      return { Items: items };
    }
    if (input.IndexName === 'ChildTaskIndex') {
      const tid = (input.ExpressionAttributeValues as Stored)[':tid'];
      return { Items: [...t.values()].filter((i) => i.child_task_id === tid) };
    }
    const oid = (input.ExpressionAttributeValues as Stored)[':oid'];
    return { Items: [...t.values()].filter((i) => i.orchestration_id === oid) };
  }
  if (_type === 'Update') {
    const item = t.get(keyOf(input.Key as Stored));
    const vals = input.ExpressionAttributeValues as Stored;
    const cond = input.ConditionExpression as string | undefined;
    if (cond && item) {
      if (cond.includes('child_status IN')) {
        const ok = item.child_status === vals[':blocked'] || item.child_status === vals[':ready'];
        if (!ok) { const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e; }
      } else if (cond.includes('child_status <> :s')) {
        if (item.child_status === vals[':s']) { const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e; }
      }
    }
    const next: Stored = { ...(item ?? input.Key as Stored) };
    if (vals[':released'] !== undefined) {
      next.child_status = vals[':released'];
      next.child_task_id = vals[':tid'];
      if (vals[':bn'] !== undefined) next.child_branch_name = vals[':bn'];
    }
    if (vals[':s'] !== undefined) next.child_status = vals[':s'];
    if (vals[':now'] !== undefined) next.updated_at = vals[':now'];
    t.set(keyOf(input.Key as Stored), next);
    return {};
  }
  throw new Error(`fake DDB: unhandled command ${_type}`);
});

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: fakeSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ _type: 'BatchWrite', input })),
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const publishTaskMetricsMock = jest.fn();
jest.mock('../../src/handlers/scoreboard-metrics', () => ({
  publishTaskMetrics: (...args: unknown[]) => publishTaskMetricsMock(...args),
}));

process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEventsTable';
process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { handler as reconcilerHandler, parseTerminalTaskRecord } from '../../src/handlers/orchestration-reconciler';
import { createTaskCore } from '../../src/handlers/shared/create-task-core';
import { computeReconcilePlan } from '../../src/handlers/shared/orchestration-reconcile';
import { releaseReadyChildren, releaseChild } from '../../src/handlers/shared/orchestration-release';
import { seedOrchestration, loadOrchestration, type OrchestrationChildRow } from '../../src/handlers/shared/orchestration-store';

const ddb = DynamoDBDocumentClient.from({} as never);
const NOW = '2026-06-10T00:00:00.000Z';
const ORCH = 'OrchestrationTable';

function streamImageFor(taskId: string, status: string, buildPassed?: boolean) {
  const rec = tables.TaskTable?.get(taskId) as Record<string, unknown> | undefined;
  if (!rec) throw new Error(`no task record ${taskId}`);
  const img: Record<string, unknown> = {
    task_id: { S: rec.task_id },
    status: { S: status },
  };
  if (buildPassed !== undefined) img.build_passed = { BOOL: buildPassed };
  const cm = rec.channel_metadata as Record<string, string> | undefined;
  if (cm) {
    img.channel_metadata = { M: Object.fromEntries(Object.entries(cm).map(([k, v]) => [k, { S: v }])) };
  }
  return { eventName: 'MODIFY' as const, dynamodb: { NewImage: img as never } };
}

async function completeAndReconcile(taskId: string, status = 'COMPLETED', buildPassed = true): Promise<void> {
  const rec = tables.TaskTable.get(taskId) as Record<string, unknown>;
  rec.status = status;
  if (buildPassed !== undefined) rec.build_passed = buildPassed;
  const event: DynamoDBStreamEvent = {
    Records: [streamImageFor(taskId, status, buildPassed) as never],
  };
  await reconcilerHandler(event);
}

async function statuses(orchestrationId: string): Promise<Record<string, string>> {
  const snap = await loadOrchestration(ddb, ORCH, orchestrationId);
  return Object.fromEntries(snap!.children.map((c) => [c.sub_issue_id, c.child_status]));
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  fakeSend.mockClear();
  publishTaskMetricsMock.mockReset().mockResolvedValue(false);
});

describe('orchestration integration — real createTaskCore', () => {
  test('release → real task persisted → reconciler resolves it (the 3-bug path)', async () => {
    const children = [
      { id: 'a00650a1-uuid-aaaa', depends_on: [], identifier: 'ABCA-1', title: 'Step A' },
      { id: 'b11761b2-uuid-bbbb', depends_on: ['a00650a1-uuid-aaaa'], identifier: 'ABCA-2', title: 'Step B' },
    ];
    const seed = await seedOrchestration({
      ddb,
      tableName: ORCH,
      parentIssueRef: 'PARENT-ISSUE',
      credentialsRef: 'WS',
      repo: 'owner/repo',
      children,
      now: NOW,
      releaseContext: { platform_user_id: 'user-1' },
    });
    expect(seed.alreadyExisted).toBe(false);

    const snap = await loadOrchestration(ddb, ORCH, seed.orchestrationId);
    const results = await releaseReadyChildren(
      ddb, ORCH, snap!.children, snap!.meta.release_context, createTaskCore, NOW,
    );
    const released = results.filter((r) => r.kind === 'released');
    expect(released).toHaveLength(1);

    const aTaskId = (released[0] as { taskId: string }).taskId;
    expect(aTaskId).toBeTruthy();
    const aRec = tables.TaskTable.get(aTaskId) as Record<string, unknown>;
    expect(aRec).toBeDefined();
    expect(aRec.channel_source).toBe('linear');

    expect((aRec.channel_metadata as Record<string, string>).orchestration_id).toBe(seed.orchestrationId);
    expect(aRec.orchestration_id).toBeUndefined();

    const evt = parseTerminalTaskRecord(streamImageFor(aTaskId, 'COMPLETED', true) as never);
    expect(evt).not.toBeNull();
    expect(evt!.orchestrationId).toBe(seed.orchestrationId);

    const reloaded = await loadOrchestration(ddb, ORCH, seed.orchestrationId);
    const childView = reloaded!.children.map((c: OrchestrationChildRow) => ({
      sub_issue_id: c.sub_issue_id, depends_on: c.depends_on, child_status: c.child_status,
    }));
    const plan = computeReconcilePlan(
      { sub_issue_id: 'a00650a1-uuid-aaaa', status: 'COMPLETED', build_passed: true },
      childView,
    );
    expect(plan.toRelease).toEqual(['b11761b2-uuid-bbbb']);
  });

  test('idempotent replay: releasing the same child twice creates one task', async () => {
    const children = [{ id: 'c-uuid', depends_on: [], identifier: 'ABCA-9', title: 'Step C' }];
    const seed = await seedOrchestration({
      ddb,
      tableName: ORCH,
      parentIssueRef: 'P2',
      credentialsRef: 'WS',
      repo: 'owner/repo',
      children,
      now: NOW,
      releaseContext: { platform_user_id: 'user-1' },
    });
    const row = (await loadOrchestration(ddb, ORCH, seed.orchestrationId))!.children[0];

    const first = await releaseChild({ ddb, tableName: ORCH, row, platformUserId: 'user-1', createTaskCore, now: NOW });
    expect(first.kind).toBe('released');
    const second = await releaseChild({ ddb, tableName: ORCH, row, platformUserId: 'user-1', createTaskCore, now: NOW });
    expect(second.kind).toBe('already_released');

    const tasks = [...tables.TaskTable.values()];
    expect(tasks).toHaveLength(1);
  });

  async function seedAndReleaseRoots(
    parent: string,
    children: Array<{ id: string; depends_on: string[]; identifier?: string; title?: string }>,
  ): Promise<{ orchestrationId: string; taskIds: Record<string, string> }> {
    const seed = await seedOrchestration({
      ddb,
      tableName: ORCH,
      parentIssueRef: parent,
      credentialsRef: 'WS',
      repo: 'owner/repo',
      children,
      now: NOW,
      releaseContext: { platform_user_id: 'user-1' },
    });
    const snap = await loadOrchestration(ddb, ORCH, seed.orchestrationId);
    const results = await releaseReadyChildren(
      ddb, ORCH, snap!.children, snap!.meta.release_context, createTaskCore, NOW,
    );
    const taskIds: Record<string, string> = {};
    const after = await loadOrchestration(ddb, ORCH, seed.orchestrationId);
    for (const c of after!.children) {
      if (c.child_task_id) taskIds[c.sub_issue_id] = c.child_task_id;
    }
    void results;
    return { orchestrationId: seed.orchestrationId, taskIds };
  }

  test('webhook replay end-to-end: re-seeding the same parent creates no duplicate children/tasks', async () => {
    const children = [
      { id: 'r-a', depends_on: [], identifier: 'ABCA-1', title: 'A' },
      { id: 'r-b', depends_on: ['r-a'], identifier: 'ABCA-2', title: 'B' },
    ];
    const first = await seedAndReleaseRoots('REPLAY-PARENT', children);
    const tasksAfterFirst = [...tables.TaskTable.values()].length;

    const seed2 = await seedOrchestration({
      ddb,
      tableName: ORCH,
      parentIssueRef: 'REPLAY-PARENT',
      credentialsRef: 'WS',
      repo: 'owner/repo',
      children,
      now: NOW,
      releaseContext: { platform_user_id: 'user-1' },
    });
    expect(seed2.alreadyExisted).toBe(true);
    expect(seed2.orchestrationId).toBe(first.orchestrationId);
    const snap = await loadOrchestration(ddb, ORCH, first.orchestrationId);
    await releaseReadyChildren(ddb, ORCH, snap!.children, snap!.meta.release_context, createTaskCore, NOW);

    expect([...tables.TaskTable.values()].length).toBe(tasksAfterFirst);
    const rows = [...tables.OrchestrationTable.values()].filter((r) => r.orchestration_id === first.orchestrationId);
    expect(rows.filter((r) => r.sub_issue_id !== '#meta')).toHaveLength(2);
  });

  test('diamond timing (wired): D releases only after BOTH B and C succeed', async () => {
    const children = [
      { id: 'd-a', depends_on: [], identifier: 'A', title: 'A' },
      { id: 'd-b', depends_on: ['d-a'], identifier: 'B', title: 'B' },
      { id: 'd-c', depends_on: ['d-a'], identifier: 'C', title: 'C' },
      { id: 'd-d', depends_on: ['d-b', 'd-c'], identifier: 'D', title: 'D' },
    ];
    const { orchestrationId, taskIds } = await seedAndReleaseRoots('DIAMOND', children);

    await completeAndReconcile(taskIds['d-a']);
    let st = await statuses(orchestrationId);
    expect(st['d-b']).toBe('released');
    expect(st['d-c']).toBe('released');
    expect(st['d-d']).toBe('blocked');

    const t2 = await loadOrchestration(ddb, ORCH, orchestrationId);
    const bTask = t2!.children.find((c) => c.sub_issue_id === 'd-b')!.child_task_id!;
    await completeAndReconcile(bTask);
    st = await statuses(orchestrationId);
    expect(st['d-d']).toBe('blocked');

    const cTask = t2!.children.find((c) => c.sub_issue_id === 'd-c')!.child_task_id!;
    await completeAndReconcile(cTask);
    st = await statuses(orchestrationId);
    expect(st['d-d']).toBe('released');
  });

  test('build_passed=false (wired): a built-but-broken root skips its dependent', async () => {
    const children = [
      { id: 'bp-a', depends_on: [], identifier: 'A', title: 'A' },
      { id: 'bp-b', depends_on: ['bp-a'], identifier: 'B', title: 'B' },
    ];
    const { orchestrationId, taskIds } = await seedAndReleaseRoots('BUILDFAIL', children);

    await completeAndReconcile(taskIds['bp-a'], 'COMPLETED', false);
    const st = await statuses(orchestrationId);
    expect(st['bp-a']).toBe('failed');
    expect(st['bp-b']).toBe('skipped');
    const bRows = [...tables.OrchestrationTable.values()].find((r) => r.sub_issue_id === 'bp-b');
    expect(bRows?.child_task_id).toBeUndefined();
  });

  test.failing('concurrent predecessors (wired): two terminal events racing the same dependent release it once', async () => {
    const children = [
      { id: 'cc-b', depends_on: [], identifier: 'B', title: 'B' },
      { id: 'cc-c', depends_on: [], identifier: 'C', title: 'C' },
      { id: 'cc-d', depends_on: ['cc-b', 'cc-c'], identifier: 'D', title: 'D' },
    ];
    const { orchestrationId, taskIds } = await seedAndReleaseRoots('CONCURRENT', children);

    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- fixed 2-element array (two named children), not input-derived
    await Promise.all([
      completeAndReconcile(taskIds['cc-b']),
      completeAndReconcile(taskIds['cc-c']),
    ]);

    const st = await statuses(orchestrationId);
    expect(st['cc-d']).toBe('released');
    const dTasks = [...tables.TaskTable.values()].filter(
      (t) => (t.channel_metadata as Record<string, string>)?.orchestration_sub_issue_id === 'cc-d',
    );
    expect(dTasks).toHaveLength(1);
  });

  function taskForSub(sub: string): Record<string, unknown> | undefined {
    return [...tables.TaskTable.values()].find(
      (t) => (t.channel_metadata as Record<string, string>)?.orchestration_sub_issue_id === sub,
    );
  }

  test('linear chain: dependent child stacks on its predecessor branch', async () => {
    const children = [
      { id: 'lin-a', depends_on: [], identifier: 'A', title: 'A' },
      { id: 'lin-b', depends_on: ['lin-a'], identifier: 'B', title: 'B' },
    ];
    const { taskIds } = await seedAndReleaseRoots('A4-LINEAR', children);

    const aBranch = tables.TaskTable.get(taskIds['lin-a'])!.branch_name as string;
    expect(aBranch).toBeTruthy();

    await completeAndReconcile(taskIds['lin-a']);

    const bTask = taskForSub('lin-b')!;
    const cm = bTask.channel_metadata as Record<string, string>;
    expect(cm.orchestration_base_branch).toBe(aBranch);
    expect(cm.orchestration_merge_branches).toBeUndefined();
  });

  test('diamond: child branches off main + merges both predecessor branches', async () => {
    const children = [
      { id: 'dia-b', depends_on: [], identifier: 'B', title: 'B' },
      { id: 'dia-c', depends_on: [], identifier: 'C', title: 'C' },
      { id: 'dia-d', depends_on: ['dia-b', 'dia-c'], identifier: 'D', title: 'D' },
    ];
    const { taskIds } = await seedAndReleaseRoots('A4-DIAMOND', children);
    const bBranch = tables.TaskTable.get(taskIds['dia-b'])!.branch_name as string;
    const cBranch = tables.TaskTable.get(taskIds['dia-c'])!.branch_name as string;

    await completeAndReconcile(taskIds['dia-b']);
    await completeAndReconcile(taskIds['dia-c']);

    const dTask = taskForSub('dia-d')!;
    const cm = dTask.channel_metadata as Record<string, string>;
    expect(cm.orchestration_base_branch).toBe('main');
    expect(JSON.parse(cm.orchestration_merge_branches)).toEqual([bBranch, cBranch].sort());
  });

  test('root child carries no stacked base (branches off main)', async () => {
    const children = [{ id: 'root-x', depends_on: [], identifier: 'X', title: 'X' }];
    await seedAndReleaseRoots('A4-ROOT', children);
    const cm = taskForSub('root-x')!.channel_metadata as Record<string, string>;
    expect(cm.orchestration_base_branch).toBeUndefined();
    expect(cm.orchestration_merge_branches).toBeUndefined();
  });
});
