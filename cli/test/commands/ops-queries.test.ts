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

import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand as DocQueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { findStuckTasks, buildConcurrencyReport, countActiveTasksForUser } from '../../src/ops-queries';

const lowLevelSend = jest.fn();
const docSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: lowLevelSend })),
  };
});

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: docSend })),
    },
  };
});

describe('ops-queries', () => {
  beforeEach(() => {
    lowLevelSend.mockReset();
    docSend.mockReset();
  });

  test('findStuckTasks returns parsed task rows', async () => {
    const oldCreated = new Date(Date.now() - 3600_000).toISOString();
    lowLevelSend.mockResolvedValue({
      Items: [{
        task_id: { S: 'task-1' },
        user_id: { S: 'user-1' },
        created_at: { S: oldCreated },
        repo: { S: 'acme/a' },
      }],
    });

    const tasks = await findStuckTasks('us-east-1', 'TaskTable');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].task_id).toBe('task-1');
    expect(tasks[0].repo).toBe('acme/a');
  });

  test('findStuckTasks queries StatusIndex for each stuck status', async () => {
    lowLevelSend.mockResolvedValue({ Items: [] });

    await findStuckTasks('us-east-1', 'TaskTable', {
      strandedTimeoutSeconds: 600,
      approvalTimeoutSeconds: 3600,
    });

    expect(lowLevelSend).toHaveBeenCalledTimes(3);
    const statuses = lowLevelSend.mock.calls.map((call) => {
      const cmd = call[0] as QueryCommand;
      return cmd.input.ExpressionAttributeValues?.[':status']?.S;
    });
    expect(statuses.sort()).toEqual(['AWAITING_APPROVAL', 'HYDRATING', 'SUBMITTED']);
  });

  test('findStuckTasks skips malformed items', async () => {
    lowLevelSend.mockResolvedValue({
      Items: [{ task_id: { S: 'partial' } }],
    });

    const tasks = await findStuckTasks('us-east-1', 'TaskTable');
    expect(tasks).toHaveLength(0);
  });

  test('findStuckTasks omits optional repo field', async () => {
    const oldCreated = new Date(Date.now() - 3600_000).toISOString();
    lowLevelSend.mockResolvedValue({
      Items: [{
        task_id: { S: 'task-2' },
        user_id: { S: 'user-2' },
        created_at: { S: oldCreated },
      }],
    });

    const tasks = await findStuckTasks('us-east-1', 'TaskTable');
    expect(tasks[0]?.repo).toBeUndefined();
  });

  test('countActiveTasksForUser paginates UserStatusIndex', async () => {
    docSend
      .mockResolvedValueOnce({
        Items: [{ status: 'RUNNING' }],
        LastEvaluatedKey: { user_id: 'user-1' },
      })
      .mockResolvedValueOnce({
        Items: [{ status: 'HYDRATING' }],
      });

    const count = await countActiveTasksForUser('us-east-1', 'TaskTable', 'user-1');
    expect(count).toBe(2);
  });

  test('findStuckTasks paginates StatusIndex query', async () => {
    const oldCreated = new Date(Date.now() - 3600_000).toISOString();
    lowLevelSend
      .mockResolvedValueOnce({
        Items: [{
          task_id: { S: 'task-1' },
          user_id: { S: 'user-1' },
          created_at: { S: oldCreated },
        }],
        LastEvaluatedKey: { task_id: { S: 'task-1' } },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValue({ Items: [] });

    const tasks = await findStuckTasks('us-east-1', 'TaskTable');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(lowLevelSend.mock.calls.length).toBeGreaterThan(3);
  });

  test('buildConcurrencyReport skips rows without user_id', async () => {
    docSend
      .mockResolvedValueOnce({
        Items: [{ active_count: 1 }, { user_id: 'user-1', active_count: 1 }],
      })
      .mockResolvedValueOnce({ Items: [] });

    const rows = await buildConcurrencyReport('us-east-1', 'TaskTable', 'ConcurrencyTable', 3);
    expect(rows).toHaveLength(1);
  });

  test('buildConcurrencyReport paginates scan and query', async () => {
    docSend
      .mockResolvedValueOnce({
        Items: [{ user_id: 'user-1', active_count: 1 }],
        LastEvaluatedKey: { user_id: 'user-1' },
      })
      .mockResolvedValueOnce({ Items: [{ status: 'RUNNING' }] })
      .mockResolvedValueOnce({
        Items: [{ user_id: 'user-2', active_count: 0 }],
      })
      .mockResolvedValueOnce({ Items: [] });

    const rows = await buildConcurrencyReport('us-east-1', 'TaskTable', 'ConcurrencyTable', 3);
    expect(rows).toHaveLength(2);
  });

  test('buildConcurrencyReport compares stored and actual counts', async () => {
    docSend
      .mockResolvedValueOnce({
        Items: [{ user_id: 'user-1', active_count: 1 }],
      })
      .mockResolvedValueOnce({
        Items: [{ status: 'RUNNING' }, { status: 'HYDRATING' }],
      });

    const rows = await buildConcurrencyReport('us-east-1', 'TaskTable', 'ConcurrencyTable', 3);
    expect(rows).toEqual([{
      user_id: 'user-1',
      stored_count: 1,
      actual_count: 2,
      limit: 3,
      drift: -1,
    }]);

    const scanCmd = docSend.mock.calls[0][0] as ScanCommand;
    expect(scanCmd.input.TableName).toBe('ConcurrencyTable');
    const queryCmd = docSend.mock.calls[1][0] as DocQueryCommand;
    expect(queryCmd.input.IndexName).toBe('UserStatusIndex');
  });
});
