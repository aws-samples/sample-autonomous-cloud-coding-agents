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

// --- Mocks ---
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

/**
 * Build a dynamodb AttributeValue map mimicking a TaskTable StatusIndex hit.
 */
function mockTaskRow(opts: {
  task_id: string;
  user_id: string;
  created_at: string;
}): Record<string, { S: string }> {
  return {
    task_id: { S: opts.task_id },
    user_id: { S: opts.user_id },
    created_at: { S: opts.created_at },
  };
}

/**
 * Run the handler after pre-seeding mockDdbSend with an array of responses.
 * Commands are popped in order; throw test-visible error if we run out.
 */
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
      { Items: [] }, // Query SUBMITTED
      { Items: [] }, // Query HYDRATING
    ]);

    await handler();

    // Exactly 2 queries, no updates.
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
  });

  test('task older than 1200s → fails + emits events + decrements concurrency', async () => {
    const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 min ago
    primeResponses([
      // Query SUBMITTED returns one stranded candidate.
      {
        Items: [mockTaskRow({
          task_id: 't-stranded',
          user_id: 'u-1',
          created_at: ancient,
        })],
      },
      {}, // conditional UpdateItem → FAILED
      {}, // PutItem task_stranded event
      {}, // PutItem task_failed event
      {}, // UpdateItem decrement concurrency
      { Items: [] }, // Query HYDRATING
    ]);

    await handler();

    // Capture the UpdateItem call that transitions status; assert condition.
    const transitionCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'));
    expect(transitionCall).toBeDefined();
    const input = transitionCall![0].input as {
      Key: { task_id: { S: string } };
      ExpressionAttributeValues: Record<string, { S?: string }>;
    };
    expect(input.Key.task_id.S).toBe('t-stranded');
    expect(input.ExpressionAttributeValues[':failed'].S).toBe('FAILED');
    expect(input.ExpressionAttributeValues[':expected'].S).toBe('SUBMITTED');

    // Events written.
    const putCalls = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'PutItem');
    expect(putCalls).toHaveLength(2);
    const eventTypes = putCalls.map(([c]) => {
      const item = (c.input as { Item: { event_type: { S: string } } }).Item;
      return item.event_type.S;
    });
    expect(eventTypes).toEqual(expect.arrayContaining(['task_stranded', 'task_failed']));

    // Concurrency decrement.
    const decrementCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.UpdateExpression).includes('active_count'));
    expect(decrementCall).toBeDefined();
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
      conditionalErr, // UpdateItem transition rejected (task already advanced)
      { Items: [] }, // HYDRATING query
    ]);

    // Must NOT throw; no events written, no concurrency decrement.
    await handler();

    const writes = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'PutItem')
      .length;
    expect(writes).toBe(0);
  });

  test('HYDRATING status also scanned (both SUBMITTED + HYDRATING queries run)', async () => {
    primeResponses([
      { Items: [] }, // SUBMITTED
      { Items: [] }, // HYDRATING
    ]);

    await handler();

    const queryCalls = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'Query');
    expect(queryCalls).toHaveLength(2);
    const statusValues = queryCalls.map(([c]) => {
      const values = (c.input as { ExpressionAttributeValues: Record<string, { S: string }> }).ExpressionAttributeValues;
      return values[':status'].S;
    });
    expect(statusValues).toEqual(expect.arrayContaining(['SUBMITTED', 'HYDRATING']));
  });

  describe('final log severity escalation', () => {
    // Spy on the logger module used by the handler. We import the logger
    // directly and replace the three level methods with jest.fn before
    // each test so we can assert exactly which level was called.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
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
      infoSpy = jest.spyOn(loggerModule.logger, 'info').mockImplementation(() => { /* silence */ });
      warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => { /* silence */ });
      errorSpy = jest.spyOn(loggerModule.logger, 'error').mockImplementation(() => { /* silence */ });
    });

    afterEach(() => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    /**
     * Find the final reconciler log line (i.e. the one whose message
     * starts with 'Stranded-task reconciler finished') across all spies
     * and return its [level, message, payload] triple.
     */
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
      // Two candidates both hit an exception on the first DDB write
      // (UpdateItem transition). None transition cleanly, so totalFailed=0,
      // totalStranded=2, totalErrors=2 → systemic failure path.
      const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const ddbErr = Object.assign(new Error('DDB blew up'), { name: 'InternalServerError' });
      primeResponses([
        // SUBMITTED query → two candidates.
        {
          Items: [
            mockTaskRow({ task_id: 't-fail-1', user_id: 'u-1', created_at: ancient }),
            mockTaskRow({ task_id: 't-fail-2', user_id: 'u-2', created_at: ancient }),
          ],
        },
        ddbErr, // UpdateItem for t-fail-1 → throws
        ddbErr, // UpdateItem for t-fail-2 → throws
        { Items: [] }, // HYDRATING query
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
      // One success (4 writes), one failure (throws on UpdateItem).
      const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const ddbErr = Object.assign(new Error('DDB throttled'), { name: 'ProvisionedThroughputExceededException' });
      primeResponses([
        // SUBMITTED query → two candidates.
        {
          Items: [
            mockTaskRow({ task_id: 't-ok', user_id: 'u-a', created_at: ancient }),
            mockTaskRow({ task_id: 't-fail', user_id: 'u-b', created_at: ancient }),
          ],
        },
        {}, // UpdateItem t-ok (transition) → success
        {}, // PutItem task_stranded event
        {}, // PutItem task_failed event
        {}, // UpdateItem decrement concurrency
        ddbErr, // UpdateItem t-fail (transition) → throws
        { Items: [] }, // HYDRATING query
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
      // Two candidates, both transition cleanly.
      const ancient = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      primeResponses([
        {
          Items: [
            mockTaskRow({ task_id: 't-1', user_id: 'u-a', created_at: ancient }),
            mockTaskRow({ task_id: 't-2', user_id: 'u-b', created_at: ancient }),
          ],
        },
        {}, {}, {}, {}, // t-1: transition + 2 events + decrement
        {}, {}, {}, {}, // t-2: transition + 2 events + decrement
        { Items: [] }, // HYDRATING
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
      // Empty-query case: totalStranded=0. Must NOT alarm.
      primeResponses([
        { Items: [] }, // SUBMITTED
        { Items: [] }, // HYDRATING
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
    // findStrandedCandidates paginates internally and returns ALL rows
    // before the handler starts writing. So the call order is:
    //   Query SUBMITTED page1 (with LEK) → Query SUBMITTED page2 (no LEK)
    //   → 4 writes for page1 candidate → 4 writes for page2 candidate
    //   → Query HYDRATING (empty).
    primeResponses([
      // SUBMITTED page 1
      {
        Items: [mockTaskRow({
          task_id: 't-page1',
          user_id: 'u-a',
          created_at: ancient,
        })],
        LastEvaluatedKey: { task_id: { S: 't-page1' } },
      },
      // SUBMITTED page 2
      {
        Items: [mockTaskRow({
          task_id: 't-page2',
          user_id: 'u-b',
          created_at: ancient,
        })],
      },
      // Writes for both candidates (4 each = 8 total).
      {}, {}, {}, {},
      {}, {}, {}, {},
      // HYDRATING
      { Items: [] },
    ]);

    await handler();

    const failedIds = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .filter(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'))
      .map(([c]) => (c.input as { Key: { task_id: { S: string } } }).Key.task_id.S);
    expect(failedIds).toEqual(expect.arrayContaining(['t-page1', 't-page2']));
  });
});
