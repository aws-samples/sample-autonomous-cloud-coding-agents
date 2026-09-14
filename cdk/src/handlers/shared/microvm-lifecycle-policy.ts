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

import type { SessionStatus } from './compute-strategy';
import { intentMatchesGate, type MicrovmLifecycleSnapshot } from './microvm-lifecycle';
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

// Initial policy values, not service limits. Live timings must validate them.
export const MICROVM_SUSPEND_GRACE_MS = 30_000;
export const MICROVM_WAKE_MARGIN_MS = 60_000;
export const MICROVM_MIN_USEFUL_SLEEP_MS = 30_000;
export const MICROVM_TRANSITION_POLL_MS = 5_000;

export interface MicrovmLifecyclePolicyInput {
  readonly snapshot: MicrovmLifecycleSnapshot;
  readonly substrate: SessionStatus;
  readonly nowMs: number;
  readonly sessionDeadlineMs: number;
  readonly pollIntervalMs: number;
  /** Stops new suspends; already-sleeping VMs can still wake or terminate. */
  readonly suspendEnabled: boolean;
  /** True only for the compatible pinned image once hooks/barriers are deployed. */
  readonly imageSupportsLifecycle: boolean;
}

export type MicrovmLifecycleDecision = (
  | { readonly action: 'wait' | 'terminate' | 'reconcile-terminal' }
  | { readonly action: 'suspend' | 'resume'; readonly requestReady: boolean }
) & { readonly reason: string; readonly nextPollInMs: number };

/** Pure policy: no API calls, status changes, or approval decisions. */
export function decideMicrovmLifecycle(input: MicrovmLifecyclePolicyInput): MicrovmLifecycleDecision {
  const { snapshot, substrate, nowMs, sessionDeadlineMs, pollIntervalMs } = input;
  if (![nowMs, sessionDeadlineMs, pollIntervalMs].every(value => Number.isSafeInteger(value) && value >= 0) || pollIntervalMs === 0) {
    throw new Error('MicroVM lifecycle policy requires valid millisecond times and a positive poll interval');
  }
  const state = substrate.microvmState ?? 'UNKNOWN';
  const terminal = state === 'TERMINATING' || state === 'TERMINATED' || state === 'NOT_FOUND';
  const nextPollInMs = Math.max(1, Math.min(pollIntervalMs, sessionDeadlineMs - nowMs));
  const transitionPoll = Math.min(nextPollInMs, MICROVM_TRANSITION_POLL_MS);
  if (TERMINAL_STATUSES.some(status => status === snapshot.status) || snapshot.status === TaskStatus.FINALIZING) {
    return { action: terminal ? 'wait' : 'terminate', reason: 'task-closed', nextPollInMs };
  }
  if (terminal) return { action: 'reconcile-terminal', reason: 'substrate-terminal', nextPollInMs };
  if (nowMs >= sessionDeadlineMs) return { action: 'terminate', reason: 'session-deadline', nextPollInMs };
  if (state !== 'RUNNING' && state !== 'SUSPENDING' && state !== 'SUSPENDED') {
    return { action: 'wait', reason: state === 'PENDING' ? 'starting' : 'unconfirmed-state', nextPollInMs: transitionPoll };
  }

  const sleeping = state === 'SUSPENDING' || state === 'SUSPENDED';
  const wake = (reason: string): MicrovmLifecycleDecision => ({
    action: 'resume', requestReady: state === 'SUSPENDED', reason, nextPollInMs: transitionPoll,
  });
  const sameGate = intentMatchesGate(snapshot);
  if (snapshot.status !== TaskStatus.AWAITING_APPROVAL) {
    if (snapshot.status !== TaskStatus.RUNNING && snapshot.status !== TaskStatus.HYDRATING) {
      return { action: 'wait', reason: 'task-not-active', nextPollInMs };
    }
    if (sleeping || (snapshot.intent?.action === 'suspend')) return wake('suspended-outside-gate');
    return { action: 'wait', reason: 'working', nextPollInMs };
  }

  const approval = snapshot.approval;
  if (approval.kind !== 'present') {
    // A failed/missing read is not permission to sleep. Preserve wake intent
    // even while RUNNING if an earlier suspend might still be in flight.
    if (sleeping || snapshot.intent) return wake(`approval-${approval.kind}`);
    return { action: 'wait', reason: `approval-${approval.kind}`, nextPollInMs: transitionPoll };
  }
  if (approval.status !== 'PENDING') return wake('approval-terminal');
  if (sameGate && snapshot.intent?.deadline_ms !== approval.deadlineMs) return wake('approval-deadline-changed');
  if (sameGate && snapshot.intent?.action === 'resume') {
    return sleeping ? wake('wake-intent') : { action: 'wait', reason: 'wake-intent', nextPollInMs: transitionPoll };
  }
  if (approval.createdAtMs > nowMs) return wake('approval-time-invalid');
  const wakeAt = Math.min(approval.deadlineMs, sessionDeadlineMs) - MICROVM_WAKE_MARGIN_MS;
  if (nowMs >= wakeAt) return wake('wake-deadline');

  if (sleeping) {
    if (!sameGate || snapshot.intent?.action !== 'suspend' || snapshot.intent.deadline_ms !== approval.deadlineMs) {
      return wake('unintended-suspension');
    }
    return { action: 'wait', reason: 'intentionally-suspended', nextPollInMs: Math.min(nextPollInMs, wakeAt - nowMs) };
  }
  if (!input.suspendEnabled || !input.imageSupportsLifecycle) {
    return { action: 'wait', reason: 'suspend-disabled', nextPollInMs };
  }
  // A prior gate's in-flight suspend must be resolved conservatively. Persist a
  // wake for this gate rather than attributing that old sleep request to it.
  if (snapshot.intent?.action === 'suspend' && !sameGate) return wake('previous-gate-suspend');
  const graceEndsAt = approval.createdAtMs + MICROVM_SUSPEND_GRACE_MS;
  if (nowMs < graceEndsAt) {
    return { action: 'wait', reason: 'suspend-grace', nextPollInMs: Math.min(nextPollInMs, graceEndsAt - nowMs, wakeAt - nowMs) };
  }
  if (wakeAt - nowMs < MICROVM_MIN_USEFUL_SLEEP_MS) {
    return { action: 'wait', reason: 'short-window', nextPollInMs: Math.min(nextPollInMs, wakeAt - nowMs) };
  }
  return {
    action: 'suspend',
    requestReady: true,
    reason: 'pending-long-gate',
    nextPollInMs: Math.min(transitionPoll, wakeAt - nowMs),
  };
}
