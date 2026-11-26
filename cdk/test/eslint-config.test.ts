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
import * as path from 'node:path';

const CASES: Array<[file: string, code: string, rules: string[]]> = [
  ['src/handlers/a.ts', 'export const client = new DynamoDBClient({});', ['no-restricted-syntax']],
  ['src/constructs/a.ts', 'export const client = new sdk.S3Client();', ['no-restricted-syntax']],
  ['src/handlers/a.ts', 'export const client = makeClient(DynamoDBClient, {});', []],
  ['src/handlers/a.ts', 'export const registry = new AgentRegistryClient(config);', []],
  ['src/constructs/a.ts', "export const client = new cognito.UserPoolClient(scope, 'Client', props);", []],
  ['test/a.test.ts', 'export const client = new DynamoDBClient({});', []],
  ['src/a.ts', "export const digest = createHash('md5');", ['no-restricted-syntax']],
  ['scripts/a.ts', "export const digest = crypto.createHash('md5');", ['no-restricted-syntax']],
  ['src/handlers/a.ts', "import 'aws-cdk-lib';", ['no-restricted-imports']],
  ['src/handlers/a.ts', "import 'aws-cdk-lib/aws-lambda';", ['no-restricted-imports']],
  ['src/handlers/a.ts', "import 'constructs';", ['no-restricted-imports']],
  ['src/handlers/shared/a.ts', "import '../../constructs/task-api';", ['import-x/no-restricted-paths']],
  ['src/handlers/a.ts', "import '../stacks/agent';", ['import-x/no-restricted-paths']],
  ['src/handlers/a.ts', "import '../constructs/task-status';", []],
  ['src/handlers/a.ts', "import './shared/types';", []],
  ['src/constructs/a.ts', "import 'aws-cdk-lib';", []],
  ['src/a.ts', '/* istanbul ignore next */', ['no-warning-comments']],
  ['src/a.ts', '/* v8 ignore next */', ['no-warning-comments']],
  ['src/a.ts', '/* c8 ignore start */', ['no-warning-comments']],
  ['src/a.ts', '/* node:coverage disable */', ['no-warning-comments']],
  ['src/handlers/shared/a.ts', "try { run(); } catch (err) { throw new Error('failed'); }", ['preserve-caught-error']],
  // Checks that the @stylistic forks of these two core rules leave out.
  ['src/a.ts', 'try { run(); } catch(err) { report(err); }', ['keyword-spacing']],
  ['src/a.ts', 'export const [,second] = pair;', ['comma-spacing']],
  ['src/a.ts', 'export const pattern = /\\x01/;', ['no-control-regex']],
  // @stylistic/no-multi-spaces lets two spaces inside an import attribute pass by default.
  ['src/a.ts', "import cfg from './cfg.json' with { type: /* c */  'json' };", ['@stylistic/no-multi-spaces']],
];

/**
 * Runs in a child process, because Jest cannot import() the ES module config that ESLint
 * loads.
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

test('eslint.config.mjs reports each snippet with exactly the rules listed', () => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', LINT_CASES, JSON.stringify(CASES)], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reported = JSON.parse(stdout) as string[][];
  expect(CASES.map(([file, code], index) => [file, code, reported[index]])).toEqual(CASES);
}, 60_000);

/**
 * ESLint looks for an eslint.config.* file from the directory of each file it lints.
 * --config applies one file to every file.
 */
test.each(['cdk', 'cli', 'web'])('the eslint tasks of %s name eslint.config.mjs', (pkg) => {
  const commands = fs.readFileSync(path.resolve(__dirname, '..', '..', pkg, 'mise.toml'), 'utf-8')
    .split('\n')
    .filter((line) => line.includes('/.bin/eslint '));
  expect(commands).toHaveLength(2);
  for (const command of commands) {
    expect(command).toContain('/.bin/eslint --config eslint.config.mjs ');
  }
});

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
