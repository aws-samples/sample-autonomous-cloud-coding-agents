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
 * HOW: the installer is copied into throwaway ABCA checkouts (marker files plus a
 * stand-in `cli/lib/bin/bgagent.js` that prints what it was run with, including its
 * working directory) and spawned with `BGAGENT_BIN_DIR` and `HOME` in temp
 * directories, so nothing touches `~/.local/bin`. The written script then runs under
 * `sh` with a PATH that holds a link to node and the system directories, checked to
 * hold no `mise`, except where a stand-in `mise` is placed on purpose.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/install-cli-shim.ts';

// Prints which checkout's CLI ran, from where, its arguments and the name setup will print.
const FAKE_CLI = 'console.log(JSON.stringify({ file: __filename, cwd: process.cwd(), args: process.argv.slice(2), invokedAs: process.env.BGAGENT_INVOKED_AS }));\n';

let tmp: string;
let basePath: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cli-shim-')));
  // A directory holding only node, so a mise installed beside node is not on PATH.
  const nodeBin = path.join(tmp, 'node-bin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  basePath = [nodeBin, '/usr/bin', '/bin'].join(path.delimiter);
  const which = spawnSync('/bin/sh', ['-c', 'command -v mise'], { env: { PATH: basePath } });
  if (which.status === 0) throw new Error(`a mise is on the test PATH (${which.stdout}); the tests assume none`);
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

/** Run the installer of `root` (or `script`) with `args`. */
function install(root: string, args: string[] = [], env: Record<string, string> = {}, script?: string) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script ?? path.join(root, SCRIPT_REL), ...args],
    { encoding: 'utf-8', env: { BGAGENT_BIN_DIR: binDir(), PATH: basePath, HOME: tmp, ...env } },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Run the written `bgagent` from `cwd`. */
function runShim(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('/bin/sh', [shimPath(), ...args], {
    cwd,
    encoding: 'utf-8',
    env: { PATH: basePath, HOME: tmp, PWD: cwd, ...env },
  });
  const last = r.stdout.trim().split('\n').pop();
  return { status: r.status, stderr: r.stderr, ran: last ? JSON.parse(last) : undefined };
}

const content = (): string => fs.readFileSync(shimPath(), 'utf-8');

describe('installer', () => {
  test('writes an executable bgagent for this checkout, and is idempotent', () => {
    const a = checkout('a');

    const first = install(a);
    expect(first.status).toBe(0);
    expect(first.out).toContain('installed');
    expect(() => fs.accessSync(shimPath(), fs.constants.X_OK)).not.toThrow();
    const written = content();
    expect(written).toContain(`INSTALLED='${a}'`);

    const again = install(a);
    expect(again.status).toBe(0);
    expect(again.out).toContain('already installed');
    expect(content()).toBe(written);
  });

  test('installs into ~/.local/bin by default', () => {
    const a = checkout('a');
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(a, SCRIPT_REL)], {
      encoding: 'utf-8',
      env: { PATH: basePath, HOME: tmp },
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, '.local', 'bin', 'bgagent'))).toBe(true);
  });

  test('refuses to replace another checkout\'s bgagent unless forced', () => {
    const a = checkout('a');
    const b = checkout('b');
    install(a);

    const refused = install(b);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain(`the bgagent of ${a}`);
    expect(refused.out).toContain('--force');
    expect(content()).toContain(`INSTALLED='${a}'`);

    expect(install(b, ['--force']).status).toBe(0);
    expect(content()).toContain(`INSTALLED='${b}'`);
  });

  test('with --keep-existing (mise run install), keeps another checkout\'s bgagent and exits 0', () => {
    const a = checkout('a');
    const b = checkout('b');
    install(a);

    const kept = install(b, ['--keep-existing']);
    expect(kept.status).toBe(0);
    expect(kept.out).toContain(`left the bgagent of ${a} in place; it runs that checkout's CLI`);
    expect(content()).toContain(`INSTALLED='${a}'`);
  });

  test('replaces the bgagent of a checkout that no longer exists, even with --keep-existing', () => {
    const a = checkout('a');
    const b = checkout('b');
    install(a);
    fs.rmSync(a, { recursive: true });

    const r = install(b, ['--keep-existing']);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`replaced the bgagent of ${a}, which no longer exists`);
    expect(content()).toContain(`INSTALLED='${b}'`);
  });

  test('updates an older bgagent of the same checkout without --force', () => {
    const a = checkout('a');
    install(a);
    fs.writeFileSync(shimPath(), content().replace('exec "', '# an older body\nexec "'));

    const r = install(a, ['--keep-existing']);
    expect(r.out).toContain('updated');
    fs.rmSync(shimPath());
    install(a);
    const fresh = content();
    install(a);
    expect(content()).toBe(fresh);
  });

  test('restores the execute permission of its own bgagent', () => {
    const a = checkout('a');
    install(a);
    fs.chmodSync(shimPath(), 0o644);

    expect(install(a).out).toContain('restored its execute permission');
    expect(() => fs.accessSync(shimPath(), fs.constants.X_OK)).not.toThrow();
  });

  test('never replaces a bgagent it did not write, except with --force', () => {
    const a = checkout('a');
    fs.mkdirSync(binDir(), { recursive: true });
    fs.writeFileSync(shimPath(), '#!/bin/sh\necho someone else\n');

    expect(install(a).status).toBe(1);
    const kept = install(a, ['--keep-existing']);
    expect(kept.status).toBe(0);
    expect(kept.out).toContain('it does not run this checkout');
    expect(content()).toBe('#!/bin/sh\necho someone else\n');
    expect(install(a, ['--force']).status).toBe(0);
    expect(content()).toContain(`INSTALLED='${a}'`);
  });

  test('never writes through a symlink: --force replaces the link, not what it points to', () => {
    const a = checkout('a');
    const victim = path.join(tmp, 'victim.js');
    fs.writeFileSync(victim, 'console.log("someone else")\n');
    fs.mkdirSync(binDir(), { recursive: true });
    fs.symlinkSync(victim, shimPath());

    expect(install(a).status).toBe(1);
    expect(install(a, ['--force']).status).toBe(0);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('console.log("someone else")\n');
    expect(fs.lstatSync(shimPath()).isSymbolicLink()).toBe(false);
    expect(content()).toContain(`INSTALLED='${a}'`);
  });

  test('a dangling symlink is not followed either', () => {
    const a = checkout('a');
    const target = path.join(tmp, 'nowhere', 'bgagent');
    fs.mkdirSync(binDir(), { recursive: true });
    fs.symlinkSync(target, shimPath());

    expect(install(a, ['--keep-existing']).status).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('a write that fails fails the task, except during mise run install', () => {
    const a = checkout('a');
    fs.writeFileSync(binDir(), 'a file where the directory should be');

    const strict = install(a);
    expect(strict.status).toBe(1);
    expect(strict.out).toContain('the bgagent command was not installed');
    const lenient = install(a, ['--keep-existing']);
    expect(lenient.status).toBe(0);
    expect(lenient.out).toContain('the bgagent command was not installed');
  });

  test('in CI, mise run install does not write the command; an explicit install does', () => {
    const a = checkout('a');
    const skipped = install(a, ['--keep-existing'], { CI: 'true' });
    expect(skipped.status).toBe(0);
    expect(skipped.out).toContain('CI is set');
    expect(fs.existsSync(shimPath())).toBe(false);

    expect(install(a, [], { CI: 'true' }).status).toBe(0);
    expect(fs.existsSync(shimPath())).toBe(true);
  });

  test('says how to put the directory on PATH, only when it is not', () => {
    const a = checkout('a');
    expect(install(a).out).toContain(`export PATH="${binDir()}:$PATH"`);
    expect(install(a, [], { PATH: `${binDir()}${path.delimiter}${basePath}` }).out).not.toContain('export PATH');
  });

  test('warns when another bgagent comes first on PATH', () => {
    const a = checkout('a');
    const other = path.join(tmp, 'other-bin');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'bgagent'), '#!/bin/sh\n');
    fs.chmodSync(path.join(other, 'bgagent'), 0o755);

    const r = install(a, [], { PATH: `${other}${path.delimiter}${binDir()}${path.delimiter}${basePath}` });
    expect(r.out).toContain(`another bgagent comes first on your PATH: ${path.join(other, 'bgagent')}`);
  });

  test('runs when started through a symlinked path', () => {
    const a = checkout('a');
    const link = path.join(tmp, 'link');
    fs.symlinkSync(a, link);

    const r = install(a, [], {}, path.join(link, SCRIPT_REL));
    expect(r.status).toBe(0);
    expect(fs.existsSync(shimPath())).toBe(true);
  });

  test('rejects an unknown argument', () => {
    expect(install(checkout('a'), ['--frce']).status).toBe(2);
  });
});

describe('the bgagent command', () => {
  test('runs the installed checkout from any directory, and keeps that directory', () => {
    const a = checkout('a');
    install(a);
    const elsewhere = path.join(tmp, 'project', 'sub');
    fs.mkdirSync(elsewhere, { recursive: true });

    const r = runShim(elsewhere, ['submit', '--attachment', 'shot.png']);
    expect(r.status).toBe(0);
    expect(r.ran.file).toBe(path.join(a, 'cli/lib/bin/bgagent.js'));
    // Relative paths such as --attachment resolve where they were typed.
    expect(r.ran.cwd).toBe(elsewhere);
    expect(r.ran.args).toEqual(['submit', '--attachment', 'shot.png']);
    expect(r.stderr).toBe('');
  });

  test('never runs code from the checkout or directory it is run in', () => {
    const a = checkout('a');
    install(a);
    // A fork under review, or a checkout planted in a shared parent directory.
    const planted = checkout('planted');
    fs.writeFileSync(path.join(planted, 'cli/lib/bin/bgagent.js'), `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'pwned'))}, 'x');\n`);
    const below = path.join(planted, 'deep', 'dir');
    fs.mkdirSync(below, { recursive: true });

    for (const cwd of [planted, below]) {
      expect(runShim(cwd).ran.file).toBe(path.join(a, 'cli/lib/bin/bgagent.js'));
    }
    expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
  });

  test('says the installed checkout is gone, exit 127', () => {
    const a = checkout('a');
    install(a);
    fs.rmSync(a, { recursive: true });

    const r = runShim(tmp);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain(`${a} no longer exists; run \`mise run cli:install --force\``);
  });

  test('tells the user to compile when the CLI is not built, exit 127', () => {
    const a = checkout('a', { built: false });
    install(a);

    const r = runShim(tmp);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain(`the CLI in ${a} is not built; run: mise //cli:compile`);
  });

  test('sets BGAGENT_INVOKED_AS so setup prints bare bgagent', () => {
    const a = checkout('a');
    install(a);
    expect(runShim(tmp).ran.invokedAs).toBe('bgagent');
  });

  test('uses the node mise resolves in the checkout, without changing directory', () => {
    const a = checkout('a');
    install(a);
    const fakeBin = path.join(tmp, 'fake-mise');
    fs.mkdirSync(fakeBin);
    // `mise which node` run in the installed checkout: records where it ran, answers node.
    fs.writeFileSync(
      path.join(fakeBin, 'mise'),
      `#!/bin/sh\necho "$PWD $*" > "${tmp}/mise-args"\necho "${process.execPath}"\n`,
    );
    fs.chmodSync(path.join(fakeBin, 'mise'), 0o755);
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);

    const r = runShim(elsewhere, ['--help'], { PATH: `${fakeBin}${path.delimiter}${basePath}` });
    expect(fs.readFileSync(path.join(tmp, 'mise-args'), 'utf-8').trim()).toBe(`${a} which node`);
    expect(r.ran.cwd).toBe(elsewhere);
    expect(r.ran.args).toEqual(['--help']);
  });

  test('falls back to plain node when mise cannot resolve one', () => {
    const a = checkout('a');
    install(a);
    const fakeBin = path.join(tmp, 'fake-mise');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'mise'), '#!/bin/sh\necho "mise ERROR node is not active" >&2\nexit 1\n');
    fs.chmodSync(path.join(fakeBin, 'mise'), 0o755);

    const r = runShim(tmp, [], { PATH: `${fakeBin}${path.delimiter}${basePath}` });
    expect(r.status).toBe(0);
    expect(r.ran.file).toBe(path.join(a, 'cli/lib/bin/bgagent.js'));
  });

  test('quotes a checkout path with spaces and quotes', () => {
    const odd = checkout("it's a checkout");
    install(odd);
    expect(runShim(tmp).ran.file).toBe(path.join(odd, 'cli/lib/bin/bgagent.js'));
    // Read back from the written script: a second checkout's refusal names it.
    expect(install(checkout('b')).out).toContain(`the bgagent of ${odd}`);
  });
});

describe('mise tasks (#913)', () => {
  function taskRun(name: string): unknown[] {
    const out = execFileSync('mise', ['tasks', 'info', name, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, MISE_EXPERIMENTAL: '1' },
    });
    return (JSON.parse(out) as { run: unknown[] }).run;
  }

  test('mise run install writes the command with --keep-existing, last', () => {
    const run = taskRun('install');
    expect(String(run[run.length - 1])).toMatch(/scripts\/install-cli-shim\.ts --keep-existing$/);
  });

  test('cli:install compiles the CLI, then runs the installer, which takes the task\'s arguments', () => {
    const run = taskRun('cli:install');
    expect(run[0]).toEqual({ task: '//cli:compile' });
    expect(String(run[run.length - 1])).toMatch(/scripts\/install-cli-shim\.ts$/);
  });
});

describe('docs (#913)', () => {
  test('no tracked Markdown file tells anyone to install the CLI from a registry', () => {
    const tracked = execFileSync('git', ['ls-files', '*.md', '*.mdx'], { cwd: REPO_ROOT, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
    const offenders = tracked.filter(f => /(npm|pnpm|yarn)\b[^\n]*(-g\b|--global|global add)[^\n]*@(backgroundagent|abca)\/cli/
      .test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
