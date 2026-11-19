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
 * Tests for `scripts/install-cli-shim.ts`, which writes the `bgagent` command (#913),
 * and for the sh script it writes.
 *
 * HOW: the installer is copied into throwaway ABCA checkouts (the two marker files
 * plus a stand-in `cli/lib/bin/bgagent.js` that prints what it was run with) and
 * spawned with `BGAGENT_BIN_DIR` pointing at a temp directory, so nothing touches
 * `~/.local/bin`. The written script then runs under `sh` with a PATH that holds node
 * and no `mise`, except where a stand-in `mise` is placed on purpose.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/install-cli-shim.ts';
const NODE_DIR = path.dirname(process.execPath);
const BASE_PATH = [NODE_DIR, '/usr/bin', '/bin'].join(path.delimiter);

// Prints which checkout's CLI ran, the arguments and the name setup will print.
const FAKE_CLI = 'console.log(JSON.stringify({ file: __filename, args: process.argv.slice(2), invokedAs: process.env.BGAGENT_INVOKED_AS }));\n';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cli-shim-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A throwaway ABCA checkout at `tmp/<name>`, with the installer and (unless `built: false`) a CLI. */
function checkout(name: string, { built = true } = {}): string {
  const root = path.join(tmp, name);
  const files: Record<string, string> = {
    'cli/package.json': '{"name":"@abca/cli"}\n',
    'contracts/deployment-capabilities.json': '{}\n',
    [SCRIPT_REL]: fs.readFileSync(path.join(REPO_ROOT, SCRIPT_REL), 'utf-8'),
  };
  if (built) files['cli/lib/bin/bgagent.js'] = FAKE_CLI;
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents);
  }
  return root;
}

const binDir = (): string => path.join(tmp, 'bin');
const shimPath = (): string => path.join(binDir(), 'bgagent');

/** Run the installer of `root` with `args`; PATH defaults to one without the bin dir. */
function install(root: string, args: string[] = [], pathValue = BASE_PATH) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', path.join(root, SCRIPT_REL), ...args], {
    encoding: 'utf-8',
    env: { BGAGENT_BIN_DIR: binDir(), PATH: pathValue, HOME: tmp },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Run the written `bgagent` from `cwd`. */
function runShim(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('/bin/sh', [shimPath(), ...args], {
    cwd,
    encoding: 'utf-8',
    env: { PATH: BASE_PATH, HOME: tmp, ...env },
  });
  const ran = r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()!) : undefined;
  return { status: r.status, stderr: r.stderr, ran };
}

describe('installer', () => {
  test('writes an executable bgagent for this checkout, and is idempotent', () => {
    const a = checkout('a');

    const first = install(a);
    expect(first.status).toBe(0);
    expect(first.out).toContain('installed');
    expect(() => fs.accessSync(shimPath(), fs.constants.X_OK)).not.toThrow();
    const content = fs.readFileSync(shimPath(), 'utf-8');
    expect(content).toContain(`INSTALLED='${a}'`);

    const again = install(a);
    expect(again.status).toBe(0);
    expect(again.out).toContain('already installed');
    expect(fs.readFileSync(shimPath(), 'utf-8')).toBe(content);
  });

  test('refuses to replace another checkout\'s bgagent unless forced', () => {
    const a = checkout('a');
    const b = checkout('b');
    install(a);

    const refused = install(b);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain(`the CLI of ${a}`);
    expect(refused.out).toContain('--force');
    expect(fs.readFileSync(shimPath(), 'utf-8')).toContain(`INSTALLED='${a}'`);

    const forced = install(b, ['--force']);
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(shimPath(), 'utf-8')).toContain(`INSTALLED='${b}'`);
  });

  test('during mise run install, keeps another checkout\'s bgagent and does not fail', () => {
    const a = checkout('a');
    const b = checkout('b');
    install(a);

    const kept = install(b, ['--keep-existing']);
    expect(kept.status).toBe(0);
    expect(kept.out).toContain('left the CLI of');
    expect(fs.readFileSync(shimPath(), 'utf-8')).toContain(`INSTALLED='${a}'`);
  });

  test('never replaces a bgagent it did not write, except with --force', () => {
    const a = checkout('a');
    fs.mkdirSync(binDir(), { recursive: true });
    fs.writeFileSync(shimPath(), '#!/bin/sh\necho someone else\n');

    expect(install(a).status).toBe(1);
    expect(install(a, ['--keep-existing']).status).toBe(0);
    expect(fs.readFileSync(shimPath(), 'utf-8')).toBe('#!/bin/sh\necho someone else\n');
    expect(install(a, ['--force']).status).toBe(0);
    expect(fs.readFileSync(shimPath(), 'utf-8')).toContain(`INSTALLED='${a}'`);
  });

  test('says how to put the directory on PATH, only when it is not', () => {
    const a = checkout('a');
    expect(install(a).out).toContain(`export PATH="${binDir()}:$PATH"`);
    expect(install(a, [], `${binDir()}${path.delimiter}${BASE_PATH}`).out).not.toContain('export PATH');
  });

  test('rejects an unknown argument', () => {
    expect(install(checkout('a'), ['--frce']).status).toBe(2);
  });
});

describe('the bgagent command', () => {
  test('runs the CLI of the checkout it is run from, at its root or below', () => {
    const a = checkout('a');
    const b = checkout('b');
    install(a);
    fs.mkdirSync(path.join(b, 'cdk', 'src'), { recursive: true });

    const atRoot = runShim(b, ['list', '--limit', '2']);
    expect(atRoot.status).toBe(0);
    expect(atRoot.ran.file).toBe(path.join(b, 'cli/lib/bin/bgagent.js'));
    expect(atRoot.ran.args).toEqual(['list', '--limit', '2']);
    // One line on stderr names the checkout that is not the installed one.
    expect(atRoot.stderr).toContain(`using the CLI from ${b}`);

    expect(runShim(path.join(b, 'cdk', 'src')).ran.file).toBe(path.join(b, 'cli/lib/bin/bgagent.js'));
  });

  test('runs the installed checkout outside any checkout, without a notice', () => {
    const a = checkout('a');
    install(a);
    const elsewhere = path.join(tmp, 'elsewhere', 'cli');
    fs.mkdirSync(elsewhere, { recursive: true });
    // A directory with cli/package.json but no contracts/ is not an ABCA checkout.
    fs.writeFileSync(path.join(tmp, 'elsewhere', 'cli', 'package.json'), '{}');

    const r = runShim(elsewhere);
    expect(r.status).toBe(0);
    expect(r.ran.file).toBe(path.join(a, 'cli/lib/bin/bgagent.js'));
    expect(r.stderr).toBe('');
  });

  test('can be quiet about using another checkout', () => {
    install(checkout('a'));
    const b = checkout('b');
    expect(runShim(b, [], { BGAGENT_SHIM_QUIET: '1' }).stderr).toBe('');
  });

  test('tells the user to compile a checkout whose CLI is not built, exit 127', () => {
    install(checkout('a'));
    const b = checkout('b', { built: false });

    const r = runShim(b);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain(`the CLI in ${b} is not built; run: mise //cli:compile`);
  });

  test('sets BGAGENT_INVOKED_AS so setup prints bare bgagent', () => {
    const a = checkout('a');
    install(a);
    expect(runShim(a).ran.invokedAs).toBe('bgagent');
  });

  test('runs node through mise in the checkout when mise is installed', () => {
    const a = checkout('a');
    install(a);
    const fakeBin = path.join(tmp, 'fake-mise');
    fs.mkdirSync(fakeBin);
    // Records how it was called, then runs the command after `--` as mise exec would.
    fs.writeFileSync(path.join(fakeBin, 'mise'), `#!/bin/sh\necho "$@" > "${tmp}/mise-args"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`);
    fs.chmodSync(path.join(fakeBin, 'mise'), 0o755);

    const r = runShim(a, ['--help'], { PATH: `${fakeBin}${path.delimiter}${BASE_PATH}` });
    expect(r.ran.args).toEqual(['--help']);
    expect(fs.readFileSync(path.join(tmp, 'mise-args'), 'utf-8').trim())
      .toBe(`exec -C ${a} -- node ${a}/cli/lib/bin/bgagent.js --help`);
  });

  test('quotes a checkout path with spaces and quotes', () => {
    const odd = checkout("it's a checkout");
    install(odd);
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    expect(runShim(elsewhere).ran.file).toBe(path.join(odd, 'cli/lib/bin/bgagent.js'));
  });
});

describe('docs (#913)', () => {
  test('no tracked file tells anyone to install the unpublished @backgroundagent/cli', () => {
    const tracked = execFileSync('git', ['ls-files', '*.md', '*.mdx'], { cwd: REPO_ROOT, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
    const offenders = tracked.filter(f => /npm (install|i) (-g|--global) @backgroundagent\/cli/
      .test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
