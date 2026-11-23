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
 * The script always runs the checkout that installed it, and never code from the
 * directory it is run in: a fork's PR checked out for review, or a directory another
 * user planted in a shared parent, must not run with the operator's credentials. To
 * use another checkout or worktree, run `mise run cli:install --force` from its repo
 * root. It finds that checkout's Node with `mise which` (no directory change, no
 * install, no trust prompt) and keeps the caller's working directory, so relative
 * paths such as `--attachment` resolve where the user typed them.
 *
 *   mise run cli:install            compile the CLI, then write the command
 *   mise run cli:install --force    replace another checkout's bgagent, or a file
 *                                   this installer did not write
 *   (mise run install)              runs this with --keep-existing: writes the command
 *                                   only when there is none (or it is this checkout's,
 *                                   or its checkout is gone), never when CI is set, and
 *                                   never fails the install over a file-system error
 *
 * `BGAGENT_BIN_DIR` overrides the directory (default `~/.local/bin`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A line every script this installer writes contains; how one is recognized. */
const SHIM_MARKER = '# bgagent: written by `mise run cli:install`.';

/** Quote a value for sh: single quotes, with an embedded quote closed, escaped, reopened. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `bgagent` script for a checkout installed at `checkout`. */
function renderShim(checkout: string): string {
  return `#!/bin/sh
${SHIM_MARKER} \`mise run cli:install --force\` from another checkout makes it run that one.
INSTALLED=${shQuote(checkout)}
# Always this checkout, never one found from the working directory: no code from where you are runs.
if [ ! -d "$INSTALLED" ]; then
  echo "bgagent: $INSTALLED no longer exists; run \\\`mise run cli:install --force\\\` from the repo root of a checkout" >&2
  exit 127
fi
if [ ! -f "$INSTALLED/cli/lib/bin/bgagent.js" ]; then
  echo "bgagent: the CLI in $INSTALLED is not built; run: mise //cli:compile (in $INSTALLED)" >&2
  exit 127
fi
# setup prints its next steps the way the CLI was launched (cliInvocation).
BGAGENT_INVOKED_AS=bgagent
export BGAGENT_INVOKED_AS
# The Node that checkout pins, found in a subshell: the caller's working directory stays,
# so relative paths resolve where they were typed. Without mise, or that Node, plain node.
node_bin=$(cd "$INSTALLED" 2>/dev/null && mise which node 2>/dev/null) || node_bin=
exec "\${node_bin:-node}" "$INSTALLED/cli/lib/bin/bgagent.js" "$@"
`;
}

/** The checkout a script written by this installer runs; undefined for any other file. */
function installedCheckout(content: string): string | undefined {
  if (!content.includes(SHIM_MARKER)) return undefined;
  const line = content.split('\n').find(l => l.startsWith('INSTALLED='));
  if (!line) return undefined;
  const quoted = line.slice('INSTALLED='.length);
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) return undefined;
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}

/**
 * What is at the target path: undefined when nothing is, null when it is not a regular
 * file (a symlink, even a dangling one, or a directory), else its content. lstat, so a
 * symlink is never followed: writing through one would overwrite what it points to.
 */
function readExisting(target: string): string | null | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return stat.isFile() ? fs.readFileSync(target, 'utf-8') : null;
}

type Plan =
  | { readonly action: 'write'; readonly reason: string }
  | { readonly action: 'keep'; readonly reason: string }
  | { readonly action: 'refuse'; readonly reason: string };

/** What to do with what is already at the target path. `force` wins over `keepExisting`. */
function planInstall(
  existing: string | null | undefined,
  checkout: string,
  options: { readonly force: boolean; readonly keepExisting: boolean; readonly executable: boolean },
): Plan {
  if (existing === undefined) return { action: 'write', reason: 'installed' };
  if (existing === renderShim(checkout)) {
    return options.executable
      ? { action: 'keep', reason: 'already installed' }
      : { action: 'write', reason: 'restored its execute permission' };
  }
  const other = existing === null ? undefined : installedCheckout(existing);
  if (other === checkout) return { action: 'write', reason: 'updated' };
  if (other !== undefined && !fs.existsSync(path.join(other, 'cli', 'package.json'))) {
    return { action: 'write', reason: `replaced the bgagent of ${other}, which no longer exists` };
  }
  const what = other === undefined ? 'a bgagent that this installer did not write' : `the bgagent of ${other}`;
  const hint = 'Run `mise run cli:install --force` from the repo root of this checkout to replace it';
  if (options.force) return { action: 'write', reason: `replaced ${what}` };
  if (options.keepExisting) {
    const runs = other === undefined ? 'it does not run this checkout' : 'it runs that checkout\'s CLI';
    return { action: 'keep', reason: `left ${what} in place; ${runs}. ${hint}` };
  }
  return { action: 'refuse', reason: `it holds ${what}. ${hint}` };
}

/** Write `content` to `target` through a new file renamed over it: atomic, and it replaces a symlink, never what it points to. */
function writeAtomic(binDir: string, target: string, content: string): void {
  const tmp = path.join(binDir, `.bgagent.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmp, flags, 0o700);
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, 0o755);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

/** The first executable `bgagent` on a PATH value, if any. */
function firstOnPath(pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'bgagent');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there or not executable: look in the next directory.
    }
  }
  return undefined;
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const force = argv.includes('--force');
  const keepExisting = argv.includes('--keep-existing');
  const unknown = argv.filter(a => a !== '--force' && a !== '--keep-existing');
  if (unknown.length > 0) {
    console.error(`install-cli-shim: unknown argument ${unknown.join(' ')} (use --force or --keep-existing)`);
    return 2;
  }
  if (keepExisting && env.CI && env.CI !== 'false' && env.CI !== '0') {
    console.log('bgagent: CI is set; not writing the bgagent command (run `mise run cli:install` to write it).');
    return 0;
  }
  const checkout = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const binDir = env.BGAGENT_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
  const target = path.join(binDir, 'bgagent');

  try {
    const existing = readExisting(target);
    const executable = (() => {
      try {
        fs.accessSync(target, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })();
    const plan = planInstall(existing, checkout, { force, keepExisting, executable });
    if (plan.action === 'refuse') {
      console.error(`bgagent: not writing ${target}: ${plan.reason}.`);
      return 1;
    }
    if (plan.action === 'write') {
      fs.mkdirSync(binDir, { recursive: true });
      writeAtomic(binDir, target, renderShim(checkout));
    }
    console.log(`bgagent: ${target}: ${plan.reason}.`);
  } catch (err) {
    // Only file-system errors: anything else is a bug in this script and must fail loudly.
    if (!(err instanceof Error && 'code' in err)) throw err;
    console.error(
      `bgagent: the bgagent command was not installed: ${err.message}. Fix that and run ` +
        '`mise run cli:install` from the repo root, or run `node cli/lib/bin/bgagent.js` there.',
    );
    // During `mise run install` a missing command is not worth failing the install over.
    return keepExisting ? 0 : 1;
  }
  const first = firstOnPath(env.PATH);
  if (first === undefined) {
    console.log(`bgagent: ${binDir} is not on your PATH. Add this line to your shell profile:`);
    console.log(`  export PATH="${binDir}:$PATH"`);
  } else if (!sameFile(first, target)) {
    console.log(`bgagent: another bgagent comes first on your PATH: ${first}. Remove it, or put ${binDir} before it.`);
  }
  return 0;
}

// Compared through realpath: run by a path that goes through a symlink, argv[1] is not
// the resolved path import.meta.url carries, and main() would silently not run.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
