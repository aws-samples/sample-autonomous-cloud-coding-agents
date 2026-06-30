#!/usr/bin/env node
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
 * Dead-code ratchet for the TS project graph (issue #282, cairn MVG gate #6).
 *
 * knip has no native baseline file, so this wraps it: run knip in JSON mode,
 * count the issues, and compare against the committed baseline in
 * `knip-baseline.json`. The build fails only when the count *increases* — the
 * cairn "dead-code count should not increase" metric. When the count drops
 * (someone cleaned up), it prints the new lower number so the baseline can be
 * tightened in the same PR.
 *
 * Counted categories mirror what knip surfaces for this repo today (unused
 * files, dependencies, unlisted, binaries, exports, types, enum/class members).
 * Per-category false positives are suppressed in `knip.json`, not here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(repoRoot, 'knip-baseline.json');

const COUNTED_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'types',
  'nsExports',
  'nsTypes',
  'duplicates',
  'enumMembers',
  'classMembers',
];

function runKnip() {
  const knipBin = join(repoRoot, 'node_modules', '.bin', 'knip');
  // knip exits non-zero when it finds issues; that is expected here — we parse
  // its JSON regardless and decide pass/fail from the count vs. the baseline.
  let stdout;
  try {
    stdout = execFileSync(knipBin, ['--reporter', 'json', '--no-progress'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    stdout = err.stdout?.toString() ?? '';
    if (!stdout.trim()) {
      console.error('check-deadcode-ratchet: knip produced no JSON output.');
      console.error(err.stderr?.toString() ?? String(err));
      process.exit(2);
    }
  }
  return JSON.parse(stdout);
}

function countIssues(report) {
  let total = (report.files ?? []).length;
  for (const issue of report.issues ?? []) {
    for (const key of COUNTED_KEYS) {
      if (Array.isArray(issue[key])) total += issue[key].length;
    }
  }
  return total;
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).count;
const current = countIssues(runKnip());

if (current > baseline) {
  console.error(
    `❌ Dead-code count increased: ${current} (baseline ${baseline}, +${current - baseline}).`,
  );
  console.error('   Run `yarn knip` to see the new findings, then remove the dead code.');
  console.error('   If a finding is a false positive, suppress it in knip.json (not the baseline).');
  process.exit(1);
}

if (current < baseline) {
  console.log(
    `✅ Dead-code count dropped to ${current} (baseline ${baseline}). ` +
      `Lower the "count" in knip-baseline.json to ${current} to ratchet it down.`,
  );
  process.exit(0);
}

console.log(`✅ Dead-code count holding at baseline (${current}).`);
process.exit(0);
