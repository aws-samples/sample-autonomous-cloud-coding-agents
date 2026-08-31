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

/**
 * Session-start transient auto-retry (once), extracted from the durable
 * ``orchestrate-task`` handler so the four retry branches are unit-testable in
 * isolation (the handler's inline ``start-session`` step is never invoked by
 * the test suite). See #599 review B1/B2.
 *
 * session-start is the ONE place a retry is idempotent by construction — no repo
 * clone, no commits, no PR have happened yet, so re-invoking
 * RunTask/InvokeAgentRuntime can't double-run work. A transient hiccup here (an
 * ECS deploy-race "TaskDefinition is inactive", ENI/capacity delay, a
 * Bedrock/agentcore throttle) usually clears on a second attempt, so the first
 * transient failure is swallowed and retried once. A NON-transient failure (bad
 * config, missing ECS substrate) is re-thrown immediately — retrying it just
 * wastes ~a minute. Mid-run crashes are NOT handled here (that's a later step;
 * the agent may have pushed commits).
 */

import type { ComputeStrategy, SessionHandle } from './compute-strategy';
import { classifyError, isTransientError } from './error-classifier';

/** Emit a ``session_start_retry`` telemetry event. Matches the shape of
 *  ``emitTaskEvent`` bound at the call site (best-effort — see below). */
export type RetryEventEmitter = (
  reason: string,
) => Promise<void>;

/** Minimal logger surface (a subset of the handler's structured logger). */
export interface RetryLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface StartSessionWithRetryResult {
  readonly handle: SessionHandle;
  /** True iff the first attempt failed transiently and a second attempt ran. */
  readonly autoRetried: boolean;
}

/**
 * Symbol tag pinned onto the error thrown from branch 4 (transient-then-transient)
 * so the retry fact survives the throw — the ``autoRetried`` result field only
 * exists on the success paths. Kept as a Symbol (not an own string prop) so it
 * never collides with, or leaks into, the error's serialized shape. Read via
 * {@link isAutoRetried}.
 */
const AUTO_RETRIED = Symbol('autoRetried');

/** True iff ``err`` was thrown after an auto-retry already ran (branch 4). */
export function isAutoRetried(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[AUTO_RETRIED] === true;
}

/**
 * Start a compute session, auto-retrying ONCE on a transient failure.
 *
 * Behaviour (the four branches #599 B2 asks be covered):
 *   1. first attempt succeeds            → return it, ``autoRetried: false``.
 *   2. first attempt fails NON-transient → re-throw the original error (no retry).
 *   3. first attempt fails transient, retry succeeds → return it, ``autoRetried: true``.
 *   4. first attempt fails transient, retry also fails → throw the retry's error
 *      TAGGED with ``autoRetried = true`` (see {@link isAutoRetried}). The result
 *      object carries ``autoRetried`` only on the success paths (1/3); on the
 *      double-failure this function throws, so the fact is instead pinned onto the
 *      thrown error itself — the caller reads it via {@link isAutoRetried} to stamp
 *      the ``[auto-retried]`` marker. Without the tag the caller could not tell a
 *      double-transient failure (retry ran) from a first-attempt failure (it did
 *      not), and would wrongly tell the user "reply to retry" (N1).
 *
 * The ``emitRetryEvent`` call is BEST-EFFORT and internally guarded (B1): a
 * TaskEvents PutItem fault (throttle/timeout — exactly the conditions that
 * co-occur with the transient session-start failures this handles) must NOT
 * abort or mis-attribute the retry. A telemetry failure is logged and swallowed;
 * the retry proceeds regardless. Previously the emit was unguarded and, if it
 * threw after ``autoRetried`` was set but before the retry ran, the user was
 * told a second attempt failed when none had.
 */
export async function startSessionWithRetry(
  strategy: Pick<ComputeStrategy, 'startSession'>,
  input: Parameters<ComputeStrategy['startSession']>[0],
  deps: {
    emitRetryEvent: RetryEventEmitter;
    logger: RetryLogger;
    taskId: string;
  },
): Promise<StartSessionWithRetryResult> {
  try {
    const handle = await strategy.startSession(input);
    return { handle, autoRetried: false };
  } catch (firstErr) {
    // Classify the RAW error, NOT a `Session start failed: …` wrapper (#599 N2):
    // `/Session start failed/i` is itself a TRANSIENT pattern, so wrapping made
    // EVERY session-start failure classify transient — a genuine config/auth
    // fault (missing ECS env, AccessDenied) would eat a pointless ~1-min retry
    // and the "non-transient throws immediately" branch below was effectively
    // dead. Classifying the raw string restores that branch. (Widening the
    // classifier's transient patterns — e.g. ThrottlingException — is a separate
    // classifier-completeness concern, not this retry gate.)
    const classification = classifyError(String(firstErr));
    if (!isTransientError(classification)) {
      throw firstErr; // service/user error — a retry won't help; surface now.
    }
    deps.logger.warn('Session start hit a transient error — auto-retrying once', {
      task_id: deps.taskId,
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });
    // Best-effort telemetry — a PutItem fault here must never abort the retry
    // or mis-report the outcome (B1).
    try {
      await deps.emitRetryEvent(classification?.title ?? 'transient');
    } catch (emitErr) {
      deps.logger.warn('session_start_retry event emit failed (non-fatal)', {
        task_id: deps.taskId,
        error: emitErr instanceof Error ? emitErr.message : String(emitErr),
      });
    }
    try {
      const handle = await strategy.startSession(input);
      return { handle, autoRetried: true };
    } catch (retryErr) {
      // Branch 4: the retry ALSO failed. Pin the retry fact onto the thrown error
      // so the caller can stamp ``[auto-retried]`` (N1) — otherwise a double-
      // transient failure is indistinguishable from a first-attempt failure and
      // the user is wrongly told "reply to retry" instead of "I already retried".
      if (typeof retryErr === 'object' && retryErr !== null) {
        (retryErr as Record<symbol, unknown>)[AUTO_RETRIED] = true;
      }
      throw retryErr;
    }
  }
}
