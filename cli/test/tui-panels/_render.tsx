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

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import type { DataSource } from '../../src/tui/api/source';
import { MockDataSource } from '../../src/tui/api/source-mock';
import { TuiProvider } from '../../src/tui/context';
import { DataProvider } from '../../src/tui/hooks/useData';

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
