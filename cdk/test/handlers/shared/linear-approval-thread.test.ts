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
import {
  closeLinearApprovalThread, linearApprovalCommentId, parseLinearApprovalReply,
  readLinearApprovalThread, saveLinearApprovalThread,
} from '../../../src/handlers/shared/linear-approval-thread';
const thread = { workspaceId: 'ws', issueId: 'issue', taskId: 'task', requestId: 'gate', userId: 'owner' };
const send = jest.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;
beforeEach(() => send.mockReset().mockResolvedValue({}));

test('Linear-compatible UUIDv4 binds distinct workspace, issue, task and request identities', () => {
  const id = linearApprovalCommentId(thread);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(linearApprovalCommentId({ ...thread })).toBe(id);
  for (const field of ['workspaceId', 'issueId', 'taskId', 'requestId']) {
    expect(linearApprovalCommentId({ ...thread, [field]: 'other' })).not.toBe(id);
  }
});

test('mapping writes preserve existing TTL and reject changed bindings', async () => {
  await saveLinearApprovalThread(ddb, 'Approvals', thread);
  const input = send.mock.calls[0][0].input;
  expect(input.Key.task_id).toContain('LINEAR_COMMENT#ws#');
  expect(input.UpdateExpression).not.toContain('ttl');
  expect(input.ConditionExpression).toContain('#thread = :thread');
  expect(input.ExpressionAttributeNames).not.toHaveProperty('user_id');
});

test('reads strongly and validates stored scope and shape', async () => {
  const id = linearApprovalCommentId(thread);
  send.mockResolvedValue({ Item: { kind: 'linear_approval_thread', thread } });
  expect(await readLinearApprovalThread(ddb, 'Approvals', 'ws', id)).toEqual(thread);
  expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
  expect(await readLinearApprovalThread(ddb, 'Approvals', 'other', id)).toBeNull();
  send.mockResolvedValue({ Item: { kind: 'linear_approval_thread', thread: { ...thread, userId: undefined } } });
  expect(await readLinearApprovalThread(ddb, 'Approvals', 'ws', id)).toBeNull();
});

test('closure starts retention once and never recreates a missing mapping', async () => {
  await closeLinearApprovalThread(ddb, 'Approvals', thread);
  const input = send.mock.calls[0][0].input;
  expect(input.UpdateExpression).toContain('if_not_exists');
  expect(input.ConditionExpression).toBe('attribute_exists(task_id)');
  send.mockRejectedValue({ name: 'ConditionalCheckFailedException' });
  await expect(closeLinearApprovalThread(ddb, 'Approvals', thread)).resolves.toBeUndefined();
  send.mockRejectedValue(new Error('throttle'));
  await expect(closeLinearApprovalThread(ddb, 'Approvals', thread)).rejects.toThrow('throttle');
});

test.each(['approve', 'APPROVE!', ' approve. '])('accepts explicit answer %s', text => {
  expect(parseLinearApprovalReply(text)).toBe('approve');
});
test.each(['deny', ' Deny! '])('accepts denial %s', text => {
  expect(parseLinearApprovalReply(text)).toBe('deny');
});
test.each([undefined, 'I approve', '`approve`', 'approve\ndeny', 'approved'])('rejects ambiguous input %s', text => {
  expect(parseLinearApprovalReply(text)).toBeNull();
});
