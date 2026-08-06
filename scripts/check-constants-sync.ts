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
 * The CDK TypeScript side is enforced by the compiler: consumers import
 * the JSON via ``resolveJsonModule``, so a missing or renamed field fails
 * ``tsc``. The Python side has no equivalent, so this script walks the
 * agent consumers and rejects known constants assigned to numeric or
 * string literals instead of reading the JSON. The published CLI's
 * package-safe mirrors are covered by ``cli/test/constants-parity.test.ts``.
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
const JIRA_REACTIONS_PY = path.join(REPO_ROOT, 'agent/src/jira_reactions.py');
const PYTHON_CONSUMERS = [POLICY_PY, JIRA_REACTIONS_PY];

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
  { name: 'FLOOR_TIMEOUT_S', regex: /^\s*FLOOR_TIMEOUT_S\s*(?::\s*int)?\s*=\s*-?\d+\b/m },
  { name: 'DEFAULT_TASK_TIMEOUT_S', regex: /^\s*DEFAULT_TASK_TIMEOUT_S\s*(?::\s*int)?\s*=\s*-?\d+\b/m },
  { name: 'APP_ACTOR_MIN_SECRET_LENGTH', regex: /^\s*APP_ACTOR_MIN_SECRET_LENGTH\s*(?::\s*int)?\s*=\s*\d+\b/m },
  { name: 'FORGE_WEBTRIGGER_SUFFIX', regex: /^\s*FORGE_WEBTRIGGER_SUFFIX\s*(?::\s*str)?\s*=\s*["']/m },
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
  let json: {
    approval_gate_cap?: { min: number; max: number; default: number };
    approval_timeout_s?: { min: number; max: number; default: number };
    jira_app_actor?: { min_secret_length: number; forge_webtrigger_suffix: string };
  };
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

  const ats = json.approval_timeout_s;
  if (!ats || typeof ats.min !== 'number' || typeof ats.max !== 'number' || typeof ats.default !== 'number') {
    console.error(`${CONSTANTS_JSON} is missing approval_timeout_s.{min,max,default}`);
    return 1;
  }
  const jiraAppActor = json.jira_app_actor;
  if (
    !jiraAppActor
    || typeof jiraAppActor.min_secret_length !== 'number'
    || typeof jiraAppActor.forge_webtrigger_suffix !== 'string'
  ) {
    console.error(
      `${CONSTANTS_JSON} is missing ` +
      'jira_app_actor.{min_secret_length,forge_webtrigger_suffix}',
    );
    return 1;
  }

  // Semantic invariants (belt-and-suspenders — agent also validates at import time)
  const invariantErrors: string[] = [];
  if (agc.min <= 0) invariantErrors.push('approval_gate_cap.min must be > 0');
  if (agc.default < agc.min) invariantErrors.push('approval_gate_cap.default must be >= min');
  if (agc.max < agc.default) invariantErrors.push('approval_gate_cap.max must be >= default');
  if (ats.min <= 0) invariantErrors.push('approval_timeout_s.min must be > 0');
  if (ats.default < ats.min) invariantErrors.push('approval_timeout_s.default must be >= min');
  if (ats.max < ats.default) invariantErrors.push('approval_timeout_s.max must be >= default');
  if (jiraAppActor.min_secret_length < 32) {
    invariantErrors.push('jira_app_actor.min_secret_length must be >= 32');
  }
  if (!jiraAppActor.forge_webtrigger_suffix.startsWith('.')) {
    invariantErrors.push('jira_app_actor.forge_webtrigger_suffix must start with "."');
  }

  if (invariantErrors.length > 0) {
    console.error(`Semantic invariant violations in ${CONSTANTS_JSON}:\n`);
    for (const e of invariantErrors) console.error(`  - ${e}`);
    return 1;
  }

  const drifts = PYTHON_CONSUMERS.flatMap(findDriftInPython);

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
      `${OWNED_PYTHON_PATTERNS.length} Python names checked across ` +
      `${PYTHON_CONSUMERS.length} consumers.`,
  );
  return 0;
}

process.exit(main());
