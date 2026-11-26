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

/**
 * pdf-parse (v2, pdfjs-based) CANNOT be esbuild-bundled — its pdfjs/@napi-rs/canvas
 * deps break at runtime.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HANDLERS_DIR = path.join(REPO_ROOT, 'cdk', 'src', 'handlers');
const CONSTRUCTS_DIR = path.join(REPO_ROOT, 'cdk', 'src', 'constructs');

const SCREENING_MODULE = 'attachment-screening';

function read(file: string): string {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function importsOf(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function reachesScreening(entry: string): boolean {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (path.basename(file) === `${SCREENING_MODULE}.ts`) return true;
    for (const spec of importsOf(read(file))) {
      const resolved = resolveImport(file, spec);
      if (resolved) stack.push(resolved);
    }
  }
  return false;
}

describe('pdf-parse bundling contract', () => {
  const entryHandlers = fs.readdirSync(HANDLERS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(HANDLERS_DIR, f));

  const pdfHandlers = entryHandlers.filter(reachesScreening).map((f) => path.basename(f));

  test('the screening-path handler set is non-empty (guard is actually testing something)', () => {
    expect(pdfHandlers.length).toBeGreaterThan(0);
    expect(pdfHandlers).toEqual(expect.arrayContaining([
      'linear-webhook-processor.ts',
      'jira-webhook-processor.ts',
      'orchestration-reconciler.ts',
    ]));
  });

  const constructFiles = fs.readdirSync(CONSTRUCTS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(CONSTRUCTS_DIR, f));

  for (const constructFile of constructFiles) {
    const src = read(constructFile);
    const referenced = pdfHandlers.filter((h) => src.includes(h));
    if (referenced.length === 0) continue;

    test(`${path.basename(constructFile)} bundles a PDF-screening handler (${referenced.join(', ')}) → must carve out pdf-parse`, () => {
      const hasCarveOut = /nodeModules\s*:\s*\[[^\]]*['"]pdf-parse['"]/.test(src);
      expect(hasCarveOut).toBe(true);
    });
  }
});
