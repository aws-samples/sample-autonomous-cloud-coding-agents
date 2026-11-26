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

describe('runtime handlers do not bundle aws-cdk-lib', () => {
  const repoCdkRoot = path.resolve(__dirname, '../../..');
  const handlersDir = path.join(repoCdkRoot, 'src/handlers');

  const entrypoints = fs.readdirSync(handlersDir, { recursive: true, encoding: 'utf8' })
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => rel.endsWith('.ts') && !rel.startsWith('shared/'))
    .map((rel) => `src/handlers/${rel}`)
    .sort();

  const EXTERNAL = ['@aws-sdk/*', 'pdf-parse', '@cedar-policy/cedar-wasm', '@cedar-policy/cedar-wasm/nodejs'];

  const CDK_MODULE = /(^|\/)node_modules\/(aws-cdk-lib|constructs)\//;

  // Measured: a bundle that pulls in aws-cdk-lib is about 57 MB.
  const CDK_LEAK_BYTES = 1_000_000;

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

  function lineOf(file: string, specifier: string): string {
    const lines = fs.readFileSync(path.join(repoCdkRoot, file), 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes(`'${specifier}'`) || line.includes(`"${specifier}"`));
    return index < 0 ? '' : `:${index + 1}`;
  }

  function importChain(inputs: Metafile['inputs'], entry: string, isTarget: (file: string) => boolean): string[] {
    const importedBy = new Map<string, { importer: string; specifier: string } | undefined>([[entry, undefined]]);
    const queue = [entry];
    for (const importer of queue) {
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

  function bundleProblem(relEntry: string): string | undefined {
    const { bytes, metafile } = bundle(relEntry);
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
    const problem = bundleProblem('src/constructs/trace-artifacts-bucket.ts');
    expect(problem).toContain('bundles the CDK into its Lambda');
    expect(problem).toMatch(/src\/constructs\/trace-artifacts-bucket\.ts:\d+ imports 'aws-cdk-lib'/);
  }, 60_000);

  it('the constants module imports nothing from the construct layer', () => {
    const src = fs.readFileSync(
      path.join(repoCdkRoot, 'src/handlers/shared/bedrock-model-constants.ts'), 'utf8',
    );
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.filter((i) => i.includes('constructs/') || i.includes('aws-cdk'))).toEqual([]);
    expect(imports).toEqual([]);
  });
});
