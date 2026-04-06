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
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateItemCommand: jest.fn((input: unknown) => ({ _type: 'UpdateItem', input })),
}));

// Set env vars before importing
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';

import { handler } from '../../src/handlers/reconcile-concurrency';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reconcile-concurrency handler', () => {
  test('completes without errors when no users exist', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await handler();
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('no update when stored count matches actual count', async () => {
    // Scan returns one user with active_count=2
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ user_id: { S: 'user-1' }, active_count: { N: '2' } }],
        LastEvaluatedKey: undefined,
      })
      // Query returns count=2 (matching)
      .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: undefined });

    await handler();

    // 1 scan + 1 query = 2 calls, no UpdateItemCommand
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    const calls = mockDdbSend.mock.calls;
    const updateCalls = calls.filter((c: any[]) => c[0]._type === 'UpdateItem');
    expect(updateCalls).toHaveLength(0);
  });

  test('fires UpdateItemCommand with ConditionExpression when count drifts', async () => {
    // Scan returns one user with active_count=5
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ user_id: { S: 'user-1' }, active_count: { N: '5' } }],
        LastEvaluatedKey: undefined,
      })
      // Query returns actual count=2 (drift)
      .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: undefined })
      // Update succeeds
      .mockResolvedValueOnce({});

    await handler();

    // 1 scan + 1 query + 1 update = 3 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(3);
    const updateCall = mockDdbSend.mock.calls[2][0];
    expect(updateCall._type).toBe('UpdateItem');
    // Verify ConditionExpression for TOCTOU protection
    expect(updateCall.input.ConditionExpression).toBe('active_count = :stored');
    expect(updateCall.input.ExpressionAttributeValues[':stored']).toEqual({ N: '5' });
    expect(updateCall.input.ExpressionAttributeValues[':count']).toEqual({ N: '2' });
  });

  test('continues to next user on ConditionalCheckFailedException', async () => {
    const condErr = new Error('Conditional check failed');
    condErr.name = 'ConditionalCheckFailedException';

    mockDdbSend
      // Scan returns two users
      .mockResolvedValueOnce({
        Items: [
          { user_id: { S: 'user-1' }, active_count: { N: '5' } },
          { user_id: { S: 'user-2' }, active_count: { N: '3' } },
        ],
        LastEvaluatedKey: undefined,
      })
      // User-1: query returns 2 (drift)
      .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: undefined })
      // User-1: update fails with CCF
      .mockRejectedValueOnce(condErr)
      // User-2: query returns 1 (drift)
      .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: undefined })
      // User-2: update succeeds
      .mockResolvedValueOnce({});

    await handler();

    // 1 scan + 2 queries + 2 updates = 5 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(5);
  });

  test('continues to next user when query fails', async () => {
    mockDdbSend
      // Scan returns two users
      .mockResolvedValueOnce({
        Items: [
          { user_id: { S: 'user-1' }, active_count: { N: '2' } },
          { user_id: { S: 'user-2' }, active_count: { N: '3' } },
        ],
        LastEvaluatedKey: undefined,
      })
      // User-1: query throws
      .mockRejectedValueOnce(new Error('DynamoDB timeout'))
      // User-2: query returns 3 (matches)
      .mockResolvedValueOnce({ Count: 3, LastEvaluatedKey: undefined });

    await handler();

    // 1 scan + 2 queries (one failed) = 3 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(3);
  });

  test('handles scan pagination', async () => {
    mockDdbSend
      // First scan page
      .mockResolvedValueOnce({
        Items: [{ user_id: { S: 'user-1' }, active_count: { N: '1' } }],
        LastEvaluatedKey: { user_id: { S: 'user-1' } },
      })
      // User-1 query
      .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: undefined })
      // Second scan page
      .mockResolvedValueOnce({
        Items: [{ user_id: { S: 'user-2' }, active_count: { N: '2' } }],
        LastEvaluatedKey: undefined,
      })
      // User-2 query
      .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: undefined });

    await handler();

    // 2 scans + 2 queries = 4 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(4);
  });

  test('handles query pagination for countActiveTasks', async () => {
    mockDdbSend
      // Scan
      .mockResolvedValueOnce({
        Items: [{ user_id: { S: 'user-1' }, active_count: { N: '0' } }],
        LastEvaluatedKey: undefined,
      })
      // First query page: count=3, has more
      .mockResolvedValueOnce({
        Count: 3,
        LastEvaluatedKey: { user_id: { S: 'user-1' }, task_id: { S: 'T3' } },
      })
      // Second query page: count=2, done
      .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: undefined })
      // Update (drift: stored=0 vs actual=5)
      .mockResolvedValueOnce({});

    await handler();

    // 1 scan + 2 queries + 1 update = 4 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(4);
    const updateCall = mockDdbSend.mock.calls[3][0];
    expect(updateCall._type).toBe('UpdateItem');
    expect(updateCall.input.ExpressionAttributeValues[':count']).toEqual({ N: '5' });
  });

  test('skips items without user_id', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ active_count: { N: '1' } }], // no user_id
      LastEvaluatedKey: undefined,
    });

    await handler();

    // Only the scan call, no query or update
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('continues to next user when UpdateItemCommand fails with non-CCF error', async () => {
    mockDdbSend
      // Scan returns two users with drift
      .mockResolvedValueOnce({
        Items: [
          { user_id: { S: 'user-1' }, active_count: { N: '5' } },
          { user_id: { S: 'user-2' }, active_count: { N: '4' } },
        ],
        LastEvaluatedKey: undefined,
      })
      // User-1: query returns 2 (drift)
      .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: undefined })
      // User-1: update fails with non-CCF error
      .mockRejectedValueOnce(new Error('InternalServerError'))
      // User-2: query returns 1 (drift)
      .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: undefined })
      // User-2: update succeeds
      .mockResolvedValueOnce({});

    await handler();

    // 1 scan + 2 queries + 2 updates = 5 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(5);
    // Verify user-2's update was still attempted and succeeded
    const updateCalls = mockDdbSend.mock.calls.filter((c: any[]) => c[0]._type === 'UpdateItem');
    expect(updateCalls).toHaveLength(2);
    // User-2's update should have the correct values
    const user2Update = updateCalls[1][0];
    expect(user2Update.input.Key).toEqual({ user_id: { S: 'user-2' } });
    expect(user2Update.input.ExpressionAttributeValues[':count']).toEqual({ N: '1' });
  });
});
