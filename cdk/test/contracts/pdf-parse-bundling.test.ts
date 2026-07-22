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
 * BUNDLING CONTRACT (ABCA-745): pdf-parse (v2, pdfjs-based) CANNOT be
 * esbuild-bundled — its pdfjs/@napi-rs/canvas deps break at runtime. Any Lambda
 * whose handler transitively reaches `attachment-screening.extractPdfText` MUST
 * ship pdf-parse unbundled via `nodeModules: ['pdf-parse']`, or every PDF
 * attachment fails at runtime ("could not be processed") while passing every
 * unit test — a deploy-only bug that has bitten twice (the initial no-MCP
 * webhook path, then the decompose-seed path on the reconciler).
 *
 * This test makes that invariant STRUCTURAL: it walks the handler import graph
 * to find every entry point that reaches `attachment-screening`, maps each to
 * the construct(s) that bundle it, and asserts the construct declares the
 * pdf-parse carve-out. A new handler/construct on the screening path fails here
 * at build time instead of silently in production.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HANDLERS_DIR = path.join(REPO_ROOT, 'cdk', 'src', 'handlers');
const CONSTRUCTS_DIR = path.join(REPO_ROOT, 'cdk', 'src', 'constructs');

/** The module whose PDF path (`extractPdfText`) requires the carve-out. */
const SCREENING_MODULE = 'attachment-screening';

/** Read a source file, or '' if it doesn't exist. */
function read(file: string): string {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

/** Resolve a relative import specifier from a file to an on-disk .ts path. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // node_module — not our graph
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/** Extract the relative import specifiers from a TS source file. */
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

/** Does `entry` transitively import the screening module? (DFS over local imports.) */
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

describe('pdf-parse bundling contract (ABCA-745)', () => {
  // Entry-point handlers = the top-level *.ts in handlers/ (not shared/).
  const entryHandlers = fs.readdirSync(HANDLERS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(HANDLERS_DIR, f));

  // The subset whose bundle reaches extractPdfText → needs the carve-out.
  const pdfHandlers = entryHandlers.filter(reachesScreening).map((f) => path.basename(f));

  test('the screening-path handler set is non-empty (guard is actually testing something)', () => {
    // If this ever hits zero, the import-walk broke — fail rather than pass vacuously.
    expect(pdfHandlers.length).toBeGreaterThan(0);
    // Sanity: the known screeners are in the set.
    expect(pdfHandlers).toEqual(expect.arrayContaining([
      'linear-webhook-processor.ts',
      'jira-webhook-processor.ts',
      'orchestration-reconciler.ts',
    ]));
  });

  const constructFiles = fs.readdirSync(CONSTRUCTS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(CONSTRUCTS_DIR, f));

  // For each construct that references a PDF-path handler by entry filename,
  // assert its source declares the pdf-parse carve-out.
  for (const constructFile of constructFiles) {
    const src = read(constructFile);
    const referenced = pdfHandlers.filter((h) => src.includes(h));
    if (referenced.length === 0) continue;

    test(`${path.basename(constructFile)} bundles a PDF-screening handler (${referenced.join(', ')}) → must carve out pdf-parse`, () => {
      // The carve-out: `nodeModules` including 'pdf-parse' somewhere in the file.
      // (All our constructs express it as `nodeModules: ['pdf-parse']` or spread
      // a bundling object that has it — a substring check is enough + robust.)
      const hasCarveOut = /nodeModules\s*:\s*\[[^\]]*['"]pdf-parse['"]/.test(src);
      expect(hasCarveOut).toBe(true);
    });
  }
});
