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
 * Tests for `scripts/check-masking-suppression-placement.mjs` — the guard over
 * semgrep suppression comments.
 *
 * WHY THESE EXIST: the guard used to check one thing, that a masking suppression
 * sits near the word `return`. A suppression with no reason, a bare one that
 * names no rule, one above a line that merely mentions `return`, and one that no
 * longer suppresses anything all passed it.
 *
 * HOW: same as `preflight-log-delivery.test.ts` — the script is spawned in a
 * throwaway repo root with a fake `semgrep` on PATH that replays the findings a
 * case declares. The real semgrep run is what `mise run security:sast:masking`
 * does on the real tree; these cases pin what the script makes of its answer.
 *
 * The suppression word is assembled from two halves throughout: the guard scans
 * test files too, and a line of this file that spelled it would have to be a
 * well-formed suppression itself.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'scripts/check-masking-suppression-placement.mjs';
const WORD = 'nose' + 'mgrep';
const TS_RULE = 'ts-silent-success-masking';
const PY_RULE = 'py-silent-success-masking';

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The arguments the script passed to semgrep. */
  readonly semgrepArgs: string[];
}

/** A finding as semgrep reports it with suppressions ignored. */
type Finding = readonly [file: string, line: number, rule: string];

interface Options {
  /** `missing`: no semgrep on PATH. `fails`: it exits 2. `scans-nothing`: it reports no scanned file. */
  readonly semgrep?: 'missing' | 'fails' | 'scans-nothing';
  /** Leave the root without a git repository. */
  readonly noGit?: boolean;
}

/** Run the script in a temp repo holding `files`, with a fake semgrep that reports `findings`. */
function run(files: Record<string, string>, findings: readonly Finding[], options: Options = {}): RunResult {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-masking-guard-'));
  // The repo holds the case's files and nothing else: the script reads every
  // tracked source file, so it runs from its real location, and the fake
  // semgrep lives beside the repo, not in it.
  const root = path.join(work, 'repo');
  const bin = path.join(work, 'bin');
  try {
    fs.mkdirSync(root);
    for (const [rel, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), contents);
    }

    const report = {
      results: findings.map(([file, line, rule]) => ({ path: file, start: { line }, check_id: `semgrep.${rule}` })),
      paths: { scanned: options.semgrep === 'scans-nothing' ? [] : Object.keys(files) },
    };
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'args.json'), '[]');
    if (options.semgrep !== 'missing') {
      fs.writeFileSync(
        path.join(bin, 'semgrep'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(options.semgrep === 'fails')}) {
  process.stderr.write('fake semgrep: invalid configuration');
  process.exit(2);
}
process.stdout.write(${JSON.stringify(JSON.stringify(report))});
`,
        { mode: 0o755 },
      );
    }

    // No inherited GIT_* variable: under a git hook they point at the real
    // repository, and both `git init` here and `git ls-files` in the script
    // would act on it instead of on the temp root.
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
    // The real semgrep must not answer for the fake one, least of all when the case is "missing".
    const realPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => !fs.existsSync(path.join(dir, 'semgrep')));
    const env = { ...Object.fromEntries(inherited), PATH: [bin, ...realPath].join(path.delimiter) };
    if (!options.noGit) {
      execFileSync('git', ['init', '--quiet'], { cwd: root, env, stdio: 'ignore' });
      execFileSync('git', ['add', '--all'], { cwd: root, env, stdio: 'ignore' });
    }

    const semgrepArgs = (): string[] => JSON.parse(fs.readFileSync(path.join(bin, 'args.json'), 'utf-8'));
    try {
      const stdout = execFileSync(process.execPath, [path.join(REPO_ROOT, SCRIPT_REL)], {
        cwd: root,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '', semgrepArgs: semgrepArgs() };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', semgrepArgs: semgrepArgs() };
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A catch block whose return carries `comment` (the finding is on line 5). */
function tsCatch(comment: string): string {
  return ['export function f(): string | null {', '  try {', '    return g();', '  } catch {', `    return null;${comment}`, '  }', '}', ''].join('\n');
}

describe('check-masking-suppression-placement', () => {
  jest.setTimeout(60_000);

  test('passes well-formed suppressions that bind, and says what it checked', () => {
    const result = run(
      {
        'src/inline.ts': tsCatch(` // ${WORD}: ${TS_RULE} -- a missing record is this lookup's null contract`),
        'src/above.py': ['def f():', '    try:', '        return g()', '    except KeyError:', `        # ${WORD}: ${PY_RULE} -- absent key means not configured`, '        return None', ''].join('\n'),
        'src/other-rule.ts': `const p = join(root, name); // ${WORD}: path-join-resolve-traversal -- name is checked against an allowlist above\n`,
        // The false-positive side: the word inside the prose of a comment line is not a suppression.
        'src/prose.ts': `// The ${WORD} comment on parseBody is justified by the test below.\nexport const x = 1;\n`,
      },
      [['src/inline.ts', 5, TS_RULE], ['src/above.py', 6, PY_RULE]],
    );

    expect(result.status).toBe(0);
    // The counts are the anti-vacuity assertion: a guard that read nothing also exits 0.
    expect(result.stdout).toContain('3 semgrep suppressions in 4 source files name a rule and a reason');
    expect(result.stdout).toContain('all 2 silent-success-masking suppressions bind to one of 2 findings');
  });

  test('asks semgrep for the findings with suppressions ignored', () => {
    const result = run({ 'src/a.ts': 'export const x = 1;\n' }, []);

    expect(result.status).toBe(0);
    expect(result.semgrepArgs).toEqual(expect.arrayContaining(['--config', '.semgrep/silent-success-masking.yaml', '--disable-nose' + 'm', '--json']));
  });

  describe('form', () => {
    test('rejects a bare suppression, which names no rule', () => {
      const result = run({ 'src/a.ts': tsCatch(` // ${WORD}`) }, [['src/a.ts', 5, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`1 semgrep suppression(s) not in the form \`${WORD}: <rule-id> -- <reason>\``);
      expect(result.stderr).toContain('src/a.ts:5');
    });

    test('rejects a suppression without a reason', () => {
      const result = run({ 'src/a.ts': tsCatch(` // ${WORD}: ${TS_RULE}`) }, [['src/a.ts', 5, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.ts:5');
      expect(result.stderr).toContain('Name the rule being suppressed and say why');
    });

    test('rejects a suppression for any rule, not only the masking ones', () => {
      const result = run({ 'src/a.py': `os.chmod(path, mode)  # ${WORD}\n` }, []);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.py:1');
    });

    test('rejects the word in the prose of a comment that trails code', () => {
      // semgrep honours the bare word anywhere on a flagged line.
      const result = run({ 'src/a.ts': tsCatch(` // deliberately ${WORD} here`) }, [['src/a.ts', 5, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.ts:5');
    });
  });

  describe('binding', () => {
    test('rejects a suppression two lines above its return', () => {
      const source = ['export function f(): string | null {', '  try {', '    return g();', '  } catch {', `    // ${WORD}: ${TS_RULE} -- missing record is the null contract`, '    // (a second line of prose pushed the suppression up)', '    return null;', '  }', '}', ''].join('\n');
      const result = run({ 'src/a.ts': source }, [['src/a.ts', 7, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('1 silent-success-masking suppression(s) suppress nothing');
      expect(result.stderr).toContain('src/a.ts:5');
      expect(result.stderr).toContain('move it onto that line or directly above it');
    });

    test('rejects a suppression above a line that only mentions return', () => {
      const source = ['export function f(): string | null {', '  try {', '    return g();', '  } catch {', `    // ${WORD}: ${TS_RULE} -- missing record is the null contract`, '    // we return early below', '    void 0;', '    return null;', '  }', '}', ''].join('\n');
      const result = run({ 'src/a.ts': source }, [['src/a.ts', 8, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.ts:5');
    });

    test('rejects a suppression on code the rule does not flag', () => {
      const result = run({ 'src/a.ts': tsCatch(` // ${WORD}: ${TS_RULE} -- missing record is the null contract`) }, []);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.ts:5');
      expect(result.stderr).toContain('delete the\nsuppression and keep the explanation as an ordinary comment');
    });

    test('rejects a suppression that names the other masking rule', () => {
      const result = run({ 'src/a.ts': tsCatch(` // ${WORD}: ${PY_RULE} -- missing record is the null contract`) }, [['src/a.ts', 5, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.ts:5');
    });
  });

  describe('fails closed', () => {
    const files = { 'src/a.ts': tsCatch(` // ${WORD}: ${TS_RULE} -- missing record is the null contract`) };
    const findings: Finding[] = [['src/a.ts', 5, TS_RULE]];

    test('when semgrep is not installed', () => {
      const result = run(files, findings, { semgrep: 'missing' });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('semgrep is not on PATH');
    });

    test('when semgrep fails', () => {
      const result = run(files, findings, { semgrep: 'fails' });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('semgrep failed (exit 2): fake semgrep: invalid configuration');
    });

    test('when semgrep scanned no file', () => {
      const result = run(files, findings, { semgrep: 'scans-nothing' });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('semgrep scanned no file');
    });

    test('when there is no tracked source file to read', () => {
      const result = run({ 'README.md': 'nothing to scan\n' }, []);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('git lists no tracked source file here');
    });

    test('outside a git repository', () => {
      const result = run(files, findings, { noGit: true });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('git ls-files failed');
    });
  });
});
