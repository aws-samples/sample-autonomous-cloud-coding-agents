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

import {
  prNumberFromTask,
  resolveTaskByLinearIssue,
} from '../../../src/handlers/shared/linear-task-by-issue';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('resolveTaskByLinearIssue', () => {
  const send = jest.fn();
  const ddb = { send } as never;

  beforeEach(() => send.mockReset());

  test('queries LinearIssueIndex descending (newest task) and maps the row', async () => {
    send.mockResolvedValueOnce({
      Items: [{ task_id: 'T9', user_id: 'u1', repo: 'o/r', pr_number: 42, status: 'COMPLETED' }],
    });

    const task = await resolveTaskByLinearIssue(ddb, 'TaskTable', 'issue-uuid');

    expect(task).toEqual({ task_id: 'T9', user_id: 'u1', repo: 'o/r', pr_number: 42, status: 'COMPLETED' });
    const input = send.mock.calls[0][0].input;
    expect(input.IndexName).toBe('LinearIssueIndex');
    expect(input.KeyConditionExpression).toContain('linear_issue_id');
    expect(input.ExpressionAttributeValues[':iid']).toBe('issue-uuid');
    expect(input.ScanIndexForward).toBe(false); // newest first
    expect(input.Limit).toBe(1);
  });

  test('GSI miss (no rows) → null', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    expect(await resolveTaskByLinearIssue(ddb, 'TaskTable', 'x')).toBeNull();
  });

  test('query error → null (swallowed, treated as non-ABCA issue)', async () => {
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await resolveTaskByLinearIssue(ddb, 'TaskTable', 'x')).toBeNull();
  });

  test('omits absent optional fields', async () => {
    send.mockResolvedValueOnce({ Items: [{ task_id: 'T1' }] });
    const task = await resolveTaskByLinearIssue(ddb, 'TaskTable', 'x');
    expect(task).toEqual({ task_id: 'T1' });
  });
});

describe('prNumberFromTask', () => {
  test('prefers numeric pr_number', () => {
    expect(prNumberFromTask({ task_id: 'T', pr_number: 7, pr_url: 'https://github.com/o/r/pull/9' })).toBe(7);
  });

  test('falls back to parsing pr_url', () => {
    expect(prNumberFromTask({ task_id: 'T', pr_url: 'https://github.com/o/r/pull/123' })).toBe(123);
  });

  test('null when neither yields a number', () => {
    expect(prNumberFromTask({ task_id: 'T' })).toBeNull();
    expect(prNumberFromTask({ task_id: 'T', pr_url: 'https://github.com/o/r/tree/main' })).toBeNull();
  });
});
