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

import { ESLint } from 'eslint';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rules below are selectors and path patterns written by hand in eslint.config.mjs. One
 * that matches nothing is still valid and lint passes, so each row lints a snippet as the
 * named file with the real config and lists the rules that must report it: none where the
 * snippet has to stay legal.
 */
const CASES: Array<[file: string, code: string, rules: string[]]> = [
  // A test that is skipped, focused, left as a todo or expected to fail.
  ['test/a.test.ts', "it.skip('name', () => {});", ['no-restricted-syntax']],
  ['test/a.test.ts', "describe.only('name', () => {});", ['no-restricted-syntax']],
  ['test/a.test.ts', "it.concurrent.only('name', () => {});", ['no-restricted-syntax']],
  ['test/a.test.ts', "it.skip.each([1])('name %i', () => {});", ['no-restricted-syntax']],
  ['test/a.test.ts', "it('name', { skip: true }, () => {});", ['no-restricted-syntax']],
  ['test/a.test.ts', "it.each([1])('name %i', { fails: true }, () => {});", ['no-restricted-syntax']],
  ['test/a.test.ts', "it('name', (ctx) => { ctx.skip(); });", ['no-restricted-syntax']],
  ['test/a.test.ts', "it('name', ({ skip }) => { skip(); });", ['no-restricted-syntax']],
  ['test/a.test.ts', "it('name');", ['no-restricted-syntax']],
  ['test/a.test.ts', "it.each([1])('name %i', { timeout: 5 }, () => {});", []],
  // src/mocks and the test helpers stay out of the production bundle.
  ['src/domains/a.ts', "import '../mocks/browser';", ['no-restricted-imports']],
  ['src/domains/a.ts', "void import('../mocks/browser');", ['no-restricted-syntax']],
  ['src/domains/a.ts', "if (__MOCK__) { void import('../mocks/browser'); }", []],
  ['src/domains/a.ts', 'void import(`../mocks/${name}.ts`);', ['no-restricted-syntax']],
  ['src/domains/a.ts', "export const all = import.meta.glob('../mocks/*.ts');", ['no-restricted-syntax']],
  ['src/domains/a.ts', "import '../../test/helpers/server';", ['no-restricted-imports']],
  ['src/domains/a.ts', "void import('../../test/helpers/server');", ['no-restricted-syntax']],
  // core does not import domains, and repeats the rules of src.
  ['src/core/a.ts', "import '../domains/tasks/hooks';", ['no-restricted-imports']],
  ['src/core/a.ts', "void import('../domains/tasks/hooks');", ['no-restricted-syntax']],
  ['src/core/a.ts', "import '../mocks/browser';", ['no-restricted-imports']],
  ['src/core/a.ts', "export const all = import.meta.glob('./*.ts');", ['no-restricted-syntax']],
  // A Cloudscape component comes from its own module.
  ['src/app/a.tsx', "import '@cloudscape-design/components';", ['no-restricted-imports']],
  ['src/app/a.tsx', "import '@cloudscape-design/components/button';", []],
  // A comment that takes code out of the coverage report.
  ['src/core/a.ts', '/* v8 ignore next */', ['no-warning-comments']],
];
const RULES = new Set(CASES.flatMap(([, , rules]) => rules));

const eslint = new ESLint({
  cwd: dirname(dirname(fileURLToPath(import.meta.url))),
  overrideConfigFile: 'eslint.config.mjs',
  // Only the rules under test and no type information: the snippets are not project files.
  ruleFilter: ({ ruleId }) => RULES.has(ruleId),
  overrideConfig: [{ files: ['**/*.{ts,tsx}'], languageOptions: { parserOptions: { projectService: false } } }],
});

describe('eslint.config.mjs', () => {
  it.each(CASES)('%s: %s', async (file, code, rules) => {
    const [result] = await eslint.lintText(code, { filePath: file });
    expect(result.messages.map((message) => message.ruleId)).toEqual(rules);
  });
});
