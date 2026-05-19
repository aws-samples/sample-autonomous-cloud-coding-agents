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
 * Adaptive polling cadence for the Watch panel.
 *
 * Mirrors `commands/watch.ts::nextCadence` (design
 * INTERACTIVE_AGENTS.md §5.3): 500 ms while events are arriving,
 * backing off through 1 s / 2 s / 5 s on consecutive empty polls,
 * resetting to fast on the next poll that delivers events.
 *
 * Kept in its own module (and as a pure state machine) so the
 * TUI-side cadence stays in lockstep with the CLI's without
 * re-importing from `commands/watch.ts` — that module has a lot of
 * retry / session-flap plumbing the TUI does not need (the
 * DataProvider's error state covers degraded polling UX).
 */

export const POLL_FAST_INTERVAL_MS = 500;
export const BACKOFF_INTERVALS_MS: readonly number[] = [1_000, 2_000, 5_000];

export interface PollCadenceState {
  readonly intervalMs: number;
  readonly consecutiveEmptyPolls: number;
}

export const INITIAL_POLL_CADENCE: PollCadenceState = {
  intervalMs: POLL_FAST_INTERVAL_MS,
  consecutiveEmptyPolls: 0,
};

/**
 * Compute the next cadence from whether the last poll delivered
 * events. Pure so the state machine is test-coverable without
 * timers.
 *
 * A single successful poll resets us to the fast cadence; this
 * matches the CLI's behaviour. It does NOT carry a session-level
 * retry counter — the TUI's DataProvider exposes an `error` channel
 * for degraded-upstream UX, and re-running the TUI is a cheap reset.
 */
export function nextCadence(state: PollCadenceState, sawEvents: boolean): PollCadenceState {
  if (sawEvents) {
    return INITIAL_POLL_CADENCE;
  }
  const nextEmpty = state.consecutiveEmptyPolls + 1;
  // Ladder index is `nextEmpty - 1` (first empty poll picks slot 0 = 1 s).
  // After the ladder is exhausted we pin at the cap.
  const idx = Math.min(nextEmpty - 1, BACKOFF_INTERVALS_MS.length - 1);
  return {
    intervalMs: BACKOFF_INTERVALS_MS[idx],
    consecutiveEmptyPolls: nextEmpty,
  };
}
