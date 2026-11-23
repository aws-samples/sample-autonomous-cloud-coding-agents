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

const sendMock = jest.fn();
jest.mock('../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: sendMock }) }));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

// The step reads the name of the task table when it loads.
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.BUDGET_TABLE_NAME = 'Budgets';

import { TaskStatus, TERMINAL_STATUSES } from '../../src/constructs/task-status';
import { publishTaskMetrics } from '../../src/handlers/scoreboard-metrics';
import { BUDGET_METRICS_PERIOD, BUDGET_ROLLUP_RETENTION_DAYS, taskBudgetMarkerKey } from '../../src/handlers/shared/budgets';
import type { TaskRecord } from '../../src/handlers/shared/types';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** ISO time `ms` milliseconds before NOW. */
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

/**
 * The stream record of a write to a task that finished a minute ago. `image` replaces
 * attributes of the new image; `undefined` leaves one out.
 */
function record(image: Record<string, { S: string } | undefined> = {}, eventName: DynamoDBRecord['eventName'] = 'MODIFY'): DynamoDBRecord {
  const attributes = {
    task_id: { S: 'task-1' },
    status: { S: 'COMPLETED' },
    completed_at: { S: '2026-11-19T11:59:00Z' },
    updated_at: { S: '2026-11-19T11:59:00Z' },
    ...image,
  };
  return {
    eventName,
    dynamodb: {
      SequenceNumber: 'seq-1',
      NewImage: Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)),
    },
  } as DynamoDBRecord;
}

/** The whole record of that task as the claim returns it: new work that ended in a verified pull request. */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: 'task-1',
    user_id: 'user-1',
    status: TaskStatus.COMPLETED,
    repo: 'Owner/Repo',
    resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
    workflow_ref: 'coding/new-task-v1',
    branch_name: 'bgagent/task-1/add-a-retry',
    channel_source: 'api',
    status_created_at: 'COMPLETED#2026-11-19T11:59:00Z',
    created_at: '2026-11-19T11:35:00.000Z',
    started_at: '2026-11-19T11:35:41.000Z',
    completed_at: '2026-11-19T11:59:00Z',
    updated_at: '2026-11-19T11:59:00Z',
    pr_url: 'https://github.com/Owner/Repo/pull/12',
    build_passed: true,
    cost_usd: '3.87',
    approval_gate_count: 0,
    ...overrides,
  };
}

/** A DynamoDB error as the SDK throws it: the name tells the kind. */
const ddbError = (name: string): Error => Object.assign(new Error(name), { name });

let stdout: jest.SpyInstance;

beforeEach(() => {
  sendMock.mockReset();
  jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('publishTaskMetrics', () => {
  describe('leaves the task alone, without a call, for', () => {
    test.each<[string, DynamoDBRecord]>([
      ['a REMOVE record', record({}, 'REMOVE')],
      ['a record without stream data', { eventName: 'MODIFY' }],
      ['a record without a new image', { eventName: 'MODIFY', dynamodb: { SequenceNumber: 'seq-1' } }],
      ['an image without a task id', record({ task_id: undefined })],
      ['an image without a status', record({ status: undefined })],
      ['a task that is still running', record({ status: { S: 'RUNNING' } })],
      // The case the age bound is for: a task from before the deployment, rewritten just now.
      ['a task that finished more than 24 hours ago, whatever its last write', record({ completed_at: { S: ago(DAY_MS + 1) } })],
      [
        'a task without completed_at whose last write is more than 24 hours old',
        record({ completed_at: undefined, updated_at: { S: ago(DAY_MS + 1) } }),
      ],
      [
        'a task with an unreadable completed_at whose last write is more than 24 hours old',
        record({ completed_at: { S: 'not a time' }, updated_at: { S: ago(DAY_MS + 1) } }),
      ],
    ])('%s', async (_what, streamRecord) => {
      await expect(publishTaskMetrics(streamRecord)).resolves.toBe(false);

      expect(sendMock).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    });
  });

  /** The table holds `item`, and the marker put lands. */
  function stored(item: TaskRecord = task()): void {
    sendMock.mockResolvedValueOnce({ Item: item }).mockResolvedValueOnce({});
  }

  describe('claims', () => {
    test.each<[string, DynamoDBRecord]>([
      ...TERMINAL_STATUSES.map((status): [string, DynamoDBRecord] => [`a ${status} task`, record({ status: { S: status } })]),
      ['a task inserted in a terminal status', record({}, 'INSERT')],
      ['a task that finished exactly 24 hours ago', record({ completed_at: { S: ago(DAY_MS) } })],
      ['a task whose last write is old but whose completed_at is not', record({ updated_at: { S: ago(DAY_MS + 1) } })],
      ['a task whose finish time is ahead of the clock', record({ completed_at: { S: ago(-MINUTE_MS) } })],
      ['a task whose image has no finish time', record({ completed_at: undefined, updated_at: undefined })],
    ])('%s', async (_what, streamRecord) => {
      stored();

      await expect(publishTaskMetrics(streamRecord)).resolves.toBe(true);

      expect(sendMock).toHaveBeenCalledTimes(2);
    });

    test('with a read of the task and one conditional put of a marker, and no write to the task', async () => {
      stored();

      await publishTaskMetrics(record());

      expect(sendMock).toHaveBeenCalledTimes(2);
      const [read, claim] = sendMock.mock.calls.map(([command]) => command);
      expect(read.constructor.name).toBe('GetCommand');
      expect(read.input).toEqual({
        TableName: 'Tasks',
        Key: { task_id: 'task-1' },
        ConsistentRead: true,
      });
      expect(claim.constructor.name).toBe('PutCommand');
      // The marker only: the task record is not part of the claim, so the stream does not deliver it.
      expect(claim.input).toEqual({
        TableName: 'Budgets',
        Item: {
          scope_key: taskBudgetMarkerKey('task-1'),
          period: BUDGET_METRICS_PERIOD,
          ttl: Math.floor(NOW.getTime() / 1000) + BUDGET_ROLLUP_RETENTION_DAYS * 24 * 3600,
        },
        ConditionExpression: 'attribute_not_exists(scope_key)',
      });
    });
  });

  test('writes one line, built from the record the read returned and not from the image', async () => {
    stored();

    await expect(publishTaskMetrics(record())).resolves.toBe(true);

    expect(stdout).toHaveBeenCalledTimes(1);
    const [written] = stdout.mock.calls[0] as [string];
    expect(written.endsWith('\n')).toBe(true);
    expect(written.indexOf('\n')).toBe(written.length - 1);
    // What the image does not hold: the user, the repository, the workflow, the cost, and the
    // times the task was created and started. The line itself is pinned where it is built
    // (test/handlers/shared/scoreboard.test.ts).
    expect(JSON.parse(written)).toMatchObject({
      user_id: 'user-1',
      repo: 'Owner/Repo',
      workflow: 'coding/new-task-v1',
      CostUsd: 3.87,
      TimeToVerifiedPrSeconds: 1440,
      wait_s: 41,
    });
  });

  test('counts what the record holds at the read: approval requests added after the write that was delivered', async () => {
    stored(task({ status: TaskStatus.FAILED, pr_url: undefined, build_passed: undefined, cost_usd: '0.5', approval_gate_count: 2 }));

    await publishTaskMetrics(record({ status: { S: 'FAILED' } }));

    const [written] = stdout.mock.calls[0] as [string];
    expect(JSON.parse(written)).toMatchObject({ Outcome: 'failed', CostUsd: 0.5, HumanTouchpoints: 2, UntouchedVerifiedPrs: 0 });
  });

  test('leaves the workflow off the line of a record without a pinned workflow', async () => {
    stored(task({ resolved_workflow: undefined }));

    await expect(publishTaskMetrics(record())).resolves.toBe(true);

    const line = JSON.parse((stdout.mock.calls[0] as [string])[0]);
    // The raw ref still tells the kind of work; the plain field is the pin, which this record lacks.
    expect(line).toMatchObject({ Outcome: 'verified_pr', Work: 'coding', task_id: 'task-1' });
    expect(line).not.toHaveProperty('workflow');
  });

  test('stamps the line with the time of the claim when the record has no finish time', async () => {
    stored(task({ completed_at: undefined, updated_at: undefined }));

    await expect(publishTaskMetrics(record({ completed_at: undefined, updated_at: undefined }))).resolves.toBe(true);

    const [written] = stdout.mock.calls[0] as [string];
    expect(JSON.parse(written)._aws.Timestamp).toBe(NOW.getTime());
  });

  test('writes no line and logs nothing when another delivery holds the claim', async () => {
    sendMock.mockResolvedValueOnce({ Item: task() }).mockRejectedValueOnce(ddbError('ConditionalCheckFailedException'));

    await expect(publishTaskMetrics(record())).resolves.toBe(false);

    expect(stdout).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  test.each([
    ['holds no such task', {}],
    ['holds a task that is not finished', { Item: task({ status: TaskStatus.RUNNING }) }],
  ])('claims nothing and writes no line when the table %s', async (_what, read) => {
    sendMock.mockResolvedValueOnce(read);

    await expect(publishTaskMetrics(record())).resolves.toBe(false);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  test('lets every other error of the read or the claim reach its caller, and writes no line', async () => {
    const throttled = ddbError('ProvisionedThroughputExceededException');
    sendMock.mockRejectedValueOnce(throttled);
    await expect(publishTaskMetrics(record())).rejects.toBe(throttled);

    sendMock.mockResolvedValueOnce({ Item: task() }).mockRejectedValueOnce(throttled);
    await expect(publishTaskMetrics(record())).rejects.toBe(throttled);

    expect(stdout).not.toHaveBeenCalled();
  });
});
