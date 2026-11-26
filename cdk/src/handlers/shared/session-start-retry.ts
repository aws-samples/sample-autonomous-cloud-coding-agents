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

import type { ComputeStrategy, SessionHandle } from './compute-strategy';
import { classifyError, isTransientError, MicrovmStartUncertainError } from './error-classifier';

/** Emit a ``session_start_retry`` telemetry event. */
export type RetryEventEmitter = (
  reason: string,
) => Promise<void>;

export interface RetryLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface StartSessionWithRetryResult {
  readonly handle: SessionHandle;
  /** True iff the first attempt failed transiently and a second attempt ran. */
  readonly autoRetried: boolean;
}

const AUTO_RETRIED = Symbol('autoRetried');

/** True iff ``err`` was thrown after an auto-retry already ran. */
export function isAutoRetried(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[AUTO_RETRIED] === true;
}

/**
 * Start a compute session, auto-retrying ONCE on a transient failure.
 *
 *   1. first attempt succeeds            → return it, ``autoRetried: false``.
 *   2. first attempt fails NON-transient → re-throw the original error (no retry).
 *   3. first attempt fails transient, retry succeeds → return it, ``autoRetried: true``.
 *   4. first attempt fails transient, retry also fails → throw the retry's error
 *      TAGGED with ``autoRetried = true`` (see {@link isAutoRetried}).
 *
 * The ``emitRetryEvent`` call is best-effort: a telemetry failure is logged and
 * swallowed; the retry proceeds regardless.
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
    const classification = classifyError(String(firstErr));
    if (!isTransientError(classification) && !(firstErr instanceof MicrovmStartUncertainError)) {
      throw firstErr;
    }
    const uncertain = firstErr instanceof MicrovmStartUncertainError;
    deps.logger.warn(uncertain
      ? 'MicroVM start response is unknown — recovering the same request once'
      : 'Session start hit a transient error — auto-retrying once', {
      task_id: deps.taskId,
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });
    try {
      await deps.emitRetryEvent(uncertain ? 'MicroVM start response unknown' : classification?.title ?? 'transient');
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
      const finalError = firstErr instanceof MicrovmStartUncertainError || retryErr instanceof MicrovmStartUncertainError
        ? new MicrovmStartUncertainError(String(retryErr), { cause: retryErr })
        : retryErr;
      if (typeof finalError === 'object' && finalError !== null) {
        (finalError as Record<symbol, unknown>)[AUTO_RETRIED] = true;
      }
      throw finalError;
    }
  }
}
