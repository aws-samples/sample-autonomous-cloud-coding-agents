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

import { createHash } from 'node:crypto';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionHandle } from './compute-strategy';
import type { ContinuationRecord } from './microvm-continuation-types';
import { MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS, readMicrovmImageMetadata, supportsMicrovmLifecycle } from './microvm-image-capability';
import { continuationEnabled, ensureWorkerLease, leaseHandleUpdate } from './microvm-worker-lease';
import { makeDocClient } from './ua';
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

type MicrovmHandle = Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;

/**
 * Internal TaskTable attribute, deliberately not part of the task API.
 * Each authorized worker attempt owns one logical start. Only a coordinator
 * continuation assignment may replace it; retries reuse the existing token.
 */
interface StartReceipt {
  readonly clientToken: string;
  readonly requestHash: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly handle?: MicrovmHandle;
}

interface StartRecord {
  readonly user_id: string;
  readonly status: string;
  readonly session_id?: string;
  readonly compute_type?: string;
  readonly compute_metadata?: Record<string, string>;
  readonly microvm_start?: StartReceipt;
  readonly repo?: string;
  readonly continuation?: ContinuationRecord;
}

export interface MicrovmStartClaim {
  readonly clientToken: string;
  readonly handle?: MicrovmHandle;
  readonly closed: boolean;
}

// A local retry limit, NOT a claim about AWS's undocumented token retention.
// After this window an unknown outcome requires investigation, never a fresh VM.
export const MICROVM_START_REPLAY_WINDOW_MS = 120_000;

const ddb = makeDocClient();
const TABLE_NAME = process.env.TASK_TABLE_NAME!;
const ACTIVE = new Set<string>([TaskStatus.HYDRATING, TaskStatus.RUNNING, TaskStatus.AWAITING_APPROVAL]);

/** Include the full S3 content, not just its URI; ignore object-key ordering. */
export function microvmStartRequestHash(request: unknown, payload: unknown): string {
  const canonical = JSON.stringify([request, payload], (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value);
  return createHash('sha256').update(canonical).digest('hex');
}

function recordedHandle(record: StartRecord): MicrovmHandle | undefined {
  const handle = record.microvm_start?.handle;
  if (handle?.strategyType === 'lambda-microvm' && handle.microvmId && handle.endpoint
    && handle.sessionId === handle.microvmId) return handle;
  // Read handles written before start receipts existed, without starting again.
  const metadata = record.compute_metadata;
  if (record.compute_type === 'lambda-microvm' && record.session_id
    && metadata?.microvmId === record.session_id && metadata.endpoint) {
    return {
      strategyType: 'lambda-microvm',
      sessionId: record.session_id,
      microvmId: metadata.microvmId,
      endpoint: metadata.endpoint,
      ...readMicrovmImageMetadata(metadata),
    };
  }
  return undefined;
}

async function readStartRecord(taskId: string, userId: string): Promise<StartRecord> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    ConsistentRead: true,
  }));
  const record = result.Item as StartRecord | undefined;
  if (!record || record.user_id !== userId) {
    throw new Error('MICROVM_START_STATE_INVALID: task is missing or its owner does not match');
  }
  return record;
}

/**
 * Establish identity and input immutability before S3 writes or RunMicrovm.
 * Conditional creation makes competing invocations use the winning receipt.
 */
export async function claimMicrovmStart(
  taskId: string,
  userId: string,
  requestHash: string,
  attemptId: string = taskId,
): Promise<MicrovmStartClaim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = await readStartRecord(taskId, userId);
    const handle = recordedHandle(record);
    if (TERMINAL_STATUSES.some(status => status === record.status)) {
      return { clientToken: attemptId, handle, closed: true };
    }
    if (!ACTIVE.has(record.status)) {
      throw new Error(`MICROVM_START_STATE_INVALID: cannot start a task in ${record.status}`);
    }
    if (attemptId !== taskId && record.continuation?.attempt_id !== attemptId) {
      throw new Error('MICROVM_START_STATE_INVALID: replacement has no coordinator assignment');
    }
    if (record.microvm_start && record.microvm_start.clientToken !== attemptId) {
      throw new Error('MICROVM_START_STATE_INVALID: start belongs to another worker attempt');
    }
    if (handle) return { clientToken: attemptId, handle, closed: false };
    const receipt = record.microvm_start;
    if (receipt) {
      if (receipt.clientToken !== attemptId || !Number.isFinite(receipt.expiresAt)) {
        throw new Error('MICROVM_START_STATE_INVALID: invalid saved start receipt');
      }
      if (receipt.requestHash !== requestHash) {
        throw new Error('MICROVM_START_INPUT_CHANGED: refusing to overwrite or restart an earlier MicroVM request');
      }
      if (Date.now() >= receipt.expiresAt) {
        throw new Error('MICROVM_START_OUTCOME_UNKNOWN: replay window expired; inspect the original start before retrying');
      }
      await ensureWorkerLease({ taskId, userId, repo: record.repo ?? '', attemptId, requestHash });
      return { clientToken: receipt.clientToken, closed: false };
    }
    const replacement = attemptId !== taskId
      && record.status === TaskStatus.AWAITING_APPROVAL && record.continuation?.state === 'STARTING';
    if (record.status !== TaskStatus.HYDRATING && !replacement) {
      throw new Error('MICROVM_START_STATE_INVALID: active task has no recoverable start receipt or handle');
    }
    const now = Date.now();
    const receiptToSave: StartReceipt = {
      clientToken: attemptId,
      requestHash,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + MICROVM_START_REPLAY_WINDOW_MS,
    };
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { task_id: taskId },
        UpdateExpression: 'SET microvm_start = :receipt',
        ConditionExpression: '#status = :startingStatus AND user_id = :user AND attribute_not_exists(microvm_start)'
          + (replacement ? ' AND continuation.#state = :starting AND continuation.attempt_id = :attempt' : ''),
        ExpressionAttributeNames: { '#status': 'status', ...(replacement && { '#state': 'state' }) },
        ExpressionAttributeValues: {
          ':receipt': receiptToSave,
          ':startingStatus': replacement ? TaskStatus.AWAITING_APPROVAL : TaskStatus.HYDRATING,
          ':user': userId,
          ...(replacement && { ':starting': 'STARTING', ':attempt': attemptId }),
        },
      }));
      await ensureWorkerLease({ taskId, userId, repo: record.repo ?? '', attemptId, requestHash });
      return { clientToken: attemptId, closed: false };
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      // Re-read the winner, or observe cancellation, before any side effect.
    }
  }
  throw new Error('MICROVM_START_STATE_INVALID: start receipt changed while being claimed');
}

/** Retain a known ID even if cancellation won while RunMicrovm was in flight. */
export async function saveMicrovmStartHandle(
  taskId: string,
  clientToken: string,
  handle: MicrovmHandle,
): Promise<void> {
  const replacement = clientToken !== taskId;
  const update = {
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    UpdateExpression: 'SET microvm_start.#handle = :handle, session_id = :id, '
      + 'compute_type = :type, compute_metadata = :metadata'
      + (replacement ? ', continuation.worker_id = :id, continuation.#state = :restoring' : ''),
    ConditionExpression: 'microvm_start.clientToken = :token AND '
      + '(attribute_not_exists(microvm_start.#handle) OR microvm_start.#handle.microvmId = :id) AND '
      + '(attribute_not_exists(session_id) OR session_id = :id)'
      + (replacement ? ' AND continuation.attempt_id = :token' : ''),
    ExpressionAttributeNames: { '#handle': 'handle', ...(replacement && { '#state': 'state' }) },
    ExpressionAttributeValues: {
      ':token': clientToken,
      ':id': handle.microvmId,
      ':handle': handle,
      ':type': 'lambda-microvm',
      ':metadata': {
        microvmId: handle.microvmId, endpoint: handle.endpoint, ...readMicrovmImageMetadata(handle),
      },
      ...(replacement && { ':restoring': 'RESTORING' }),
    },
  };
  if (continuationEnabled()) {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Update: update }, leaseHandleUpdate(taskId, clientToken, handle.microvmId),
      ],
    }));
  } else {
    await ddb.send(new UpdateCommand(update));
  }
}

/** Enrich only the same durably saved launch; never replace its identity or task state. */
export async function saveMicrovmImageCapability(
  taskId: string, clientToken: string, handle: MicrovmHandle,
): Promise<void> {
  if (!supportsMicrovmLifecycle(handle)) throw new Error('MicroVM image capability is incomplete');
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { task_id: taskId },
    UpdateExpression: 'SET microvm_start.#handle.lifecycleProtocol = :protocol, compute_metadata.lifecycleProtocol = :protocol',
    ConditionExpression: 'microvm_start.clientToken = :token AND session_id = :id AND '
      + 'microvm_start.#handle.microvmId = :id AND compute_metadata.microvmId = :id AND '
      + 'microvm_start.#handle.imageArn = :arn AND compute_metadata.imageArn = :arn AND '
      + 'microvm_start.#handle.imageVersion = :version AND compute_metadata.imageVersion = :version',
    ExpressionAttributeNames: { '#handle': 'handle' },
    ExpressionAttributeValues: {
      ':token': clientToken,
      ':id': handle.microvmId,
      ':arn': handle.imageArn,
      ':version': handle.imageVersion,
      ':protocol': handle.lifecycleProtocol,
    },
  }), { abortSignal: AbortSignal.timeout(MICROVM_IMAGE_CAPABILITY_REQUEST_TIMEOUT_MS) });
}
