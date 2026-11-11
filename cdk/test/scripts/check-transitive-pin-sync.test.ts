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
 * Tests for `scripts/check-transitive-pin-sync.mjs` — the guard that keeps the
 * root `resolutions` floors and the standalone Jira Forge app's lockfile in step.
 *
 * WHY THESE EXIST: the guard used to look up each `resolutions` key as a package
 * name, so a key that is a path pattern (the root pins glob and minimatch that
 * way) matched nothing and was skipped while the guard printed "OK".
 *
 * HOW: same as `check-constants-sync.test.ts` — the script is spawned against a
 * throwaway repo root. The two files it reads are written per case, so the cases
 * do not depend on what the repository pins today.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/check-transitive-pin-sync.mjs';
const ROOT_PACKAGE = 'package.json';
const FORGE_LOCK = 'integrations/jira-forge-app/package-lock.json';

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the script in a temp root holding `files` (path → contents; `null` copies the real file). */
function run(files: Record<string, string | null>): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-pin-sync-'));
  try {
    for (const [rel, contents] of Object.entries({ [SCRIPT_REL]: null, ...files })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      if (contents === null) fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
      else fs.writeFileSync(path.join(root, rel), contents);
    }
    try {
      const stdout = execFileSync(process.execPath, [path.join(root, SCRIPT_REL)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A root manifest with these `resolutions`, and a Forge lockfile resolving these install paths. */
function fixture(resolutions: Record<string, string>, resolved: Record<string, string>): Record<string, string> {
  const packages: Record<string, { version?: string }> = { '': {} };
  for (const [installPath, version] of Object.entries(resolved)) packages[installPath] = { version };
  return {
    [ROOT_PACKAGE]: JSON.stringify({ resolutions }),
    [FORGE_LOCK]: JSON.stringify({ lockfileVersion: 3, packages }),
  };
}

describe('check-transitive-pin-sync', () => {
  jest.setTimeout(60_000);

  test('the real repository passes, and says how many pins it compared', () => {
    const result = run({ [ROOT_PACKAGE]: null, [FORGE_LOCK]: null });

    expect(result.status).toBe(0);
    // The count is the anti-vacuity assertion: a guard that compared nothing also exits 0.
    expect(result.stdout).toMatch(/OK — [1-9]\d* shared pin\(s\) in sync/);
  });

  test('fails when a package pinned by name resolves below the floor', () => {
    const result = run(fixture({ undici: '^7.30.1' }, { 'node_modules/undici': '6.0.0' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✖ undici: root pins "^7.30.1" but jira-forge-app resolves 6.0.0');
    expect(result.stderr).toContain('add "undici": "^7.30.1" to integrations/jira-forge-app/package.json "overrides"');
  });

  test('fails when a package pinned by a path pattern resolves below the floor', () => {
    const result = run(fixture(
      { '**/eslint/minimatch': '^11.0.1', '**/@eslint/config-array/minimatch': '^11.0.1' },
      { 'node_modules/minimatch': '3.0.0' },
    ));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✖ minimatch: root pins "^11.0.1" (resolutions key "**/eslint/minimatch") but jira-forge-app resolves 3.0.0');
    // Two patterns pinning one package to one floor are one drift, not two.
    expect(result.stderr).toContain('Drifted: 1.');
  });

  test('checks every copy of a pattern-pinned package, nested ones included', () => {
    const result = run(fixture(
      { 'parent/glob': '^14.0.2' },
      { 'node_modules/glob': '14.0.3', 'node_modules/other/node_modules/glob': '10.4.5' },
    ));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✖ glob: root pins "^14.0.2" (resolutions key "parent/glob") but jira-forge-app resolves 10.4.5');
  });

  test('maps a pattern that ends in a scoped name to the scoped package', () => {
    const result = run(fixture(
      { '**/parent/@scope/pkg': '^2.0.0' },
      { 'node_modules/@scope/pkg': '1.9.9', 'node_modules/pkg': '0.0.1' },
    ));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✖ @scope/pkg: root pins "^2.0.0" (resolutions key "**/parent/@scope/pkg") but jira-forge-app resolves 1.9.9');
    expect(result.stderr).toContain('Drifted: 1.');
  });

  test('does NOT read a scoped package name as a pattern', () => {
    // The false-positive side: `@scope/pkg` is one name, not "pkg under @scope".
    const result = run(fixture(
      { '@scope/pkg': '^2.0.0' },
      { 'node_modules/@scope/pkg': '2.0.1', 'node_modules/pkg': '0.0.1' },
    ));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 shared pin(s) in sync');
  });

  test('passes when every pinned package meets its floor', () => {
    const result = run(fixture(
      { 'undici': '^7.30.1', '**/eslint/minimatch': '^11.0.1', 'yaml': '^2.8.3' },
      { 'node_modules/undici': '7.30.1', 'node_modules/minimatch': '11.0.4' },
    ));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 shared pin(s) in sync');
  });

  describe('fails closed', () => {
    test('when the Forge lockfile is missing', () => {
      const result = run({ [ROOT_PACKAGE]: JSON.stringify({ resolutions: { undici: '^7.30.1' } }) });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('cannot read');
    });

    test('when a version cannot be compared', () => {
      const result = run(fixture({ '**/eslint/minimatch': 'latest' }, { 'node_modules/minimatch': '11.0.4' }));

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('cannot compare minimatch@11.0.4 against pin "**/eslint/minimatch": "latest"');
    });
  });
});
