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
 * Tests for `scripts/check-types-sync.ts` — the API type drift gate between the
 * CDK types (canonical), the CLI mirror (exact) and the web mirror (subset).
 *
 * WHY THESE EXIST: a comparison that silently skips a kind of declaration still
 * prints "OK". The gate used to trust re-exports, ignore `extends`, index and
 * method signatures, compare types declared in another file by name only, and
 * never read the web mirror — so the task-status union, among others, was not
 * compared at all. Each of those is pinned here by making the gate fail on it.
 *
 * HOW: same as `check-constants-sync.test.ts` — the script is spawned against a
 * throwaway repo root. Drift is APPENDED to copies of the real files as small
 * `Gate*` declarations, so the cases do not depend on what the real types look
 * like today. All drift cases share one run (the script compiles three files,
 * about a second per run); each test then asserts its own message.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/check-types-sync.ts';
const CDK_TYPES = 'cdk/src/handlers/shared/types.ts';
const CLI_TYPES = 'cli/src/types.ts';
const WEB_TYPES = 'web/src/core/api/types.ts';

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Copy what the script reads into a temp root, apply `mutate`, and run it there. */
function runInMutatedRepo(mutate: (root: string) => void): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-types-sync-'));
  const nodeModules = path.join(root, 'node_modules');
  try {
    // The script compiles the three files, so it also reads what the CDK types
    // import. Copy the CDK sources whole: a hand-kept import closure would rot.
    fs.cpSync(path.join(REPO_ROOT, 'cdk/src'), path.join(root, 'cdk/src'), { recursive: true });
    for (const rel of [SCRIPT_REL, CLI_TYPES, WEB_TYPES, 'contracts/constants.json']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
    }
    // `typescript` and the packages the CDK types import resolve from here.
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModules, 'dir');
    mutate(root);

    try {
      const stdout = execFileSync(
        process.execPath,
        ['--experimental-strip-types', path.join(root, SCRIPT_REL)],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  } finally {
    // Unlink the link itself first, so the cleanup can never reach the real node_modules.
    fs.rmSync(nodeModules, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function append(root: string, rel: string, text: string): void {
  fs.appendFileSync(path.join(root, rel), `\n${text}\n`);
}

/** Escape a literal for use inside a `RegExp`. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Add an entry to one of the script's own allowlists (fails loudly if the list is renamed). */
function allowlist(root: string, list: string, entry: string): void {
  const file = path.join(root, SCRIPT_REL);
  const opening = `const ${list} = new Set<string>([`;
  const source = fs.readFileSync(file, 'utf-8');
  if (!source.includes(opening)) throw new Error(`${SCRIPT_REL} no longer declares ${list}`);
  fs.writeFileSync(file, source.replace(opening, `${opening}\n  '${entry}',`));
}

describe('check-types-sync', () => {
  jest.setTimeout(120_000);

  describe('the real repository', () => {
    test('passes, and says what it actually compared', () => {
      const result = runInMutatedRepo(() => {});

      expect(result.status).toBe(0);
      // The counts are the anti-vacuity assertion: a script that compared
      // NOTHING would also exit 0.
      expect(result.stdout).toMatch(/[1-9]\d* CLI exports validated against [1-9]\d* CDK exports/);
      expect(result.stdout).toMatch(/CDK ↔ web: [1-9]\d* of \d+ web exports have a CDK declaration and match it/);
    });
  });

  describe('drift is rejected, member by member', () => {
    let result: RunResult;

    beforeAll(() => {
      result = runInMutatedRepo((root) => {
        // Declared OUTSIDE the CDK types file, as the task-status union is.
        fs.writeFileSync(
          path.join(root, 'cdk/src/handlers/shared/gate-fixture.ts'),
          [
            "export const GateStatuses = { A: 'A', B: 'B' } as const;",
            'export type GateStatus = (typeof GateStatuses)[keyof typeof GateStatuses];',
            'export interface GateNested { readonly x: string; readonly y: number }',
          ].join('\n'),
        );
        append(root, CDK_TYPES, [
          "import type { GateNested } from './gate-fixture';",
          "import type { GateMissing } from './gate-missing';",
          "export type { GateStatus } from './gate-fixture';",
          'export interface GateBase { readonly a: string }',
          'export interface GateChild extends GateBase { readonly b: string }',
          'export interface GateOuter { readonly inner: GateNested | null }',
          'export interface GateMembers { readonly a: string; readonly b: string; readonly c: string }',
          'export interface GateKind { readonly a: string }',
          "export enum GateEnum { A = 'a' }",
          'export const GATE_LIMIT = 30;',
          'export interface GateBoth { readonly a: string }',
          "export interface GateSame extends GateBase { readonly s: 'x' | 'y'; readonly list: string[] }",
          'export interface GateWeb { readonly a: string; readonly b?: number; readonly c: string }',
          'export interface GateSubset { readonly a: string; readonly b: number }',
          'export interface GateUnresolved { readonly a: GateMissing }',
        ].join('\n'));
        append(root, CLI_TYPES, [
          "export type GateStatus = 'A';",
          'export interface GateBase { readonly a: string }',
          'export interface GateChild { readonly b: string }',
          'interface GateNested { readonly x: string }',
          'export interface GateOuter { readonly inner: GateNested | null }',
          'export interface GateMembers { readonly a?: string; b: string; readonly c: string; readonly [extra: string]: unknown; ping(): void }',
          'export type GateKind = { readonly a: string };',
          "export enum GateEnum { A = 'b' }",
          'export const GATE_LIMIT = 60;',
          'export interface GateBoth { readonly a: string }',
          "export interface GateSame { readonly a: string; readonly s: 'y' | 'x'; readonly list: Array<string> }",
          'export interface GateWeb { readonly a: string; readonly b?: number; readonly c: string }',
          'export interface GateSubset { readonly a: string; readonly b: number }',
          'export interface GateUnresolved { readonly a: string }',
          "export enum GateCliEnum { A = 'a' }",
          'export function gateCliFn(): number { return 1; }',
          'export class GateCliClass {}',
        ].join('\n'));
        append(root, WEB_TYPES, [
          "export type GateStatus = 'A';",
          'export interface GateWeb { readonly a: number; readonly b: number; readonly d: string }',
          'export interface GateSubset { readonly a: string }',
        ].join('\n'));
        allowlist(root, 'CDK_ONLY_ALLOWLIST', 'GateStale');
        allowlist(root, 'CLI_ONLY_ALLOWLIST', 'GateBoth');
        allowlist(root, 'WEB_REQUIRED_WHERE_CDK_OPTIONAL', 'GateWeb.gone');
      });
    });

    test('exits 1', () => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('API type sync drift detected');
    });

    test('follows a re-export to a union derived in another file (the task-status shape)', () => {
      // The CDK location is the DECLARING file: the re-export was followed, not trusted.
      const declared = 'cdk/src/handlers/shared/gate-fixture.ts:2 (CDK)';
      expect(result.stderr).toMatch(new RegExp(`"GateStatus" differs between ${escape(declared)} and ${escape(CLI_TYPES)}:\\d+ \\(CLI\\)`));
      expect(result.stderr).toMatch(new RegExp(`"GateStatus" differs between ${escape(declared)} and ${escape(WEB_TYPES)}:\\d+ \\(web\\)`));
      expect(result.stderr).toContain('GateStatus: "B" only in CDK');
    });

    test('compares the members an `extends` clause contributes', () => {
      expect(result.stderr).toContain('GateChild: only in CDK: a');
    });

    test('compares a type declared outside the types file by its members, not its name', () => {
      expect(result.stderr).toContain('GateOuter.inner: only in CDK: y');
    });

    test('compares index and method signatures, optionality and readonly', () => {
      expect(result.stderr).toContain('GateMembers: only in CLI: ping, [string]');
      expect(result.stderr).toContain('GateMembers.a: required in CDK, optional in CLI');
      expect(result.stderr).toContain('GateMembers.b: readonly in CDK, writable in CLI');
    });

    test('compares declaration kinds, enum values and literal constants', () => {
      expect(result.stderr).toMatch(/"GateKind" kind mismatch: CDK=interface \(\S+:\d+\) vs CLI=type-alias \(\S+:\d+\)\./);
      expect(result.stderr).toContain('GateEnum.A: "a" in CDK, "b" in CLI');
      expect(result.stderr).toContain('GATE_LIMIT: 30 in CDK, 60 in CLI');
    });

    test('registers enum, function and class names, not only interfaces and aliases', () => {
      for (const name of ['GateCliEnum', 'gateCliFn', 'GateCliClass']) {
        expect(result.stderr).toContain(`CLI exports "${name}" but CDK does not`);
      }
    });

    test('rejects an allowlist entry that is stale or names a pair', () => {
      expect(result.stderr).toContain(`CDK_ONLY_ALLOWLIST in ${SCRIPT_REL} names "GateStale", which ${CDK_TYPES} does not export`);
      expect(result.stderr).toContain(`CLI_ONLY_ALLOWLIST in ${SCRIPT_REL} names "GateBoth", but ${CDK_TYPES} exports it too`);
      expect(result.stderr).toContain(`WEB_REQUIRED_WHERE_CDK_OPTIONAL in ${SCRIPT_REL} names "GateWeb.gone"`);
    });

    test('holds the web mirror to the CDK for every member it declares', () => {
      expect(result.stderr).toContain('GateWeb: only in web: d');
      expect(result.stderr).toContain('GateWeb.a: string in CDK, number in web');
      expect(result.stderr).toContain('GateWeb.b: optional in CDK, required in web');
    });

    test('lets the web mirror leave members out (it is a subset)', () => {
      expect(result.stderr).not.toContain('GateSubset');
      expect(result.stderr).not.toContain('GateWeb: only in CDK');
    });

    test('does not flag the same shape spelled differently', () => {
      // The false-positive side: flattened `extends`, reordered union, `T[]` vs `Array<T>`.
      expect(result.stderr).not.toContain('GateSame');
    });

    test('reports a file that does not type-check instead of comparing `any` with `any`', () => {
      expect(result.stderr).toMatch(/cdk\/src\/handlers\/shared\/types\.ts:\d+ does not type-check/);
      expect(result.stderr).toContain("Cannot find module './gate-missing'");
    });
  });

  describe('fails closed', () => {
    test('when a mirror is missing', () => {
      const result = runInMutatedRepo((root) => {
        fs.rmSync(path.join(root, WEB_TYPES));
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${WEB_TYPES} is missing or exports nothing`);
    });
  });
});
