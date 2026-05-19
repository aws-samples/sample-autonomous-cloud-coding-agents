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
 * TUI bootstrap. Exports `runTui()` for both the standalone
 * `npm run tui` dev path and the `bgagent tui` subcommand.
 */
import { render } from 'ink';
import React from 'react';
import type { DataSource } from './api/source.js';
import App from './App.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import { TuiProvider } from './context.js';
import { DataProvider } from './hooks/useData.js';

// ── Alt screen buffer ───────────────────────────────────────────
// Like vim/htop — no scrollback, clean repaint.
const enterAltScreen = () => {
  process.stdout.write('\x1b[?1049h'); // enter alt buffer
  process.stdout.write('\x1b[?25l'); // hide cursor
};

const leaveAltScreen = () => {
  process.stdout.write('\x1b[?25h'); // show cursor
  process.stdout.write('\x1b[?1049l'); // leave alt buffer
};

export interface RunTuiOptions {
  /** Inject a specific data source (used by the subcommand when it
   *  wants to force mock or live regardless of the env flag). */
  readonly source?: DataSource;
}

/** Start the TUI and return a Promise that resolves when the user
 *  exits (Ctrl+C or `q`). Safe to call from a subcommand action. */
export async function runTui(opts: RunTuiOptions = {}): Promise<void> {
  enterAltScreen();

  const cleanup = () => { leaveAltScreen(); };
  const onSigint = () => { cleanup(); process.exit(0); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });

  const { waitUntilExit } = render(
    <ErrorBoundary>
      <DataProvider source={opts.source}>
        <TuiProvider>
          <App />
        </TuiProvider>
      </DataProvider>
    </ErrorBoundary>,
  );

  try {
    await waitUntilExit();
  } finally {
    cleanup();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);
  }
}

// Boot standalone when invoked directly via `npm run tui`.
// Works in ESM (TUI is compiled with `module: Node16` + `type: module`
// in the emitted package.json) via `import.meta.url` comparison.
// `require.main === module` would ReferenceError here.
import { pathToFileURL } from 'node:url';
const invokedDirectly = typeof process !== 'undefined'
  && process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runTui().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
