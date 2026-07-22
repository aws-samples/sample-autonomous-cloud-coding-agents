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
}));

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  jiraIssueIdentity,
  prNumberFromTask,
  resolveTaskByJiraIssue,
} from '../../../src/handlers/shared/jira-task-by-issue';

const ddb = { send } as unknown as DynamoDBDocumentClient;

beforeEach(() => {
  send.mockReset();
});

test('builds a tenant-scoped Jira issue identity', () => {
  expect(jiraIssueIdentity('cloud-1', 'ENG-42')).toBe('cloud-1#ENG-42');
});

test('returns the newest PR-producing task and uses JiraIssueIndex', async () => {
  send.mockResolvedValueOnce({
    Items: [{
      task_id: 'task-2',
      user_id: 'user-1',
      repo: 'org/repo',
      pr_number: 42,
      status: 'COMPLETED',
      channel_metadata: { jira_cloud_id: 'cloud-1', jira_issue_key: 'ENG-42' },
    }],
  });

  const result = await resolveTaskByJiraIssue(ddb, 'Tasks', 'cloud-1', 'ENG-42');

  expect(result).toMatchObject({ task_id: 'task-2', pr_number: 42, repo: 'org/repo' });
  expect(send.mock.calls[0][0].input).toMatchObject({
    TableName: 'Tasks',
    IndexName: 'JiraIssueIndex',
    ExpressionAttributeValues: { ':identity': 'cloud-1#ENG-42' },
    ScanIndexForward: false,
  });
});

test('skips newer PR-less tasks on the same page', async () => {
  send.mockResolvedValueOnce({
    Items: [
      { task_id: 'task-new', repo: 'org/repo' },
      { task_id: 'task-pr', repo: 'org/repo', pr_url: 'https://github.com/org/repo/pull/18' },
    ],
  });

  await expect(resolveTaskByJiraIssue(ddb, 'Tasks', 'cloud-1', 'ENG-42'))
    .resolves.toMatchObject({ task_id: 'task-pr', pr_url: expect.stringContaining('/pull/18') });
});

test('paginates past a PR-less first page', async () => {
  send
    .mockResolvedValueOnce({
      Items: [{ task_id: 'task-new', repo: 'org/repo' }],
      LastEvaluatedKey: { jira_issue_identity: 'cloud-1#ENG-42', created_at: '2026-01-02' },
    })
    .mockResolvedValueOnce({
      Items: [{ task_id: 'task-pr', repo: 'org/repo', pr_number: 17 }],
    });

  await expect(resolveTaskByJiraIssue(ddb, 'Tasks', 'cloud-1', 'ENG-42'))
    .resolves.toMatchObject({ task_id: 'task-pr', pr_number: 17 });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
    jira_issue_identity: 'cloud-1#ENG-42',
    created_at: '2026-01-02',
  });
});

test('returns null when no PR-producing task exists', async () => {
  send.mockResolvedValueOnce({ Items: [{ task_id: 'task-new' }] });
  await expect(resolveTaskByJiraIssue(ddb, 'Tasks', 'cloud-1', 'ENG-42')).resolves.toBeNull();
});

test('propagates query failures so the async processor can retry', async () => {
  send.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
  await expect(resolveTaskByJiraIssue(ddb, 'Tasks', 'cloud-1', 'ENG-42'))
    .rejects.toThrow('DynamoDB unavailable');
});

test.each([
  [{ pr_number: 12 }, 12],
  [{ pr_url: 'https://github.com/o/r/pull/99/files' }, 99],
  [{ pr_number: 0, pr_url: 'not-a-pr' }, null],
])('prNumberFromTask(%o) returns %p', (task, expected) => {
  expect(prNumberFromTask(task)).toBe(expected);
});
