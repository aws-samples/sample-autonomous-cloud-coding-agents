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
import * as path from 'node:path';

/**
 * The rules below are selectors, path lists and one import zone written by hand in
 * eslint.config.mjs. One that matches nothing is still valid and lint passes, so each row
 * lints a snippet as the named file with the real config and lists the rules that must
 * report it: none where the snippet has to stay legal.
 */
const CASES: Array<[file: string, code: string, rules: string[]]> = [
  // An AWS SDK client built outside the ua factory (#319).
  ['src/handlers/a.ts', 'export const client = new DynamoDBClient({});', ['no-restricted-syntax']],
  ['src/constructs/a.ts', 'export const client = new sdk.S3Client();', ['no-restricted-syntax']],
  ['src/handlers/a.ts', 'export const client = makeClient(DynamoDBClient, {});', []],
  ['src/handlers/a.ts', 'export const registry = new AgentRegistryClient(config);', []],
  ['src/constructs/a.ts', "export const client = new cognito.UserPoolClient(scope, 'Client', props);", []],
  ['test/a.test.ts', 'export const client = new DynamoDBClient({});', []],
  // md5 from node:crypto.
  ['src/a.ts', "export const digest = createHash('md5');", ['no-restricted-syntax']],
  ['scripts/a.ts', "export const digest = crypto.createHash('md5');", ['no-restricted-syntax']],
  // Handler code stays clear of the CDK and of the modules that import it.
  ['src/handlers/a.ts', "import 'aws-cdk-lib';", ['no-restricted-imports']],
  ['src/handlers/a.ts', "import 'aws-cdk-lib/aws-lambda';", ['no-restricted-imports']],
  ['src/handlers/a.ts', "import 'constructs';", ['no-restricted-imports']],
  ['src/handlers/shared/a.ts', "import '../../constructs/task-api';", ['import-x/no-restricted-paths']],
  ['src/handlers/a.ts', "import '../stacks/agent';", ['import-x/no-restricted-paths']],
  ['src/handlers/a.ts', "import '../constructs/task-status';", []],
  ['src/handlers/a.ts', "import './shared/types';", []],
  ['src/constructs/a.ts', "import 'aws-cdk-lib';", []],
  // A comment that takes code out of the coverage report.
  ['src/a.ts', '/* istanbul ignore next */', ['no-warning-comments']],
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

test('eslint.config.mjs reports each snippet with exactly the rules listed', () => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', LINT_CASES, JSON.stringify(CASES)], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reported = JSON.parse(stdout) as string[][];
  expect(CASES.map(([file, code], index) => [file, code, reported[index]])).toEqual(CASES);
}, 60_000);
