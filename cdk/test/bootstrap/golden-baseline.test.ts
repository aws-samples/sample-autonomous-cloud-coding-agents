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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Stack } from 'aws-cdk-lib';

import { applicationPolicy, infrastructurePolicy, observabilityPolicy } from '../../src/bootstrap/policies';

/**
 * Extracts all ```json ... ``` fenced code blocks from a markdown string.
 */
function extractJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

interface NormalizedStatement {
  sid: string;
  actions: string[];
  resources: string[];
}

/**
 * Normalizes policy statements for comparison by sorting actions and resources.
 */
function normalizeStatements(
  statements: Array<{ Sid?: string; Action?: string | string[]; Resource?: string | string[] }>,
): NormalizedStatement[] {
  return statements.map((s) => {
    const actions = Array.isArray(s.Action) ? [...s.Action] : [s.Action ?? ''];
    const resources = Array.isArray(s.Resource) ? [...s.Resource] : [s.Resource ?? ''];
    return {
      sid: s.Sid ?? '',
      actions: actions.sort(),
      resources: resources.sort(),
    };
  });
}

describe('Golden-file parity: TypeScript policies match DEPLOYMENT_ROLES.md', () => {
  const stack = new Stack();

  // Read the source-of-truth markdown
  const markdownPath = join(__dirname, '..', '..', '..', 'docs', 'design', 'DEPLOYMENT_ROLES.md');
  const markdown = readFileSync(markdownPath, 'utf-8');

  // Extract JSON blocks: [0]=trust, [1]=infrastructure, [2]=application, [3]=observability, [4]=ECS
  const jsonBlocks = extractJsonBlocks(markdown);
  const goldenInfra = JSON.parse(jsonBlocks[1]);
  const goldenApp = JSON.parse(jsonBlocks[2]);
  const goldenObs = JSON.parse(jsonBlocks[3]);

  // Resolve TypeScript policies via CDK Stack
  const tsInfra = stack.resolve(infrastructurePolicy());
  const tsApp = stack.resolve(applicationPolicy());
  const tsObs = stack.resolve(observabilityPolicy());

  const testCases: Array<{
    name: string;
    golden: { Statement: Array<Record<string, unknown>> };
    typescript: { Statement: Array<Record<string, unknown>> };
  }> = [
    { name: 'Infrastructure', golden: goldenInfra, typescript: tsInfra },
    { name: 'Application', golden: goldenApp, typescript: tsApp },
    { name: 'Observability', golden: goldenObs, typescript: tsObs },
  ];

  for (const { name, golden, typescript } of testCases) {
    describe(`${name} policy`, () => {
      const goldenNorm = normalizeStatements(
        golden.Statement as Array<{ Sid?: string; Action?: string | string[]; Resource?: string | string[] }>,
      );
      const tsNorm = normalizeStatements(
        typescript.Statement as Array<{ Sid?: string; Action?: string | string[]; Resource?: string | string[] }>,
      );

      it('has the same SIDs in the same order', () => {
        const goldenSids = goldenNorm.map((s) => s.sid);
        const tsSids = tsNorm.map((s) => s.sid);
        expect(tsSids).toEqual(goldenSids);
      });

      it('has identical actions per statement (sorted)', () => {
        for (let i = 0; i < goldenNorm.length; i++) {
          expect(tsNorm[i].actions).toEqual(goldenNorm[i].actions);
        }
      });

      it('has identical resources per statement (sorted)', () => {
        for (let i = 0; i < goldenNorm.length; i++) {
          expect(tsNorm[i].resources).toEqual(goldenNorm[i].resources);
        }
      });
    });
  }
});
