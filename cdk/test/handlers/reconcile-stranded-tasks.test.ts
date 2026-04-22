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
process.env.STRANDED_INTERACTIVE_TIMEOUT_SECONDS = '300';
process.env.STRANDED_ORCHESTRATOR_TIMEOUT_SECONDS = '1200';
process.env.TASK_RETENTION_DAYS = '90';

import { handler } from '../../src/handlers/reconcile-stranded-tasks';

/**
 * Build a dynamodb AttributeValue map mimicking a TaskTable StatusIndex hit.
 */
function mockTaskRow(opts: {
  task_id: string;
  user_id: string;
  created_at: string;
  execution_mode?: string;
}): Record<string, { S: string }> {
  return {
    task_id: { S: opts.task_id },
    user_id: { S: opts.user_id },
    created_at: { S: opts.created_at },
    ...(opts.execution_mode && { execution_mode: { S: opts.execution_mode } }),
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

  test('interactive task older than 300s → fails + emits events + decrements concurrency', async () => {
    const ancient = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    primeResponses([
      // Query SUBMITTED returns one stranded interactive candidate.
      {
        Items: [mockTaskRow({
          task_id: 't-stranded-interactive',
          user_id: 'u-1',
          created_at: ancient,
          execution_mode: 'interactive',
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
    expect(input.Key.task_id.S).toBe('t-stranded-interactive');
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

  test('orchestrator task younger than 1200s is NOT failed (threshold respected)', async () => {
    // Query's sort-key condition uses the INTERACTIVE (stricter/shorter)
    // cutoff, so this orchestrator row may come back from the query, but
    // the in-code per-mode filter must skip it. Age: 10 min (600s) —
    // older than interactive (300s) but younger than orchestrator (1200s).
    const mid = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-orch-young',
          user_id: 'u-1',
          created_at: mid,
          execution_mode: 'orchestrator',
        })],
      },
      { Items: [] }, // Query HYDRATING
    ]);

    await handler();

    const writes = (mockDdbSend.mock.calls as [{ _type: string }][])
      .filter(([c]) => c._type === 'UpdateItem' || c._type === 'PutItem');
    expect(writes).toHaveLength(0);
  });

  test('orchestrator task older than 1200s → failed', async () => {
    const veryOld = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 min
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-orch-stranded',
          user_id: 'u-2',
          created_at: veryOld,
          execution_mode: 'orchestrator',
        })],
      },
      {}, // UpdateItem transition
      {}, // task_stranded event
      {}, // task_failed event
      {}, // concurrency decrement
      { Items: [] }, // HYDRATING query
    ]);

    await handler();

    const transitionCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'));
    expect(transitionCall).toBeDefined();
    const input = transitionCall![0].input as {
      Key: { task_id: { S: string } };
    };
    expect(input.Key.task_id.S).toBe('t-orch-stranded');
  });

  test('legacy task (no execution_mode) → treated as orchestrator threshold', async () => {
    const veryOld = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-legacy',
          user_id: 'u-3',
          created_at: veryOld,
          // execution_mode omitted
        })],
      },
      {}, {}, {}, {}, // transition + 2 events + decrement
      { Items: [] }, // HYDRATING query
    ]);

    await handler();

    const transitionCall = (mockDdbSend.mock.calls as [{ _type: string; input: Record<string, unknown> }][])
      .find(([c]) => c._type === 'UpdateItem' && String(c.input.ConditionExpression).includes('= :expected'));
    expect(transitionCall).toBeDefined();
  });

  test('task advances during reconcile (ConditionalCheckFailedException) → skipped cleanly', async () => {
    const ancient = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const conditionalErr = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'ConditionalCheckFailedException',
    });
    primeResponses([
      {
        Items: [mockTaskRow({
          task_id: 't-raced',
          user_id: 'u-4',
          created_at: ancient,
          execution_mode: 'interactive',
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

  test('query paginates with ExclusiveStartKey when LastEvaluatedKey present', async () => {
    const ancient = new Date(Date.now() - 10 * 60 * 1000).toISOString();
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
          execution_mode: 'interactive',
        })],
        LastEvaluatedKey: { task_id: { S: 't-page1' } },
      },
      // SUBMITTED page 2
      {
        Items: [mockTaskRow({
          task_id: 't-page2',
          user_id: 'u-b',
          created_at: ancient,
          execution_mode: 'interactive',
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
