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
import { canonicalJson } from './canonical-json';
import type { ComputeStrategy, SessionControlOptions } from './compute-strategy';
import { logger } from './logger';
import { verifyContinuationCheckpoint } from './microvm-continuation-storage';
import { CONTINUATION_RETIREMENT_TIMEOUT_MS, CONTINUATION_STOP_TIMEOUT_MS } from './microvm-continuation-timing';
import { CONTINUATION, type ContinuationRecord, type MicrovmHandle, type WorkerLease, validateContinuation, workerLeaseKey } from './microvm-continuation-types';
import { continuationEnabled } from './microvm-worker-lease';
import { MICROVM_SLEEP_AFTER_S_DEFAULT, type TaskRecord } from './types';
import { makeDocClient } from './ua';
import { TaskStatus } from '../../constructs/task-status';

const ddb = makeDocClient();
const TABLE = process.env.TASK_TABLE_NAME!;
const APPROVALS = process.env.TASK_APPROVALS_TABLE_NAME!;
const COUNTERS = process.env.USER_CONCURRENCY_TABLE_NAME!;

interface HeldSlot {
  readonly state: 'held' | 'released';
  readonly acquired_at: string;
  readonly released_at?: string;
  readonly attempt_id?: string;
}

export type ContinuableTask = TaskRecord & {
  readonly concurrency_slot?: HeldSlot;
  readonly microvm_start?: { readonly clientToken: string; readonly handle?: MicrovmHandle; readonly createdAt?: string };
};

export type RetirementResult = 'not-due' | 'stopping' | 'parked' | 'ownership-lost';

async function readTask(taskId: string, options: SessionControlOptions): Promise<ContinuableTask | undefined> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { task_id: taskId }, ConsistentRead: true,
  }), options);
  return result.Item as ContinuableTask | undefined;
}

function sameRecord(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function leaseMatches(
  task: ContinuableTask, handle: MicrovmHandle, state: 'FENCED' | 'PARKED', options: SessionControlOptions,
): Promise<boolean> {
  if (!task.microvm_start?.clientToken) return false;
  const result = await ddb.send(new GetCommand({
    TableName: TABLE, Key: workerLeaseKey(task.task_id), ConsistentRead: true,
  }), options);
  const lease = result.Item as WorkerLease | undefined;
  return lease?.lease_state === state && lease.lease_attempt_id === task.microvm_start.clientToken
    && lease.lease_microvm_id === handle.microvmId && lease.lease_user_id === task.user_id
    && lease.lease_repo === (task.repo ?? '');
}

async function fence(task: ContinuableTask, handle: MicrovmHandle, options: SessionControlOptions): Promise<ContinuationRecord | undefined> {
  const record = task.continuation!;
  const fenced: ContinuationRecord = { ...record, state: 'FENCED', source_handle: handle };
  const attempt = task.microvm_start?.clientToken;
  if (!attempt || record.identity.attempt_id !== handle.microvmId) {
    throw new Error('MICROVM_CONTINUATION_INVALID: source worker has no matching launch receipt');
  }
  await verifyContinuationCheckpoint(record, options);
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { task_id: task.task_id },
            UpdateExpression: 'SET continuation = :fenced',
            ConditionExpression: 'user_id = :user AND #status = :awaiting AND session_id = :vm '
              + 'AND awaiting_approval_request_id = :request AND continuation = :record',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':user': task.user_id,
              ':awaiting': TaskStatus.AWAITING_APPROVAL,
              ':vm': handle.microvmId,
              ':request': record.identity.request_id,
              ':record': record,
              ':fenced': fenced,
            },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: workerLeaseKey(task.task_id),
            UpdateExpression: 'SET lease_state = :fenced',
            ConditionExpression: 'lease_state = :active AND lease_attempt_id = :attempt '
              + 'AND lease_microvm_id = :vm AND lease_user_id = :user',
            ExpressionAttributeValues: {
              ':fenced': 'FENCED',
              ':active': 'ACTIVE',
              ':attempt': attempt,
              ':vm': handle.microvmId,
              ':user': task.user_id,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: APPROVALS,
            Key: { task_id: task.task_id, request_id: record.identity.request_id },
            ConditionExpression: 'user_id = :user AND #status IN (:pending, :approved, :denied, :timedout)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':user': task.user_id,
              ':pending': 'PENDING',
              ':approved': 'APPROVED',
              ':denied': 'DENIED',
              ':timedout': 'TIMED_OUT',
            },
          },
        },
      ],
    }), options);
    return fenced;
  } catch (error) {
    const latest = await readTask(task.task_id, options);
    if (latest?.user_id === task.user_id && latest.status === TaskStatus.AWAITING_APPROVAL
      && sameRecord(latest.continuation, fenced)
      && await leaseMatches(latest, handle, 'FENCED', options)) return fenced;
    // Original worker resumed or cancellation won before the fence.
    if (!latest || latest.status !== TaskStatus.AWAITING_APPROVAL
      || !sameRecord(latest.continuation, record)) return undefined;
    throw error;
  }
}

/** Close the old reservation only after GetMicrovm confirmed terminal/not-found. */
async function parkAfterTermination(task: ContinuableTask, record: ContinuationRecord, options: SessionControlOptions): Promise<boolean> {
  if (task.concurrency_slot?.state !== 'held' || !task.microvm_start?.clientToken) {
    throw new Error('MICROVM_CONTINUATION_RESERVATION_INVALID: fenced worker has no held capacity');
  }
  let emptyCounter = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date().toISOString();
    const revision = randomUUID();
    const parked: ContinuationRecord = { ...record, state: 'PARKED', parked_at: now };
    try {
      await ddb.send(new TransactWriteCommand({
        ClientRequestToken: revision,
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { task_id: task.task_id },
              UpdateExpression: 'SET continuation = :parked, concurrency_slot.#state = :released, '
                + 'concurrency_slot.released_at = :now REMOVE #ttl',
              ConditionExpression: 'user_id = :user AND #status = :awaiting AND continuation = :record '
                + 'AND concurrency_slot = :slot',
              ExpressionAttributeNames: { '#status': 'status', '#state': 'state', '#ttl': 'ttl' },
              ExpressionAttributeValues: {
                ':user': task.user_id,
                ':awaiting': TaskStatus.AWAITING_APPROVAL,
                ':record': record,
                ':slot': task.concurrency_slot,
                ':parked': parked,
                ':released': 'released',
                ':now': now,
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: workerLeaseKey(task.task_id),
              UpdateExpression: 'SET lease_state = :parked',
              ConditionExpression: 'lease_state = :fenced AND lease_attempt_id = :attempt AND lease_microvm_id = :vm',
              ExpressionAttributeValues: {
                ':parked': 'PARKED',
                ':fenced': 'FENCED',
                ':attempt': task.microvm_start.clientToken,
                ':vm': record.source_handle!.microvmId,
              },
            },
          },
          {
            Update: {
              TableName: COUNTERS,
              Key: { user_id: task.user_id },
              UpdateExpression: emptyCounter
                ? 'SET active_count = if_not_exists(active_count, :zero), updated_at = :now, reservation_version = :revision'
                : 'SET active_count = active_count - :one, updated_at = :now, reservation_version = :revision',
              ConditionExpression: emptyCounter
                ? 'attribute_not_exists(active_count) OR active_count >= :zero'
                : 'active_count > :zero',
              ExpressionAttributeValues: {
                ':zero': 0, ...(!emptyCounter && { ':one': 1 }), ':now': now, ':revision': revision,
              },
            },
          },
        ],
      }), options);
      if (emptyCounter) {
        logger.warn('Parked continuation whose capacity counter was already empty', {
          task_id: task.task_id, error_id: 'CONCURRENCY_EMPTY_COUNTER',
        });
      }
      return true;
    } catch (error) {
      const latest = await readTask(task.task_id, options);
      if (latest?.user_id === task.user_id && latest.continuation?.state === 'PARKED'
        && latest.concurrency_slot?.state === 'released'
        && sameRecord(latest.continuation.identity, record.identity)
        && await leaseMatches(latest, record.source_handle!, 'PARKED', options)) return true;
      if (!latest || latest.status !== TaskStatus.AWAITING_APPROVAL
        || !sameRecord(latest.continuation, record)) return false;
      const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
      if (!emptyCounter && failure.name === 'TransactionCanceledException'
        && failure.CancellationReasons?.[2]?.Code === 'ConditionalCheckFailed') {
        emptyCounter = true;
        continue;
      }
      throw error;
    }
  }
  throw new Error('MICROVM_CONTINUATION_RESERVATION_INVALID: capacity release was not acknowledged');
}

/**
 * One bounded retirement cycle. A worker is fenced before termination; its
 * reservation remains held until the service confirms it cannot execute.
 */
export async function retireCheckpointedMicrovm(input: {
  taskId: string;
  userId: string;
  handle: MicrovmHandle;
  strategy: ComputeStrategy;
  sessionDeadlineMs: number;
  force?: boolean;
  abortSignal?: AbortSignal;
}): Promise<RetirementResult> {
  if (!continuationEnabled()) return 'not-due';
  const timeout = AbortSignal.timeout(CONTINUATION_RETIREMENT_TIMEOUT_MS);
  const options = { abortSignal: input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout };
  const task = await readTask(input.taskId, options);
  if (!task || task.user_id !== input.userId || task.session_id !== input.handle.microvmId) {
    return 'ownership-lost';
  }
  if (task.status !== TaskStatus.AWAITING_APPROVAL || !task.continuation) return 'not-due';
  const record = task.continuation;
  validateContinuation(record, task);
  if (record.state === 'PARKED' || record.state === 'FENCED') {
    // Workers can publish the continuation attribute, but only the coordinator
    // can advance the separate lease. Never treat a worker-written state label
    // as proof that shutdown or capacity release actually happened.
    if (!await leaseMatches(task, input.handle, record.state, options)
      || (record.state === 'PARKED' && task.concurrency_slot?.state !== 'released')) {
      throw new Error('MICROVM_CONTINUATION_LEASE_INVALID: retirement state has no coordinator authority');
    }
    if (record.state === 'PARKED') return 'parked';
  }
  if (record.state !== 'READY' && record.state !== 'FENCED') return 'not-due';
  if (record.state === 'READY') {
    const approval = await ddb.send(new GetCommand({
      TableName: APPROVALS,
      Key: { task_id: task.task_id, request_id: record.identity.request_id },
      ConsistentRead: true,
    }), options);
    const now = Date.now();
    const created = Date.parse(approval.Item?.created_at ?? '');
    const sleep = task.microvm_sleep_after_s ?? MICROVM_SLEEP_AFTER_S_DEFAULT;
    const ageDue = sleep > 0 && Number.isFinite(created) && now - created >= CONTINUATION.park_after_seconds * 1000;
    const lifetimeDue = Number.isFinite(input.sessionDeadlineMs)
      && now >= input.sessionDeadlineMs - CONTINUATION.retirement_margin_seconds * 1000;
    if (!input.force && !ageDue && !lifetimeDue) return 'not-due';
  }
  const fenced = record.state === 'FENCED' ? record : await fence(task, input.handle, options);
  if (!fenced) return 'not-due';
  if (fenced.source_handle?.microvmId !== input.handle.microvmId) {
    throw new Error('MICROVM_CONTINUATION_INVALID: retirement handle does not match the fence');
  }
  const signal = AbortSignal.any([options.abortSignal, AbortSignal.timeout(CONTINUATION_STOP_TIMEOUT_MS)]);
  await input.strategy.stopSession(input.handle, { abortSignal: signal });
  const state = await input.strategy.pollSession(input.handle, { abortSignal: signal });
  if (state.microvmState !== 'TERMINATED' && state.microvmState !== 'NOT_FOUND') return 'stopping';
  return await parkAfterTermination(task, fenced, options) ? 'parked' : 'not-due';
}
