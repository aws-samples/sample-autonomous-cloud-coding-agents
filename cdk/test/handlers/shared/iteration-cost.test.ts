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

const send = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { sumIterationCostForIssue } from '../../../src/handlers/shared/iteration-cost';

const ddb = { send } as unknown as DynamoDBDocumentClient;

const call = (over: Partial<Parameters<typeof sumIterationCostForIssue>[0]> = {}) =>
  sumIterationCostForIssue({
    ddb, taskTableName: 'Tasks', linearIssueId: 'issue-1', thisTaskId: 'task-this', ...over,
  });

/** A Query page listing task ids, optionally with a continuation key. */
const page = (ids: string[], last?: Record<string, unknown>) => ({
  Items: ids.map((task_id) => ({ task_id })),
  ...(last && { LastEvaluatedKey: last }),
});

const isQuery = (c: { _type?: string }) => c._type === 'Query';

beforeEach(() => {
  send.mockReset();
});

describe('sumIterationCostForIssue', () => {
  test('sums prior tasks plus this task, and reports a COMPLETE total', async () => {
    send
      .mockResolvedValueOnce(page(['task-a', 'task-this']))
      .mockResolvedValueOnce({ Item: { cost_usd: 1.5 } }); // task-a

    await expect(call({ thisCost: 0.25 })).resolves.toEqual({ total: 1.75, partial: false });
    // this task's cost comes from the argument, so no GetItem is spent on it
    expect(send.mock.calls.filter(([c]) => !isQuery(c))).toHaveLength(1);
  });

  test('FOLLOWS the Query pagination cursor — a total must not stop at one 1 MB page', async () => {
    // The pre-refactor version summed a single page as though it were everything,
    // so past the page boundary the user saw a silently short total.
    send
      .mockResolvedValueOnce(page(['task-a'], { task_id: 'task-a' }))
      .mockResolvedValueOnce(page(['task-b']))
      .mockResolvedValueOnce({ Item: { cost_usd: 2 } })
      .mockResolvedValueOnce({ Item: { cost_usd: 3 } });

    await expect(call()).resolves.toEqual({ total: 5, partial: false });
    expect(send.mock.calls.filter(([c]) => isQuery(c))).toHaveLength(2);
  });

  test('a string cost_usd is parsed, not concatenated or turned into NaN', async () => {
    // One of the two pre-refactor copies added a stringified cost without a finite
    // check, which poisoned the whole total to NaN.
    send
      .mockResolvedValueOnce(page(['task-a']))
      .mockResolvedValueOnce({ Item: { cost_usd: '2.5' } });

    await expect(call()).resolves.toEqual({ total: 2.5, partial: false });
  });

  test('an unparseable cost is skipped rather than poisoning the total', async () => {
    send
      .mockResolvedValueOnce(page(['task-a', 'task-b']))
      .mockResolvedValueOnce({ Item: { cost_usd: 'not-a-number' } })
      .mockResolvedValueOnce({ Item: { cost_usd: 4 } });

    await expect(call()).resolves.toEqual({ total: 4, partial: false });
  });

  test('the row cap BOUNDS the GetItem fan-out and reports PARTIAL, even within one page', async () => {
    // A single Query page can hold far more than the cap: the projection is
    // task_id alone, so ~1 MB is a great many rows. Stopping pagination is not
    // enough — the cap must also trim the id list the reads iterate, or a
    // pathological issue still fans out over the whole page inside one invocation.
    send
      .mockResolvedValueOnce(page(Array.from({ length: 900 }, (_, i) => `t${i}`)))
      .mockResolvedValue({ Item: { cost_usd: 1 } });

    const res = await call();
    expect(res.partial).toBe(true);
    expect(res.total).toBe(500);
    expect(send.mock.calls.filter(([c]) => !isQuery(c))).toHaveLength(500);
  });

  test('the cap applies across pages too', async () => {
    send
      .mockResolvedValueOnce(page(Array.from({ length: 400 }, (_, i) => `t${i}`), { task_id: 't399' }))
      .mockResolvedValueOnce(page(Array.from({ length: 400 }, (_, i) => `u${i}`)))
      .mockResolvedValue({ Item: { cost_usd: 1 } });

    const res = await call();
    expect(res.partial).toBe(true);
    expect(res.total).toBe(500);
    // stops after the page that crosses the cap — a third Query is never issued
    expect(send.mock.calls.filter(([c]) => isQuery(c))).toHaveLength(2);
  });

  test('a failed read reports PARTIAL and still returns what it has', async () => {
    send
      .mockResolvedValueOnce(page(['task-a', 'task-b']))
      .mockResolvedValueOnce({ Item: { cost_usd: 1 } })
      .mockRejectedValueOnce(new Error('throttled'));

    await expect(call({ thisCost: 0.5 })).resolves.toEqual({ total: 1.5, partial: true });
  });

  test('a failed Query reports PARTIAL and falls back to this task alone', async () => {
    send.mockRejectedValueOnce(new Error('index unavailable'));
    await expect(call({ thisCost: 0.75 })).resolves.toEqual({ total: 0.75, partial: true });
  });

  test('nothing known → null total, not a misleading $0', async () => {
    send.mockResolvedValueOnce(page([]));
    await expect(call()).resolves.toEqual({ total: null, partial: false });
  });

  test('this task is counted once even when the GSI already lists it', async () => {
    send.mockResolvedValueOnce(page(['task-this']));
    await expect(call({ thisCost: 3 })).resolves.toEqual({ total: 3, partial: false });
    expect(send.mock.calls.filter(([c]) => !isQuery(c))).toHaveLength(0);
  });

  test('queries the LinearIssueIndex for the issue, projecting only task_id', async () => {
    send.mockResolvedValueOnce(page([]));
    await call();
    const [[cmd]] = send.mock.calls;
    expect(cmd.input).toMatchObject({
      TableName: 'Tasks',
      IndexName: 'LinearIssueIndex',
      KeyConditionExpression: 'linear_issue_id = :iid',
      ProjectionExpression: 'task_id',
      ExpressionAttributeValues: { ':iid': 'issue-1' },
    });
  });
});
