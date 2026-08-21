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

async function loadRollup(options: { enabled?: boolean } = {}) {
  jest.resetModules();
  sendMock.mockReset();
  if (options.enabled === false) {
    delete process.env.BUDGET_TABLE_NAME;
  } else {
    process.env.BUDGET_TABLE_NAME = 'Budgets';
  }
  jest.doMock('../../src/handlers/shared/ua', () => ({
    makeDocClient: () => ({ send: sendMock }),
    makeClient: () => ({ send: jest.fn() }),
  }));
  return import('../../src/handlers/budget-rollup');
}

function record(): DynamoDBRecord {
  return {
    eventID: 'event-1',
    eventName: 'MODIFY',
    eventSource: 'aws:dynamodb',
    eventVersion: '1.1',
    awsRegion: 'us-east-1',
    eventSourceARN: 'arn:stream',
    dynamodb: {
      SequenceNumber: 'seq-1',
      NewImage: {
        task_id: { S: 'task-1' },
        user_id: { S: 'user-1' },
        team_ids: { L: [{ S: 'Platform' }] },
        status: { S: 'COMPLETED' },
        cost_usd: { S: '8.5' },
        completed_at: { S: '2026-08-18T12:00:00Z' },
      },
    },
  };
}

afterEach(() => {
  jest.dontMock('../../src/handlers/shared/ua');
  delete process.env.BUDGET_TABLE_NAME;
  jest.restoreAllMocks();
});

describe('budget rollup handler', () => {
  test('is a no-op when the optional budget table is not wired', async () => {
    const rollup = await loadRollup({ enabled: false });

    await expect(rollup.rollupTaskCost(record())).resolves.toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('parses terminal task cost and team scopes', async () => {
    const rollup = await loadRollup();
    expect(rollup.parseTaskCostEvent(record())).toEqual({
      taskId: 'task-1',
      userId: 'user-1',
      teamIds: ['Platform'],
      period: '2026-08',
      costUsd: 8.5,
    });
  });

  test('writes one transaction and emits the 80 percent threshold once', async () => {
    const rollup = await loadRollup();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    sendMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Responses: {
          Budgets: [
            {
              scope_key: 'USER#user-1',
              period: 'CONFIG',
              monthly_limit_usd: 10,
              hard_stop: true,
            },
            {
              scope_key: 'USER#user-1',
              period: '2026-08',
              spend_usd: 8.5,
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    const result = await rollup.rollupTaskCost(record());

    expect(result).toBe(true);
    const transaction = sendMock.mock.calls[0][0];
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems[0].Put.Item.scope_key).toBe('TASK#task-1');
    for (const item of transaction.input.TransactItems.slice(1)) {
      expect(item.Update.UpdateExpression).toContain('#ttl = :ttl');
      expect(item.Update.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    }
    expect(stdout.mock.calls.map(call => String(call[0])).join('')).toContain('"Threshold":"80"');
  });

  test('treats an existing task marker as an idempotent replay', async () => {
    const rollup = await loadRollup();
    const canceled = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
    });
    sendMock
      .mockRejectedValueOnce(canceled)
      .mockResolvedValueOnce({ Item: { scope_key: 'TASK#task-1' } })
      .mockResolvedValueOnce({ Responses: { Budgets: [] } });

    const result = await rollup.rollupTaskCost(record());

    expect(result).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  test('retries threshold claims after the spend transaction already committed', async () => {
    const rollup = await loadRollup();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const canceled = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
    });
    sendMock
      // First delivery: spend commits, then the read needed for alerts fails.
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('read throttled'))
      // Retry: marker proves the spend is already applied.
      .mockRejectedValueOnce(canceled)
      .mockResolvedValueOnce({ Item: { scope_key: 'TASK#task-1' } })
      .mockResolvedValueOnce({
        Responses: {
          Budgets: [
            {
              scope_key: 'USER#user-1',
              period: 'CONFIG',
              monthly_limit_usd: 10,
              hard_stop: true,
            },
            {
              scope_key: 'USER#user-1',
              period: '2026-08',
              spend_usd: 8.5,
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    await expect(rollup.rollupTaskCost(record())).rejects.toThrow('read throttled');
    await expect(rollup.rollupTaskCost(record())).resolves.toBe(false);

    expect(stdout.mock.calls.map(call => String(call[0])).join('')).toContain('"Threshold":"80"');
  });

  test('throws so the shared stream consumer retries the record', async () => {
    const rollup = await loadRollup();
    sendMock.mockRejectedValue(new Error('ddb unavailable'));

    await expect(rollup.rollupTaskCost(record())).rejects.toThrow('ddb unavailable');
  });
});
