/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * Test wrapper that mounts a TUI panel inside the full provider
 * stack (DataProvider + TuiProvider) backed by a mock source.
 * Returns the underlying ink-testing-library instance so tests
 * can stdin.write, assert lastFrame, and unmount.
 *
 * The mock source resolves Promises on the next microtask, so a
 * single `flush()` after render lands the first snapshot. Tests
 * that need to observe the snapshot should call `flush()` once
 * before asserting.
 */

import type { ReactElement } from 'react';
import { render } from 'ink-testing-library';
import { DataProvider } from '../../src/tui/hooks/useData';
import { TuiProvider } from '../../src/tui/context';
import { MockDataSource } from '../../src/tui/api/source-mock';
import type { DataSource } from '../../src/tui/api/source';

export interface RenderPanelOptions {
  /** Override the data source. Defaults to a fresh `MockDataSource`. */
  source?: DataSource;
  /** Override the provider's poll interval — set high in tests so the
   *  loop doesn't fire during the window of interest. */
  pollIntervalMs?: number;
}

export function renderPanel(
  node: ReactElement,
  opts: RenderPanelOptions = {},
): ReturnType<typeof render> {
  const source = opts.source ?? new MockDataSource();
  return render(
    <DataProvider source={source} pollIntervalMs={opts.pollIntervalMs ?? 60_000}>
      <TuiProvider>
        {node}
      </TuiProvider>
    </DataProvider>,
  );
}
