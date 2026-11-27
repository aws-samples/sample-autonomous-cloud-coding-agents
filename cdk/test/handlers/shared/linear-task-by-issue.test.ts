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

import { lookupRunningTaskInSession, lookupTaskByLinearIssue } from '../../../src/handlers/shared/linear-task-by-issue';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('lookupTaskByLinearIssue', () => {
  const send = jest.fn();
  const ddb = { send } as never;

  beforeEach(() => send.mockReset());

  test('queries LinearIssueIndex descending (newest task) and maps the row', async () => {
    send.mockResolvedValueOnce({
      Items: [{ task_id: 'T9', user_id: 'u1', repo: 'o/r', pr_number: 42, status: 'COMPLETED' }],
    });

    const found = await lookupTaskByLinearIssue(ddb, 'TaskTable', 'issue-uuid');

    expect(found).toEqual({
      kind: 'found',
      task: { task_id: 'T9', user_id: 'u1', repo: 'o/r', pr_number: 42, status: 'COMPLETED' },
    });
    const input = send.mock.calls[0][0].input;
    expect(input.IndexName).toBe('LinearIssueIndex');
    expect(input.KeyConditionExpression).toContain('linear_issue_id');
    expect(input.ExpressionAttributeValues[':iid']).toBe('issue-uuid');
    expect(input.ScanIndexForward).toBe(false); // newest first
    expect(input.Limit).toBe(1);
  });

  // A miss and a failure are different answers: the comment path tells the user
  // "no task is linked to this issue" for the first and "the lookup failed" for
  // the second. Reporting a failed query as a miss is a guess presented as a fact.
  test('GSI miss (no rows) → none', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    expect(await lookupTaskByLinearIssue(ddb, 'TaskTable', 'x')).toEqual({ kind: 'none' });
  });

  test('query error → error with its message, not a miss', async () => {
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await lookupTaskByLinearIssue(ddb, 'TaskTable', 'x')).toEqual({ kind: 'error', message: 'AccessDenied' });
  });

  test('omits absent optional fields', async () => {
    send.mockResolvedValueOnce({ Items: [{ task_id: 'T1' }] });
    expect(await lookupTaskByLinearIssue(ddb, 'TaskTable', 'x')).toEqual({ kind: 'found', task: { task_id: 'T1' } });
  });
});

describe('lookupRunningTaskInSession', () => {
  const send = jest.fn();
  const ddb = { send } as never;
  const row = (taskId: string, status: string, session?: string) => ({
    task_id: taskId, status, channel_metadata: { linear_workspace_id: 'org-1', ...(session && { linear_agent_session_id: session }) },
  });

  beforeEach(() => send.mockReset());

  test('finds the running task of this session, not the newest task on the issue', async () => {
    send.mockResolvedValueOnce({ Items: [row('t-new', 'RUNNING'), row('t-old', 'AWAITING_APPROVAL', 'session-1'), row('t-done', 'COMPLETED', 'session-1')] });
    await expect(lookupRunningTaskInSession(ddb, 'TaskTable', 'issue-1', 'session-1')).resolves.toBe('t-old');
    const input = send.mock.calls[0][0].input;
    expect(input.IndexName).toBe('LinearIssueIndex');
    expect(input.ExpressionAttributeValues[':iid']).toBe('issue-1');
  });

  test('null when the session has no running task, and the query error is thrown', async () => {
    send.mockResolvedValueOnce({ Items: [row('t-done', 'COMPLETED', 'session-1'), row('t-other', 'RUNNING', 'session-2')] });
    await expect(lookupRunningTaskInSession(ddb, 'TaskTable', 'issue-1', 'session-1')).resolves.toBeNull();
    send.mockRejectedValueOnce(new Error('Throttled'));
    await expect(lookupRunningTaskInSession(ddb, 'TaskTable', 'issue-1', 'session-1')).rejects.toThrow('Throttled');
  });
});
