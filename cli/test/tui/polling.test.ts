/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import {
  BACKOFF_INTERVALS_MS,
  INITIAL_POLL_CADENCE,
  POLL_FAST_INTERVAL_MS,
  nextCadence,
} from '../../src/tui/utils/polling';

describe('nextCadence', () => {
  it('stays at fast cadence when events arrive', () => {
    const next = nextCadence(INITIAL_POLL_CADENCE, true);
    expect(next.intervalMs).toBe(POLL_FAST_INTERVAL_MS);
    expect(next.consecutiveEmptyPolls).toBe(0);
  });

  it('walks the backoff ladder on consecutive empty polls', () => {
    let state = INITIAL_POLL_CADENCE;
    const observed: number[] = [];
    for (let i = 0; i < BACKOFF_INTERVALS_MS.length + 2; i += 1) {
      state = nextCadence(state, false);
      observed.push(state.intervalMs);
    }
    // After ladder exhaustion, pins at the cap.
    expect(observed.slice(0, BACKOFF_INTERVALS_MS.length)).toEqual([...BACKOFF_INTERVALS_MS]);
    expect(observed[observed.length - 1]).toBe(BACKOFF_INTERVALS_MS[BACKOFF_INTERVALS_MS.length - 1]);
  });

  it('resets to fast on a single non-empty poll mid-backoff', () => {
    let state = nextCadence(INITIAL_POLL_CADENCE, false); // 1s
    state = nextCadence(state, false);                      // 2s
    state = nextCadence(state, true);                       // back to fast
    expect(state).toEqual(INITIAL_POLL_CADENCE);
  });

  it('counter increments monotonically during empty streak', () => {
    let state = INITIAL_POLL_CADENCE;
    for (let i = 1; i <= 5; i += 1) {
      state = nextCadence(state, false);
      expect(state.consecutiveEmptyPolls).toBe(i);
    }
  });
});
