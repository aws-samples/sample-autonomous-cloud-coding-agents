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

import * as path from 'path';
import { buildSync } from 'esbuild';

/**
 * The runtime/construct layering boundary, enforced by actually bundling.
 *
 * A runtime handler that imports from `src/constructs/` can pull all of
 * `aws-cdk-lib` into its deploy artifact, because several construct modules evaluate
 * CDK values at module top level and esbuild cannot tree-shake a module whose top
 * level `require`s the library. `aws-cdk-lib` appears in no construct's
 * `externalModules` (only `@aws-sdk/*` does), so nothing downstream strips it.
 *
 * This is not theoretical. `handlers/shared/workflows.ts` imported two constants from
 * `constructs/bedrock-models.ts`, whose geography list was
 * `Object.values(CrossRegionInferenceProfileRegion)` — a runtime read of an alpha-CDK
 * enum. Measured effect on `workflows.ts` alone: **6.8 KB and zero `aws-cdk-lib`
 * references became 57 MB and 9,679**, on every Lambda that reaches it — the
 * orchestrator, create-task, webhook create-task, the Slack/Linear/Jira webhook
 * processors and the reconcilers. Nothing failed: synth passed, CI passed, and there
 * is no bundle-size gate. The fix was to move the values into a dependency-free
 * module; this test is what stops the import from creeping back.
 *
 * Bundling is genuinely slow (multi-second), so the entry list is deliberately short:
 * the shared modules a control-plane Lambda is most likely to reach.
 */
describe('runtime handlers do not bundle aws-cdk-lib', () => {
  const repoCdkRoot = path.resolve(__dirname, '../../..');

  /** Bundle one entry the way the CDK does, and report size + CDK references. */
  function bundle(relEntry: string): { bytes: number; cdkRefs: number } {
    const result = buildSync({
      entryPoints: [path.join(repoCdkRoot, relEntry)],
      bundle: true,
      write: false,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      logLevel: 'silent',
      // Mirrors the constructs' own bundling options: only the SDK is external.
      external: ['@aws-sdk/*'],
    });
    const text = result.outputFiles[0].text;
    return {
      bytes: Buffer.byteLength(text, 'utf8'),
      cdkRefs: (text.match(/aws-cdk-lib/g) ?? []).length,
    };
  }

  // 1 MB is far above any legitimate handler bundle (`workflows.ts` is ~6 KB) and far
  // below the failure mode (~57 MB), so it distinguishes them without being a
  // size-creep ratchet that fails on ordinary growth.
  const CDK_LEAK_BYTES = 1_000_000;

  it.each([
    'src/handlers/shared/workflows.ts',
    'src/handlers/shared/bedrock-model-constants.ts',
  ])('%s bundles without pulling in the CDK', (entry) => {
    const { bytes, cdkRefs } = bundle(entry);
    // Reference count first: it names the actual defect, so the failure message is
    // "you imported the CDK" rather than "this file got big".
    expect(cdkRefs).toBe(0);
    expect(bytes).toBeLessThan(CDK_LEAK_BYTES);
  }, 60_000);

  it('the constants module imports nothing from the construct layer', () => {
    // A cheap static backstop for the same rule. It catches a construct import that
    // happens not to bundle the CDK today but would the moment that construct grows
    // a top-level CDK evaluation — the exact shape of the original regression.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const src = fs.readFileSync(
      path.join(repoCdkRoot, 'src/handlers/shared/bedrock-model-constants.ts'), 'utf8',
    );
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.filter((i) => i.includes('constructs/') || i.includes('aws-cdk'))).toEqual([]);
    // It should import nothing at all, in fact — it is pure data plus one helper.
    expect(imports).toEqual([]);
  });
});
