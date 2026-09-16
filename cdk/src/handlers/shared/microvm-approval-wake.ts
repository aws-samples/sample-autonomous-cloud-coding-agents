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

// SPDX-License-Identifier: MIT-0

import { GetMicrovmCommand, LambdaMicrovmsClient, ResumeMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import type { Context } from 'aws-lambda';
import type { SessionControlOptions } from './compute-strategy';
import { logger } from './logger';
import { microvmErrorIdentity, microvmRequestIdentity } from './microvm-control';
import { readMicrovmLifecycleSnapshot, saveMicrovmLifecycleIntent, type MicrovmLifecycleSnapshot } from './microvm-lifecycle';
import { makeClient } from './ua';
import { TaskStatus } from '../../constructs/task-status';

const API_TIMEOUT_MS = 15_000;
const RESPONSE_RESERVE_MS = 1_000;
export const APPROVAL_POST_COMMIT_TIMEOUT_MS = 8_000;
export const APPROVAL_AUDIT_TIMEOUT_MS = 2_000;
let client: LambdaMicrovmsClient | undefined;

/** Reserve time to send 202 after a committed decision, including slow prior work. */
export function approvalPostCommitOptions(
  invocationStartedMs: number, context?: Pick<Context, 'getRemainingTimeInMillis'>,
): SessionControlOptions {
  const remaining = context?.getRemainingTimeInMillis() ?? API_TIMEOUT_MS - (Date.now() - invocationStartedMs);
  const budget = Math.floor(Math.min(APPROVAL_POST_COMMIT_TIMEOUT_MS, remaining - RESPONSE_RESERVE_MS));
  return {
    abortSignal: Number.isSafeInteger(budget) && budget > 0
      ? AbortSignal.timeout(budget) : AbortSignal.abort(new Error('Approval post-commit budget exhausted')),
  };
}

interface ApprovalWakeInput {
  readonly taskId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly decision: 'APPROVED' | 'DENIED';
  readonly options: SessionControlOptions;
  readonly emitEvent: (eventType: string, metadata: Record<string, unknown>, options: SessionControlOptions) => Promise<void>;
}

function relevant(snapshot: MicrovmLifecycleSnapshot, input: ApprovalWakeInput): boolean {
  if (snapshot.status === TaskStatus.AWAITING_APPROVAL) {
    return snapshot.requestId === input.requestId
      && (snapshot.approval.kind !== 'present' || snapshot.approval.status === input.decision);
  }
  // The guest may already have consumed this decision while an earlier Suspend
  // is still in flight. Fence only this decision's old intent, never a new gate.
  return snapshot.status === TaskStatus.RUNNING && snapshot.requestId === null
    && snapshot.intent?.request_id === input.requestId;
}

/**
 * Optional latency improvement after the approval transaction commits. The
 * durable supervisor remains responsible for retries and observed RUNNING.
 * This path cannot suspend, terminate, alter task status or rewrite a decision.
 */
export async function wakeMicrovmAfterApproval(input: ApprovalWakeInput): Promise<void> {
  const options = { abortSignal: input.options.abortSignal ?? AbortSignal.timeout(APPROVAL_POST_COMMIT_TIMEOUT_MS) };
  let stage = 'task-read';
  let microvmId: string | undefined;
  const report = async (reason: string, error?: unknown) => {
    const metadata = {
      task_id: input.taskId,
      request_id: input.requestId,
      ...(microvmId && { microvm_id: microvmId }),
      stage,
      reason,
      ...(error !== undefined && microvmErrorIdentity(error)),
    };
    logger.warn('MicroVM approval wake deferred to durable supervisor', metadata);
    try {
      const abortSignal = AbortSignal.any([options.abortSignal, AbortSignal.timeout(APPROVAL_AUDIT_TIMEOUT_MS)]);
      abortSignal.throwIfAborted();
      await input.emitEvent('microvm_resume_orphan', metadata, { abortSignal });
    } catch (auditError) {
      logger.warn('MicroVM resume audit failed after decision commit', { ...metadata, ...microvmErrorIdentity(auditError) });
    }
  };
  try {
    options.abortSignal?.throwIfAborted();
    const snapshot = await readMicrovmLifecycleSnapshot(input.taskId, input.userId, options);
    options.abortSignal.throwIfAborted();
    if (!snapshot) return;
    microvmId = snapshot.handle.microvmId;
    if (!relevant(snapshot, input)) {
      await report('task-or-gate-changed');
      return;
    }
    stage = 'wake-intent';
    const saved = await saveMicrovmLifecycleIntent(snapshot, 'resume', Date.now(), options);
    if (saved.status !== 'saved') {
      await report(`intent-${saved.status}`);
      return;
    }

    // Save even if AWS still reports RUNNING/SUSPENDING. A delayed Suspend must
    // not strand the worker after the decision handler has returned.
    stage = 'substrate-read';
    options.abortSignal?.throwIfAborted();
    client ??= makeClient(LambdaMicrovmsClient);
    const observed = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }), options);
    options.abortSignal?.throwIfAborted();
    logger.info('MicroVM observed after approval decision', {
      task_id: input.taskId,
      request_id: input.requestId,
      microvm_id: microvmId,
      observed_state: observed.state,
      generation: saved.intent.generation,
      intent_requested_at_ms: saved.intent.requested_at_ms,
      ...microvmRequestIdentity(observed),
    });
    if (observed.state !== 'SUSPENDED') {
      if (observed.state !== 'RUNNING' && observed.state !== 'SUSPENDING') await report('state-not-resumable');
      return;
    }

    stage = 'pre-resume-read';
    const current = await readMicrovmLifecycleSnapshot(input.taskId, input.userId, options);
    options.abortSignal?.throwIfAborted();
    if (!current || current.handle.microvmId !== microvmId || current.handle.endpoint !== snapshot.handle.endpoint
      || current.handle.sessionId !== snapshot.handle.sessionId
      || current.requestId !== snapshot.requestId || current.status !== snapshot.status
      || current.intent?.generation !== saved.intent.generation
      || (current.status === TaskStatus.AWAITING_APPROVAL && !relevant(current, input))) {
      await report('worker-or-gate-changed-before-resume');
      return;
    }

    stage = 'resume-request';
    const startedAt = Date.now();
    const diagnostic = {
      task_id: input.taskId,
      request_id: input.requestId,
      microvm_id: microvmId,
      generation: saved.intent.generation,
      intent_requested_at_ms: saved.intent.requested_at_ms,
      image_arn: snapshot.handle.imageArn,
      image_version: snapshot.handle.imageVersion,
    };
    logger.info('MicroVM wake request started after approval decision', diagnostic);
    try {
      const response = await client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }), options);
      logger.info('MicroVM wake requested after approval decision', {
        ...diagnostic, elapsed_ms: Date.now() - startedAt, ...microvmRequestIdentity(response),
      });
    } catch (error) {
      await report('resume-request-failed', error);
    } finally {
      // Check after both acknowledged and uncertain outcomes. No next action
      // follows a cancellation, changed gate or ownership loss in this handler.
      stage = 'post-resume-read';
      options.abortSignal?.throwIfAborted();
      await readMicrovmLifecycleSnapshot(input.taskId, input.userId, options);
    }
  } catch (error) {
    await report('wake-reconciliation-failed', error);
  }
}
