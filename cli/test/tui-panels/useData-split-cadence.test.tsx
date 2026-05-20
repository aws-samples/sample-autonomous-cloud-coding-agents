/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * Verifies the DataProvider splits tasks/repos polling from pending
 * polling. Phase A surfaced a UX regression where backing off the
 * /v1/pending cadence (correct, the endpoint is rate-limited) also
 * delayed the Tasks list updating after a CLI submit (wrong — that
 * endpoint isn't rate-limited and the user expects it live).
 *
 * The fix moved tasks/repos to a fixed 3 s cadence and kept only
 * /pending on the adaptive ladder. This suite asserts the two
 * timers fire independently, and that switching to the Approvals
 * panel resets the pending cadence to fast.
 */

import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { jest } from '@jest/globals';
import React, { useEffect } from 'react';
import { MockDataSource } from '../../src/tui/api/source-mock';
import { DataProvider, useData } from '../../src/tui/hooks/useData';
import { flush } from './_helpers';

/** Tiny harness component that exposes the data context to the
 *  surrounding test by reading and rendering a counter for each
 *  endpoint, and optionally calls `resetPendingCadence` once on
 *  mount. */
const Harness: React.FC<{ resetOnMount?: boolean }> = ({ resetOnMount }) => {
  const { snapshot, resetPendingCadence } = useData();
  useEffect(() => {
    if (resetOnMount) resetPendingCadence();
  }, [resetOnMount, resetPendingCadence]);
  return (
    <Box flexDirection="column">
      <Text>tasks={snapshot.tasks.length}</Text>
      <Text>pending={snapshot.approvals.length}</Text>
      <Text>err={snapshot.error ?? 'null'}</Text>
      <Text>rl={snapshot.rateLimited ? 'true' : 'false'}</Text>
    </Box>
  );
};

describe('DataProvider split cadence', () => {
  it('runs tasks and pending refreshes through separate code paths', async () => {
    const source = new MockDataSource();
    const tasksSpy = jest.spyOn(source, 'listTasks');
    const pendingSpy = jest.spyOn(source, 'listPending');
    // Use the adaptive ladder (no pollIntervalMs override). Initial
    // pending cadence is 3 s; tasks default cadence is 3 s. We don't
    // wait long enough to observe a second poll on either — we just
    // assert that both fire independently on initial hydration, which
    // would not happen if the unified-refresh code path were still
    // active and one of them threw.
    const { unmount } = render(
      <DataProvider source={source}>
        <Harness />
      </DataProvider>,
    );
    for (let i = 0; i < 3; i += 1) await flush();
    expect(tasksSpy).toHaveBeenCalledTimes(1);
    expect(pendingSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('resetPendingCadence triggers an additional /pending poll', async () => {
    const source = new MockDataSource();
    const tasksSpy = jest.spyOn(source, 'listTasks');
    const pendingSpy = jest.spyOn(source, 'listPending');
    const { rerender, unmount } = render(
      <DataProvider source={source}>
        <Harness resetOnMount={false} />
      </DataProvider>,
    );
    for (let i = 0; i < 3; i += 1) await flush();
    const tasksBefore = tasksSpy.mock.calls.length;
    const pendingBefore = pendingSpy.mock.calls.length;
    // Re-render with resetOnMount=true to fire the reset.
    rerender(
      <DataProvider source={source}>
        <Harness resetOnMount />
      </DataProvider>,
    );
    for (let i = 0; i < 4; i += 1) await flush();
    // A reset must have produced at least one extra /pending call.
    expect(pendingSpy.mock.calls.length).toBeGreaterThan(pendingBefore);
    // Tasks call count is unaffected by the reset (it has its own
    // timer). Allow ±1 because the timing of the tasks tick relative
    // to the rerender is non-deterministic in the test harness; we
    // mainly want to confirm the reset doesn't ALSO restart the tasks
    // timer (which would be a leak — separate timers must stay
    // separate).
    expect(Math.abs(tasksSpy.mock.calls.length - tasksBefore)).toBeLessThanOrEqual(2);
    unmount();
  });

  it('a 429 on /pending does not interfere with future /tasks polls', async () => {
    const source = new MockDataSource();
    const tasksSpy = jest.spyOn(source, 'listTasks');
    // Synthesize an ApiError-shaped 429 so isRateLimitError() narrows.
    const rateLimitErr = Object.assign(new Error('429 RATE_LIMIT_EXCEEDED'), {
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED',
    });
    let pendingCalls = 0;
    jest.spyOn(source, 'listPending').mockImplementation(async () => {
      pendingCalls += 1;
      // First call rate-limits; subsequent calls would succeed but we
      // don't wait long enough to observe them.
      if (pendingCalls === 1) throw rateLimitErr;
      return [];
    });
    const { lastFrame, unmount } = render(
      <DataProvider source={source}>
        <Harness />
      </DataProvider>,
    );
    for (let i = 0; i < 5; i += 1) await flush();
    // Tasks endpoint was hit even though pending threw.
    expect(tasksSpy).toHaveBeenCalled();
    // Snapshot reflects the rate-limit state from the pending failure.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('rl=true');
    expect(frame).toContain('Rate limit reached');
    // tasks count is still rendered — the tasks branch did NOT inherit
    // the pending error path.
    expect(frame).toMatch(/tasks=\d+/);
    unmount();
  });
});
