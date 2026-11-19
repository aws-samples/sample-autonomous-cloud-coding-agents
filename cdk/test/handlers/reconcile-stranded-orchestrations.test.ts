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
 * Stranded-orchestration backstop. Uses a stateful in-memory
 * DynamoDB fake so the sweep's read-advance-release cycle is exercised
 * for real (status writes are visible to the subsequent reload).
 */

interface Row { [k: string]: unknown }
const orch = new Map<string, Row>(); // OrchestrationTable, key = `${oid} ${sk}`
const tasksTbl = new Map<string, Row>(); // TaskTable, key = task_id

/** Runs once, after the next Query has read its rows: lets a test change a row
 *  between the sweep's read and the write that follows it. */
let afterNextQuery: (() => void) | undefined;

/** The condition syntax the sweep and the release path use: clauses joined by
 *  AND, each ``attr = :v``, ``attr <> :v`` or ``attr IN (:a, :b)``. */
function conditionHolds(row: Row, expression: unknown, vals: Row): boolean {
  if (expression === undefined) return true;
  return String(expression).split(' AND ').every((clause) => {
    const [, attr, op, rhs] = /^(\w+) (=|<>|IN) (.+)$/.exec(clause)!;
    if (op === 'IN') return rhs.slice(1, -1).split(', ').some((v) => row[attr] === vals[v]);
    return (row[attr] === vals[rhs]) === (op === '=');
  });
}

const fakeSend = jest.fn(async (cmd: { _type: string; input: Record<string, unknown> }) => {
  const { _type, input } = cmd;
  const tn = input.TableName as string;
  if (_type === 'Scan') {
    // meta-row scan on OrchestrationTable: only the projected attributes come back
    const attrs = String(input.ProjectionExpression).split(', ');
    return {
      Items: [...orch.values()]
        .filter((r) => r.sub_issue_id === '#meta')
        .map((r) => Object.fromEntries(attrs.filter((a) => a in r).map((a) => [a, r[a]]))),
    };
  }
  if (_type === 'Get') {
    const k = input.Key as Row;
    return { Item: tn.includes('Task') ? tasksTbl.get(String(k.task_id)) : orch.get(`${k.orchestration_id} ${k.sub_issue_id}`) };
  }
  if (_type === 'Query') {
    const oid = (input.ExpressionAttributeValues as Row)[':oid'];
    const items = [...orch.values()].filter((r) => r.orchestration_id === oid).map((r) => ({ ...r }));
    const hook = afterNextQuery;
    afterNextQuery = undefined;
    hook?.();
    return { Items: items };
  }
  if (_type === 'Update') {
    // Applies the ``SET attr = :value`` and the ``REMOVE attr`` clause when the
    // condition holds, as DynamoDB does.
    const k = input.Key as Row;
    const key = `${k.orchestration_id} ${k.sub_issue_id}`;
    const vals = input.ExpressionAttributeValues as Row;
    const row = orch.get(key) ?? { ...k };
    if (!conditionHolds(row, input.ConditionExpression, vals)) {
      const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e;
    }
    const expression = String(input.UpdateExpression);
    for (const assignment of /SET (.+?)(?= REMOVE |$)/.exec(expression)?.[1].split(', ') ?? []) {
      const [attr, value] = assignment.split(' = ');
      row[attr] = vals[value];
    }
    for (const attr of /REMOVE (.+?)(?= SET |$)/.exec(expression)?.[1].split(', ') ?? []) delete row[attr];
    orch.set(key, row);
    return {};
  }
  throw new Error(`fake: unhandled ${_type}`);
});

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: fakeSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));
jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// The sweep imports refreshPanelAndSettle from the reconciler to settle an epic
// whose last terminal event was lost. Mock it so we can assert the sweep CALLS
// it (its real body is exercised by the reconciler's own suite).
const refreshPanelAndSettleMock = jest.fn();
jest.mock('../../src/handlers/orchestration-reconciler', () => ({
  refreshPanelAndSettle: (...args: unknown[]) => refreshPanelAndSettleMock(...args),
}));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/reconcile-stranded-orchestrations';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function seed(
  oid: string,
  children: Array<{ sk: string; deps?: string[]; status: string; taskId?: string; updatedAt?: string }>,
  meta: Row = {},
): void {
  orch.set(`${oid} #meta`, {
    orchestration_id: oid,
    sub_issue_id: '#meta',
    parent_linear_issue_id: 'P',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: children.length,
    platform_user_id: 'user-1',
    ...meta,
  });
  for (const c of children) {
    orch.set(`${oid} ${c.sk}`, {
      orchestration_id: oid,
      sub_issue_id: c.sk,
      depends_on: c.deps ?? [],
      child_status: c.status,
      repo: 'o/r',
      parent_linear_issue_id: 'P',
      linear_workspace_id: 'WS',
      updated_at: c.updatedAt ?? minutesAgo(0),
      ...(c.taskId && { child_task_id: c.taskId }),
    });
  }
}
const statusOf = (oid: string, sk: string) => orch.get(`${oid} ${sk}`)?.child_status;

beforeEach(() => {
  orch.clear(); tasksTbl.clear(); fakeSend.mockClear(); afterNextQuery = undefined;
  createTaskCoreMock.mockReset();
  createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'new-task' } }) });
  refreshPanelAndSettleMock.mockReset();
});

describe('stranded-orchestration backstop', () => {
  test('lost RELEASE event: A already succeeded, B blocked → sweep releases B', async () => {
    // The reconciler missed releasing B even though A is succeeded.
    seed('o1', [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
    ]);
    await handler();
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(statusOf('o1', 'B')).toBe('released');
  });

  test('a child the sweep starts is stamped, and loses the reason of an earlier start that was refused', async () => {
    // A retry put the child back to ready and the sweep is the one to start it.
    seed('o-reason', [{ sk: 'A', status: 'ready', updatedAt: minutesAgo(30) }]);
    orch.get('o-reason A')!.failure_reason = 'Blocked by content policy — reword this sub-issue, then reply `@bgagent retry` on the epic to re-run.';
    await handler();
    const started = orch.get('o-reason A')!;
    expect(started.child_status).toBe('released');
    expect(started.child_task_id).toBe('new-task');
    expect(started).not.toHaveProperty('failure_reason');
    expect(Date.parse(String(started.updated_at))).toBeGreaterThan(Date.parse(minutesAgo(1)));
  });

  test('lost TERMINAL event: A released + its task COMPLETED but row stuck → sweep advances A and releases B', async () => {
    seed('o2', [
      { sk: 'A', status: 'released', taskId: 'task-A' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
    ]);
    tasksTbl.set('task-A', { task_id: 'task-A', status: 'COMPLETED', build_passed: true });
    await handler();
    expect(statusOf('o2', 'A')).toBe('succeeded');
    expect(statusOf('o2', 'B')).toBe('released');
  });

  // The sweep must SETTLE the parent (post rollup + transition Linear), not
  // just flip DDB rows — else a lost last-terminal event leaves the epic 'done'
  // in DDB but stuck 🔄 In Progress in Linear forever.
  test('lost LAST terminal event: the only remaining child completes → sweep settles the parent', async () => {
    seed('o-settle', [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'released', taskId: 'task-B' },
    ]);
    tasksTbl.set('task-B', { task_id: 'task-B', status: 'COMPLETED', build_passed: true });
    await handler();
    // B advanced to terminal in DDB…
    expect(statusOf('o-settle', 'B')).toBe('succeeded');
    // …and, crucially, the parent was settled — the whole point of the backstop.
    expect(refreshPanelAndSettleMock).toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled(); // nothing left to release
  });

  test('already fully-terminal but unsettled epic → sweep still settles (idempotent)', async () => {
    seed('o-done', [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'succeeded' },
    ]);
    await handler();
    expect(refreshPanelAndSettleMock).toHaveBeenCalledWith('o-done', expect.any(Array), expect.any(Object), expect.any(String));
  });

  test('lost TERMINAL event with build_passed=false: A→failed, B→skipped, no release', async () => {
    seed('o3', [
      { sk: 'A', status: 'released', taskId: 'task-A' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
    ]);
    tasksTbl.set('task-A', { task_id: 'task-A', status: 'COMPLETED', build_passed: false });
    await handler();
    expect(statusOf('o3', 'A')).toBe('failed');
    expect(statusOf('o3', 'B')).toBe('skipped');
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('transitive skip: A failed → B and C (chain) both skipped', async () => {
    seed('o4', [
      { sk: 'A', status: 'failed' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
      { sk: 'C', deps: ['B'], status: 'blocked' },
    ]);
    await handler();
    expect(statusOf('o4', 'B')).toBe('skipped');
    expect(statusOf('o4', 'C')).toBe('skipped');
  });

  test('still-running child is left alone (task not terminal)', async () => {
    seed('o5', [
      { sk: 'A', status: 'released', taskId: 'task-A' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
    ]);
    tasksTbl.set('task-A', { task_id: 'task-A', status: 'RUNNING' });
    await handler();
    expect(statusOf('o5', 'A')).toBe('released'); // unchanged
    expect(statusOf('o5', 'B')).toBe('blocked');
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('fully-terminal orchestration is skipped (no work, no release)', async () => {
    seed('o6', [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'succeeded' },
    ]);
    await handler();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('diamond: D releases only once BOTH B and C are succeeded', async () => {
    seed('o7', [
      { sk: 'B', status: 'succeeded' },
      { sk: 'C', status: 'succeeded' },
      { sk: 'D', deps: ['B', 'C'], status: 'blocked' },
    ]);
    await handler();
    expect(statusOf('o7', 'D')).toBe('released');
  });

  test('diamond not-ready: one predecessor still running → D stays blocked', async () => {
    seed('o8', [
      { sk: 'B', status: 'succeeded' },
      { sk: 'C', status: 'released', taskId: 'task-C' },
      { sk: 'D', deps: ['B', 'C'], status: 'blocked' },
    ]);
    tasksTbl.set('task-C', { task_id: 'task-C', status: 'RUNNING' });
    await handler();
    expect(statusOf('o8', 'D')).toBe('blocked');
  });

  test('idempotent: a second sweep over a healthy orchestration releases nothing new', async () => {
    seed('o9', [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
    ]);
    await handler();
    createTaskCoreMock.mockClear();
    await handler(); // B is now 'released' → no further release
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  // The sweep settles the parent in the run that ends the epic, not one or two
  // runs (10 or 20 minutes) later. What it hands to the settle are the rows as
  // they are after its own writes.
  describe('an epic that this run brings to its end', () => {
    const settledWith = () => {
      expect(refreshPanelAndSettleMock).toHaveBeenCalledTimes(1);
      const children = refreshPanelAndSettleMock.mock.calls[0][1] as Row[];
      return children.map((c) => [c.sub_issue_id, c.child_status]);
    };
    const refusedForGood = {
      statusCode: 400,
      body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Task description was blocked by content policy.' } }),
    };

    test('a failed child whose dependents the sweep skips → settled with the skips', async () => {
      seed('o-ends', [
        { sk: 'A', status: 'released', taskId: 'task-A' },
        { sk: 'B', deps: ['A'], status: 'blocked' },
      ]);
      tasksTbl.set('task-A', { task_id: 'task-A', status: 'COMPLETED', build_passed: false });
      await handler();
      expect(settledWith()).toEqual([['A', 'failed'], ['B', 'skipped']]);
    });

    test('a release that is refused for good → dependents skipped and the parent settled', async () => {
      // R was left ``ready`` by the concurrency throttle; the guardrail rejects its text.
      seed('o-refused', [
        { sk: 'R', status: 'ready' },
        { sk: 'D', deps: ['R'], status: 'blocked' },
      ]);
      createTaskCoreMock.mockResolvedValue(refusedForGood);
      await handler();
      expect(settledWith()).toEqual([['R', 'failed'], ['D', 'skipped']]);
      // The reason the panel shows for R comes with the rows.
      expect(orch.get('o-refused R')?.failure_reason).toMatch(/content policy/);
    });

    test('a refused release beside one that started → dependents skipped, no settle while a child runs', async () => {
      seed('o-mixed', [
        { sk: 'R1', status: 'ready' },
        { sk: 'R2', status: 'ready' },
        { sk: 'D', deps: ['R1'], status: 'blocked' },
      ]);
      createTaskCoreMock.mockResolvedValueOnce(refusedForGood);
      await handler();
      expect(statusOf('o-mixed', 'R1')).toBe('failed');
      expect(statusOf('o-mixed', 'R2')).toBe('released');
      expect(statusOf('o-mixed', 'D')).toBe('skipped');
      expect(refreshPanelAndSettleMock).not.toHaveBeenCalled();
    });
  });

  // ``rollup_posted_at`` on the meta row is the stamp of the settle. Finished
  // epics stay in the table, so settling each of them again on every run would
  // edit every panel ever posted, every 10 minutes.
  describe('an epic whose rollup is already posted', () => {
    const done = [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'succeeded' },
    ];

    test('posted hours ago → left alone: the panel is not rendered again', async () => {
      seed('o-settled', done, { rollup_posted_at: minutesAgo(120) });
      await handler();
      expect(refreshPanelAndSettleMock).not.toHaveBeenCalled();
    });

    test('posted minutes ago → still refreshed, so a panel edit that failed after the stamp is repaired', async () => {
      seed('o-just-settled', done, { rollup_posted_at: minutesAgo(5) });
      await handler();
      expect(refreshPanelAndSettleMock).toHaveBeenCalledTimes(1);
    });

    test('an old stamp on an epic that is running again does not stop the recovery', async () => {
      // Re-opened (a sub-issue added, a retry) by a writer whose removal of the
      // stamp failed; the last child then lost its terminal event.
      seed('o-reopened', [
        { sk: 'A', status: 'succeeded' },
        { sk: 'B', deps: ['A'], status: 'released', taskId: 'task-B' },
      ], { rollup_posted_at: minutesAgo(120) });
      tasksTbl.set('task-B', { task_id: 'task-B', status: 'COMPLETED', build_passed: true });
      await handler();
      expect(statusOf('o-reopened', 'B')).toBe('succeeded');
      expect(refreshPanelAndSettleMock).toHaveBeenCalledTimes(1);
    });
  });

  // ``releasing`` is the claim a releaser holds while it creates the task. Taking
  // it from a releaser that is still running starts a second task for the child.
  describe('a child found in releasing', () => {
    test('claimed moments ago → left to its releaser: not reset, not released a second time', async () => {
      seed('o-live', [
        { sk: 'A', status: 'succeeded' },
        { sk: 'B', deps: ['A'], status: 'releasing', updatedAt: minutesAgo(0) },
      ]);
      await handler();
      expect(statusOf('o-live', 'B')).toBe('releasing');
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });

    test('claimed longer ago than any releaser can run → reset and released again', async () => {
      seed('o-dead', [
        { sk: 'A', status: 'succeeded' },
        { sk: 'B', deps: ['A'], status: 'releasing', updatedAt: minutesAgo(20) },
      ]);
      await handler();
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(statusOf('o-dead', 'B')).toBe('released');
    });

    test('an old claim that a new releaser took over after the sweep read it → left alone', async () => {
      seed('o-retaken', [
        { sk: 'A', status: 'succeeded' },
        { sk: 'B', deps: ['A'], status: 'releasing', updatedAt: minutesAgo(20) },
      ]);
      // Between the sweep's read and its reset another sweep run resets the dead
      // claim and takes it itself: the row reads ``releasing`` again, claimed now.
      afterNextQuery = () => { orch.get('o-retaken B')!.updated_at = minutesAgo(0); };
      await handler();
      expect(statusOf('o-retaken', 'B')).toBe('releasing');
      expect(createTaskCoreMock).not.toHaveBeenCalled();
    });
  });
});
