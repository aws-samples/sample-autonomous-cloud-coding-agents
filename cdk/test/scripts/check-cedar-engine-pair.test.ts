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
 * Tests for `scripts/check-cedar-engine-pair.mjs` — the check that the two Cedar
 * engines stay pinned, exactly, to the pair named in
 * `contracts/cedar-parity/engines/versions.json`.
 *
 * WHY THESE EXIST: "pinned exactly, bumped together" was a rule in comments
 * only. The parity fixtures compare what the two engines decide; nothing failed
 * when one manifest loosened its pin to a range or one engine moved alone.
 *
 * HOW: same as `check-constants-sync.test.ts` — the script is spawned against a
 * copy of the four files it reads, with one of them changed per case.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/check-cedar-engine-pair.mjs';
const PAIR = 'contracts/cedar-parity/engines/versions.json';
const CDK_PACKAGE = 'cdk/package.json';
const LAYER_PACKAGE = 'cdk/layers/cedar-wasm/package.json';
const PYPROJECT = 'agent/pyproject.toml';
const WASM = '@cedar-policy/cedar-wasm';

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Copy what the script reads into a temp root, apply `mutate`, and run it there. */
function runInMutatedRepo(mutate: (root: string) => void): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cedar-pair-'));
  try {
    for (const rel of [SCRIPT_REL, PAIR, CDK_PACKAGE, LAYER_PACKAGE, PYPROJECT]) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
    }
    mutate(root);
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

/** Rewrite one JSON file in the temp root. */
function patchJson(root: string, rel: string, mutate: (json: any) => void): void {
  const file = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  mutate(json);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

/** Replace the cedarpy requirement in the temp root's pyproject.toml (fails loudly if it is not there). */
function setPyRequirement(root: string, requirement: string): void {
  const file = path.join(root, PYPROJECT);
  const source = fs.readFileSync(file, 'utf-8');
  const pinned = /"cedarpy==[\d.]+"/;
  if (!pinned.test(source)) throw new Error(`${PYPROJECT} no longer pins cedarpy with ==`);
  fs.writeFileSync(file, source.replace(pinned, requirement));
}

describe('check-cedar-engine-pair', () => {
  jest.setTimeout(60_000);

  test('the real repository passes, and names the pair it checked', () => {
    const result = runInMutatedRepo(() => {});

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK — @cedar-policy\/cedar-wasm \d+\.\d+\.\d+ \(cdk, Lambda layer\) and cedarpy \d+\.\d+\.\d+ \(agent\)/);
  });

  test('fails when the CDK engine is bumped alone', () => {
    const result = runInMutatedRepo((root) => {
      patchJson(root, CDK_PACKAGE, (pkg) => { pkg.dependencies[WASM] = '4.13.0'; });
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${CDK_PACKAGE}: ${WASM} is pinned to "4.13.0", but ${PAIR} names `);
    expect(result.stderr).toContain(`bump both engines and ${PAIR} in one change`);
    // The Lambda layer and the agent still match, so they are not reported.
    expect(result.stderr).not.toContain(LAYER_PACKAGE);
    expect(result.stderr).not.toContain(PYPROJECT);
  });

  test('fails when the CDK pin is loosened to a range', () => {
    const result = runInMutatedRepo((root) => {
      patchJson(root, CDK_PACKAGE, (pkg) => { pkg.dependencies[WASM] = `^${pkg.dependencies[WASM]}`; });
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cdk\/package\.json: @cedar-policy\/cedar-wasm is pinned to "\^\d/);
    expect(result.stderr).toContain('no ^ or ~');
  });

  test('fails when the Lambda layer carries another engine version', () => {
    const result = runInMutatedRepo((root) => {
      patchJson(root, LAYER_PACKAGE, (pkg) => { pkg.dependencies[WASM] = '4.11.0'; });
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${LAYER_PACKAGE}: ${WASM} is pinned to "4.11.0"`);
  });

  test('fails when the agent engine is bumped alone', () => {
    const result = runInMutatedRepo((root) => setPyRequirement(root, '"cedarpy==4.13.0"'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${PYPROJECT}: cedarpy is pinned to "4.13.0", but ${PAIR} names `);
  });

  test('fails when the agent pin is loosened to a range', () => {
    const result = runInMutatedRepo((root) => setPyRequirement(root, '"cedarpy>=4.12.2"'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${PYPROJECT}: cedarpy is pinned to ">=4.12.2"`);
    expect(result.stderr).toMatch(/Pin it exactly \("cedarpy==\d+\.\d+\.\d+"\)/);
  });

  test('fails when the agent declares the engine twice', () => {
    // Which of two requirements wins is the installer's business; neither is "the" pin.
    const result = runInMutatedRepo((root) => setPyRequirement(root, '"cedarpy>=4", "cedarpy<5"'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${PYPROJECT}: expected one "cedarpy" requirement, found 2`);
  });

  test('fails when the pair file itself names a range', () => {
    const result = runInMutatedRepo((root) => {
      patchJson(root, PAIR, (pair) => { pair.cedarpy = '>=4.12'; });
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${PAIR}: "cedarpy" must be one exact version such as 4.12.0, found ">=4.12"`);
  });

  describe('fails closed', () => {
    test('when the pair file is missing', () => {
      const result = runInMutatedRepo((root) => fs.rmSync(path.join(root, PAIR)));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${PAIR}: cannot be read`);
    });

    test('when the pair file names something else', () => {
      const result = runInMutatedRepo((root) => fs.writeFileSync(path.join(root, PAIR), '{}'));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${PAIR}: must name exactly "${WASM}" and "cedarpy", found: nothing`);
    });

    test('when the agent no longer declares cedarpy', () => {
      const result = runInMutatedRepo((root) => setPyRequirement(root, '"some-other-engine==1.0.0"'));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${PYPROJECT}: expected one "cedarpy" requirement, found 0`);
    });

    test('when a manifest is missing', () => {
      const result = runInMutatedRepo((root) => fs.rmSync(path.join(root, LAYER_PACKAGE)));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${LAYER_PACKAGE}: cannot be read`);
    });
  });
});
