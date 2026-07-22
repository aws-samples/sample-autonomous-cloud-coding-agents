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

// Admission-queue deferred pickup (#441). Regression coverage for the #331
// scenario lives in the "fan-out burst" describe block at the bottom.

// --- Mocks ---
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetItemCommand: jest.fn((input: unknown) => ({ _type: 'GetItem', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
  PutItemCommand: jest.fn((input: unknown) => ({ _type: 'PutItem', input })),
}));

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Concurrency';
process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';
process.env.MAX_CONCURRENT_TASKS_PER_USER = '3';
process.env.QUEUE_MAX_AGE_SECONDS = '86400';
process.env.TASK_RETENTION_DAYS = '90';

import { handler } from '../../src/handlers/reconcile-admission-queue';

/** A QUEUED StatusIndex row as the DDB low-level client returns it. */
function queuedRow(opts: {
  task_id: string;
  user_id: string;
  created_at: string;
  admission_attempts?: number;
}): Record<string, { S: string } | { N: string }> {
  return {
    task_id: { S: opts.task_id },
    user_id: { S: opts.user_id },
    created_at: { S: opts.created_at },
    ...(opts.admission_attempts !== undefined && { admission_attempts: { N: String(opts.admission_attempts) } }),
  };
}

/** Recent ISO timestamp (now - ageSeconds). */
function isoAge(ageSeconds: number): string {
  return new Date(Date.now() - ageSeconds * 1000).toISOString();
}

interface SentCommand {
  _type: string;
  input: Record<string, any>;
}

function sentDdbCommands(type?: string): SentCommand[] {
  const cmds = mockDdbSend.mock.calls.map(c => c[0] as SentCommand);
  return type ? cmds.filter(c => c._type === type) : cmds;
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
});

describe('reconcile-admission-queue — empty queue', () => {
  test('no QUEUED tasks → single query, no writes, no invokes', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    const summary = await handler();
    expect(summary.queued_seen).toBe(0);
    expect(summary.picked_up).toBe(0);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('reconcile-admission-queue — pickup', () => {
  test('picks up the oldest task when the user has capacity', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'T1', user_id: 'u1', created_at: isoAge(60), admission_attempts: 1 })],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '1' } } }); // 1 of 3 used
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.picked_up).toBe(1);

    // Conditional QUEUED -> SUBMITTED flip
    const updates = sentDdbCommands('UpdateItem');
    expect(updates).toHaveLength(1);
    expect(updates[0].input.ConditionExpression).toContain(':queued');
    expect(updates[0].input.ExpressionAttributeValues[':submitted']).toEqual({ S: 'SUBMITTED' });

    // queue_pickup event emitted
    const events = sentDdbCommands('PutItem');
    expect(events).toHaveLength(1);
    expect(events[0].input.Item.event_type).toEqual({ S: 'queue_pickup' });

    // Orchestrator re-invoked async with a pickup nonce
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const invoke = mockLambdaSend.mock.calls[0][0] as SentCommand;
    expect(invoke.input.InvocationType).toBe('Event');
    const payload = JSON.parse(new TextDecoder().decode(invoke.input.Payload));
    expect(payload.task_id).toBe('T1');
    expect(payload.queue_pickup_id).toBeDefined();
  });

  test('picks up in FIFO order, bounded by free capacity', async () => {
    // 3 queued tasks for u1; only 2 free slots (active_count=1, max=3).
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [
            queuedRow({ task_id: 'OLD', user_id: 'u1', created_at: isoAge(300) }),
            queuedRow({ task_id: 'MID', user_id: 'u1', created_at: isoAge(240) }),
            queuedRow({ task_id: 'NEW', user_id: 'u1', created_at: isoAge(180) }),
          ],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '1' } } });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.picked_up).toBe(2);
    expect(summary.skipped_no_capacity).toBe(1);

    const flipped = sentDdbCommands('UpdateItem').map(u => u.input.Key.task_id.S);
    expect(flipped).toEqual(['OLD', 'MID']); // FIFO — NEW stays queued
  });

  test('skips a user at capacity entirely', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'T1', user_id: 'u1', created_at: isoAge(60) })],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '3' } } }); // full
      }
      return Promise.resolve({});
    });

    const summary = await handler();
    expect(summary.picked_up).toBe(0);
    expect(summary.skipped_no_capacity).toBe(1);
    expect(sentDdbCommands('UpdateItem')).toHaveLength(0);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('per-user isolation: one user at capacity does not block another', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [
            queuedRow({ task_id: 'FULL-USER-TASK', user_id: 'u-full', created_at: isoAge(120) }),
            queuedRow({ task_id: 'FREE-USER-TASK', user_id: 'u-free', created_at: isoAge(60) }),
          ],
        });
      }
      if (cmd._type === 'GetItem') {
        const userId = cmd.input.Key.user_id.S;
        return Promise.resolve({ Item: { active_count: { N: userId === 'u-full' ? '3' : '0' } } });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.picked_up).toBe(1);
    expect(summary.skipped_no_capacity).toBe(1);
    const flipped = sentDdbCommands('UpdateItem').map(u => u.input.Key.task_id.S);
    expect(flipped).toEqual(['FREE-USER-TASK']);
  });

  test('missing concurrency row counts as zero active (full capacity)', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'T1', user_id: 'new-user', created_at: isoAge(30) })],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({}); // no Item
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.picked_up).toBe(1);
  });
});

describe('reconcile-admission-queue — races and failures', () => {
  test('lost flip race (ConditionalCheckFailedException) is skipped cleanly', async () => {
    const condErr = Object.assign(new Error('conditional failed'), { name: 'ConditionalCheckFailedException' });
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'T1', user_id: 'u1', created_at: isoAge(60) })],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '0' } } });
      }
      if (cmd._type === 'UpdateItem') {
        return Promise.reject(condErr);
      }
      return Promise.resolve({});
    });

    const summary = await handler();
    expect(summary.picked_up).toBe(0);
    expect(summary.skipped_race).toBe(1);
    expect(summary.errors).toBe(0);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('orchestrator invoke failure after flip does NOT roll back (stranded reconciler sweeps)', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'T1', user_id: 'u1', created_at: isoAge(60) })],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '0' } } });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockRejectedValue(new Error('lambda throttled'));

    const summary = await handler();
    expect(summary.picked_up).toBe(0);
    // Only the QUEUED -> SUBMITTED flip — no compensating write back to QUEUED.
    const updates = sentDdbCommands('UpdateItem');
    expect(updates).toHaveLength(1);
    expect(updates[0].input.ExpressionAttributeValues[':submitted']).toEqual({ S: 'SUBMITTED' });
  });

  test('per-user concurrency read failure skips that user but not others', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [
            queuedRow({ task_id: 'BROKEN', user_id: 'u-err', created_at: isoAge(120) }),
            queuedRow({ task_id: 'OK', user_id: 'u-ok', created_at: isoAge(60) }),
          ],
        });
      }
      if (cmd._type === 'GetItem') {
        if (cmd.input.Key.user_id.S === 'u-err') {
          return Promise.reject(new Error('DDB throttled'));
        }
        return Promise.resolve({ Item: { active_count: { N: '0' } } });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.errors).toBe(1);
    expect(summary.picked_up).toBe(1);
    const flipped = sentDdbCommands('UpdateItem').map(u => u.input.Key.task_id.S);
    expect(flipped).toEqual(['OK']);
  });

  test('queue query failure aborts the cycle with a throw (EventBridge will retry)', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('GSI unavailable'));
    await expect(handler()).rejects.toThrow('GSI unavailable');
  });
});

describe('reconcile-admission-queue — max-age backstop', () => {
  test('a task queued past QUEUE_MAX_AGE_SECONDS is failed, not picked up', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'ZOMBIE', user_id: 'u1', created_at: isoAge(90000) })], // > 86400
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '0' } } });
      }
      return Promise.resolve({});
    });

    const summary = await handler();
    expect(summary.expired).toBe(1);
    expect(summary.picked_up).toBe(0);

    const updates = sentDdbCommands('UpdateItem');
    expect(updates).toHaveLength(1);
    expect(updates[0].input.ExpressionAttributeValues[':failed']).toEqual({ S: 'FAILED' });
    // No concurrency decrement — QUEUED tasks never held a slot.
    expect(updates.every(u => u.input.TableName === 'Tasks')).toBe(true);
    // task_failed event with queue_timeout reason
    const events = sentDdbCommands('PutItem');
    expect(events).toHaveLength(1);
    expect(events[0].input.Item.event_type).toEqual({ S: 'task_failed' });
    expect(events[0].input.Item.metadata.M.reason).toEqual({ S: 'queue_timeout' });
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('reconcile-admission-queue — #331 regression (fan-out burst)', () => {
  test('a burst of children above the cap all survive as QUEUED and drain FIFO without any failure', async () => {
    // #331: an epic fan-out released 8 children against a cap of 3.
    // Pre-#441 admission FAILED the excess 5. Now: 3 admitted directly
    // (never reach QUEUED), 5 QUEUED. This cycle: user has 0 active
    // (children finished), so 3 of the 5 queued drain; 2 remain queued;
    // ZERO tasks fail.
    const queued = ['C4', 'C5', 'C6', 'C7', 'C8'].map((id, i) =>
      // Oldest first: C4 queued 300s ago ... C8 queued 60s ago.
      queuedRow({ task_id: id, user_id: 'epic-user', created_at: isoAge(300 - i * 60), admission_attempts: 1 }),
    );
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({ Items: queued });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '0' } } });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.queued_seen).toBe(5);
    expect(summary.picked_up).toBe(3); // cap-bounded drain
    expect(summary.skipped_no_capacity).toBe(2); // survive for next cycle
    expect(summary.expired).toBe(0); // nothing dies

    // FIFO: the three oldest children drain first.
    const flipped = sentDdbCommands('UpdateItem').map(u => u.input.Key.task_id.S);
    expect(flipped).toEqual(['C4', 'C5', 'C6']);
    // No task was transitioned to FAILED anywhere in the cycle.
    const failedWrites = sentDdbCommands('UpdateItem')
      .filter(u => u.input.ExpressionAttributeValues[':failed'] !== undefined);
    expect(failedWrites).toHaveLength(0);
  });

  test('paginated QUEUED query preserves FIFO across pages', async () => {
    let queryCount = 0;
    mockDdbSend.mockImplementation((cmd: SentCommand) => {
      if (cmd._type === 'Query') {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            Items: [queuedRow({ task_id: 'P1', user_id: 'u1', created_at: isoAge(120) })],
            LastEvaluatedKey: { task_id: { S: 'P1' } },
          });
        }
        return Promise.resolve({
          Items: [queuedRow({ task_id: 'P2', user_id: 'u1', created_at: isoAge(60) })],
        });
      }
      if (cmd._type === 'GetItem') {
        return Promise.resolve({ Item: { active_count: { N: '1' } } }); // 2 free
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockResolvedValue({});

    const summary = await handler();
    expect(summary.queued_seen).toBe(2);
    expect(summary.picked_up).toBe(2);
    const flipped = sentDdbCommands('UpdateItem').map(u => u.input.Key.task_id.S);
    expect(flipped).toEqual(['P1', 'P2']);
  });
});
