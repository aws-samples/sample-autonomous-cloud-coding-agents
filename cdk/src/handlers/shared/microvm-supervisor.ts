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

import { evaluateAgentHeartbeat } from './agent-heartbeat';
import type { ComputeStrategy, SessionControlOptions, SessionHandle, SessionStatus } from './compute-strategy';
import { logger } from './logger';
import { microvmErrorIdentity } from './microvm-control';
import {
  intentMatchesGate, readMicrovmLifecycleSnapshot, saveMicrovmLifecycleIntent,
  type MicrovmLifecycleSnapshot,
} from './microvm-lifecycle';
import { decideMicrovmLifecycle, MICROVM_TRANSITION_POLL_MS } from './microvm-lifecycle-policy';
import { readMicrovmSuspendEnabled } from './microvm-suspend-config';
import { MICROVM_MAX_DURATION_SECONDS } from './strategies/lambda-microvm-strategy';
import { TaskStatus, TERMINAL_STATUSES, type TaskStatusType } from '../../constructs/task-status';

type MicrovmHandle = Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;
export const MICROVM_SUPERVISOR_CYCLE_MS = 45_000;
export const MICROVM_MAX_POLL_FAILURES = 3;
export const MICROVM_RECOVERY_TIMEOUT_MS = 120_000;
export const MICROVM_STARTUP_TIMEOUT_MS = 300_000;
export const MICROVM_CLEANUP_TIMEOUT_MS = 25_000;

interface Recovery {
  readonly kind: 'starting' | 'unconfirmed' | 'suspend' | 'wake';
  readonly sinceMs: number;
}

/** JSON-only state retained by waitForCondition; a fresh Lambda must reuse it. */
export interface MicrovmSupervisorState {
  readonly version: 1;
  readonly microvmId: string;
  readonly firstObservedAtMs: number;
  readonly sessionDeadlineMs: number;
  readonly lifetimeVerified: boolean;
  /** False until AWS confirms a post-startup state; absent in older saved state. */
  readonly startupConfirmed?: boolean;
  readonly consecutivePollFailures: number;
  readonly consecutiveResumeFailures: number;
  readonly recovery?: Recovery;
  readonly anomalyReported: boolean;
  readonly nextPollInMs: number;
}

export interface MicrovmSupervisorInput {
  readonly taskId: string;
  readonly userId: string;
  readonly handle: MicrovmHandle;
  readonly strategy: ComputeStrategy;
  readonly previous?: MicrovmSupervisorState;
  readonly pollIntervalMs: number;
  readonly suspendEnabled: boolean;
  /** Implementations must respect the supplied signal; event failure is best-effort. */
  readonly emitEvent?: (eventType: string, metadata: Record<string, unknown>, options: SessionControlOptions) => Promise<void>;
}

type SupervisorOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'closed'; readonly status: TaskStatusType }
  | { readonly kind: 'substrate-terminal' }
  | { readonly kind: 'failure' | 'ownership-lost'; readonly reason: string };

export type MicrovmSupervisorResult = {
  readonly state: MicrovmSupervisorState;
  readonly snapshot?: MicrovmLifecycleSnapshot;
  readonly substrate?: SessionStatus;
  readonly deferHeartbeat: boolean;
  readonly heartbeatUnhealthy: boolean;
} & SupervisorOutcome;

function permanent(error: unknown): boolean {
  return ['AccessDeniedException', 'ValidationException', 'UnrecognizedClientException', 'InvalidSignatureException']
    .includes(microvmErrorIdentity(error).error_type);
}

function closed(status: TaskStatusType): boolean {
  return TERMINAL_STATUSES.includes(status) || status === TaskStatus.FINALIZING;
}

function sameWorker(snapshot: MicrovmLifecycleSnapshot | undefined, input: MicrovmSupervisorInput): snapshot is MicrovmLifecycleSnapshot {
  return snapshot?.handle.microvmId === input.handle.microvmId
    && snapshot.handle.sessionId === input.handle.sessionId && snapshot.handle.endpoint === input.handle.endpoint;
}

/**
 * One bounded poll cycle. Stores intent before control calls and rechecks after
 * every outcome. Task finalization and compute cleanup remain the durable caller's
 * responsibility; no task status or capacity reservation is changed here.
 */
export async function superviseMicrovm(input: MicrovmSupervisorInput): Promise<MicrovmSupervisorResult> {
  const now = Date.now();
  if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs <= 0) {
    throw new Error('MicroVM supervision requires a positive poll interval');
  }
  if (input.previous && (input.previous.version !== 1 || input.previous.microvmId !== input.handle.microvmId)) {
    throw new Error('MicroVM supervisor state belongs to another worker or protocol');
  }
  const prior = input.previous;
  let state: MicrovmSupervisorState = prior ?? {
    version: 1,
    microvmId: input.handle.microvmId,
    firstObservedAtMs: now,
    sessionDeadlineMs: now + MICROVM_MAX_DURATION_SECONDS * 1000,
    lifetimeVerified: false,
    startupConfirmed: false,
    consecutivePollFailures: 0,
    consecutiveResumeFailures: 0,
    anomalyReported: false,
    nextPollInMs: input.pollIntervalMs,
  };
  const options: SessionControlOptions = { abortSignal: AbortSignal.timeout(MICROVM_SUPERVISOR_CYCLE_MS) };
  let snapshot: MicrovmLifecycleSnapshot | undefined;
  let substrate: SessionStatus | undefined;
  let stage = 'task-read';
  let readFailed = false;
  let suspendRequested = false;
  const result = (outcome: SupervisorOutcome): MicrovmSupervisorResult => {
    if (outcome.kind === 'continue') {
      if (!readFailed) {state = { ...state, consecutivePollFailures: 0 };} else if (state.consecutivePollFailures >= MICROVM_MAX_POLL_FAILURES) {
        outcome = { kind: 'failure', reason: `${stage}-failed-repeatedly` };
      }
    }
    const deferHeartbeat = snapshot?.status === TaskStatus.AWAITING_APPROVAL || state.recovery !== undefined;
    return {
      ...outcome,
      state,
      snapshot,
      substrate,
      deferHeartbeat,
      heartbeatUnhealthy: !deferHeartbeat && snapshot?.status === TaskStatus.RUNNING
        && evaluateAgentHeartbeat(snapshot.taskStartedAtMs, snapshot.heartbeatAtMs, Date.now()) !== undefined,
    };
  };
  const retry = () => {
    state = { ...state, nextPollInMs: Math.min(MICROVM_TRANSITION_POLL_MS, input.pollIntervalMs) };
    return result({ kind: 'continue' });
  };
  const report = async (eventType: string, detail: Record<string, unknown>) => {
    const metadata = {
      task_id: input.taskId,
      microvm_id: input.handle.microvmId,
      ...(snapshot && { request_id: snapshot.requestId }),
      ...detail,
    };
    logger.warn(eventType, metadata);
    if (input.emitEvent) {
      try { await input.emitEvent(eventType, metadata, options); } catch (error) {
        logger.warn('MicroVM lifecycle audit failed', { ...metadata, ...microvmErrorIdentity(error) });
      }
    }
  };
  const fresh = async () => {
    options.abortSignal!.throwIfAborted();
    const current = await readMicrovmLifecycleSnapshot(input.taskId, input.userId, options);
    options.abortSignal!.throwIfAborted();
    return current;
  };
  const beginRecovery = (kind: Recovery['kind'], sinceMs = Date.now()) => {
    state = {
      ...state,
      recovery: state.recovery?.kind === kind ? state.recovery : { kind, sinceMs },
    };
  };
  const recoveryExpired = () => state.recovery !== undefined
    && Date.now() - state.recovery.sinceMs >= (state.recovery.kind === 'starting'
      ? MICROVM_STARTUP_TIMEOUT_MS : MICROVM_RECOVERY_TIMEOUT_MS);

  try {
    snapshot = await fresh();
    if (!sameWorker(snapshot, input)) return result({ kind: 'ownership-lost', reason: 'worker-record-changed-or-missing' });
    if (closed(snapshot.status)) {
      if (snapshot.status === TaskStatus.FINALIZING && Date.now() >= state.sessionDeadlineMs) {
        return result({ kind: 'failure', reason: 'session-deadline' });
      }
      state = { ...state, nextPollInMs: Math.max(1, Math.min(input.pollIntervalMs, state.sessionDeadlineMs - Date.now())) };
      return result({ kind: 'closed', status: snapshot.status });
    }
    stage = 'substrate-read';
    substrate = await input.strategy.pollSession(input.handle, options);
    options.abortSignal!.throwIfAborted();
    const startedAt = substrate.microvmStartedAtMs;
    const maximum = substrate.microvmMaximumDurationSeconds;
    if (Number.isSafeInteger(startedAt) && startedAt! >= 0
      && Number.isSafeInteger(maximum) && maximum! > 0) {
      const observedDeadline = startedAt! + Math.min(maximum!, MICROVM_MAX_DURATION_SECONDS) * 1000;
      if (Number.isSafeInteger(observedDeadline)) {
        state = { ...state, lifetimeVerified: true, sessionDeadlineMs: Math.min(state.sessionDeadlineMs, observedDeadline) };
      }
    }
    const approvalFailure = snapshot!.approval.kind === 'unavailable';
    readFailed = approvalFailure;
    state = {
      ...state,
      consecutivePollFailures: approvalFailure ? state.consecutivePollFailures + 1 : state.consecutivePollFailures,
    };
    const observed = substrate.microvmState ?? 'UNKNOWN';
    if (observed === 'RUNNING' || observed === 'SUSPENDING' || observed === 'SUSPENDED') {
      state = { ...state, startupConfirmed: true };
    }
    const wakeRepairWanted = state.recovery?.kind === 'wake'
      && (!intentMatchesGate(snapshot!) || snapshot!.intent?.action !== 'resume');
    const awaitingDecisionConsumption = snapshot.status === TaskStatus.AWAITING_APPROVAL
      && (snapshot.approval.kind !== 'present' || snapshot.approval.status !== 'PENDING'
        || Date.now() >= snapshot.approval.deadlineMs);
    if (observed === 'RUNNING') {
      // AWS RUNNING does not prove the guest consumed a decided/expired gate.
      // Recovery ends after fresh guest liveness, or an intentional early wake
      // where the original human decision is still pending.
      if (state.recovery?.kind !== 'wake' || (!wakeRepairWanted && (
        (snapshot.status === TaskStatus.RUNNING && (snapshot.heartbeatAtMs ?? -1) >= state.recovery.sinceMs)
        || (snapshot.status === TaskStatus.AWAITING_APPROVAL && !awaitingDecisionConsumption)
      ))) {
        state = { ...state, recovery: undefined, consecutiveResumeFailures: 0 };
      }
    } else if (observed === 'PENDING' || observed === 'UNKNOWN') {
      // An uncertain observation cannot reset an in-flight wake/suspend clock.
      if (!state.recovery) {
        if (intentMatchesGate(snapshot) && snapshot.intent?.action === 'resume') {
          // AWS can report PENDING while restoring an already-running worker.
          // An API-triggered wake may arrive between supervisor polls; retain its
          // saved start time instead of reusing the worker's original boot clock.
          beginRecovery('wake', Math.min(Date.now(), snapshot.intent.requested_at_ms));
        } else if (observed === 'PENDING'
          && (state.startupConfirmed === false || snapshot.status === TaskStatus.HYDRATING)) {
          // The coordinator marks the task RUNNING before AWS finishes startup.
          // Retain first-observation age across failed initial reads and replay.
          beginRecovery('starting', state.firstObservedAtMs);
        } else {
          beginRecovery('unconfirmed');
        }
      }
    }

    let suspendEnabled = input.suspendEnabled && state.lifetimeVerified;
    const policy = () => decideMicrovmLifecycle({
      snapshot: snapshot!,
      substrate: substrate!,
      nowMs: Date.now(),
      sessionDeadlineMs: state.sessionDeadlineMs,
      pollIntervalMs: input.pollIntervalMs,
      suspendEnabled,
    });
    let decision = policy();
    if ((wakeRepairWanted || (state.recovery?.kind === 'wake'
      && (observed === 'SUSPENDING' || observed === 'SUSPENDED')))
      && (decision.action === 'wait' || decision.action === 'suspend')
      && (observed === 'RUNNING' || observed === 'SUSPENDING' || observed === 'SUSPENDED')) {
      // A previous cycle may have lost the wake-intent write. Its durable recovery
      // state still forbids leaving the worker asleep while that write is retried.
      decision = {
        action: 'resume',
        requestReady: observed === 'SUSPENDED',
        reason: 'wake-recovery',
        nextPollInMs: MICROVM_TRANSITION_POLL_MS,
      };
    }
    if (decision.action === 'suspend') {
      suspendEnabled = await readMicrovmSuspendEnabled(options);
      decision = policy();
    }
    state = { ...state, nextPollInMs: decision.nextPollInMs };
    if (decision.action === 'reconcile-terminal') return result({ kind: 'substrate-terminal' });
    if (decision.action === 'terminate') return result({ kind: 'failure', reason: decision.reason });
    if (snapshot.status === TaskStatus.HYDRATING && Date.now() - state.firstObservedAtMs >= MICROVM_STARTUP_TIMEOUT_MS) {
      return result({ kind: 'failure', reason: 'startup-deadline' });
    }

    const anomaly = (observed === 'SUSPENDING' || observed === 'SUSPENDED')
      && state.recovery?.kind !== 'wake'
      && !(snapshot.status === TaskStatus.AWAITING_APPROVAL && intentMatchesGate(snapshot) && snapshot.intent?.action === 'resume')
      && (snapshot.status !== TaskStatus.AWAITING_APPROVAL || !intentMatchesGate(snapshot));
    if (anomaly && !state.anomalyReported) await report('microvm_suspend_anomaly', { reason: decision.reason });
    state = { ...state, anomalyReported: anomaly };

    if (decision.action === 'wait') {
      if (observed === 'SUSPENDING') beginRecovery('suspend', snapshot!.intent?.requested_at_ms ?? Date.now());
      if (observed === 'SUSPENDED') state = { ...state, recovery: undefined };
      if (recoveryExpired()) return result({ kind: 'failure', reason: 'recovery-deadline' });
      if (approvalFailure && state.consecutivePollFailures >= MICROVM_MAX_POLL_FAILURES) {
        return result({ kind: 'failure', reason: 'approval-read-failed-repeatedly' });
      }
      return result({ kind: 'continue' });
    }

    stage = `${decision.action}-intent`;
    if (decision.action === 'resume'
      && (observed === 'SUSPENDING' || observed === 'SUSPENDED' || awaitingDecisionConsumption || wakeRepairWanted)) {
      beginRecovery('wake');
    }
    const saved = await saveMicrovmLifecycleIntent(snapshot!, decision.action, Date.now(), options);
    if (saved.status !== 'saved') return retry();
    snapshot = { ...snapshot!, intent: saved.intent };

    if (decision.action === 'resume') {
      if (observed === 'SUSPENDING' || observed === 'SUSPENDED') beginRecovery('wake');
      if (recoveryExpired()) return result({ kind: 'failure', reason: 'wake-deadline' });
      if (!decision.requestReady) return retry();
    } else {
      beginRecovery('suspend', saved.intent.requested_at_ms);
      // An uncompleted attempt while still RUNNING is a lost saving opportunity.
      // Fence it with wake intent, including a delayed service-side suspension.
      if (recoveryExpired()) {
        beginRecovery('wake');
        await saveMicrovmLifecycleIntent(snapshot, 'resume', Date.now(), options);
        return retry();
      }
    }

    // Recheck the live switch after saving intent, then refresh the gate. An
    // immutable Lambda environment alone cannot disable an existing execution.
    if (decision.action === 'suspend') suspendEnabled = await readMicrovmSuspendEnabled(options);
    // Database success is not a lock over the next AWS request.
    stage = 'pre-command-read';
    snapshot = await fresh();
    if (!sameWorker(snapshot, input)) return result({ kind: 'ownership-lost', reason: 'worker-record-changed-or-missing' });
    if (closed(snapshot!.status)) return result({ kind: 'closed', status: snapshot!.status });
    if (snapshot!.intent?.generation !== saved.intent.generation || snapshot.requestId !== saved.intent.request_id) return retry();
    if (decision.action === 'suspend' && policy().action !== 'suspend') {
      // Approval/deadline/disable can win after intent was saved but before the call.
      beginRecovery('wake');
      await saveMicrovmLifecycleIntent(snapshot!, 'resume', Date.now(), options);
      return retry();
    }

    stage = `${decision.action}-request`;
    suspendRequested = decision.action === 'suspend';
    let commandError: unknown;
    try {
      const acknowledgement = decision.action === 'suspend'
        ? await input.strategy.suspendSession(input.handle, options)
        : await input.strategy.resumeSession(input.handle, options);
      if (!acknowledgement.supported) commandError = new Error('Lifecycle request is unsupported');
    } catch (error) { commandError = error; }
    if (commandError) {
      await report(`microvm_${decision.action}_request_failed`, { stage, ...microvmErrorIdentity(commandError) });
    }

    stage = 'post-command-read';
    snapshot = await fresh();
    if (!sameWorker(snapshot, input)) return result({ kind: 'ownership-lost', reason: 'worker-record-changed-or-missing' });
    if (closed(snapshot!.status)) return result({ kind: 'closed', status: snapshot!.status });
    if (decision.action === 'suspend' && (commandError || policy().action !== 'suspend')) {
      // Even a failed command can have committed. Retain wake until fresh AWS
      // observations confirm recovery; never erase it after an acknowledgment.
      beginRecovery('wake');
      await saveMicrovmLifecycleIntent(snapshot!, 'resume', Date.now(), options);
    }
    if (decision.action === 'resume') {
      state = { ...state, consecutiveResumeFailures: commandError ? state.consecutiveResumeFailures + 1 : 0 };
      if (commandError && (permanent(commandError) || state.consecutiveResumeFailures >= MICROVM_MAX_POLL_FAILURES)) {
        return result({ kind: 'failure', reason: 'resume-request-failed-repeatedly' });
      }
    }
    return retry();
  } catch (error) {
    // A lost post-command read/write cannot prove the worker stayed awake.
    // Persist this recovery obligation even when the wake-intent write failed.
    if (suspendRequested) beginRecovery('wake');
    state = { ...state, consecutivePollFailures: state.consecutivePollFailures + (readFailed ? 0 : 1) };
    readFailed = true;
    await report('microvm_supervisor_request_failed', {
      stage, consecutive_failures: state.consecutivePollFailures, ...microvmErrorIdentity(error),
    });
    if (permanent(error) || state.consecutivePollFailures >= MICROVM_MAX_POLL_FAILURES
      || recoveryExpired() || Date.now() >= state.sessionDeadlineMs) {
      return result({ kind: 'failure', reason: `${stage}-failed` });
    }
    return retry();
  }
}

/** Bounded best-effort cleanup; an unconfirmed outcome stays visible with its handle. */
export async function stopMicrovmWithDiagnostics(
  input: Pick<MicrovmSupervisorInput, 'taskId' | 'handle' | 'strategy' | 'emitEvent'>,
): Promise<void> {
  const options: SessionControlOptions = { abortSignal: AbortSignal.timeout(MICROVM_CLEANUP_TIMEOUT_MS) };
  let failure = { error_type: 'NoStopEvidence' } as ReturnType<typeof microvmErrorIdentity>;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      options.abortSignal!.throwIfAborted();
      const stopped = await input.strategy.stopSession(input.handle, options);
      if (stopped && stopped.outcome !== 'unconfirmed') return;
      if (stopped?.outcome === 'unconfirmed') failure = stopped;
    } catch (error) { failure = microvmErrorIdentity(error); }
    if (['AccessDeniedException', 'ValidationException'].includes(failure.error_type)) break;
  }
  const metadata = {
    task_id: input.taskId,
    microvm_id: input.handle.microvmId,
    error_type: failure.error_type,
    ...(failure.aws_request_id && { aws_request_id: failure.aws_request_id }),
  };
  logger.error('MicroVM cleanup unconfirmed; retained handle requires recovery', metadata);
  try {
    await input.emitEvent?.('microvm_cleanup_unconfirmed', metadata, options);
  } catch (error) {
    logger.warn('MicroVM cleanup audit failed', { ...metadata, ...microvmErrorIdentity(error) });
  }
}
