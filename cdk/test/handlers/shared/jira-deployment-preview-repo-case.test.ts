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

// GitHub answers to every letter case of a repository name and reports its own spelling.

import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deliverJiraDeploymentPreview } from '../../../src/handlers/shared/jira-deployment-preview';
import { postIssueCommentAdf } from '../../../src/handlers/shared/jira-feedback';
import { updateJiraIterationComment } from '../../../src/handlers/shared/jira-iteration-comment';
import type { TaskRecord } from '../../../src/handlers/shared/types';

jest.mock('../../../src/handlers/shared/jira-feedback', () => ({
  ...jest.requireActual('../../../src/handlers/shared/jira-feedback'),
  postIssueCommentAdf: jest.fn(),
}));
jest.mock('../../../src/handlers/shared/jira-iteration-comment', () => ({
  ...jest.requireActual('../../../src/handlers/shared/jira-iteration-comment'),
  updateJiraIterationComment: jest.fn(),
}));
const post = jest.mocked(postIssueCommentAdf);
const iteration = jest.mocked(updateJiraIterationComment);

const taskOf = (repo: string): TaskRecord => ({
  task_id: 'original',
  user_id: 'user-1',
  status: 'COMPLETED',
  repo,
  branch_name: 'bgagent/original/eng-42',
  channel_source: 'jira',
  head_sha: 'initial',
  channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'ENG-42' },
  status_created_at: 'COMPLETED#2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});
const iterationOf = (repo: string): TaskRecord => ({
  ...taskOf(repo),
  task_id: 'iteration',
  head_sha: 'deployed',
  channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'ENG-42', trigger_comment_id: 'trigger', iteration_reply_comment_id: '200' },
});

let onTheIssue: TaskRecord[];
const send = jest.fn(async (command: unknown) => {
  if (command instanceof QueryCommand) return { Items: onTheIssue };
  if (command instanceof GetCommand) return { Item: onTheIssue.find((task) => task.task_id === command.input.Key!.task_id) };
  if (command instanceof UpdateCommand) return {};
  throw new Error('Unexpected command');
});
const ddb = { send } as unknown as DynamoDBDocumentClient;
const updates = () => send.mock.calls.filter(([command]) => command instanceof UpdateCommand);

const deliver = (task: TaskRecord, sha: string) => deliverJiraDeploymentPreview(
  ddb, 'tasks', 'registry', task, 'owner/repo', sha, 'https://cdn.example.com/shot.png', 'https://preview.example.com', () => 30_000,
);

beforeEach(() => {
  jest.clearAllMocks();
  onTheIssue = [];
  post.mockResolvedValue({ ok: true, commentId: '123' });
  iteration.mockResolvedValue({ ok: true });
});

test('a task whose blueprint spells the repository in another letter case gets its Jira preview', async () => {
  await deliver(taskOf('Owner/Repo'), 'initial');

  expect(post).toHaveBeenCalledWith(expect.objectContaining({ cloudId: 'cloud' }), 'ENG-42', expect.objectContaining({ type: 'doc' }));
});

test('an iteration whose repository is spelled in another letter case gets the preview of its commit', async () => {
  onTheIssue = [iterationOf('Owner/Repo')];

  await deliver(taskOf('owner/repo'), 'deployed');

  expect(iteration).toHaveBeenCalledWith(ddb, 'tasks', 'iteration', expect.anything(), 'ENG-42', '200', undefined, expect.anything());
  expect(post).not.toHaveBeenCalled();
});

test('an iteration of another repository on the same Jira issue is not taken for the deployed commit', async () => {
  onTheIssue = [iterationOf('owner/other-repo')];

  await deliver(taskOf('owner/repo'), 'deployed');

  expect(updates()).toHaveLength(0);
  expect(iteration).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});
