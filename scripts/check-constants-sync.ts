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
const SERVER_PY = path.join(REPO_ROOT, 'agent/src/server.py');
const PYTHON_CONSUMERS = [POLICY_PY, JIRA_REACTIONS_PY, SERVER_PY];
const MICROVM_COMPUTE_TS = path.join(REPO_ROOT, 'cdk/src/constructs/lambda-microvm-compute.ts');
const TS_CONSUMERS = [MICROVM_COMPUTE_TS];

/** Env var names must be UPPER_SNAKE — they are installed into a process env. */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/** ``platform_config`` wire keys are snake_case. */
const CONFIG_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Constant names that ``contracts/constants.json`` owns and the
 * pre-compiled regex that catches their literal assignment in any
 * consumer file.  Each pattern matches ``NAME = 50``, ``NAME: int = 50``
 * and ``NAME: float = 50.0`` styles; the regex literals are hard-coded
 * (not built from string concatenation) so semgrep's
 * ``detect-non-literal-regexp`` rule is satisfied without an exception.
 *
 * The annotation group accepts ``float`` as well as ``int`` deliberately. The
 * value half (``-?\d+\b``) already matches a float literal — ``\d+`` takes the
 * integral part and ``\b`` is satisfied by the following ``.`` — so an
 * unannotated ``NAME = 240.0`` was always caught; what a narrower group would
 * have missed is an *annotated* ``NAME: float = 240.0``. Widening costs nothing
 * and removes the only shape that could have slipped through.
 *
 * The two ``MICROVM_PLATFORM_CONFIG_*`` patterns are shaped differently: those
 * constants are a mapping and a set, so the drift they catch is a collection
 * LITERAL (``= {``, ``= [``, ``= frozenset({``) rather than a scalar. A
 * contract-sourced ``= dict(_CONTRACT["env_by_key"])`` does not match.
 */
const OWNED_PYTHON_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'DEFAULT_APPROVAL_GATE_CAP', regex: /^\s*DEFAULT_APPROVAL_GATE_CAP\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m },
  { name: 'APPROVAL_GATE_CAP_MIN', regex: /^\s*APPROVAL_GATE_CAP_MIN\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m },
  { name: 'APPROVAL_GATE_CAP_MAX', regex: /^\s*APPROVAL_GATE_CAP_MAX\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m },
  { name: 'FLOOR_TIMEOUT_S', regex: /^\s*FLOOR_TIMEOUT_S\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m },
  { name: 'DEFAULT_TASK_TIMEOUT_S', regex: /^\s*DEFAULT_TASK_TIMEOUT_S\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m },
  { name: 'APP_ACTOR_MIN_SECRET_LENGTH', regex: /^\s*APP_ACTOR_MIN_SECRET_LENGTH\s*(?::\s*(?:int|float))?\s*=\s*\d+\b/m },
  { name: 'FORGE_WEBTRIGGER_SUFFIX', regex: /^\s*FORGE_WEBTRIGGER_SUFFIX\s*(?::\s*str)?\s*=\s*["']/m },
  {
    name: 'MICROVM_PLATFORM_CONFIG_ENV_BY_KEY',
    regex: /^\s*MICROVM_PLATFORM_CONFIG_ENV_BY_KEY\s*(?::[^=]+)?=\s*(?:dict\()?\s*[[{]/m,
  },
  {
    name: 'MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS',
    regex: /^\s*MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS\s*(?::[^=]+)?=\s*(?:frozenset\(|set\()?\s*[[{]/m,
  },
  // ADR-021 P2: the `/ready` warm-up ceiling and the CDK-side `/ready` hook
  // timeout are a RELATIONSHIP (`warmup_total < ready_hook`), and a relationship
  // cannot be enforced from one side — so neither side may re-declare its half as
  // a literal. A contract-sourced `= _HOOK_BUDGETS["…"]` does not match.
  {
    name: '_READY_WARMUP_TOTAL_BUDGET_SECONDS',
    regex: /^\s*_READY_WARMUP_TOTAL_BUDGET_SECONDS\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m,
  },
  {
    name: '_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS',
    regex: /^\s*_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS\s*(?::\s*(?:int|float))?\s*=\s*-?\d+\b/m,
  },
];

/**
 * The TypeScript half of the same no-literal-redeclaration rule.
 *
 * `tsc` already catches a *renamed* contract field, but it cannot catch a
 * construct that stops reading the contract and goes back to
 * `const READY_HOOK_TIMEOUT_SECONDS = 300;` — which is exactly how the budget
 * invariant got asserted against a hardcoded copy in the first place. So the one
 * TypeScript consumer whose value is half of a cross-language invariant is checked
 * the same way the Python ones are.
 */
const OWNED_TS_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  {
    name: 'READY_HOOK_TIMEOUT_SECONDS',
    regex: /^\s*(?:export\s+)?const\s+READY_HOOK_TIMEOUT_SECONDS\s*(?::\s*number)?\s*=\s*-?\d+\b/m,
  },
];

interface Drift {
  readonly file: string;
  readonly name: string;
  readonly line: string;
}

function findDriftInPython(filePath: string): Drift[] {
  return findLiteralDrift(filePath, OWNED_PYTHON_PATTERNS);
}

function findDriftInTypeScript(filePath: string): Drift[] {
  return findLiteralDrift(filePath, OWNED_TS_PATTERNS);
}

function findLiteralDrift(
  filePath: string,
  patterns: ReadonlyArray<{ name: string; regex: RegExp }>,
): Drift[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const lines = source.split('\n');
  const drifts: Drift[] = [];
  for (const { name, regex } of patterns) {
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
    microvm_platform_config?: {
      env_by_key: Record<string, string>;
      required: string[];
      arn_keys: string[];
      account_anchor_key: string;
    };
    microvm_hook_budgets?: {
      ready_hook_timeout_seconds: number;
      warmup_total_budget_seconds: number;
      warmup_required_timeout_seconds: number;
    };
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

  // ADR-021 P2: the MicroVM `/run` hook installs `platform_config` into the
  // agent's process environment, so this block is BOTH a cross-language contract
  // (agent/src/server.py consumes it; the orchestrator's run-hook envelope
  // builder produces it) AND a security allowlist. A malformed entry here would
  // widen what the agent accepts into its env, so the shape is validated, not
  // just present.
  const mpc = json.microvm_platform_config;
  if (
    !mpc
    || typeof mpc.env_by_key !== 'object'
    || mpc.env_by_key === null
    || !Array.isArray(mpc.required)
  ) {
    console.error(
      `${CONSTANTS_JSON} is missing microvm_platform_config.{env_by_key,required}`,
    );
    return 1;
  }

  const envByKey = mpc.env_by_key;
  const configKeys = Object.keys(envByKey);
  if (configKeys.length === 0) {
    invariantErrors.push('microvm_platform_config.env_by_key must not be empty');
  }
  for (const key of configKeys) {
    if (!CONFIG_KEY_PATTERN.test(key)) {
      invariantErrors.push(`microvm_platform_config.env_by_key key "${key}" must be snake_case`);
    }
    const envName = envByKey[key];
    if (typeof envName !== 'string' || !ENV_NAME_PATTERN.test(envName)) {
      invariantErrors.push(
        `microvm_platform_config.env_by_key["${key}"] must be an UPPER_SNAKE env var name`,
      );
    }
  }
  const envNames = configKeys.map(key => envByKey[key]);
  if (new Set(envNames).size !== envNames.length) {
    invariantErrors.push(
      'microvm_platform_config.env_by_key maps two keys onto the same env var',
    );
  }
  if (mpc.required.length === 0) {
    invariantErrors.push('microvm_platform_config.required must not be empty');
  }
  for (const key of mpc.required) {
    if (!Object.hasOwn(envByKey, key)) {
      invariantErrors.push(
        `microvm_platform_config.required names "${key}", absent from env_by_key`,
      );
    }
  }
  if (new Set(mpc.required).size !== mpc.required.length) {
    invariantErrors.push('microvm_platform_config.required contains a duplicate');
  }

  // ARN pinning (ADR-021 P2, review B5). `arn_keys` names the values the agent
  // pins to its own partition/account before installing them into the env that
  // resolves credentials and fetches secrets; `account_anchor_key` names the ARN
  // that supplies the expected partition/account. Both are validated here as well
  // as at agent import time, because a malformed entry would silently WIDEN what
  // the agent accepts from a network payload.
  if (!Array.isArray(mpc.arn_keys) || mpc.arn_keys.length === 0) {
    invariantErrors.push('microvm_platform_config.arn_keys must be a non-empty array');
  } else {
    for (const key of mpc.arn_keys) {
      if (!Object.hasOwn(envByKey, key)) {
        invariantErrors.push(
          `microvm_platform_config.arn_keys names "${key}", absent from env_by_key`,
        );
      }
    }
    if (new Set(mpc.arn_keys).size !== mpc.arn_keys.length) {
      invariantErrors.push('microvm_platform_config.arn_keys contains a duplicate');
    }
    if (!mpc.arn_keys.includes(mpc.account_anchor_key)) {
      invariantErrors.push(
        'microvm_platform_config.account_anchor_key must be one of arn_keys',
      );
    }
  }
  // The anchor MUST be required, or a payload can disarm ARN pinning by simply
  // omitting the anchor.
  if (!mpc.required.includes(mpc.account_anchor_key)) {
    invariantErrors.push(
      'microvm_platform_config.account_anchor_key must also be listed in required — '
      + 'an optional anchor would make ARN pinning skippable by omission',
    );
  }

  // ADR-021 P2: `/ready` does real work (it warms the 225 MiB `claude` binary), so
  // the agent's warm-up ceiling and the CDK-declared hook timeout are coupled — the
  // warm-up MUST finish inside the budget the service holds the hook to, or a fix
  // for a runtime failure becomes a build failure. Both halves live here precisely
  // so the relationship is checkable; this is the check.
  const mhb = json.microvm_hook_budgets;
  const BUDGET_FIELDS = [
    'ready_hook_timeout_seconds',
    'warmup_total_budget_seconds',
    'warmup_required_timeout_seconds',
  ] as const;
  if (!mhb || BUDGET_FIELDS.some(field => !Number.isInteger(mhb[field]))) {
    console.error(
      `${CONSTANTS_JSON} is missing microvm_hook_budgets.{${BUDGET_FIELDS.join(',')}} ` +
      '(all must be integers)',
    );
    return 1;
  }
  for (const field of BUDGET_FIELDS) {
    if (mhb[field] <= 0) invariantErrors.push(`microvm_hook_budgets.${field} must be > 0`);
  }
  if (mhb.warmup_total_budget_seconds >= mhb.ready_hook_timeout_seconds) {
    invariantErrors.push(
      'microvm_hook_budgets.warmup_total_budget_seconds must be < ' +
      'ready_hook_timeout_seconds (/ready has to answer inside the hook budget)',
    );
  }
  if (mhb.warmup_required_timeout_seconds >= mhb.warmup_total_budget_seconds) {
    invariantErrors.push(
      'microvm_hook_budgets.warmup_required_timeout_seconds must be < ' +
      'warmup_total_budget_seconds (the required warm-up must leave the ' +
      'best-effort ones something to share)',
    );
  }

  if (invariantErrors.length > 0) {
    console.error(`Semantic invariant violations in ${CONSTANTS_JSON}:\n`);
    for (const e of invariantErrors) console.error(`  - ${e}`);
    return 1;
  }

  const drifts = [
    ...PYTHON_CONSUMERS.flatMap(findDriftInPython),
    ...TS_CONSUMERS.flatMap(findDriftInTypeScript),
  ];

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
      `${PYTHON_CONSUMERS.length} consumers, ` +
      `${OWNED_TS_PATTERNS.length} TypeScript name(s) across ` +
      `${TS_CONSUMERS.length} consumer(s).`,
  );
  return 0;
}

process.exit(main());
