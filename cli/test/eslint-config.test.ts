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

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The rules below are selectors written by hand in eslint.config.mjs. One that matches
 * nothing is still valid and lint passes, so each row lints a snippet as the named file
 * with the real config and lists the rules that must report it: none where the snippet
 * has to stay legal.
 */
const CASES: Array<[file: string, code: string, rules: string[]]> = [
  // An AWS SDK client built outside the ua factory (#319).
  ['src/a.ts', 'export const client = new CloudFormationClient({});', ['no-restricted-syntax']],
  ['src/a.ts', 'export const client = new sdk.STSClient();', ['no-restricted-syntax']],
  ['src/a.ts', 'export const client = makeClient(CloudFormationClient, {});', []],
  ['src/a.ts', "export const api = new ApiClient('https://api.example');", []],
  ['test/a.test.ts', 'export const client = new CloudFormationClient({});', []],
  // md5 from node:crypto.
  ['src/a.ts', "export const digest = createHash('md5');", ['no-restricted-syntax']],
  ['test/a.test.ts', "export const digest = crypto.createHash('md5');", ['no-restricted-syntax']],
  // A comment that takes code out of the coverage report, in each spelling the rule lists.
  ['src/a.ts', '/* istanbul ignore next */', ['no-warning-comments']],
  ['src/a.ts', '/* v8 ignore next */', ['no-warning-comments']],
  ['src/a.ts', '/* c8 ignore start */', ['no-warning-comments']],
  ['src/a.ts', '/* node:coverage disable */', ['no-warning-comments']],
  // An explicit any.
  ['src/a.ts', 'export const value: any = 1;', ['@typescript-eslint/no-explicit-any']],
  // The two core formatting rules that stay on beside their @stylistic forks: what the
  // forks leave out.
  ['src/a.ts', 'try { run(); } catch(err) { report(err); }', ['keyword-spacing']],
  ['src/a.ts', 'export const [,second] = pair;', ['comma-spacing']],
  // A control character in a regular expression.
  ['src/a.ts', 'export const pattern = /\\x01/;', ['no-control-regex']],
  // Two spaces inside an import attribute, which @stylistic/no-multi-spaces lets pass by default.
  ['src/a.ts', "import cfg from './cfg.json' with { type: /* c */  'json' };", ['@stylistic/no-multi-spaces']],
];

const SHEBANG = '#!/usr/bin/env node';
const HEADER = fs.readFileSync(path.resolve(__dirname, '..', 'header.js'), 'utf-8').trim();

/**
 * A file that starts with a shebang carries the license header like any other (#172). The
 * rule takes the shebang as the one line allowed above the header and wants the header
 * right below it, one blank line apart. A table of its own: every rule named in a table
 * runs on every row of it, and the snippets above carry no header.
 */
const SHEBANG_CASES: typeof CASES = [
  ['src/bin/a.ts', `${SHEBANG}\n\n${HEADER}\n\nexport const a = 1;\n`, []],
  // No header.
  ['src/bin/a.ts', `${SHEBANG}\n\nexport const a = 1;\n`, ['license-header/header']],
  // Two blank lines between the shebang and the header.
  ['src/bin/a.ts', `${SHEBANG}\n\n\n${HEADER}\n\nexport const a = 1;\n`, ['license-header/header']],
  // A comment between the shebang and the header.
  ['src/bin/a.ts', `${SHEBANG}\n\n// a comment\n\n${HEADER}\n\nexport const a = 1;\n`, ['license-header/header']],
];

/**
 * Runs in a child process, because Jest cannot import() the ES module config that ESLint
 * loads. Only the rules under test run and the parser gets no project: the snippets are
 * not files of the project.
 */
const LINT_CASES = `
  import { ESLint } from 'eslint';
  const cases = JSON.parse(process.argv[1]);
  const rules = new Set(cases.flatMap(([, , ids]) => ids));
  const eslint = new ESLint({
    overrideConfigFile: 'eslint.config.mjs',
    ruleFilter: ({ ruleId }) => rules.has(ruleId),
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parserOptions: { project: null } } }],
  });
  const reported = [];
  for (const [file, code] of cases) {
    const [result] = await eslint.lintText(code, { filePath: file });
    reported.push(result.messages.map((message) => message.ruleId));
  }
  console.log(JSON.stringify(reported));
`;

test.each([
  ['each snippet', CASES],
  ['each file that starts with a shebang', SHEBANG_CASES],
])('eslint.config.mjs reports %s with exactly the rules listed', (_name, cases) => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', LINT_CASES, JSON.stringify(cases)], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reported = JSON.parse(stdout) as string[][];
  expect(cases.map(([file, code], index) => [file, code, reported[index]])).toEqual(cases);
}, 60_000);

/**
 * The check-only lint (`mise //cli:eslint:check`, part of `mise run lint`) of the files that
 * start with a shebang. Run without --fix, the parser would take each file's syntax tree
 * from the copy on disk, where a shebang is not a comment, and the license-header rule
 * would report the header below it as misplaced: eslint.config.mjs tells the parser not to.
 * Only this run shows it: the build lints with --fix and the tests above lint without a
 * project, and the parser does that in neither.
 */
test('eslint without --fix passes the files that start with a shebang', () => {
  const eslint = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'eslint');
  const { status, stdout } = spawnSync(process.execPath, [eslint, '--config', 'eslint.config.mjs', '--max-warnings', '0', 'src/bin'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect({ status, stdout }).toEqual({ status: 0, stdout: '' });
}, 60_000);

/**
 * A function that was above the complexity ceiling when the ceiling landed carries a
 * directive, and the first number in its parenthesis is the record: the value the function
 * had then, lowered whenever a change made the function smaller. The directive switches
 * the rule off for that function, so nothing else compares the two numbers: this lints
 * src with the directives ignored and holds each function above the ceiling to the record
 * on the line above it.
 */
const LINT_COMPLEXITY = `
  import { readFileSync } from 'node:fs';
  import { relative } from 'node:path';
  import { ESLint } from 'eslint';
  const eslint = new ESLint({
    overrideConfigFile: 'eslint.config.mjs',
    allowInlineConfig: false,
    ruleFilter: ({ ruleId }) => ruleId === 'complexity',
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parserOptions: { project: null } } }],
  });
  const grown = [];
  for (const result of await eslint.lintFiles(['src'])) {
    const lines = readFileSync(result.filePath, 'utf-8').split('\\n');
    for (const { line, message } of result.messages) {
      const [, now] = /has a complexity of (\\d+)/.exec(message) ?? [];
      const [, recorded] = /complexity -- .*?\\((\\d+)/.exec(lines[line - 2]) ?? [];
      // A message or a directive without a number fails the comparison as well.
      if (!(Number(now) <= Number(recorded))) {
        grown.push(relative('.', result.filePath) + ':' + line + ' ' + message + ' Recorded: ' + (recorded ?? 'nothing') + '.');
      }
    }
  }
  console.log(JSON.stringify(grown));
`;

test('no function above the complexity ceiling has grown past the value its directive records', () => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', LINT_COMPLEXITY], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(JSON.parse(stdout)).toEqual([]);
}, 60_000);
