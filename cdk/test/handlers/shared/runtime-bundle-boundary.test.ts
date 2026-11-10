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

import * as fs from 'fs';
import * as path from 'path';
import { buildSync, type Metafile } from 'esbuild';

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
 * It then crept back where this test was not looking. The test bundled two shared
 * modules; eight imports of a string constant from three other construct modules put
 * the library into 11 Lambda bundles while it stayed green. So it now bundles every
 * entrypoint. A clean bundle takes about 10 ms, the whole list under a second.
 */
describe('runtime handlers do not bundle aws-cdk-lib', () => {
  const repoCdkRoot = path.resolve(__dirname, '../../..');
  const handlersDir = path.join(repoCdkRoot, 'src/handlers');

  /**
   * Every Lambda entrypoint: each `NodejsFunction` takes its `entry` from this directory,
   * as `<name>.ts` or `<name>/index.ts`. Everything outside `shared/` counts as one; a
   * file that is only a helper for an entrypoint gets bundled on its own as well, which
   * is cheaper than telling the two apart.
   */
  const entrypoints = fs.readdirSync(handlersDir, { recursive: true, encoding: 'utf8' })
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => rel.endsWith('.ts') && !rel.startsWith('shared/'))
    .map((rel) => `src/handlers/${rel}`)
    .sort();

  /**
   * What the real build keeps out of a bundle. Each `NodejsFunction` passes its own list,
   * so this is their union: `externalModules` is `@aws-sdk/*`, part of it or empty,
   * `nodeModules: ['pdf-parse']` ships pdf-parse beside the bundle, and get-policies takes
   * cedar-wasm from a layer. A function that bundles some of the SDK is still covered,
   * because no SDK package imports the CDK. Only list what the constructs list: anything
   * else stays in the real bundle whatever this test says.
   */
  const EXTERNAL = ['@aws-sdk/*', 'pdf-parse', '@cedar-policy/cedar-wasm', '@cedar-policy/cedar-wasm/nodejs'];

  /** `aws-cdk-lib` and `constructs`, wherever module resolution found them. */
  const CDK_MODULE = /(^|\/)node_modules\/(aws-cdk-lib|constructs)\//;

  // 1 MB is above every handler bundle built this way (the largest,
  // `github-webhook-processor.ts`, is 0.63 MB) and far below the failure mode (~57 MB).
  // It is a second net under the CDK check: for a heavyweight import that is not the
  // CDK, and for the day the path match above stops matching.
  const CDK_LEAK_BYTES = 1_000_000;

  /** Bundle one entry the way the CDK does (`esbuild --bundle --target=node24 --platform=node`). */
  function bundle(relEntry: string): { bytes: number; metafile: Metafile } {
    const result = buildSync({
      entryPoints: [relEntry],
      absWorkingDir: repoCdkRoot, // metafile paths are relative to this
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      logLevel: 'silent',
      external: EXTERNAL,
    });
    return { bytes: result.outputFiles[0].contents.byteLength, metafile: result.metafile };
  }

  /** `:<line>` of the first line of `file` that quotes `specifier`, or '' when none does. */
  function lineOf(file: string, specifier: string): string {
    const lines = fs.readFileSync(path.join(repoCdkRoot, file), 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes(`'${specifier}'`) || line.includes(`"${specifier}"`));
    return index < 0 ? '' : `:${index + 1}`;
  }

  /**
   * Shortest import chain from the entry to the first bundled file matching `isTarget`,
   * one `file:line imports 'specifier'` step per hop. Empty when no such file is bundled.
   */
  function importChain(inputs: Metafile['inputs'], entry: string, isTarget: (file: string) => boolean): string[] {
    const importedBy = new Map<string, { importer: string; specifier: string } | undefined>([[entry, undefined]]);
    const queue = [entry];
    for (const importer of queue) { // breadth-first: the loop also visits what it appends
      for (const { path: file, original, external } of inputs[importer].imports) {
        if (external || importedBy.has(file)) continue;
        importedBy.set(file, { importer, specifier: original ?? file });
        if (isTarget(file)) {
          const steps: string[] = [];
          for (let hop = importedBy.get(file); hop; hop = importedBy.get(hop.importer)) {
            steps.unshift(`    ${hop.importer}${lineOf(hop.importer, hop.specifier)} imports '${hop.specifier}'`);
          }
          return steps;
        }
        queue.push(file);
      }
    }
    return [];
  }

  /** What is wrong with the bundle of `relEntry`, how it got there and what to do; undefined when it is clean. */
  function bundleProblem(relEntry: string): string | undefined {
    const { bytes, metafile } = bundle(relEntry);
    // The CDK first: it names the actual defect, so the failure message is
    // "you imported the CDK" rather than "this file got big".
    const cdkFiles = Object.keys(metafile.inputs).filter((file) => CDK_MODULE.test(file));
    if (cdkFiles.length > 0) {
      return [
        `${relEntry} bundles the CDK into its Lambda (${cdkFiles.length} files of aws-cdk-lib/constructs), imported through:`,
        ...importChain(metafile.inputs, relEntry, (file) => CDK_MODULE.test(file)),
        'Lambda runtime code must not import a module that imports aws-cdk-lib or constructs: esbuild',
        'cannot tree-shake the library, so the function ships and loads all of it. Move what the handler',
        'needs into a module under src/handlers/shared/ that imports neither (see storage-names.ts) and',
        'import it from there in both the handler and the construct.',
      ].join('\n');
    }
    if (bytes >= CDK_LEAK_BYTES) {
      const [[largest, { bytesInOutput }]] = Object.entries(Object.values(metafile.outputs)[0].inputs)
        .sort(([, a], [, b]) => b.bytesInOutput - a.bytesInOutput);
      return [
        `${relEntry} bundles to ${bytes} bytes; the limit is ${CDK_LEAK_BYTES} with ${EXTERNAL.join(', ')} external.`,
        `Largest input: ${largest} (${bytesInOutput} bytes), imported through:`,
        ...importChain(metafile.inputs, relEntry, (file) => file === largest),
        'Drop the import if Lambda runtime code does not need that package. If the constructs ship it',
        'outside the bundle (`nodeModules` or `externalModules` in the bundling options), list it in',
        'EXTERNAL in this test as well.',
      ].join('\n');
    }
    return undefined;
  }

  it.each(entrypoints)('%s bundles without pulling in the CDK', (entry) => {
    expect(bundleProblem(entry)).toBeUndefined();
  }, 60_000);

  it('reports the CDK, with the import chain, when a construct module is bundled', () => {
    // The control for the cases above. If the CDK stopped being detected (a change in
    // esbuild's metafile or the node_modules layout, the CDK added to EXTERNAL), every
    // entrypoint would pass vacuously; this fails instead.
    const problem = bundleProblem('src/constructs/trace-artifacts-bucket.ts');
    expect(problem).toContain('bundles the CDK into its Lambda');
    expect(problem).toMatch(/src\/constructs\/trace-artifacts-bucket\.ts:\d+ imports 'aws-cdk-lib'/);
  }, 60_000);

  it('the constants module imports nothing from the construct layer', () => {
    // A cheap static backstop for the same rule. It catches a construct import that
    // happens not to bundle the CDK today but would the moment that construct grows
    // a top-level CDK evaluation — the exact shape of the original regression.
    const src = fs.readFileSync(
      path.join(repoCdkRoot, 'src/handlers/shared/bedrock-model-constants.ts'), 'utf8',
    );
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.filter((i) => i.includes('constructs/') || i.includes('aws-cdk'))).toEqual([]);
    // It should import nothing at all, in fact — it is pure data plus one helper.
    expect(imports).toEqual([]);
  });
});
