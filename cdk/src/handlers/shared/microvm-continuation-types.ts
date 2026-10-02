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

import type { SessionHandle } from './compute-strategy';
import constants from '../../../../contracts/constants.json';

export const CONTINUATION = constants.microvm_continuation;
export type MicrovmHandle = Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;

export interface ContinuationIdentity {
  readonly task_id: string;
  /** Physical worker that captured the source checkpoint. */
  readonly attempt_id: string;
  readonly request_id: string;
  readonly user_id: string;
  readonly repo: string;
}

export interface ContinuationReceipt {
  readonly kind: 'manifest';
  readonly key: string;
  readonly version_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface ContinuationRecord {
  readonly version: number;
  /** PARKED means the source worker has retired; the guest's local parked phase only means a safe approval wait. */
  readonly state: 'READY' | 'FENCED' | 'PARKED' | 'STARTING' | 'RESTORING' | 'CONSUMED';
  readonly identity: ContinuationIdentity;
  readonly manifest: ContinuationReceipt;
  readonly source_handle?: MicrovmHandle;
  readonly parked_at?: string;
  /** Logical launch token, assigned before calling RunMicrovm. */
  readonly attempt_id?: string;
  readonly worker_id?: string;
  readonly started_at?: string;
}

export interface ContinuationLaunchReceipt {
  readonly version: number;
  readonly key: string;
  readonly version_id: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly orchestrator_version: string;
}

export interface WorkerLease {
  readonly task_id: string;
  readonly lease_attempt_id: string;
  readonly lease_state: 'ACTIVE' | 'FENCED' | 'PARKED' | 'CLOSED';
  readonly lease_user_id: string;
  readonly lease_repo: string;
  readonly lease_microvm_id?: string;
}

export function workerLeaseKey(taskId: string): { task_id: string } {
  return { task_id: CONTINUATION.lease_key_prefix + taskId };
}

export function validAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/** A worker may publish a pointer only within its own complete checkpoint prefix. */
export function validateContinuation(record: ContinuationRecord, task: {
  task_id: string; user_id: string; repo?: string; awaiting_approval_request_id?: string;
}): void {
  const identity = record?.identity;
  const receipt = record?.manifest;
  if (record?.version !== CONTINUATION.version || !identity || !receipt
    || identity.task_id !== task.task_id || identity.user_id !== task.user_id || identity.repo !== (task.repo ?? '')
    || identity.request_id !== task.awaiting_approval_request_id
    || !validAttemptId(identity.task_id) || !validAttemptId(identity.attempt_id) || !validAttemptId(identity.request_id)
    || receipt.kind !== 'manifest' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || receipt.key !== `${CONTINUATION.object_key_prefix}${identity.task_id}/${identity.attempt_id}/${identity.request_id}/manifest/${receipt.sha256}.json`
    || typeof receipt.version_id !== 'string' || !receipt.version_id || receipt.version_id === 'null'
    || !Number.isSafeInteger(receipt.size_bytes) || receipt.size_bytes <= 0 || receipt.size_bytes > CONTINUATION.max_manifest_bytes) {
    throw new Error('MICROVM_CONTINUATION_INVALID: checkpoint identity or receipt does not match the pending request');
  }
}
