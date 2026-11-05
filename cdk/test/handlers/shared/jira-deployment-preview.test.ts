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

import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deliverJiraDeploymentPreview } from '../../../src/handlers/shared/jira-deployment-preview';
import { postIssueCommentAdf, updateIssueCommentAdf } from '../../../src/handlers/shared/jira-feedback';
import { updateJiraIterationComment } from '../../../src/handlers/shared/jira-preview';
import { INTEGRATION_NODE_SUFFIX } from '../../../src/handlers/shared/orchestration-integration-node';
import type { TaskRecord } from '../../../src/handlers/shared/types';

jest.mock('../../../src/handlers/shared/jira-feedback', () => ({
  ...jest.requireActual('../../../src/handlers/shared/jira-feedback'),
  postIssueCommentAdf: jest.fn(),
  updateIssueCommentAdf: jest.fn(),
}));
jest.mock('../../../src/handlers/shared/jira-preview', () => ({
  ...jest.requireActual('../../../src/handlers/shared/jira-preview'),
  updateJiraIterationComment: jest.fn(),
}));
const post = jest.mocked(postIssueCommentAdf);
const edit = jest.mocked(updateIssueCommentAdf);
const iteration = jest.mocked(updateJiraIterationComment);
const original = {
  task_id: 'original',
  repo: 'owner/repo',
  channel_source: 'jira',
  head_sha: 'initial',
  channel_metadata: { jira_cloud_id: 'cloud', jira_issue_key: 'ENG-42' },
} as TaskRecord;
const shot = 'https://cdn.example.com/shot.png';
const preview = 'https://preview.example.com';
let records: Record<string, TaskRecord>;
let candidates: TaskRecord[];
const defaultSend = async (command: any) => {
  if (command instanceof QueryCommand) return { Items: candidates };
  if (command instanceof GetCommand) return { Item: records[command.input.Key!.task_id] };
  if (command instanceof UpdateCommand) {
    const id = command.input.Key!.task_id;
    const values = command.input.ExpressionAttributeValues!;
    const task = records[id];
    if (values[':yes']) {
      if (task.jira_preview_claimed) throw Object.assign(new Error('claimed'), { name: 'ConditionalCheckFailedException' });
      records[id] = { ...task, jira_preview_claimed: true };
    } else if (values[':id']) {
      records[id] = { ...task, jira_preview_comment_id: values[':id'] };
    } else {
      records[id] = { ...task, screenshot_url: values[':s'], screenshot_preview_url: values[':p'] };
    }
    return {};
  }
  throw new Error('Unexpected command');
};
const send = jest.fn(defaultSend);
const ddb = { send } as unknown as DynamoDBDocumentClient;
const deliver = (task = original, sha = 'initial') => deliverJiraDeploymentPreview(ddb, 'tasks', 'registry', task, 'owner/repo', sha, shot, preview, () => 30_000);

beforeEach(() => {
  jest.clearAllMocks();
  send.mockReset().mockImplementation(defaultSend);
  records = { original: structuredClone(original) };
  candidates = [];
  post.mockResolvedValue({ ok: true, commentId: '123' });
  edit.mockResolvedValue({ ok: true });
  iteration.mockResolvedValue({ ok: true });
});

test('standalone Jira task posts ADF screenshot and live links on its stored issue', async () => {
  await deliver();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ cloudId: 'cloud', registryTableName: 'registry' }), 'ENG-42', expect.objectContaining({ type: 'doc' }));
  expect(JSON.stringify(post.mock.calls[0][2])).toContain('Open screenshot');
  expect(records.original.jira_preview_comment_id).toBe('123');
});

test('duplicate and concurrent deployments create only one Jira comment', async () => {
  // Exactly two deliveries exercise the claim race.
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  await Promise.all([deliver(), deliver()]);
  await deliver();
  expect(post).toHaveBeenCalledTimes(1);
  expect(edit).toHaveBeenCalledTimes(1);
});

test('iteration attribution uses the matching SHA, not the newest task', async () => {
  const make = (id: string, sha: string) => ({
    ...original,
    task_id: id,
    head_sha: sha,
    channel_metadata: { ...original.channel_metadata, trigger_comment_id: 'trigger', iteration_reply_comment_id: id, trigger_comment_issue_id: 'PARENT-1' },
  });
  const older = make('200', 'deployed');
  const newer = make('201', 'newer');
  candidates = [newer, older];
  records['200'] = older;
  records['201'] = newer;
  await deliver(original, 'deployed');
  expect(iteration).toHaveBeenCalledWith(ddb, 'tasks', '200', expect.anything(), 'PARENT-1', '200', undefined, expect.anything());
  expect(records['200'].screenshot_url).toBe(shot);
  expect(records['201'].screenshot_url).toBeUndefined();
  expect(post).not.toHaveBeenCalled();
});

test('missing iteration acknowledgement never creates a competing preview comment', async () => {
  const task = { ...original, channel_metadata: { ...original.channel_metadata, trigger_comment_id: 'trigger' } };
  await deliver(task);
  expect(iteration).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test('synthetic integration nodes leave delivery to the parent rollup', async () => {
  await deliver({ ...original, channel_metadata: { ...original.channel_metadata, orchestration_sub_issue_id: INTEGRATION_NODE_SUFFIX } });
  expect(send).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test.each(['linear', 'github', 'cli'])('never routes a %s task to Jira', async (source) => {
  await deliver({ ...original, channel_source: source } as TaskRecord);
  expect(send).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test.each([
  { ...original, channel_metadata: {} },
  { ...original, repo: 'different/repo' },
  { ...original, channel_metadata: { ...original.channel_metadata, jira_issue_key: 'orch__integration' } },
])('missing metadata and repository mismatches fail closed', async (task) => {
  await expect(deliver(task)).resolves.toBeUndefined();
  expect(post).not.toHaveBeenCalled();
});

test('Jira delivery failure never fails the deployment and is not blindly reposted', async () => {
  post.mockResolvedValueOnce({ ok: false, retryable: true });
  await expect(deliver()).resolves.toBeUndefined();
  await deliver();
  expect(post).toHaveBeenCalledTimes(1);
});

test('an unknown deployment SHA cannot be assigned to the original task while the iteration index lags', async () => {
  await deliver(original, 'unknown');
  expect(post).not.toHaveBeenCalled();
  expect(iteration).not.toHaveBeenCalled();
});

test('iteration lookup follows pagination before choosing the SHA owner', async () => {
  const matching = { ...original, task_id: '200', head_sha: 'deployed', channel_metadata: { ...original.channel_metadata, trigger_comment_id: 'trigger', iteration_reply_comment_id: '200' } };
  records['200'] = matching;
  candidates = [matching];
  send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { task_id: 'previous-page' } } as never);
  await deliver(original, 'deployed');
  expect(iteration).toHaveBeenCalledWith(ddb, 'tasks', '200', expect.anything(), 'ENG-42', '200', undefined, expect.anything());
  const queries = send.mock.calls.filter(([command]) => command instanceof QueryCommand);
  expect(queries).toHaveLength(2);
  expect(queries[1][0].input.ExclusiveStartKey).toEqual({ task_id: 'previous-page' });
});

test('a no-change question cannot take the original deployment preview', async () => {
  const question = { ...original, task_id: 'question', code_changed: false, channel_metadata: { ...original.channel_metadata, trigger_comment_id: 'trigger', iteration_reply_comment_id: '200' } };
  records.question = question;
  candidates = [question];
  await deliver();
  expect(post).toHaveBeenCalledTimes(1);
  expect(iteration).not.toHaveBeenCalled();
});

test('the standalone claim is conditional on an absent claim attribute', async () => {
  await deliver();
  const claim = send.mock.calls.find(([command]) => command.input.ExpressionAttributeValues?.[':yes'])![0];
  expect(claim.input.ConditionExpression).toBe('attribute_exists(task_id) AND attribute_not_exists(jira_preview_claimed)');
});

test('an iteration with a synthetic reply target never calls Jira', async () => {
  await deliver({
    ...original,
    channel_metadata: {
      ...original.channel_metadata,
      trigger_comment_id: 'trigger',
      iteration_reply_comment_id: '123',
      trigger_comment_issue_id: 'orch__integration',
    },
  });
  expect(iteration).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test('untrusted screenshots are rejected before claiming or posting', async () => {
  await deliverJiraDeploymentPreview(ddb, 'tasks', 'registry', original, 'owner/repo', 'initial', 'https://localhost/a', preview, () => 30_000);
  expect(send).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test('delivery skips all requests when the processor budget is exhausted', async () => {
  await deliverJiraDeploymentPreview(ddb, 'tasks', 'registry', original, 'owner/repo', 'initial', shot, preview, () => 1_000);
  expect(send).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test('a hanging SDK request cannot run past the processor budget or start a later POST', async () => {
  jest.useFakeTimers();
  try {
    send.mockImplementationOnce(() => new Promise(() => {}));
    const delivery = deliverJiraDeploymentPreview(ddb, 'tasks', 'registry', original, 'owner/repo', 'initial', shot, preview, () => 3_000);
    await jest.advanceTimersByTimeAsync(1_500);
    await expect(delivery).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('lookup caps page count and still delivers a known original SHA', async () => {
  for (let i = 0; i < 10; i++) send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { task_id: `page-${i}` } } as never);
  await deliver();
  expect(send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(10);
  expect(post).toHaveBeenCalledTimes(1);
  send.mockReset().mockImplementation(defaultSend);
});

test('lookup caps total candidate reads across pages', async () => {
  const candidate = { ...original, task_id: 'iteration', head_sha: 'other', channel_metadata: { ...original.channel_metadata, trigger_comment_id: 'trigger' } };
  records.iteration = candidate;
  send.mockImplementation(async (command) => command instanceof QueryCommand
    ? { Items: Array(25).fill(candidate), LastEvaluatedKey: { task_id: 'next' } } as never
    : defaultSend(command));
  await deliver();
  expect(send.mock.calls.filter(([command]) => command instanceof GetCommand)).toHaveLength(25);
  expect(post).toHaveBeenCalledTimes(1);
  send.mockReset().mockImplementation(defaultSend);
});

test('an iteration without a deployment SHA cannot receive preview feedback', async () => {
  await deliver({
    ...original,
    head_sha: undefined,
    channel_metadata: {
      ...original.channel_metadata, trigger_comment_id: 'trigger', iteration_reply_comment_id: '123',
    },
  });
  expect(iteration).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test('a slow Jira POST is bounded and its uncertain claim is not repeated', async () => {
  jest.useFakeTimers();
  try {
    post.mockImplementationOnce(() => new Promise(() => {}));
    const delivery = deliver();
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(delivery).resolves.toBeUndefined();
    expect(records.original.jira_preview_claimed).toBe(true);
    expect(records.original.jira_preview_comment_id).toBeUndefined();
    await deliver();
    expect(post).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('rechecks the remaining processor budget between lookup and persistence', async () => {
  let remaining = 30_000;
  send.mockImplementationOnce(async () => {
    remaining = 1_000;
    return { Items: [] };
  });
  await deliverJiraDeploymentPreview(ddb, 'tasks', 'registry', original, 'owner/repo', 'initial', shot, preview, () => remaining);
  expect(send).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});
