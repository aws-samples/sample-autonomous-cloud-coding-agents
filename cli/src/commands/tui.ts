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

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { CliError } from '../errors';

/** Test seam: swap the TUI runner so `commands/tui.ts` can be
 *  exercised without booting the full Ink runtime. Production
 *  callers never touch this — the default launches the real TUI. */
type RunTuiFn = () => Promise<void>;
let runTuiImpl: RunTuiFn | null = null;
export function _setRunTuiForTests(fn: RunTuiFn | null): void {
  runTuiImpl = fn;
}

/**
 * `bgagent tui [--mock]` — launch the interactive terminal UI.
 *
 * The TUI shares auth + config with all other `bgagent` commands
 * (Cognito + `~/.bgagent/config.json`), so a user who has already
 * run `bgagent login` can jump straight in. Use `--mock` (or
 * export `BGAGENT_TUI_MOCK=1`) to run against in-memory fixtures
 * — useful for demos without a deployed backend.
 *
 * The TUI code lives in `cli/src/tui/` and is loaded lazily so the
 * heavier Ink + React dependency graph isn't paid on every
 * `bgagent` invocation.
 */
export function makeTuiCommand(): Command {
  return new Command('tui')
    .description('Launch the interactive terminal UI')
    .option('--mock', 'Use in-memory mock data instead of the live API (for demos)', false)
    .addHelpText(
      'after',
      '\nExamples:\n'
      + '  $ bgagent tui             # live mode — requires `bgagent configure` + `bgagent login`\n'
      + '  $ bgagent tui --mock      # mock mode — no backend required\n'
      + '  $ BGAGENT_TUI_MOCK=1 bgagent tui\n',
    )
    .action(async (opts) => {
      // Flip the env flag for `DataProvider.pickSourceFromEnv()`.
      // Setting it here (rather than constructing a `MockDataSource`
      // directly) keeps the TUI launcher source-agnostic — the
      // selection stays in one place.
      if (opts.mock) {
        process.env.BGAGENT_TUI_MOCK = '1';
      }

      try {
        if (runTuiImpl) {
          await runTuiImpl();
          return;
        }
        // Lazy-load so non-TUI commands don't pay the Ink/React cost.
        // The TUI builds via a separate tsconfig (React JSX + Node16
        // ESM output), so we dynamic-`import()` rather than
        // `require()`. The emitted `lib/tui/` carries a
        // `package.json` with `"type": "module"` so Node recognizes
        // the bundle as ESM. We resolve an absolute file:// URL
        // because bare relative paths don't resolve reliably across
        // CJS → ESM interop.
        //
        // The indirection `Function('p', 'return import(p)')` keeps
        // TypeScript's CommonJS transpile from rewriting `import()`
        // into `require()` — otherwise the ESM graph rejection
        // recurs.
        const tuiAbsPath = path.resolve(__dirname, '..', 'tui', 'index.js');
        const tuiUrl = pathToFileURL(tuiAbsPath).href;
        const dynImport = Function('p', 'return import(p)') as (p: string) => Promise<{ runTui: () => Promise<void> }>;
        const tui = await dynImport(tuiUrl);
        await tui.runTui();
      } catch (err) {
        if (err instanceof Error) {
          throw new CliError(`Failed to launch TUI: ${err.message}`);
        }
        throw err;
      }
    });
}
