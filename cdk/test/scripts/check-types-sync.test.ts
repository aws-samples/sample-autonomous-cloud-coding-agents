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
 * So is each direction of the name checks: a mirror export nothing declares,
 * and a CDK export the CLI lacks. The CLI's copies of the status list and of
 * the coding workflow id were excused as client-only although the CDK declares
 * both in other modules; a mirror export declared elsewhere, under its own
 * name or another, is pinned too.
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

/** Add an entry to one of the script's own lists (fails loudly if the list is renamed). */
function addEntry(root: string, opening: string, entry: string): void {
  const file = path.join(root, SCRIPT_REL);
  const source = fs.readFileSync(file, 'utf-8');
  if (!source.includes(opening)) throw new Error(`${SCRIPT_REL} no longer declares \`${opening}\``);
  fs.writeFileSync(file, source.replace(opening, `${opening}\n  ${entry},`));
}

function allowlist(root: string, list: string, entry: string): void {
  addEntry(root, `const ${list} = new Set<string>([`, `'${entry}'`);
}

/** Tell the script that a mirror export is declared in a CDK module other than the types file (as `canonName`, when it differs). */
function canonElsewhere(root: string, name: string, module: string, canonName?: string): void {
  const declaration = canonName === undefined ? `'${module}'` : `'${module}', '${canonName}'`;
  addEntry(root, 'const CANON_ELSEWHERE: ReadonlyMap<string, readonly [module: string, name?: string]> = new Map([', `['${name}', [${declaration}]]`);
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
      expect(result.stdout).toMatch(/CDK ↔ web: [1-9]\d* of \d+ web exports match their canonical declaration \([1-9]\d* console-only allowlisted\)/);
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
            // Constants declared outside the types file, as the status lists are.
            'export const GateList: readonly GateStatus[] = [GateStatuses.A, GateStatuses.B];',
            'export const GateListSame: readonly GateStatus[] = [GateStatuses.A, GateStatuses.B];',
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
          'export interface GateCdkOnly { readonly a: string }',
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
          'export interface GateCliShape { readonly a: string }',
          // Copies of what the CDK declares outside its types file, as the status list is.
          "export const GateList = ['B', 'A'] as const;",
          "export const GATE_RENAMED_LIST = ['A'] as const;",
          "export const GATE_RENAMED_LIST_SAME = ['A', 'B'] as const;",
          "export const GateExcused = ['A'] as const;",
          'export const GateMoved = 1;',
        ].join('\n'));
        append(root, WEB_TYPES, [
          "export type GateStatus = 'A';",
          'export interface GateWeb { readonly a: number; readonly b: number; readonly d: string }',
          'export interface GateSubset { readonly a: string }',
          "export const GateList: readonly string[] = ['A'];",
          "export const GateListSame = ['A', 'B'] as const;",
          'export interface GateCliShape { readonly a: number }',
          'export interface GateWebOnly { readonly a: string }',
          'export interface GateConsole { readonly a: string }',
          "export const GateListListed = ['A', 'B'] as const;",
        ].join('\n'));
        canonElsewhere(root, 'GateList', 'cdk/src/handlers/shared/gate-fixture.ts');
        canonElsewhere(root, 'GateListSame', 'cdk/src/handlers/shared/gate-fixture.ts');
        canonElsewhere(root, 'GateGone', 'cdk/src/handlers/shared/gate-fixture.ts');
        canonElsewhere(root, 'GateWeb', 'cdk/src/handlers/shared/gate-fixture.ts');
        canonElsewhere(root, 'GATE_RENAMED_LIST', 'cdk/src/handlers/shared/gate-fixture.ts', 'GateList');
        canonElsewhere(root, 'GATE_RENAMED_LIST_SAME', 'cdk/src/handlers/shared/gate-fixture.ts', 'GateListSame');
        canonElsewhere(root, 'GateExcused', 'cdk/src/handlers/shared/gate-fixture.ts', 'GateList');
        canonElsewhere(root, 'GateMoved', 'cdk/src/handlers/shared/gate-fixture.ts');
        allowlist(root, 'CLI_ONLY_ALLOWLIST', 'GateExcused');
        allowlist(root, 'CLI_ONLY_ALLOWLIST', 'GateCliShape');
        allowlist(root, 'WEB_ONLY_ALLOWLIST', 'GateConsole');
        allowlist(root, 'WEB_ONLY_ALLOWLIST', 'GateStaleWeb');
        allowlist(root, 'WEB_ONLY_ALLOWLIST', 'GateWeb');
        // Listed as console-only although the CLI declares it, or the canonical-module list names it.
        allowlist(root, 'WEB_ONLY_ALLOWLIST', 'GateCliShape');
        canonElsewhere(root, 'GateListListed', 'cdk/src/handlers/shared/gate-fixture.ts', 'GateListSame');
        allowlist(root, 'WEB_ONLY_ALLOWLIST', 'GateListListed');
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

    test('rejects a CDK export the CLI neither mirrors nor is excused from', () => {
      expect(result.stderr).toContain('CDK exports "GateCdkOnly" but CLI does not');
    });

    test('rejects a web export that nothing declares, and accepts a listed console-only one', () => {
      // A type renamed in the CDK and the CLI leaves the forgotten web copy here.
      expect(result.stderr).toContain(`web exports "GateWebOnly" but neither ${CDK_TYPES} nor ${CLI_TYPES} declares it`);
      expect(result.stderr).not.toContain('"GateConsole"');
    });

    test('compares a web constant with the CDK module that declares it, by value', () => {
      expect(result.stderr).toMatch(new RegExp(`"GateList" differs between cdk/src/handlers/shared/gate-fixture\\.ts:\\d+ \\(CDK\\) and ${escape(WEB_TYPES)}:\\d+ \\(web\\)`));
      expect(result.stderr).toContain('GateList: ["A","B"] in CDK, ["A"] in web');
      // The false-positive side: member accesses on one side, literals `as const` on the other.
      expect(result.stderr).not.toContain('GateListSame');
    });

    test('compares a CLI constant with the CDK module that declares it, under the same name or another', () => {
      const between = `differs between cdk/src/handlers/shared/gate-fixture\\.ts:\\d+ \\(CDK\\) and ${escape(CLI_TYPES)}:\\d+ \\(CLI\\)`;
      expect(result.stderr).toMatch(new RegExp(`"GateList" ${between}`));
      expect(result.stderr).toContain('GateList: ["A","B"] in CDK, ["B","A"] in CLI');
      expect(result.stderr).toMatch(new RegExp(`"GATE_RENAMED_LIST" ${between}`));
      expect(result.stderr).toContain('GATE_RENAMED_LIST: ["A","B"] in CDK, ["A"] in CLI');
      // The false-positive side: an equal copy under another name.
      expect(result.stderr).not.toContain('GATE_RENAMED_LIST_SAME');
    });

    test('compares a web export the CDK types lack with the CLI declaration', () => {
      expect(result.stderr).toContain('GateCliShape.a: string in CLI, number in web');
    });

    test('rejects a stale or contradicted entry of the web lists', () => {
      expect(result.stderr).toContain(`WEB_ONLY_ALLOWLIST in ${SCRIPT_REL} names "GateStaleWeb", which ${WEB_TYPES} does not export`);
      // A canonical declaration is one in the CDK types, in the CLI mirror or in a listed CDK module.
      for (const name of ['GateWeb', 'GateCliShape', 'GateListListed']) {
        expect(result.stderr).toContain(`WEB_ONLY_ALLOWLIST in ${SCRIPT_REL} names "${name}", but it has a canonical declaration`);
      }
    });

    test('rejects a stale, contradicted or dangling entry of the canonical-module list', () => {
      expect(result.stderr).toContain(`CANON_ELSEWHERE in ${SCRIPT_REL} names "GateGone", which neither ${CLI_TYPES} nor ${WEB_TYPES} exports`);
      expect(result.stderr).toContain(`CANON_ELSEWHERE in ${SCRIPT_REL} sends "GateWeb" to cdk/src/handlers/shared/gate-fixture.ts, but ${CDK_TYPES} exports it`);
      // Excused as CLI-only and given a canonical declaration at once: the excuse would win silently.
      expect(result.stderr).toContain(`CLI_ONLY_ALLOWLIST in ${SCRIPT_REL} names "GateExcused", but CANON_ELSEWHERE there gives it a canonical declaration`);
      // The module named for a CLI export lacks it: one message, about the entry.
      expect(result.stderr).toContain('says cdk/src/handlers/shared/gate-fixture.ts declares "GateMoved", but that module does not export it');
      expect(result.stderr).not.toContain('CLI exports "GateMoved" but CDK does not');
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

    test('when the web mirror has nothing left to compare', () => {
      const result = runInMutatedRepo((root) => {
        fs.writeFileSync(path.join(root, WEB_TYPES), 'export interface DecisionResponse { readonly task_id: string }\n');
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${WEB_TYPES} shares no export name with ${CDK_TYPES}, so the web mirror check compared nothing`);
    });

    test('when a module named as canonical does not export the name', () => {
      const result = runInMutatedRepo((root) => {
        canonElsewhere(root, 'TaskEvent', 'cdk/src/constructs/task-status.ts');
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('says cdk/src/constructs/task-status.ts declares "TaskEvent", but that module does not export it');
    });
  });
});
