#!/usr/bin/env -S node --experimental-strip-types
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
 * Cross-language constants drift check (S9).
 *
 * ``contracts/constants.json`` is the single source of truth for
 * constants shared across Python (agent runtime) and TypeScript (CDK +
 * CLI). This script catches the failure mode that the contract is
 * designed to prevent: someone re-introducing a literal declaration of
 * one of these constants in code.
 *
 * The TypeScript side is enforced by the compiler — every consumer
 * imports the JSON via ``resolveJsonModule``, so a missing or renamed
 * field fails ``tsc``. The Python side has no equivalent; this script
 * walks ``agent/src/policy.py`` and rejects any line that assigns a
 * known constant name to a numeric literal instead of reading the
 * JSON.
 *
 * Run via ``mise run check:constants-sync`` or
 * ``node --experimental-strip-types scripts/check-constants-sync.ts``.
 *
 * Exit 0 on success, 1 on drift.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CONSTANTS_JSON = path.join(REPO_ROOT, 'contracts/constants.json');
const POLICY_PY = path.join(REPO_ROOT, 'agent/src/policy.py');

/**
 * Constant names that ``contracts/constants.json`` owns and the
 * pre-compiled regex that catches their literal assignment in any
 * consumer file.  Each pattern matches ``NAME = 50`` and
 * ``NAME: int = 50`` styles; the regex literals are hard-coded (not
 * built from string concatenation) so semgrep's
 * ``detect-non-literal-regexp`` rule is satisfied without an exception.
 */
const OWNED_PYTHON_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'DEFAULT_APPROVAL_GATE_CAP', regex: /^\s*DEFAULT_APPROVAL_GATE_CAP\s*(?::\s*int)?\s*=\s*-?\d+\b/m },
  { name: 'APPROVAL_GATE_CAP_MIN', regex: /^\s*APPROVAL_GATE_CAP_MIN\s*(?::\s*int)?\s*=\s*-?\d+\b/m },
  { name: 'APPROVAL_GATE_CAP_MAX', regex: /^\s*APPROVAL_GATE_CAP_MAX\s*(?::\s*int)?\s*=\s*-?\d+\b/m },
];

interface Drift {
  readonly file: string;
  readonly name: string;
  readonly line: string;
}

function findDriftInPython(filePath: string): Drift[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const lines = source.split('\n');
  const drifts: Drift[] = [];
  for (const { name, regex } of OWNED_PYTHON_PATTERNS) {
    for (const line of lines) {
      if (regex.test(line)) {
        drifts.push({ file: filePath, name, line: line.trim() });
      }
    }
  }
  return drifts;
}

function main(): number {
  // Sanity: confirm the JSON is parseable and shaped as expected.
  let json: { approval_gate_cap?: { min: number; max: number; default: number } };
  try {
    json = JSON.parse(fs.readFileSync(CONSTANTS_JSON, 'utf-8'));
  } catch (err) {
    console.error(`Cannot read ${CONSTANTS_JSON}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const agc = json.approval_gate_cap;
  if (!agc || typeof agc.min !== 'number' || typeof agc.max !== 'number' || typeof agc.default !== 'number') {
    console.error(`${CONSTANTS_JSON} is missing approval_gate_cap.{min,max,default}`);
    return 1;
  }

  const drifts = findDriftInPython(POLICY_PY);

  if (drifts.length > 0) {
    console.error('Cross-language constants drift detected:\n');
    for (const d of drifts) {
      console.error(
        `  - ${path.relative(REPO_ROOT, d.file)}: "${d.name}" assigned to a literal:\n` +
          `      ${d.line}\n` +
          `    Read from contracts/constants.json instead (see contracts/constants.md).`,
      );
    }
    console.error(`\n${drifts.length} drift issue(s) found.`);
    return 1;
  }

  console.log(
    `Constants sync OK: contracts/constants.json validated; ` +
      `${OWNED_PYTHON_PATTERNS.length} Python names checked in ${path.relative(REPO_ROOT, POLICY_PY)}.`,
  );
  return 0;
}

process.exit(main());
