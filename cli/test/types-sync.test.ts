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
 * Rev-5 TDA-4: cross-file type-drift detection.
 *
 * `ExecutionMode` + `ApiErrorCode` are duplicated between
 * `cdk/src/handlers/shared/types.ts` and `cli/src/types.ts` pending a
 * shared-types workspace (tracked in `PHASE_1B_REV5_FOLLOWUPS.md`).
 * This test parses the raw source of the CDK types file and asserts it
 * declares the same string values as the CLI side.
 *
 * The test is intentionally string-based rather than type-level —
 * TypeScript can't see the CDK file from a CLI jest run (different
 * tsconfig paths), so we grep the file text. A future codegen /
 * workspace move renders this obsolete and the test can be deleted.
 */

import * as fs from 'fs';
import * as path from 'path';

const CDK_TYPES_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'cdk',
  'src',
  'handlers',
  'shared',
  'types.ts',
);

function readCdkTypesSource(): string {
  return fs.readFileSync(CDK_TYPES_PATH, 'utf-8');
}

/** Extract the string literals of a `type X = 'a' | 'b' | ...` declaration. */
function extractUnionLiterals(source: string, typeName: string): string[] {
  const match = source.match(
    new RegExp(`export type ${typeName}\\s*=([^;]+);`, 'm'),
  );
  if (!match) return [];
  const body = match[1];
  return Array.from(body.matchAll(/'([^']+)'/g)).map(m => m[1]).sort();
}

describe('Rev-5 TDA-4: cross-file type drift detection', () => {
  test('ExecutionMode union has the same members in CDK and CLI', () => {
    // CLI canonical (ExecutionMode is a pure type so there's no runtime
    // value to import — check against the grep-extracted CDK list).
    const cliExpected = ['interactive', 'orchestrator'];
    const cdkActual = extractUnionLiterals(readCdkTypesSource(), 'ExecutionMode');
    expect(cdkActual).toEqual(cliExpected);
    // Bonus: also grep CLI types.ts to catch drift in the other direction.
    const cliTypesPath = path.resolve(__dirname, '..', 'src', 'types.ts');
    const cliActual = extractUnionLiterals(fs.readFileSync(cliTypesPath, 'utf-8'), 'ExecutionMode');
    expect(cliActual).toEqual(cliExpected);
  });

  test('ApiErrorCode union has the same members in CDK and CLI', async () => {
    // CLI canonical list (alphabetised for stable comparison):
    const cliExpected = [
      'RUN_ELSEWHERE',
      'SSE_ATTACH_RACE',
      'TASK_RECORD_INCOMPLETE',
      'TASK_STATE_UNAVAILABLE',
    ].sort();
    const cdkActual = extractUnionLiterals(readCdkTypesSource(), 'ApiErrorCode');
    expect(cdkActual).toEqual(cliExpected);
  });
});
