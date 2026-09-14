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
import type { SessionHandle } from './compute-strategy';
import type { ApprovalStatus } from './types';
import { makeDocClient } from './ua';
import { TaskStatus, type TaskStatusType } from '../../constructs/task-status';

type MicrovmHandle = Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;
export type LifecycleAction = 'suspend' | 'resume';

/** Internal coordinator data. Retain it until task expiry; never erase a wake intent. */
export interface MicrovmLifecycleIntent {
  readonly version: 1;
  readonly generation: string;
  readonly microvm_id: string;
  readonly request_id: string | null;
  readonly action: LifecycleAction;
  readonly requested_at_ms: number;
  readonly deadline_ms: number | null;
}

export type LifecycleApproval =
  | {
    readonly kind: 'present';
    readonly status: ApprovalStatus;
    readonly created_at: string;
    readonly timeout_s: number;
    readonly createdAtMs: number;
    readonly deadlineMs: number;
  }
  | { readonly kind: 'none' | 'missing' | 'invalid' }
  | { readonly kind: 'unavailable'; readonly errorType: string };

/** A read is only an observation; saving intent rechecks identity and generation atomically. */
export interface MicrovmLifecycleSnapshot {
  readonly taskId: string;
  readonly userId: string;
  readonly status: TaskStatusType;
  readonly handle: MicrovmHandle;
  readonly requestId: string | null;
  readonly intent?: MicrovmLifecycleIntent;
  readonly approval: LifecycleApproval;
}

export type SaveLifecycleResult =
  | { readonly status: 'saved'; readonly intent: MicrovmLifecycleIntent }
  | { readonly status: 'stale' | 'ineligible' };

// Per request/read sequence. A write plus lost-reply recovery can take two such
// budgets; the caller must also bound its whole reconciliation cycle.
export const MICROVM_LIFECYCLE_STORE_TIMEOUT_MS = 5_000;
const ddb = makeDocClient();
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const APPROVALS_TABLE = process.env.TASK_APPROVALS_TABLE_NAME!;
const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['PENDING', 'APPROVED', 'DENIED', 'TIMED_OUT', 'STRANDED'];
const LIVE_TASK_STATUSES: readonly TaskStatusType[] = [TaskStatus.HYDRATING, TaskStatus.RUNNING, TaskStatus.AWAITING_APPROVAL];

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validIntent(value: unknown): value is MicrovmLifecycleIntent {
  if (!value || typeof value !== 'object') return false;
  const item = value as MicrovmLifecycleIntent;
  return item.version === 1 && nonblank(item.generation) && nonblank(item.microvm_id)
    && (item.request_id === null || nonblank(item.request_id))
    && (item.action === 'suspend' || item.action === 'resume')
    && timestamp(item.requested_at_ms) && (item.deadline_ms === null || timestamp(item.deadline_ms))
    && (item.action !== 'suspend' || (item.request_id !== null && item.deadline_ms !== null));
}

function parseApproval(row: Record<string, unknown> | undefined, taskId: string, userId: string, requestId: string): LifecycleApproval {
  if (!row) return { kind: 'missing' };
  if (row.task_id !== taskId || row.user_id !== userId || row.request_id !== requestId
    || !APPROVAL_STATUSES.includes(row.status as ApprovalStatus)
    || typeof row.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(row.created_at)
    || !timestamp(row.timeout_s) || row.timeout_s === 0) return { kind: 'invalid' };
  const createdAtMs = Date.parse(row.created_at);
  const canonical = row.created_at.includes('.') ? row.created_at : row.created_at.replace('Z', '.000Z');
  const deadlineMs = createdAtMs + row.timeout_s * 1000;
  if (!timestamp(createdAtMs) || new Date(createdAtMs).toISOString() !== canonical || !timestamp(deadlineMs)) return { kind: 'invalid' };
  return {
    kind: 'present',
    status: row.status as ApprovalStatus,
    created_at: row.created_at,
    timeout_s: row.timeout_s,
    createdAtMs,
    deadlineMs,
  };
}

/** Missing/non-MicroVM tasks are inapplicable. Invalid identity/state fails visibly. */
export async function readMicrovmLifecycleSnapshot(taskId: string, userId: string): Promise<MicrovmLifecycleSnapshot | undefined> {
  const abortSignal = AbortSignal.timeout(MICROVM_LIFECYCLE_STORE_TIMEOUT_MS);
  const result = await ddb.send(new GetCommand({ TableName: TASK_TABLE, Key: { task_id: taskId }, ConsistentRead: true }), { abortSignal });
  const task = result.Item;
  if (!task) return undefined;
  if (task.user_id !== userId || task.task_id !== taskId) throw new Error('MicroVM lifecycle task identity mismatch');
  if (task.compute_type !== 'lambda-microvm') return undefined;
  const metadata = task.compute_metadata;
  if (!nonblank(task.session_id) || metadata?.microvmId !== task.session_id || !nonblank(metadata?.endpoint)
    || !Object.values(TaskStatus).includes(task.status)) throw new Error('MicroVM lifecycle task has invalid handle or status');
  const requestId = task.awaiting_approval_request_id ?? null;
  if ((requestId !== null && !nonblank(requestId))
    || (task.status === TaskStatus.AWAITING_APPROVAL && requestId === null)
    || ((task.status === TaskStatus.RUNNING || task.status === TaskStatus.HYDRATING) && requestId !== null)) {
    throw new Error('MicroVM lifecycle task has inconsistent approval identity');
  }
  if (task.microvm_lifecycle !== undefined && !validIntent(task.microvm_lifecycle)) {
    throw new Error('MicroVM lifecycle intent is malformed or has an unsupported version');
  }
  let approval: LifecycleApproval = { kind: 'none' };
  // Cancellation/terminal writers can retain the old gate pointer. They need
  // cleanup, not another approval read or a wake, so preserve that identity only.
  if (task.status === TaskStatus.AWAITING_APPROVAL && requestId !== null) {
    try {
      const response = await ddb.send(new GetCommand({
        TableName: APPROVALS_TABLE,
        Key: { task_id: taskId, request_id: requestId },
        ConsistentRead: true,
      }), { abortSignal });
      approval = parseApproval(response.Item, taskId, userId, requestId);
    } catch (error) {
      // This explicit observation forbids suspend and permits conservative wake.
      // The caller must count/report the failure; no raw SDK message is retained.
      const name = (error as { name?: unknown })?.name;
      approval = { kind: 'unavailable', errorType: typeof name === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(name) ? name : 'Error' };
    }
  }
  return {
    taskId,
    userId,
    status: task.status,
    requestId,
    approval,
    intent: task.microvm_lifecycle,
    handle: { strategyType: 'lambda-microvm', sessionId: task.session_id, microvmId: metadata.microvmId, endpoint: metadata.endpoint },
  };
}

export function intentMatchesGate(snapshot: MicrovmLifecycleSnapshot): boolean {
  return snapshot.intent?.microvm_id === snapshot.handle.microvmId && snapshot.intent.request_id === snapshot.requestId;
}

function eligible(snapshot: MicrovmLifecycleSnapshot, action: LifecycleAction, nowMs: number): boolean {
  if (!LIVE_TASK_STATUSES.includes(snapshot.status)) return false;
  if (action === 'resume') return true;
  return snapshot.status === TaskStatus.AWAITING_APPROVAL && snapshot.requestId !== null
    && snapshot.approval.kind === 'present' && snapshot.approval.status === 'PENDING'
    && nowMs >= snapshot.approval.createdAtMs && nowMs < snapshot.approval.deadlineMs
    && !(intentMatchesGate(snapshot) && (snapshot.intent?.action === 'resume'
      || snapshot.intent?.deadline_ms !== snapshot.approval.deadlineMs));
}

/**
 * Save before touching AWS compute. A wake is sticky for this gate, including
 * while AWS still reports RUNNING: an older suspend may be in flight.
 * Caller must recheck the gate/time before suspend and reconcile after commands.
 */
export async function saveMicrovmLifecycleIntent(
  snapshot: MicrovmLifecycleSnapshot, action: LifecycleAction, nowMs = Date.now(),
): Promise<SaveLifecycleResult> {
  if (!timestamp(nowMs)) throw new Error('MicroVM lifecycle time must be epoch milliseconds');
  if (!eligible(snapshot, action, nowMs)) return { status: 'ineligible' };
  const sameGate = intentMatchesGate(snapshot);
  // Repeated requests retain their original age/generation, so polling cannot
  // reset the eventual recovery budget. A new gate/action gets a new generation.
  const intent: MicrovmLifecycleIntent = sameGate && snapshot.intent?.action === action ? snapshot.intent : {
    version: 1,
    generation: randomUUID(),
    microvm_id: snapshot.handle.microvmId,
    request_id: snapshot.requestId,
    action,
    requested_at_ms: nowMs,
    deadline_ms: snapshot.approval.kind === 'present' ? snapshot.approval.deadlineMs : sameGate ? snapshot.intent!.deadline_ms : null,
  };
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = {
    ':intent': intent,
    ':user': snapshot.userId,
    ':status': snapshot.status,
    ':type': 'lambda-microvm',
    ':id': snapshot.handle.microvmId,
    ':endpoint': snapshot.handle.endpoint,
  };
  let condition = 'user_id = :user AND #status = :status AND compute_type = :type AND session_id = :id '
    + 'AND compute_metadata.microvmId = :id AND compute_metadata.endpoint = :endpoint';
  if (snapshot.requestId === null) {
    condition += ' AND attribute_not_exists(awaiting_approval_request_id)';
  } else {
    condition += ' AND awaiting_approval_request_id = :request';
    values[':request'] = snapshot.requestId;
  }
  if (!snapshot.intent) {
    condition += ' AND attribute_not_exists(microvm_lifecycle)';
  } else {
    condition += ' AND microvm_lifecycle.generation = :generation';
    values[':generation'] = snapshot.intent.generation;
  }
  const command = new TransactWriteCommand({
    // Separate from the persistent generation: a repeated save has a different
    // condition shape, so reusing that generation as an AWS token would conflict.
    ClientRequestToken: randomUUID(),
    TransactItems: [
      {
        Update: {
          TableName: TASK_TABLE,
          Key: { task_id: snapshot.taskId },
          UpdateExpression: 'SET microvm_lifecycle = :intent',
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      },
      ...(action === 'suspend' && snapshot.approval.kind === 'present' ? [{
        ConditionCheck: {
          TableName: APPROVALS_TABLE,
          Key: { task_id: snapshot.taskId, request_id: snapshot.requestId },
          ConditionExpression: '#status = :pending AND user_id = :user AND created_at = :created AND timeout_s = :timeout',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING', ':user': snapshot.userId, ':created': snapshot.approval.created_at, ':timeout': snapshot.approval.timeout_s,
          },
        },
      }] : []),
    ],
  });
  try {
    await ddb.send(command, { abortSignal: AbortSignal.timeout(MICROVM_LIFECYCLE_STORE_TIMEOUT_MS) });
    return { status: 'saved', intent };
  } catch (error) {
    const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
    if (failure?.name === 'TransactionCanceledException'
      && failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) return { status: 'stale' };
    // Lost committed reply: observe exactly our generation and unchanged task
    // identity before reporting success. Unknown/unreadable outcomes stay errors.
    const current = await readMicrovmLifecycleSnapshot(snapshot.taskId, snapshot.userId);
    if (current?.intent?.generation === intent.generation) {
      if (current.status === snapshot.status && current.requestId === snapshot.requestId
        && current.handle.microvmId === snapshot.handle.microvmId && current.handle.endpoint === snapshot.handle.endpoint
        && eligible(current, action, Date.now())) return { status: 'saved', intent: current.intent };
      // Our write committed, but cancellation/a decision moved the task on.
      return { status: 'stale' };
    }
    throw error;
  }
}
