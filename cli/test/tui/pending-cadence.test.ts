/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * Adaptive `/v1/pending` cadence machine. Phase A live drive surfaced
 * the case where the TUI's fixed 2 s pending poll hit the server's
 * RATE_LIMIT_EXCEEDED in production; this state machine moves the
 * cadence between 3-30 s based on activity and 429 responses.
 */

import {
  INITIAL_PENDING_CADENCE,
  PENDING_BACKOFF_INTERVALS_MS,
  PENDING_FAST_INTERVAL_MS,
  PENDING_RATE_LIMITED_INTERVAL_MS,
  isRateLimitError,
  nextPendingCadence,
} from '../../src/tui/utils/pending-cadence';

describe('nextPendingCadence', () => {
  it('starts at the fast interval', () => {
    expect(INITIAL_PENDING_CADENCE.intervalMs).toBe(PENDING_FAST_INTERVAL_MS);
    expect(INITIAL_PENDING_CADENCE.consecutiveEmptyPolls).toBe(0);
    expect(INITIAL_PENDING_CADENCE.rateLimited).toBe(false);
  });

  it('walks the ladder on consecutive empty polls', () => {
    let s = INITIAL_PENDING_CADENCE;
    for (let i = 0; i < PENDING_BACKOFF_INTERVALS_MS.length; i += 1) {
      s = nextPendingCadence(s, { sawPending: false, rateLimited: false });
      expect(s.intervalMs).toBe(PENDING_BACKOFF_INTERVALS_MS[i]);
      expect(s.consecutiveEmptyPolls).toBe(i + 1);
      expect(s.rateLimited).toBe(false);
    }
  });

  it('pins at the slowest slot once the ladder is exhausted', () => {
    let s = INITIAL_PENDING_CADENCE;
    for (let i = 0; i < 10; i += 1) {
      s = nextPendingCadence(s, { sawPending: false, rateLimited: false });
    }
    expect(s.intervalMs).toBe(
      PENDING_BACKOFF_INTERVALS_MS[PENDING_BACKOFF_INTERVALS_MS.length - 1],
    );
  });

  it('resets to the fast interval when a poll returns at least one row', () => {
    let s = INITIAL_PENDING_CADENCE;
    s = nextPendingCadence(s, { sawPending: false, rateLimited: false });
    s = nextPendingCadence(s, { sawPending: false, rateLimited: false });
    expect(s.intervalMs).toBeGreaterThan(PENDING_FAST_INTERVAL_MS);
    s = nextPendingCadence(s, { sawPending: true, rateLimited: false });
    expect(s.intervalMs).toBe(PENDING_FAST_INTERVAL_MS);
    expect(s.consecutiveEmptyPolls).toBe(0);
  });

  it('jumps to the rate-limit interval on 429', () => {
    const s = nextPendingCadence(INITIAL_PENDING_CADENCE, {
      sawPending: false,
      rateLimited: true,
    });
    expect(s.intervalMs).toBe(PENDING_RATE_LIMITED_INTERVAL_MS);
    expect(s.rateLimited).toBe(true);
  });

  it('clears rate-limited flag on next successful non-429 poll', () => {
    const limited = nextPendingCadence(INITIAL_PENDING_CADENCE, {
      sawPending: false,
      rateLimited: true,
    });
    const recovered = nextPendingCadence(limited, {
      sawPending: false,
      rateLimited: false,
    });
    expect(recovered.rateLimited).toBe(false);
  });

  it('rate-limited overrides sawPending when both are true', () => {
    // Defensive: in practice the server doesn't return rows with 429,
    // but the state machine treats 429 as authoritative.
    const s = nextPendingCadence(INITIAL_PENDING_CADENCE, {
      sawPending: true,
      rateLimited: true,
    });
    expect(s.intervalMs).toBe(PENDING_RATE_LIMITED_INTERVAL_MS);
    expect(s.rateLimited).toBe(true);
  });
});

describe('isRateLimitError', () => {
  it('detects an ApiError-shaped object with statusCode 429', () => {
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it('rejects other status codes', () => {
    expect(isRateLimitError({ statusCode: 500 })).toBe(false);
    expect(isRateLimitError({ statusCode: 401 })).toBe(false);
  });

  it('rejects objects without a statusCode field', () => {
    expect(isRateLimitError({})).toBe(false);
    expect(isRateLimitError(new Error('boom'))).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('429')).toBe(false);
    expect(isRateLimitError(429)).toBe(false);
  });
});
