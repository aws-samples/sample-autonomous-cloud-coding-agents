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
 * Adaptive cadence for the global `/v1/pending` poll inside the TUI's
 * DataProvider. Distinct from `polling.ts` (which paces per-task event
 * streams) because:
 *
 *   - `/pending` is an account-scoped query that the server explicitly
 *     rate-limits (see `commands/pending.ts::mapPendingError` — the
 *     CLI prints "slow down `watch` polls" on 429). The TUI got
 *     RATE_LIMIT_EXCEEDED in production at the previous 2 s default.
 *
 *   - The use-cases differ. The per-task event poll wants 500 ms when
 *     events are flowing so the Watch panel feels live. The pending
 *     poll only needs to surface a new approval row within a few
 *     seconds — the user's eyes are still on the Approvals panel
 *     reading the previous gate when the next one fires.
 *
 * Ladder (ms): 2000 → 5000 → 10000 → 30000.
 *   - First poll: 2 s (snappy enough that a fresh gate appears before
 *     the user finishes thinking). Sustained = 30 polls/min, which
 *     fits inside the server's default `PENDING_RATE_LIMIT_PER_MINUTE`
 *     of 60/user/min with 2x headroom for concurrent CLI calls.
 *   - Each consecutive empty poll backs off one slot.
 *   - On a poll that returns at least one pending row, reset to 2 s
 *     (an active session warrants more frequent polling).
 *   - On a poll that hits 429: jump straight to 30 s and stay there
 *     until the next non-429 poll resets the ladder. This is the key
 *     recovery property — the rate-limit window typically clears in
 *     30-60 s, so a single bad poll shouldn't cascade.
 *
 * Pure state machine so the cadence is testable without timers.
 */

export const PENDING_FAST_INTERVAL_MS = 2_000;
export const PENDING_BACKOFF_INTERVALS_MS: readonly number[] = [
  5_000,
  10_000,
  30_000,
];
export const PENDING_RATE_LIMITED_INTERVAL_MS = 30_000;

export interface PendingCadenceState {
  readonly intervalMs: number;
  readonly consecutiveEmptyPolls: number;
  /** Set after a 429 so the next call to `nextPendingCadence` is a
   *  no-op until something resets the ladder via a successful poll
   *  with rows. Used by callers as advisory state for UX (e.g. show a
   *  "rate-limited, slowing down" banner). */
  readonly rateLimited: boolean;
}

export const INITIAL_PENDING_CADENCE: PendingCadenceState = {
  intervalMs: PENDING_FAST_INTERVAL_MS,
  consecutiveEmptyPolls: 0,
  rateLimited: false,
};

export interface PendingPollOutcome {
  /** Did the poll return at least one pending row? */
  readonly sawPending: boolean;
  /** Did the server return a 429? Takes precedence over `sawPending`. */
  readonly rateLimited: boolean;
}

export function nextPendingCadence(
  state: PendingCadenceState,
  outcome: PendingPollOutcome,
): PendingCadenceState {
  if (outcome.rateLimited) {
    return {
      intervalMs: PENDING_RATE_LIMITED_INTERVAL_MS,
      consecutiveEmptyPolls: state.consecutiveEmptyPolls,
      rateLimited: true,
    };
  }
  if (outcome.sawPending) {
    return INITIAL_PENDING_CADENCE;
  }
  const nextEmpty = state.consecutiveEmptyPolls + 1;
  const idx = Math.min(nextEmpty - 1, PENDING_BACKOFF_INTERVALS_MS.length - 1);
  return {
    intervalMs: PENDING_BACKOFF_INTERVALS_MS[idx],
    consecutiveEmptyPolls: nextEmpty,
    rateLimited: false,
  };
}

/**
 * Type-narrow an arbitrary thrown value to `{statusCode: number}` so
 * the DataProvider can detect 429s without an `instanceof ApiError`
 * import (avoids pulling the full api-client into the TUI source-mock
 * tests). Mirrors the shape exported by `cli/src/errors.ts::ApiError`.
 */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const sc = (err as { statusCode?: unknown }).statusCode;
  return typeof sc === 'number' && sc === 429;
}
