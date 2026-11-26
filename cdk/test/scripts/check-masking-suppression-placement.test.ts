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
  readonly semgrepArgs: string[];
}

type Finding = readonly [file: string, line: number, rule: string];

interface Options {
  readonly semgrep?: 'missing' | 'fails' | 'scans-nothing';
  readonly scanned?: readonly string[];
  readonly noGit?: boolean;
  readonly links?: Record<string, string>;
}

function run(files: Record<string, string>, findings: readonly Finding[], options: Options = {}): RunResult {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-masking-guard-'));
  const root = path.join(work, 'repo');
  const bin = path.join(work, 'bin');
  try {
    fs.mkdirSync(root);
    for (const [rel, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), contents);
    }

    for (const [rel, target] of Object.entries(options.links ?? {})) {
      fs.symlinkSync(target, path.join(root, rel));
    }

    const report = {
      results: findings.map(([file, line, rule]) => ({ path: file, start: { line }, check_id: `semgrep.${rule}` })),
      paths: { scanned: options.semgrep === 'scans-nothing' ? [] : options.scanned ?? Object.keys(files) },
    };
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'args.json'), '[]');
    if (options.semgrep !== 'missing') {
      fs.writeFileSync(
        path.join(bin, 'semgrep'),
        `#!${process.execPath}
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

    // Git exports GIT_* variables to its hooks, and a child git that inherits them acts on the hook's repository.
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
    const inheritedPath = (process.env.PATH ?? '').split(path.delimiter);
    const realPath = options.semgrep === 'missing'
      ? inheritedPath.filter((dir) => !fs.existsSync(path.join(dir, 'semgrep')))
      : inheritedPath;
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

function tsCatchWith(lines: readonly string[]): string {
  return ['export function f(): string | null {', '  try {', '    return g();', '  } catch {', ...lines.map((line) => `    ${line}`), '  }', '}', ''].join('\n');
}

function tsCatch(comment: string): string {
  return tsCatchWith([`return null;${comment}`]);
}

describe('check-masking-suppression-placement', () => {
  jest.setTimeout(60_000);

  test('passes well-formed suppressions that bind, and says what it checked', () => {
    const result = run(
      {
        'src/inline.ts': tsCatch(` // ${WORD}: ${TS_RULE} -- a missing record is this lookup's null contract`),
        'src/above.py': ['def f():', '    try:', '        return g()', '    except KeyError:', `        # ${WORD}: ${PY_RULE} -- absent key means not configured`, '        return None', ''].join('\n'),
        'src/other-rule.ts': `const p = join(root, name); // ${WORD}: path-join-resolve-traversal -- name is checked against an allowlist above\n`,
        'src/other-word.ts': 'export function diagnoseMemory(): number {\n  return 1;\n}\n',
      },
      [['src/inline.ts', 5, TS_RULE], ['src/above.py', 6, PY_RULE]],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('3 semgrep suppressions in 4 files name a rule and a reason');
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

    test('reads a file semgrep scanned although its name is not a source file name', () => {
      const tool = `#!/usr/bin/env node\n${tsCatch(` // ${WORD}`)}`;
      const result = run({ 'src/a.ts': 'export const x = 1;\n', 'bin/tool': tool }, [['bin/tool', 6, TS_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('bin/tool:6 (semgrep reads ');
    });

    describe('reads the tracked files that the masking rules do not', () => {
      // semgrep honours a suppression in workflows, Dockerfiles, shell scripts and configuration as well.
      const names = ['.github/workflows/build.yml', 'agent/Dockerfile', 'scripts/ci-build.sh', 'agent/pyproject.toml', 'docs/src/components/Search.astro'];
      const files = {
        'src/a.ts': 'export const x = 1;\n',
        ...Object.fromEntries(names.map((name) => [name, `# what follows is not for review\n# ${WORD}\n`])),
      };
      let result: RunResult;
      beforeAll(() => {
        result = run(files, [], { scanned: ['src/a.ts'] });
      });

      test('exits 1 and reports every one of them', () => {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${names.length} semgrep suppression(s) not in the form`);
      });

      test.each(names)('rejects the bare suppression in %s', (name) => {
        expect(result.stderr).toContain(`${name}:2 (semgrep reads `);
      });
    });

    test('leaves Markdown alone, where the guides have to spell the word', () => {
      const result = run(
        {
          'src/a.ts': 'export const x = 1;\n',
          'src/b.ts': 'export const y = 2;\n',
          'AGENTS.md': `A line that holds the word \`${WORD}\` must be one suppression.\n`,
          'docs/guide.mdx': `Use \`${WORD}\` with a rule id and a reason.\n`,
        },
        [],
        { scanned: ['src/a.ts', 'src/b.ts'] },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('0 semgrep suppressions in 2 files name a rule and a reason');
    });

    test('reads a Markdown file that semgrep scanned', () => {
      // semgrep reads an executable file that starts with a script line, whatever its name, and honours the suppression in it.
      const tool = `#!/usr/bin/env node\n${tsCatch(` // ${WORD}`)}`;
      const result = run(
        { 'src/a.ts': 'export const x = 1;\n', 'tools/release.md': tool },
        [['tools/release.md', 6, TS_RULE]],
        { scanned: ['src/a.ts', 'tools/release.md'] },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('tools/release.md:6 (semgrep reads ');
    });

    test('passes over a tracked link to a directory, which semgrep does not read through', () => {
      const result = run(
        { 'src/a.ts': 'export const x = 1;\n', 'docs/imgs/a.txt': 'x\n' },
        [],
        { scanned: ['src/a.ts'], links: { latest: 'docs/imgs' } },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('0 semgrep suppressions in 2 files name a rule and a reason');
    });

    test('reads a file that holds a NUL byte', () => {
      // semgrep reads a source file that holds a NUL byte and honours the suppression in it.
      const source = ['def f():', '    try:', '        return g()', '    except KeyError:', `        return None  # ${WORD}`, `BLOB = "${String.fromCharCode(0)}"`, ''].join('\n');
      const result = run({ 'src/a.py': source }, [['src/a.py', 5, PY_RULE]]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/a.py:5 (semgrep reads ');
    });

    describe('finds the word the way semgrep does', () => {
      // The pinned semgrep treats each of these catch bodies as suppressed.
      const UPPER = WORD.toUpperCase();
      const SHORT = 'NOSE' + 'M';
      const tsBodies: ReadonlyArray<readonly string[]> = [
        [`return null; // ${UPPER}`],
        [`return null; // ${'NoSe' + 'mgrep'}`],
        [`return null; // ${SHORT}`],
        [`return null; // ${WORD}_all`],
        [`return null; // ${'nose' + 'mantic'} change`],
        [`return null; // no\u017Fe${'mgrep'}`],
        [`/* optional */ return null; // ${WORD}`],
        [`const ${'no' + 'Semicolons'} = 1; return null;`],
        [`// ${UPPER}`, 'return null;'],
        [`// _${WORD}`, 'return null;'],
        [`// The ${WORD} comment on this return is explained elsewhere.`, 'return null;'],
        [`/* ${SHORT}:${TS_RULE} */ return null; // ${WORD}: other-rule -- the reason given for another rule`],
        [`return null; // ${SHORT} x${WORD}: other-rule -- the reason given for another rule`],
        [`return null; //${WORD}: other-rule -- the reason given for another rule ${SHORT}`],
      ];
      const pyBodies: ReadonlyArray<readonly string[]> = [
        [`return None  # ${UPPER}`],
        [`# ${SHORT}`, 'return None'],
        [`# The ${WORD} comment on this return is explained elsewhere.`, 'return None'],
      ];
      const pyExcept = (lines: readonly string[]): string =>
        ['def f():', '    try:', '        return g()', '    except KeyError:', ...lines.map((line) => `        ${line}`), ''].join('\n');
      const files = {
        ...Object.fromEntries(tsBodies.map((lines, i) => [`src/v${i}.ts`, tsCatchWith(lines)])),
        ...Object.fromEntries(pyBodies.map((lines, i) => [`src/p${i}.py`, pyExcept(lines)])),
      };
      let result: RunResult;
      beforeAll(() => {
        result = run(files, []);
      });

      test('exits 1 and reports every one of them', () => {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${tsBodies.length + pyBodies.length} semgrep suppression(s) not in the form`);
        expect(result.stderr).toContain('reword the comment or rename the identifier');
      });

      test.each(Object.keys(files))('rejects the suppression in %s', (file) => {
        expect(result.stderr).toContain(`${file}:5 (semgrep reads `);
      });
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
      expect(result.stderr).toContain(`src/a.ts:5 (${PY_RULE})`);
    });

    test('rejects a suppression that also names a masking rule it has no finding for', () => {
      const result = run(
        { 'src/a.ts': tsCatch(` // ${WORD}: ${TS_RULE} -- the agent does the same under ${PY_RULE}`) },
        [['src/a.ts', 5, TS_RULE]],
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`src/a.ts:5 (${PY_RULE})`);
      expect(result.stderr).not.toContain(`src/a.ts:5 (${TS_RULE})`);
    });

    describe('counts a suppression as a masking one however its rule id is written', () => {
      // The pinned semgrep accepts each of these comments as naming the masking rule.
      const comments = [
        ` // ${WORD}: semgrep.${TS_RULE} -- missing record is the null contract`,
        ` // ${WORD}: other-rule -- missing record is the null contract, ${TS_RULE}`,
      ];

      test.each(comments.map((_, i) => i))('rejects comment %i on code the rule does not flag', (i) => {
        const result = run({ 'src/a.ts': tsCatch(comments[i]) }, []);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('1 silent-success-masking suppression(s) suppress nothing');
        expect(result.stderr).toContain(`src/a.ts:5 (${TS_RULE})`);
      });

      test('and holds each of them to a finding of that rule', () => {
        const files = Object.fromEntries(comments.map((comment, i) => [`src/c${i}.ts`, tsCatch(comment)]));
        const result = run(files, comments.map((_, i): Finding => [`src/c${i}.ts`, 5, TS_RULE]));

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`all ${comments.length} silent-success-masking suppressions bind to one of ${comments.length} findings`);
      });
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
