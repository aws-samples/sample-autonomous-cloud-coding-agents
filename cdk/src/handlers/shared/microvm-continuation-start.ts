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

import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionControlOptions } from './compute-strategy';
import type { ContinuableTask } from './microvm-continuation-retirement';
import { CONTINUATION_IO_TIMEOUT_MS } from './microvm-continuation-timing';
import { type ContinuationRecord, type WorkerLease, validateContinuation, workerLeaseKey } from './microvm-continuation-types';
import { makeDocClient } from './ua';
import { TaskStatus } from '../../constructs/task-status';

const ddb = makeDocClient();
const TABLE = process.env.TASK_TABLE_NAME!;
const APPROVALS = process.env.TASK_APPROVALS_TABLE_NAME!;
const COUNTERS = process.env.USER_CONCURRENCY_TABLE_NAME!;

export type ContinuationAdmission =
  | { readonly kind: 'ready'; readonly task: ContinuableTask }
  | { readonly kind: 'waiting' | 'closed' | 'capacity' };

async function readTask(taskId: string, options: SessionControlOptions): Promise<ContinuableTask | undefined> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { task_id: taskId }, ConsistentRead: true,
  }), options);
  return result.Item as ContinuableTask | undefined;
}

/** A replay can use only the same active assignment, never revive a retired lease. */
async function readActiveAssignment(task: ContinuableTask, options: SessionControlOptions): Promise<boolean> {
  const record = task.continuation;
  if (!record?.attempt_id || task.concurrency_slot?.state !== 'held'
    || task.concurrency_slot.attempt_id !== record.attempt_id) return false;
  const result = await ddb.send(new GetCommand({
    TableName: TABLE, Key: workerLeaseKey(task.task_id), ConsistentRead: true,
  }), options);
  const lease = result.Item as WorkerLease | undefined;
  if (record.state === 'RESTORING' && (!task.session_id || record.worker_id !== task.session_id
    || lease?.lease_microvm_id !== task.session_id)) return false;
  return lease?.lease_state === 'ACTIVE' && lease.lease_attempt_id === record.attempt_id
    && lease.lease_user_id === task.user_id && lease.lease_repo === (task.repo ?? '');
}

/**
 * Claim capacity and assign a fresh worker token only for a resolved PARKED
 * request. The old worker was already confirmed stopped before PARKED.
 */
export async function admitContinuation(
  taskId: string, userId: string, requestId: string, limit: number,
  options: SessionControlOptions = { abortSignal: AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS) },
): Promise<ContinuationAdmission> {
  const task = await readTask(taskId, options);
  if (!task || task.user_id !== userId || task.status !== TaskStatus.AWAITING_APPROVAL
    || task.awaiting_approval_request_id !== requestId || !task.continuation) return { kind: 'closed' };
  const record = task.continuation;
  validateContinuation(record, task);
  if (record.state === 'STARTING' || record.state === 'RESTORING') {
    if (!await readActiveAssignment(task, options)) {
      throw new Error('MICROVM_CONTINUATION_LEASE_INVALID: replacement assignment is not active');
    }
    return { kind: 'ready', task };
  }
  if (record.state !== 'PARKED') return { kind: 'waiting' };
  const approval = await ddb.send(new GetCommand({
    TableName: APPROVALS, Key: { task_id: taskId, request_id: requestId }, ConsistentRead: true,
  }), options);
  if (approval.Item?.user_id !== userId || approval.Item.status === 'CANCELLED') return { kind: 'closed' };
  const finiteDeadline = Date.parse(approval.Item?.created_at ?? '') + Number(approval.Item?.timeout_s) * 1000;
  const expired = approval.Item?.status === 'PENDING' && Number(approval.Item.timeout_s) > 0
    && Number.isFinite(finiteDeadline) && Date.now() >= finiteDeadline;
  if (!expired && !['APPROVED', 'DENIED', 'TIMED_OUT'].includes(approval.Item?.status)) return { kind: 'waiting' };
  if (task.concurrency_slot?.state !== 'released' || !task.microvm_start?.clientToken
    || !record.source_handle || record.source_handle.microvmId !== task.session_id
    || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('MICROVM_CONTINUATION_RESERVATION_INVALID: parked task has no released source reservation');
  }
  const attempt = randomUUID();
  const now = new Date().toISOString();
  const starting: ContinuationRecord = {
    ...record, state: 'STARTING', attempt_id: attempt, started_at: now,
  };
  const slot = { state: 'held' as const, acquired_at: now, attempt_id: attempt };
  const lease: WorkerLease = {
    ...workerLeaseKey(taskId),
    lease_state: 'ACTIVE',
    lease_attempt_id: attempt,
    lease_user_id: userId,
    lease_repo: record.identity.repo,
  };
  try {
    await ddb.send(new TransactWriteCommand({
      ClientRequestToken: attempt,
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { task_id: taskId },
            UpdateExpression: 'SET continuation = :starting, concurrency_slot = :slot '
              + 'REMOVE session_id, compute_metadata, microvm_start, microvm_lifecycle, agent_heartbeat_at',
            ConditionExpression: 'user_id = :user AND #status = :awaiting AND awaiting_approval_request_id = :request '
              + 'AND continuation = :record AND concurrency_slot.#state = :released',
            ExpressionAttributeNames: { '#status': 'status', '#state': 'state' },
            ExpressionAttributeValues: {
              ':user': userId,
              ':awaiting': TaskStatus.AWAITING_APPROVAL,
              ':request': requestId,
              ':record': record,
              ':released': 'released',
              ':starting': starting,
              ':slot': slot,
            },
          },
        },
        {
          Update: {
            TableName: COUNTERS,
            Key: { user_id: userId },
            UpdateExpression: 'SET active_count = if_not_exists(active_count, :zero) + :one, '
              + 'updated_at = :now, reservation_version = :revision',
            ConditionExpression: 'attribute_not_exists(active_count) OR active_count < :limit',
            ExpressionAttributeValues: {
              ':zero': 0, ':one': 1, ':now': now, ':revision': attempt, ':limit': limit,
            },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: lease,
            ConditionExpression: 'lease_state = :parked AND lease_attempt_id = :source '
              + 'AND lease_microvm_id = :vm AND lease_user_id = :user',
            ExpressionAttributeValues: {
              ':parked': 'PARKED',
              ':source': task.microvm_start.clientToken,
              ':vm': record.source_handle.microvmId,
              ':user': userId,
            },
          },
        },
        expired ? {
          Update: {
            TableName: APPROVALS,
            Key: { task_id: taskId, request_id: requestId },
            UpdateExpression: 'SET #status = :timedout, decided_at = :now',
            ConditionExpression: 'user_id = :user AND #status = :pending AND created_at = :created AND timeout_s = :timeout',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':user': userId,
              ':pending': 'PENDING',
              ':timedout': 'TIMED_OUT',
              ':now': now,
              ':created': approval.Item!.created_at,
              ':timeout': approval.Item!.timeout_s,
            },
          },
        } : {
          ConditionCheck: {
            TableName: APPROVALS,
            Key: { task_id: taskId, request_id: requestId },
            ConditionExpression: 'user_id = :user AND #status IN (:approved, :denied, :timedout)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':user': userId, ':approved': 'APPROVED', ':denied': 'DENIED', ':timedout': 'TIMED_OUT',
            },
          },
        },
      ],
    }), options);
    const updated: ContinuableTask = {
      ...task,
      continuation: starting,
      concurrency_slot: slot,
      session_id: undefined,
      compute_metadata: undefined,
      microvm_start: undefined,
      agent_heartbeat_at: undefined,
    };
    return { kind: 'ready', task: updated };
  } catch (error) {
    const latest = await readTask(taskId, options);
    if (!latest || latest.user_id !== userId || latest.status !== TaskStatus.AWAITING_APPROVAL
      || latest.awaiting_approval_request_id !== requestId) return { kind: 'closed' };
    if (['STARTING', 'RESTORING'].includes(latest.continuation?.state ?? '')
      && await readActiveAssignment(latest, options)) return { kind: 'ready', task: latest };
    const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
    if (failure.name === 'TransactionCanceledException'
      && failure.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed'
      && latest.continuation?.state === 'PARKED') return { kind: 'capacity' };
    throw error;
  }
}
