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

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handleLinearApprovalReply } from '../../../src/handlers/shared/linear-approval-reply';
import { linearApprovalCommentId } from '../../../src/handlers/shared/linear-approval-thread';

const mockApprove = jest.fn();
const mockDeny = jest.fn();
const mockPost = jest.fn();
jest.mock('../../../src/handlers/approve-task.js', () => ({ recordApprovalForUser: mockApprove }), { virtual: true });
jest.mock('../../../src/handlers/deny-task.js', () => ({ recordDenialForUser: mockDeny }), { virtual: true });
jest.mock('../../../src/handlers/shared/linear-feedback', () => ({
  postIdentifiedComment: (...args: unknown[]) => mockPost(...args),
}));
const thread = { workspaceId: 'ws', issueId: 'issue', taskId: 'task', requestId: 'gate', userId: 'owner' };
const root = linearApprovalCommentId(thread);
const event = {
  action: 'create',
  organizationId: 'ws',
  actor: { id: 'actor' },
  data: { id: 'reply', body: 'approve', parentId: root, issueId: 'issue' },
};
const source = JSON.stringify(['linear', 'ws', 'reply']);
let approval: Record<string, unknown>;
let task: Record<string, unknown>;
const send = jest.fn();
const lookupUser = jest.fn();
const deps = {
  ddb: { send } as unknown as DynamoDBDocumentClient,
  approvalsTable: 'Approvals',
  taskTable: 'Tasks',
  registryTable: 'Registry',
  lookupUser,
};

beforeEach(() => {
  jest.clearAllMocks();
  approval = { user_id: 'owner', status: 'PENDING' };
  task = {
    user_id: 'owner',
    channel_source: 'linear',
    status: 'AWAITING_APPROVAL',
    channel_metadata: { linear_workspace_id: 'ws', linear_issue_id: 'issue' },
  };
  lookupUser.mockResolvedValue('owner');
  mockPost.mockResolvedValue({ ok: true });
  mockApprove.mockResolvedValue({ statusCode: 202 });
  mockDeny.mockResolvedValue({ statusCode: 202 });
  send.mockImplementation(async command => {
    if (command.input.UpdateExpression) return {};
    if (command.input.Key.task_id.startsWith('LINEAR_COMMENT#')) {
      return { Item: { kind: 'linear_approval_thread', thread } };
    }
    return { Item: command.input.TableName === 'Tasks' ? task : approval };
  });
});

test.each(['approve', 'deny'])('records %s for the bound request and mapped owner', async body => {
  expect(await handleLinearApprovalReply({ ...event, data: { ...event.data, body } }, deps)).toBe(true);
  const record = body === 'approve' ? mockApprove : mockDeny;
  expect(record).toHaveBeenCalledWith({
    userId: 'owner',
    taskId: 'task',
    decisionSource: source,
    body: JSON.stringify({ request_id: 'gate', decision: body }),
  });
  expect(mockPost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ issueId: 'issue', parentId: root }));
});

test.each(['update', 'remove'])('ignores %s events', async action => {
  expect(await handleLinearApprovalReply({ ...event, action }, deps)).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

test.each(['I approve', '> approve', 'approve and delete it', '@bgagent approve'])('ignores prose: %s', async body => {
  expect(await handleLinearApprovalReply({ ...event, data: { ...event.data, body } }, deps)).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

test('ignores top-level replies and unknown threads', async () => {
  expect(await handleLinearApprovalReply({ ...event, data: { ...event.data, parentId: undefined } }, deps)).toBe(false);
  send.mockResolvedValue({});
  expect(await handleLinearApprovalReply(event, deps)).toBe(false);
  expect(mockApprove).not.toHaveBeenCalled();
});

test.each([null, 'different-owner'])('rejects unmapped or different owner %s', async user => {
  lookupUser.mockResolvedValue(user);
  expect(await handleLinearApprovalReply(event, deps)).toBe(true);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(mockPost.mock.calls[0][1].body).toContain('Only the task owner');
});

test('does not act across workspaces or issues', async () => {
  expect(await handleLinearApprovalReply({ ...event, organizationId: 'other' }, deps)).toBe(false);
  expect(await handleLinearApprovalReply({ ...event, data: { ...event.data, issueId: 'other' } }, deps)).toBe(true);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});

test.each(['user_id', 'channel_source', 'channel_metadata'])('rejects changed task binding: %s', async field => {
  task[field] = 'changed';
  await handleLinearApprovalReply(event, deps);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(mockPost.mock.calls[0][1].body).toContain('no longer available');
});

test('acknowledges duplicate deliveries without recording again even after the task advances', async () => {
  approval = { user_id: 'owner', status: 'APPROVED', decision_source: source };
  task.status = 'SUCCEEDED';
  await handleLinearApprovalReply(event, deps);
  await handleLinearApprovalReply(event, deps);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(mockPost.mock.calls[0]).toEqual(mockPost.mock.calls[1]);
});

test.each([404, 409])('reports a closed or superseded gate (HTTP %s)', async statusCode => {
  mockApprove.mockResolvedValue({ statusCode });
  await handleLinearApprovalReply(event, deps);
  expect(mockPost.mock.calls[0][1].body).toContain('No new decision');
  expect(JSON.parse(mockApprove.mock.calls[0][0].body).request_id).toBe('gate');
});

test('recognizes a duplicate that committed concurrently', async () => {
  mockApprove.mockImplementation(async () => {
    approval = { user_id: 'owner', status: 'APPROVED', decision_source: source };
    return { statusCode: 404 };
  });
  await handleLinearApprovalReply(event, deps);
  expect(mockPost.mock.calls[0][1].body).toContain('Approved for this action once');
});

test('retries transient decision and acknowledgement failures', async () => {
  mockApprove.mockResolvedValue({ statusCode: 503 });
  await expect(handleLinearApprovalReply(event, deps)).rejects.toThrow('HTTP 503');
  mockApprove.mockResolvedValue({ statusCode: 202 });
  mockPost.mockResolvedValue({ ok: false, retryable: true });
  await expect(handleLinearApprovalReply(event, deps)).rejects.toThrow('acknowledgement failure');
});
