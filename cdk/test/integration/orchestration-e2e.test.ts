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

/**
 * Orchestration integration test — sub-issue graph declared on the parent issue.
 *
 * Drives the REAL release/reconcile path against a stateful in-memory
 * DynamoDB fake and the REAL ``createTaskCore`` — NOT a mock of it. The
 * unit tests mock createTaskCore, which is exactly why the first dev
 * smoke shipped three bugs they couldn't catch:
 *   1. idempotency key with '#' rejected by createTaskCore's validator,
 *   2. orchestration_id persisted under nested ``channel_metadata`` (not
 *      top-level) so the reconciler's stream parse missed it,
 *   3. (memory OOM — runtime-only, not coverable here).
 *
 * This test exercises: seedOrchestration → releaseReadyChildren →
 * createTaskCore (real) → persisted TaskRecord → simulate the TaskTable
 * stream image → parseTerminalTaskRecord → computeReconcilePlan, and
 * asserts the round-trips the bugs broke.
 *
 * The fake implements just enough DynamoDB DocumentClient semantics
 * (Put/Get/Query/Update with a ConditionExpression subset + the
 * IdempotencyIndex GSI) for these handlers. It is deliberately in this
 * file (not shared) — it tracks exactly what these code paths use.
 */

// ── In-memory DynamoDB DocumentClient fake ───────────────────────────
interface Stored { [k: string]: unknown }
const tables: Record<string, Map<string, Stored>> = {};

function pk(item: Stored): string {
  // Composite key support: TaskTable uses task_id; OrchestrationTable
  // uses orchestration_id + sub_issue_id.
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
    // IdempotencyIndex GSI on TaskTable.
    if (input.IndexName === 'IdempotencyIndex') {
      const key = (input.ExpressionAttributeValues as Stored)[':key'];
      const items = [...t.values()].filter((i) => i.idempotency_key === key);
      return { Items: items };
    }
    // ChildTaskIndex GSI on OrchestrationTable.
    if (input.IndexName === 'ChildTaskIndex') {
      const tid = (input.ExpressionAttributeValues as Stored)[':tid'];
      return { Items: [...t.values()].filter((i) => i.child_task_id === tid) };
    }
    // loadOrchestration: query by orchestration_id partition.
    const oid = (input.ExpressionAttributeValues as Stored)[':oid'];
    return { Items: [...t.values()].filter((i) => i.orchestration_id === oid) };
  }
  if (_type === 'Update') {
    const item = t.get(keyOf(input.Key as Stored));
    const vals = input.ExpressionAttributeValues as Stored;
    // Evaluate the two ConditionExpressions our code uses.
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
    // Minimal SET parser for the expressions our code issues.
    if (vals[':released'] !== undefined) {
      next.child_status = vals[':released'];
      next.child_task_id = vals[':tid'];
      // The release flip also persists the child's branch_name.
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

// Env: no guardrail, no repo table (lookupRepo → onboarded:true), no
// orchestrator invoke. Keeps createTaskCore on its pure validate+persist
// path so the integration stays hermetic.
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

/** Build the TaskTable stream NewImage for a persisted task record. */
function streamImageFor(taskId: string, status: string, buildPassed?: boolean) {
  const rec = tables.TaskTable?.get(taskId) as Record<string, unknown> | undefined;
  if (!rec) throw new Error(`no task record ${taskId}`);
  const img: Record<string, unknown> = {
    task_id: { S: rec.task_id },
    status: { S: status },
  };
  if (buildPassed !== undefined) img.build_passed = { BOOL: buildPassed };
  // Mirror how the Document client marshals the nested channel_metadata MAP.
  const cm = rec.channel_metadata as Record<string, string> | undefined;
  if (cm) {
    img.channel_metadata = { M: Object.fromEntries(Object.entries(cm).map(([k, v]) => [k, { S: v }])) };
  }
  return { eventName: 'MODIFY' as const, dynamodb: { NewImage: img as never } };
}

/**
 * Mark a released child's task terminal and drive its stream event
 * through the REAL reconciler handler — the full load → plan → persist →
 * release wired path (not just computeReconcilePlan in isolation).
 */
async function completeAndReconcile(taskId: string, status = 'COMPLETED', buildPassed = true): Promise<void> {
  const rec = tables.TaskTable.get(taskId) as Record<string, unknown>;
  rec.status = status;
  if (buildPassed !== undefined) rec.build_passed = buildPassed;
  const event: DynamoDBStreamEvent = {
    Records: [streamImageFor(taskId, status, buildPassed) as never],
  };
  await reconcilerHandler(event);
}

/** Convenience: current child_status map for an orchestration. */
async function statuses(orchestrationId: string): Promise<Record<string, string>> {
  const snap = await loadOrchestration(ddb, ORCH, orchestrationId);
  return Object.fromEntries(snap!.children.map((c) => [c.sub_issue_id, c.child_status]));
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  fakeSend.mockClear();
});

describe('orchestration integration — real createTaskCore', () => {
  test('release → real task persisted → reconciler resolves it (the 3-bug path)', async () => {
    // Seed a 2-child graph: A (root), B depends on A.
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

    // Release roots via the REAL createTaskCore.
    const snap = await loadOrchestration(ddb, ORCH, seed.orchestrationId);
    const results = await releaseReadyChildren(
      ddb, ORCH, snap!.children, snap!.meta.release_context, createTaskCore, NOW,
    );
    const released = results.filter((r) => r.kind === 'released');
    expect(released).toHaveLength(1); // only A is ready; B is blocked

    // BUG 1 regression: the real createTaskCore accepted the key (no 400),
    // so a real TaskRecord exists.
    const aTaskId = (released[0] as { taskId: string }).taskId;
    expect(aTaskId).toBeTruthy();
    const aRec = tables.TaskTable.get(aTaskId) as Record<string, unknown>;
    expect(aRec).toBeDefined();
    expect(aRec.channel_source).toBe('linear');

    // BUG 2 regression: orchestration_id round-trips under channel_metadata
    // (NOT top-level) — exactly the shape the reconciler must read.
    expect((aRec.channel_metadata as Record<string, string>).orchestration_id).toBe(seed.orchestrationId);
    expect(aRec.orchestration_id).toBeUndefined();

    // Now simulate A's terminal stream event and confirm the reconciler
    // parser extracts the orchestration id from the PERSISTED shape.
    const evt = parseTerminalTaskRecord(streamImageFor(aTaskId, 'COMPLETED', true) as never);
    expect(evt).not.toBeNull();
    expect(evt!.orchestrationId).toBe(seed.orchestrationId);

    // Gating: A succeeded → B becomes releasable.
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
    // Second attempt on the same (now 'released') row: conditional flip fails.
    const second = await releaseChild({ ddb, tableName: ORCH, row, platformUserId: 'user-1', createTaskCore, now: NOW });
    expect(second.kind).toBe('already_released');

    // Exactly one TaskRecord for this child (idempotency-key dedup in createTaskCore).
    const tasks = [...tables.TaskTable.values()];
    expect(tasks).toHaveLength(1);
  });

  // ── seed + release roots, returning the orchestration id + a map of
  //    sub_issue_id → released task id (for the wired reconciler tests) ──
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
    // map released task ids back to their sub_issue_id via the child rows
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

    // Replay: same parent labeled again → seedOrchestration sees the meta
    // row and no-ops; re-releasing roots must not create a second task.
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

    // No new tasks (the already-released root's conditional flip fails;
    // even if it re-called createTaskCore, the idempotency key dedups).
    expect([...tables.TaskTable.values()].length).toBe(tasksAfterFirst);
    // Still exactly one child row per sub-issue (+ meta).
    const rows = [...tables.OrchestrationTable.values()].filter((r) => r.orchestration_id === first.orchestrationId);
    expect(rows.filter((r) => r.sub_issue_id !== '#meta')).toHaveLength(2);
  });

  test('diamond timing (wired): D releases only after BOTH B and C succeed', async () => {
    // A → {B,C} → D. Root A; B,C depend on A; D depends on B,C.
    const children = [
      { id: 'd-a', depends_on: [], identifier: 'A', title: 'A' },
      { id: 'd-b', depends_on: ['d-a'], identifier: 'B', title: 'B' },
      { id: 'd-c', depends_on: ['d-a'], identifier: 'C', title: 'C' },
      { id: 'd-d', depends_on: ['d-b', 'd-c'], identifier: 'D', title: 'D' },
    ];
    const { orchestrationId, taskIds } = await seedAndReleaseRoots('DIAMOND', children);

    // A completes → B and C release.
    await completeAndReconcile(taskIds['d-a']);
    let st = await statuses(orchestrationId);
    expect(st['d-b']).toBe('released');
    expect(st['d-c']).toBe('released');
    expect(st['d-d']).toBe('blocked');

    // B completes → D still blocked (C not done).
    const t2 = await loadOrchestration(ddb, ORCH, orchestrationId);
    const bTask = t2!.children.find((c) => c.sub_issue_id === 'd-b')!.child_task_id!;
    await completeAndReconcile(bTask);
    st = await statuses(orchestrationId);
    expect(st['d-d']).toBe('blocked');

    // C completes → D releases.
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

    // A reaches COMPLETED but build failed → NOT a success → B skipped.
    await completeAndReconcile(taskIds['bp-a'], 'COMPLETED', false);
    const st = await statuses(orchestrationId);
    expect(st['bp-a']).toBe('failed');
    expect(st['bp-b']).toBe('skipped');
    // No task ever created for B.
    const bRows = [...tables.OrchestrationTable.values()].find((r) => r.sub_issue_id === 'bp-b');
    expect(bRows?.child_task_id).toBeUndefined();
  });

  // KNOWN FAILURE — executable witness for double task creation under
  // concurrent predecessor completion. See
  // docs/research/orchestration-reconciler-correctness.md §4 schedule S2.
  // The reconciler's release is create-then-flip, so the conditional row
  // flip (the only serialization point) happens AFTER the irreversible
  // createTaskCore → two predecessors racing D each create a task. The fix
  // is flip-then-create, with the stranded-task sweep as the backstop for a
  // crash between flip and create; un-skip when that lands. Kept as
  // `test.failing` so the suite stays green AND CI flags us the day the bug
  // is fixed.
  test.failing('concurrent predecessors (wired): two terminal events racing the same dependent release it once', async () => {
    // D depends on B and C; both succeed "simultaneously" — fire both
    // reconciler events without awaiting between them, then assert D
    // released exactly once (one task).
    const children = [
      { id: 'cc-b', depends_on: [], identifier: 'B', title: 'B' },
      { id: 'cc-c', depends_on: [], identifier: 'C', title: 'C' },
      { id: 'cc-d', depends_on: ['cc-b', 'cc-c'], identifier: 'D', title: 'D' },
    ];
    const { orchestrationId, taskIds } = await seedAndReleaseRoots('CONCURRENT', children);

    // Mark both terminal, then drive both events. (The fake is sync under
    // the hood, so this is sequential-but-interleaved at the await points
    // — enough to exercise the conditional-flip idempotency guard.)
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism -- fixed 2-element array (two named children), not input-derived
    await Promise.all([
      completeAndReconcile(taskIds['cc-b']),
      completeAndReconcile(taskIds['cc-c']),
    ]);

    const st = await statuses(orchestrationId);
    expect(st['cc-d']).toBe('released');
    // Exactly one task for D despite both predecessors triggering release.
    const dTasks = [...tables.TaskTable.values()].filter(
      (t) => (t.channel_metadata as Record<string, string>)?.orchestration_sub_issue_id === 'cc-d',
    );
    expect(dTasks).toHaveLength(1);
  });

  // ── base-branch selection threads through the real release path ──

  /** Find the persisted task record for a given orchestration sub_issue_id. */
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

    // A's persisted branch_name → becomes B's base when B releases.
    const aBranch = tables.TaskTable.get(taskIds['lin-a'])!.branch_name as string;
    expect(aBranch).toBeTruthy();

    await completeAndReconcile(taskIds['lin-a']);

    const bTask = taskForSub('lin-b')!;
    const cm = bTask.channel_metadata as Record<string, string>;
    // B stacks on A: base = A's branch, no merges.
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

    // Both predecessors complete → D releases.
    await completeAndReconcile(taskIds['dia-b']);
    await completeAndReconcile(taskIds['dia-c']);

    const dTask = taskForSub('dia-d')!;
    const cm = dTask.channel_metadata as Record<string, string>;
    // Diamond: D branches off main, merges B's and C's branches in.
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
