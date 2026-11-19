#!/usr/bin/env -S node --experimental-strip-types
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
 * Writes the `bgagent` command (#913): a small sh script in `~/.local/bin` that runs
 * the CLI of this checkout. The CLI is not published to npm, and should not be: it is
 * tied to the checkout the stack was deployed from (bootstrap version, the
 * DeploymentFeatures output, API shapes shared with the handlers).
 *
 * The script follows the checkout the user is in: from inside any ABCA checkout or
 * worktree it runs that checkout's CLI, and elsewhere the checkout that installed it.
 * Re-running this script with `--force` changes that fallback.
 *
 *   mise run cli:install            compile the CLI, then write the command
 *   mise run cli:install --force    also replace a `bgagent` that is not this checkout's
 *   (mise run install)              runs this with --keep-existing: never replaces
 *                                   anything and never fails the install
 *
 * `BGAGENT_BIN_DIR` overrides the directory (default `~/.local/bin`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** First line after the shebang of every script this writes; how one is recognized. */
const SHIM_MARKER = '# bgagent: written by `mise run cli:install`.';

/** Files that mark a directory as an ABCA checkout, so an unrelated `cli/` is not picked up. */
const CHECKOUT_MARKERS = ['cli/package.json', 'contracts/deployment-capabilities.json'];

/** Quote a value for sh: single quotes, with an embedded quote closed, escaped, reopened. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `bgagent` script for a checkout installed at `checkout`. */
function renderShim(checkout: string): string {
  const markerTests = CHECKOUT_MARKERS.map(m => `[ -f "$dir/${m}" ]`).join(' && ');
  return `#!/bin/sh
${SHIM_MARKER} Re-run it to change the fallback checkout.
INSTALLED=${shQuote(checkout)}
# Run the CLI of the ABCA checkout the working directory is in, else the installed one.
root=
dir=$PWD
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if ${markerTests}; then root=$dir; break; fi
  dir=$(dirname "$dir")
done
root=\${root:-$INSTALLED}
if [ ! -f "$root/cli/lib/bin/bgagent.js" ]; then
  echo "bgagent: the CLI in $root is not built; run: mise //cli:compile (in $root)" >&2
  exit 127
fi
[ "$root" = "$INSTALLED" ] || [ -n "\${BGAGENT_SHIM_QUIET:-}" ] || echo "bgagent: using the CLI from $root" >&2
# setup prints its next steps the way the CLI was launched (cliInvocation).
BGAGENT_INVOKED_AS=bgagent
export BGAGENT_INVOKED_AS
if command -v mise >/dev/null 2>&1; then
  exec mise exec -C "$root" -- node "$root/cli/lib/bin/bgagent.js" "$@"
fi
exec node "$root/cli/lib/bin/bgagent.js" "$@"
`;
}

/** The checkout a script written by this installer falls back to; undefined for any other file. */
function installedCheckout(content: string): string | undefined {
  if (!content.includes(SHIM_MARKER)) return undefined;
  const line = content.split('\n').find(l => l.startsWith('INSTALLED='));
  if (!line) return undefined;
  const quoted = line.slice('INSTALLED='.length);
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) return undefined;
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}

type Plan =
  | { readonly action: 'write'; readonly reason: string }
  | { readonly action: 'keep'; readonly reason: string }
  | { readonly action: 'refuse'; readonly reason: string };

/** What to do with the `bgagent` already at the target path, if any. */
function planInstall(
  existing: string | undefined,
  checkout: string,
  options: { readonly force: boolean; readonly keepExisting: boolean },
): Plan {
  if (existing === undefined) return { action: 'write', reason: 'installed' };
  if (existing === renderShim(checkout)) return { action: 'keep', reason: 'already installed' };
  const other = installedCheckout(existing);
  if (other === checkout) return { action: 'write', reason: 'updated' };
  const what = other === undefined ? 'a bgagent that this installer did not write' : `the CLI of ${other}`;
  if (options.force) return { action: 'write', reason: `replaced ${what}` };
  if (options.keepExisting) {
    return {
      action: 'keep',
      reason: `left ${what} in place; it still runs the CLI of whichever checkout you are in. Run \`mise run cli:install --force\` here to make this checkout the fallback`,
    };
  }
  return {
    action: 'refuse',
    reason: `it holds ${what}. Run \`mise run cli:install --force\` to replace it`,
  };
}

/** True when `dir` is one of the entries of a PATH value. */
function onPath(dir: string, pathValue: string | undefined): boolean {
  const target = path.resolve(dir);
  return (pathValue ?? '').split(path.delimiter).some(entry => entry !== '' && path.resolve(entry) === target);
}

function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const force = argv.includes('--force');
  const keepExisting = argv.includes('--keep-existing');
  const unknown = argv.filter(a => a !== '--force' && a !== '--keep-existing');
  if (unknown.length > 0) {
    console.error(`install-cli-shim: unknown argument ${unknown.join(' ')} (use --force or --keep-existing)`);
    return 2;
  }
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const binDir = env.BGAGENT_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
  const target = path.join(binDir, 'bgagent');

  try {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : undefined;
    const plan = planInstall(existing, checkout, { force, keepExisting });
    if (plan.action === 'refuse') {
      console.error(`bgagent: not writing ${target}: ${plan.reason}.`);
      return 1;
    }
    if (plan.action === 'write') {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(target, renderShim(checkout), { mode: 0o755 });
      fs.chmodSync(target, 0o755);
    }
    console.log(`bgagent: ${target}: ${plan.reason}.`);
  } catch (err) {
    console.error(`bgagent: could not write ${target}: ${err instanceof Error ? err.message : String(err)}`);
    // During `mise run install` a missing command is not worth failing the install over.
    return keepExisting ? 0 : 1;
  }
  if (!onPath(binDir, env.PATH)) {
    console.log(`bgagent: ${binDir} is not on your PATH. Add this line to your shell profile:`);
    console.log(`  export PATH="${binDir}:$PATH"`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
