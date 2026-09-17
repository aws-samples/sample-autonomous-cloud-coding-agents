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
import { TaskStatus } from '../../../src/constructs/task-status';
import { approvalNotificationMarkdown, loadApprovalNotification, markApprovalNotificationDelivered } from '../../../src/handlers/shared/approval-notifications';
import type { TaskRecord } from '../../../src/handlers/shared/types';

const send = jest.fn();
const ddb = { send } as unknown as DynamoDBDocumentClient;
const task = {
  task_id: 'task',
  user_id: 'owner',
  status: TaskStatus.AWAITING_APPROVAL,
  awaiting_approval_request_id: 'gate',
} as TaskRecord;
const row = {
  status: 'PENDING',
  user_id: 'owner',
  tool_name: 'Bash',
  severity: 'high',
  reason: 'Destructive command',
  tool_input_preview: 'git push --force',
  created_at: '2026-09-16T12:00:00Z',
  timeout_s: 1800,
};
beforeEach(() => {
  process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
  send.mockReset().mockResolvedValue({ Item: row });
});

test('shows the saved action and exact deadline, with one-call CLI approval', async () => {
  const message = await loadApprovalNotification(ddb, task, 'approval_requested', { request_id: 'gate', reason: 'wrong' }, 'slack');
  expect(message?.text).toContain('Destructive command');
  expect(message?.text).toContain('git push --force');
  expect(message?.text).toContain('2026-09-16T12:30:00.000Z');
  expect(message?.text).toContain('bgagent approve task gate --scope this_call');
  expect(message?.text).toContain('bgagent deny task gate');
  expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
});

test.each([
  ['cancelled task', { ...task, status: TaskStatus.CANCELLED }, row],
  ['new gate', { ...task, awaiting_approval_request_id: 'new' }, row],
  ['already decided', task, { ...row, status: 'APPROVED' }],
  ['foreign owner', task, { ...row, user_id: 'other' }],
  ['already delivered', task, { ...row, notified_slack_approval_requested: '2026-09-16' }],
  ['missing approval', task, undefined],
])('suppresses a delayed request: %s', async (_label, owningTask, approval) => {
  send.mockResolvedValue({ Item: approval });
  expect(await loadApprovalNotification(ddb, owningTask, 'approval_requested', { request_id: 'gate' }, 'slack')).toBeNull();
});

test.each([
  ['APPROVED', 'approval_decision_recorded', 'Approval recorded'],
  ['DENIED', 'approval_decision_recorded', 'Denial recorded'],
  ['TIMED_OUT', 'approval_timed_out', 'Approval request timed out'],
  ['CANCELLED', 'approval_cancelled', 'Approval request cancelled'],
  ['STRANDED', 'approval_stranded', 'Approval wait could not continue'],
])('reports saved %s even when the task is now terminal', async (status, event, title) => {
  send.mockResolvedValue({ Item: { ...row, status, cancellation_reason: 'Task cancelled by its owner' } });
  const message = await loadApprovalNotification(ddb, { ...task, status: TaskStatus.CANCELLED }, event, { request_id: 'gate' }, 'linear');
  expect(message?.title).toBe(title);
  expect(message?.text).not.toContain('bgagent approve');
  if (status === 'CANCELLED') expect(message?.text).toContain('Task cancelled by its owner');
  if (status === 'APPROVED' || status === 'DENIED') {
    expect(message?.text).toContain('Task status: CANCELLED. The task has already ended.');
    expect(message?.text).not.toContain('when its worker is ready');
  }
});

test.each([
  [undefined, 'The configured decision deadline was reached.'],
  ['poll failed 3 consecutive times', 'poll failed 3 consecutive times'],
])('reports timeout closure instead of the original policy reason (%s)', async (denyReason, expected) => {
  send.mockResolvedValue({ Item: { ...row, status: 'TIMED_OUT', deny_reason: denyReason } });
  const message = await loadApprovalNotification(ddb, task, 'approval_timed_out', { request_id: 'gate' }, 'slack');
  expect(message?.text).toContain(expected);
  expect(message?.text).not.toContain(row.reason);
});

test('handles the actual stranded-reconciler event without changing the pending approval', async () => {
  const failed = { ...task, status: TaskStatus.FAILED, error_message: 'Approval stranded: task paused for approval for 7200s with no resume transition.' };
  const message = await loadApprovalNotification(ddb, failed, 'approval_stranded', { reason: 'STRANDED_NO_HEARTBEAT' }, 'linear');
  expect(message).toMatchObject({ title: 'Approval wait could not continue', requestId: 'gate' });
  expect(message?.text).toContain(failed.error_message);
  expect(message?.text).not.toContain('bgagent approve');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].input.Key).toEqual({ task_id: 'task', request_id: 'gate' });
});

test.each([
  [task, row],
  [{ ...task, status: TaskStatus.FAILED, error_message: 'Unrelated failure' }, row],
  [{ ...task, status: TaskStatus.FAILED, error_message: 'Approval stranded: old wait', awaiting_approval_request_id: undefined }, row],
  [{ ...task, status: TaskStatus.FAILED, error_message: 'Approval stranded: old wait' }, { ...row, user_id: 'foreign' }],
  [{ ...task, status: TaskStatus.FAILED, error_message: 'Approval stranded: old wait' }, { ...row, status: 'APPROVED' }],
])('does not infer a stranded request from an unrelated or decided task', async (owningTask, approval) => {
  send.mockResolvedValue({ Item: approval });
  expect(await loadApprovalNotification(ddb, owningTask, 'approval_stranded', { reason: 'STRANDED_NO_HEARTBEAT' }, 'linear')).toBeNull();
});

test('delivery receipts are separate for each request and channel and cannot recreate a deleted row', async () => {
  const message = (await loadApprovalNotification(ddb, task, 'approval_requested', { request_id: 'gate' }, 'linear'))!;
  await markApprovalNotificationDelivered(ddb, message);
  expect(send.mock.calls[1][0].input).toMatchObject({
    Key: { task_id: 'task', request_id: 'gate' },
    ConditionExpression: 'attribute_exists(task_id) AND user_id = :user',
    ExpressionAttributeNames: { '#marker': 'notified_linear_approval_requested' },
  });
});

test('does not turn repository content into markdown or shell command substitutions', async () => {
  send.mockResolvedValue({ Item: { ...row, tool_input_preview: '``` @everyone <https://evil|link> $(touch file)' } });
  const message = (await loadApprovalNotification(ddb, { ...task, awaiting_approval_request_id: '$(evil)' }, 'approval_requested', { request_id: '$(evil)' }, 'linear'))!;
  expect(message.text).not.toContain('bgagent approve');
  expect(approvalNotificationMarkdown(message).match(/```/g)).toHaveLength(2);
});

test('redacts known credential shapes before posting a preview to a shared channel', async () => {
  const token = `ghp_${'a'.repeat(36)}`;
  send.mockResolvedValue({ Item: { ...row, tool_input_preview: `\u001b[31mTOKEN=${token}\u202eecho` } });
  const message = (await loadApprovalNotification(ddb, task, 'approval_requested', { request_id: 'gate' }, 'slack'))!;
  expect(message.text).toContain('[REDACTED-GITHUB_TOKEN]');
  expect(message.text).not.toContain(token);
  expect(message.text).not.toMatch(/[\u001b\u202e]/);
});
