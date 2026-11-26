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

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
  PutItemCommand: jest.fn((input: unknown) => ({ _type: 'PutItem', input })),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Concurrency';
process.env.STRANDED_TIMEOUT_SECONDS = '1200';
process.env.TASK_RETENTION_DAYS = '90';

import { handler } from '../../src/handlers/reconcile-stranded-tasks';

function mockTaskRow(opts: {
  task_id: string;
  user_id: string;
  created_at: string;
  status_created_at?: string;
}): Record<string, { S: string }> {
  return {
    task_id: { S: opts.task_id },
    user_id: { S: opts.user_id },
    created_at: { S: opts.created_at },
    ...(opts.status_created_at !== undefined && { status_created_at: { S: opts.status_created_at } }),
  };
}

function primeResponses(responses: unknown[]): void {
  mockDdbSend.mockReset();
  let idx = 0;
  mockDdbSend.mockImplementation(() => {
    if (idx >= responses.length) {
      throw new Error(`mockDdbSend ran out of responses after ${idx} calls`);
    }
    const r = responses[idx++];
    if (r instanceof Error) throw r;
    return Promise.resolve(r);
  });
}

describe('reconcile-stranded-tasks', () => {
  beforeEach(() => {
    mockDdbSend.mockReset();
  });

  test('no candidates → handler is a no-op with no writes', async () => {
    primeResponses([
      { Items: [] },
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    expect(mockDdbSend).toHaveBeenCalledTimes(3);
  });

  test('task older than 1200s → fails + emits events + decrements concurrency', async () => {
    const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-stranded',
          user_id: 'u-1',
          created_at: ancient,
        })],
      },
      {},
      {},
      {},
      {},
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const transitionCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'));
    expect(transitionCall).toBeDefined();
    const input = transitionCall![0].input as {
      Key: { task_id: { S: string } };
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, { S?: string; N?: string }>;
    };
    expect(input.Key.task_id.S).toBe('t-stranded');
    expect(input.ExpressionAttributeValues[':failed'].S).toBe('FAILED');
    expect(input.ExpressionAttributeValues[':expected'].S).toBe('SUBMITTED');
    expect(input.UpdateExpression).toContain('#ttl = :ttl');
    expect(Number(input.ExpressionAttributeValues[':ttl'].N)).toBeGreaterThan(Date.now() / 1000 + 89 * 86400);

    const putCalls = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'PutItem');
    expect(putCalls).toHaveLength(2);
    const eventTypes = putCalls.map(([c]) => {
      const item = (c.input as { Item: { event_type: { S: string } } }).Item;
      return item.event_type.S;
    });
    expect(eventTypes).toEqual(expect.arrayContaining(['task_stranded', 'task_failed']));
    expect(input.ExpressionAttributeValues[':ttl'].N).toBe((putCalls[0][0].input as { Item: { ttl: { N: string } } }).Item.ttl.N);

    const decrementCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.UpdateExpression).includes('active_count'));
    expect(decrementCall).toBeDefined();
  });

  test('#441: task with old created_at but FRESH status_created_at is NOT failed (freshly picked up from the queue)', async () => {
    const ancientCreate = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const freshStatus = new Date(Date.now() - 30 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-just-picked-up',
          user_id: 'u-1',
          created_at: ancientCreate,
          status_created_at: `SUBMITTED#${freshStatus}`,
        })],
      },
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    expect(mockDdbSend).toHaveBeenCalledTimes(3);
  });

  test('#441: task with old created_at AND old status_created_at is still failed (genuinely stranded)', async () => {
    const ancient = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-stuck',
          user_id: 'u-2',
          created_at: ancient,
          status_created_at: `SUBMITTED#${ancient}`,
        })],
      },
      {},
      {},
      {},
      {},
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const transitionCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'));
    expect(transitionCall).toBeDefined();
    const input = transitionCall![0].input as {
      Key: { task_id: { S: string } };
      ExpressionAttributeValues: Record<string, { S?: string }>;
    };
    expect(input.Key.task_id.S).toBe('t-stuck');
    expect(input.ExpressionAttributeValues[':failed'].S).toBe('FAILED');
  });

  test('#441: malformed status_created_at falls back to created_at (pre-#441 behavior)', async () => {
    const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-malformed',
          user_id: 'u-3',
          created_at: ancient,
          status_created_at: 'SUBMITTED#not-a-timestamp',
        })],
      },
      {},
      {},
      {},
      {},
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const transitionCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'));
    expect(transitionCall).toBeDefined();
    expect((transitionCall![0].input as { Key: { task_id: { S: string } } }).Key.task_id.S).toBe('t-malformed');
  });

  test('task advances during reconcile (ConditionalCheckFailedException) → skipped cleanly', async () => {
    const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const conditionalErr = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'ConditionalCheckFailedException',
    });
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-raced',
          user_id: 'u-4',
          created_at: ancient,
        })],
      },
      conditionalErr,
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const writes = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'PutItem')
      .length;
    expect(writes).toBe(0);
  });

  test('AWAITING_APPROVAL stranded task additionally emits approval_stranded milestone', async () => {
    const ancient = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    primeResponses([
      { Items: [] },
      { Items: [] },
      { Items: [mockTaskRow({ task_id: 't-await', user_id: 'u-1', created_at: ancient })] },
      {},
      {},
      {},
      {},
      {},
    ]);

    await handler();

    const putCalls = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'PutItem');
    expect(putCalls).toHaveLength(3);

    const milestonePut = putCalls.find(([c]) => {
      const item = (c.input as { Item: Record<string, { S?: string; M?: Record<string, { S?: string }> }> }).Item;
      return item.event_type?.S === 'agent_milestone';
    });
    expect(milestonePut).toBeDefined();
    const item = (milestonePut![0].input as {
      Item: {
        event_type: { S: string };
        metadata: { M: Record<string, { S?: string; N?: string }> };
      };
    }).Item;
    expect(item.event_type.S).toBe('agent_milestone');
    expect(item.metadata.M.milestone.S).toBe('approval_stranded');
    expect(item.metadata.M.reason.S).toBe('STRANDED_NO_HEARTBEAT');
    expect(item.metadata.M.age_s.N).toBeDefined();
  });

  test('SUBMITTED stranded task does NOT emit approval_stranded milestone (only AWAITING_APPROVAL does)', async () => {
    const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    primeResponses([
      { Items: [mockTaskRow({ task_id: 't-sub', user_id: 'u-1', created_at: ancient })] },
      {},
      {},
      {},
      {},
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const putCalls = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'PutItem');
    expect(putCalls).toHaveLength(2);
    const anyMilestone = putCalls.some(([c]) => {
      const item = (c.input as { Item: Record<string, { S?: string }> }).Item;
      return item.event_type?.S === 'agent_milestone';
    });
    expect(anyMilestone).toBe(false);
  });

  test('SUBMITTED + HYDRATING + AWAITING_APPROVAL queries all run', async () => {
    primeResponses([
      { Items: [] },
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const queryCalls = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'Query');
    expect(queryCalls).toHaveLength(3);
    const statusValues = queryCalls.map(([c]) => {
      const values = (c.input as { ExpressionAttributeValues: Record<string, { S: string }> }).ExpressionAttributeValues;
      return values[':status'].S;
    });
    expect(statusValues).toEqual(
      expect.arrayContaining(['SUBMITTED', 'HYDRATING', 'AWAITING_APPROVAL']),
    );
  });

  describe('final log severity escalation', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loggerModule = require('../../src/handlers/shared/logger') as {
      logger: {
        info: (m: string, d?: Record<string, unknown>) => void;
        warn: (m: string, d?: Record<string, unknown>) => void;
        error: (m: string, d?: Record<string, unknown>) => void;
      };
    };

    let infoSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      infoSpy = jest.spyOn(loggerModule.logger, 'info').mockImplementation(() => {});
      warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => {});
      errorSpy = jest.spyOn(loggerModule.logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    function findFinalLog(): { level: 'INFO' | 'WARN' | 'ERROR'; message: string; payload: Record<string, unknown> } {
      const match = (spy: jest.SpyInstance, level: 'INFO' | 'WARN' | 'ERROR') => {
        const call = spy.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('Stranded-task reconciler finished'),
        );
        return call ? { level, message: call[0] as string, payload: (call[1] ?? {}) as Record<string, unknown> } : null;
      };
      return match(errorSpy, 'ERROR') ?? match(warnSpy, 'WARN') ?? match(infoSpy, 'INFO')
        ?? (() => { throw new Error('No final reconciler log line found'); })();
    }

    test('test_logs_ERROR_with_RECONCILER_TOTAL_FAILURE_error_id_when_every_task_fails', async () => {
      const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const ddbErr = Object.assign(new Error('DDB blew up'), { name: 'InternalServerError' });
      primeResponses([
        {
          Items: [
            mockTaskRow({ task_id: 't-fail-1', user_id: 'u-1', created_at: ancient }),
            mockTaskRow({ task_id: 't-fail-2', user_id: 'u-2', created_at: ancient }),
          ],
        },
        ddbErr,
        ddbErr,
        { Items: [] },
        { Items: [] },
      ]);

      await handler();

      const final = findFinalLog();
      expect(final.level).toBe('ERROR');
      expect(final.payload.error_id).toBe('RECONCILER_TOTAL_FAILURE');
      expect(final.payload.stranded).toBe(2);
      expect(final.payload.failed).toBe(0);
      expect(final.payload.errors).toBe(2);
    });

    test('test_logs_WARN_with_RECONCILER_PARTIAL_FAILURE_when_some_tasks_fail', async () => {
      const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const ddbErr = Object.assign(new Error('DDB throttled'), { name: 'ProvisionedThroughputExceededException' });
      primeResponses([
        {
          Items: [
            mockTaskRow({ task_id: 't-ok', user_id: 'u-a', created_at: ancient }),
            mockTaskRow({ task_id: 't-fail', user_id: 'u-b', created_at: ancient }),
          ],
        },
        {},
        {},
        {},
        {},
        ddbErr,
        { Items: [] },
        { Items: [] },
      ]);

      await handler();

      const final = findFinalLog();
      expect(final.level).toBe('WARN');
      expect(final.payload.error_id).toBe('RECONCILER_PARTIAL_FAILURE');
      expect(final.payload.stranded).toBe(2);
      expect(final.payload.failed).toBe(1);
      expect(final.payload.errors).toBe(1);
    });

    test('test_logs_INFO_on_full_success', async () => {
      const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      primeResponses([
        {
          Items: [
            mockTaskRow({ task_id: 't-1', user_id: 'u-a', created_at: ancient }),
            mockTaskRow({ task_id: 't-2', user_id: 'u-b', created_at: ancient }),
          ],
        },
        {}, {}, {}, {},
        {}, {}, {}, {},
        { Items: [] },
        { Items: [] },
      ]);

      await handler();

      const final = findFinalLog();
      expect(final.level).toBe('INFO');
      expect(final.payload.error_id).toBeUndefined();
      expect(final.payload.stranded).toBe(2);
      expect(final.payload.failed).toBe(2);
      expect(final.payload.errors).toBe(0);
    });

    test('test_no_stranded_tasks_logs_INFO_not_ERROR', async () => {
      primeResponses([
        { Items: [] },
        { Items: [] },
        { Items: [] },
      ]);

      await handler();

      const final = findFinalLog();
      expect(final.level).toBe('INFO');
      expect(final.payload.stranded).toBe(0);
      expect(final.payload.errors).toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  test('query paginates with ExclusiveStartKey when LastEvaluatedKey present', async () => {
    const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-page1',
          user_id: 'u-a',
          created_at: ancient,
        })],
        LastEvaluatedKey: { task_id: { S: 't-page1' } },
      },
      {
        Items: [mockTaskRow({
          task_id: 't-page2',
          user_id: 'u-b',
          created_at: ancient,
        })],
      },
      {}, {}, {}, {},
      {}, {}, {}, {},
      { Items: [] },
      { Items: [] },
    ]);

    await handler();

    const failedIds = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'))
      .map(([c]) => (c.input as { Key: { task_id: { S: string } } }).Key.task_id.S);
    expect(failedIds).toEqual(expect.arrayContaining(['t-page1', 't-page2']));
  });
});
