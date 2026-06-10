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
 * #303 — stranded-orchestration backstop. Uses a stateful in-memory
 * DynamoDB fake so the sweep's read-advance-release cycle is exercised
 * for real (status writes are visible to the subsequent reload).
 */

interface Row { [k: string]: unknown }
const orch = new Map<string, Row>(); // OrchestrationTable, key = `${oid} ${sk}`
const tasksTbl = new Map<string, Row>(); // TaskTable, key = task_id

const fakeSend = jest.fn(async (cmd: { _type: string; input: Record<string, unknown> }) => {
  const { _type, input } = cmd;
  const tn = input.TableName as string;
  if (_type === 'Scan') {
    // meta-row scan on OrchestrationTable
    const items = [...orch.values()].filter((r) => r.sub_issue_id === '#meta');
    return { Items: items };
  }
  if (_type === 'Get') {
    const k = input.Key as Row;
    return { Item: tn.includes('Task') ? tasksTbl.get(String(k.task_id)) : orch.get(`${k.orchestration_id} ${k.sub_issue_id}`) };
  }
  if (_type === 'Query') {
    const oid = (input.ExpressionAttributeValues as Row)[':oid'];
    return { Items: [...orch.values()].filter((r) => r.orchestration_id === oid) };
  }
  if (_type === 'Update') {
    const k = input.Key as Row;
    const key = `${k.orchestration_id} ${k.sub_issue_id}`;
    const vals = input.ExpressionAttributeValues as Row;
    const row = orch.get(key);
    if (row && input.ConditionExpression?.toString().includes('child_status <> :s') && row.child_status === vals[':s']) {
      const e = new Error('c'); e.name = 'ConditionalCheckFailedException'; throw e;
    }
    if (row) {
      if (vals[':s'] !== undefined) row.child_status = vals[':s'];
      if (vals[':released'] !== undefined) { row.child_status = 'released'; row.child_task_id = vals[':tid']; }
    }
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

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { handler } from '../../src/handlers/reconcile-stranded-orchestrations';

function seed(oid: string, children: Array<{ sk: string; deps?: string[]; status: string; taskId?: string }>): void {
  orch.set(`${oid} #meta`, {
    orchestration_id: oid, sub_issue_id: '#meta', parent_linear_issue_id: 'P',
    linear_workspace_id: 'WS', repo: 'o/r', child_count: children.length, platform_user_id: 'user-1',
  });
  for (const c of children) {
    orch.set(`${oid} ${c.sk}`, {
      orchestration_id: oid, sub_issue_id: c.sk, depends_on: c.deps ?? [],
      child_status: c.status, repo: 'o/r', parent_linear_issue_id: 'P', linear_workspace_id: 'WS',
      ...(c.taskId && { child_task_id: c.taskId }),
    });
  }
}
const statusOf = (oid: string, sk: string) => orch.get(`${oid} ${sk}`)?.child_status;

beforeEach(() => {
  orch.clear(); tasksTbl.clear(); fakeSend.mockClear();
  createTaskCoreMock.mockReset();
  createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'new-task' } }) });
});

describe('#303 stranded-orchestration backstop', () => {
  test('lost RELEASE event: A already succeeded, B blocked → sweep releases B', async () => {
    // The live reconciler missed releasing B even though A is succeeded.
    seed('o1', [
      { sk: 'A', status: 'succeeded' },
      { sk: 'B', deps: ['A'], status: 'blocked' },
    ]);
    await handler();
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(statusOf('o1', 'B')).toBe('released');
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
});
