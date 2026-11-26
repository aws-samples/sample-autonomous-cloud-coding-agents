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
 * Cross-language constants drift check: fails when code declares a constant
 * that ``contracts/constants.json`` owns instead of reading it from the contract.
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
const AGENT_SRC = path.join(REPO_ROOT, 'agent/src');
const PARITY_TEST = 'agent/tests/test_constants_parity.py';
const MICROVM_COMPUTE_TS = path.join(REPO_ROOT, 'cdk/src/constructs/lambda-microvm-compute.ts');
const MICROVM_IMAGE_CAPABILITY_TS = path.join(REPO_ROOT, 'cdk/src/handlers/shared/microvm/image-capability.ts');
const MICROVM_STRATEGY_TS = path.join(REPO_ROOT, 'cdk/src/handlers/shared/strategies/lambda-microvm-strategy.ts');
const TS_CONSUMERS = [MICROVM_COMPUTE_TS, MICROVM_IMAGE_CAPABILITY_TS, MICROVM_STRATEGY_TS];

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CONFIG_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const OWNED_PYTHON_NAMES: ReadonlyMap<string, string> = new Map([
  ['DEFAULT_APPROVAL_GATE_CAP', 'default'],
  ['APPROVAL_GATE_CAP_MIN', 'min'],
  ['APPROVAL_GATE_CAP_MAX', 'max'],
  ['FLOOR_TIMEOUT_S', 'min'],
  ['DEFAULT_TASK_TIMEOUT_S', 'default'],
  ['APP_ACTOR_MIN_SECRET_LENGTH', 'min_secret_length'],
  ['FORGE_WEBTRIGGER_SUFFIX', 'forge_webtrigger_suffix'],
  ['MICROVM_PLATFORM_CONFIG_ENV_BY_KEY', 'env_by_key'],
  ['MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS', 'required'],
  ['MICROVM_PLATFORM_CONFIG_ARN_KEYS', 'arn_keys'],
  ['MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY', 'account_anchor_key'],
  ['_READY_WARMUP_TOTAL_BUDGET_SECONDS', 'warmup_total_budget_seconds'],
  ['_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS', 'warmup_required_timeout_seconds'],
  ['_LINEAR_VAULT_SCOPES', 'scopes'],
  ['_LINEAR_VAULT_CUSTOM_PARAMS', 'custom_parameters'],
  ['LIFECYCLE_HANDLER_BUDGET_S', 'lifecycle_handler_budget_seconds'],
  ['LIFECYCLE_HOOK_TIMEOUT_S', 'lifecycle_hook_timeout_seconds'],
]);

const OWNED_TS_NAMES: ReadonlyMap<string, string> = new Map([
  ['READY_HOOK_TIMEOUT_SECONDS', 'microvm_hook_budgets.ready_hook_timeout_seconds'],
  ['LIFECYCLE_HOOK_TIMEOUT_SECONDS', 'microvm_hook_budgets.lifecycle_hook_timeout_seconds'],
  ['AGENT_HOOK_PORT', 'microvm_lifecycle.hook_port'],
  ['MICROVM_LIFECYCLE_PROTOCOL', 'microvm_lifecycle.protocol_version'],
  ['MICROVM_IMAGE_PROTOCOL_ENV', 'microvm_lifecycle.image_protocol_env'],
  ['MICROVM_MAX_DURATION_SECONDS', 'microvm_lifecycle.maximum_duration_seconds'],
]);

const PY_ASSIGNMENT = /^\s*((?:[A-Za-z_][\w.]*\s*,\s*)*[A-Za-z_][\w.]*)\s*(?::[^=]*)?(?:\*\*|\/\/|>>|<<|[-+*/%@&|^])?=(?!=)(.*)$/;
const PY_CONTRACT_READ = /^(?:(?:int|float|str|bool|dict|list|tuple|set|frozenset)\( ?)?[A-Za-z_]\w*((?:\[(?:"[a-z_]+"|'[a-z_]+')\])+),? ?\)?$/;
const PY_LAST_KEY = /\[["']([a-z_]+)["']\]$/;
const PY_COMMENT = /(?:^|\s)#.*$/;
const TS_DECLARATION = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?!=)(.*)$/;
const TS_CONTRACT_READ = /^(?:(?:String|Number)\( ?)?[A-Za-z_$][\w$]*\.([a-z_.]+) ?\)?;?$/;

interface Drift {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly statement: string;
  readonly expected: string;
}

function sourceFiles(dir: string, extension: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => path.join(dir, entry))
    .sort();
}

function openBrackets(text: string): number {
  let depth = 0;
  for (const char of text) {
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
  }
  return depth;
}

function findDriftInPython(filePath: string, seen: Set<string>): Drift[] {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const drifts: Drift[] = [];
  lines.forEach((line, index) => {
    const assignment = PY_ASSIGNMENT.exec(line);
    if (!assignment) return;
    const targets = assignment[1].split(',').map((target) => target.trim().split('.').pop() ?? '');
    for (const name of targets) {
      const key = OWNED_PYTHON_NAMES.get(name);
      if (key === undefined) continue;
      seen.add(name);
      let value = assignment[2].replace(PY_COMMENT, '');
      for (let next = index + 1; openBrackets(value) > 0 && next < lines.length; next++) {
        value += ` ${lines[next].replace(PY_COMMENT, '')}`;
      }
      const read = PY_CONTRACT_READ.exec(value.replace(/\s+/g, ' ').trim());
      if (targets.length === 1 && read && PY_LAST_KEY.exec(read[1])?.[1] === key) continue;
      drifts.push({
        file: filePath,
        line: index + 1,
        name,
        statement: line.trim(),
        expected: `${name} = <contract section>["${key}"], optionally inside one conversion such as int(...)`,
      });
    }
  });
  return drifts;
}

function findDriftInTypeScript(filePath: string, seen: Set<string>): Drift[] {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const drifts: Drift[] = [];
  lines.forEach((line, index) => {
    const declaration = TS_DECLARATION.exec(line);
    const contractPath = declaration ? OWNED_TS_NAMES.get(declaration[1]) : undefined;
    if (!declaration || contractPath === undefined) return;
    seen.add(declaration[1]);
    const value = (declaration[2].trim() || (lines[index + 1] ?? '')).trim();
    if (TS_CONTRACT_READ.exec(value)?.[1] === contractPath) return;
    drifts.push({
      file: filePath,
      line: index + 1,
      name: declaration[1],
      statement: line.trim(),
      expected: `const ${declaration[1]} = <constants.json import>.${contractPath}`,
    });
  });
  return drifts;
}

function main(): number {
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
      lifecycle_hook_timeout_seconds: number;
      lifecycle_handler_budget_seconds: number;
    };
    microvm_lifecycle?: {
      protocol_version: number;
      image_protocol_env: string;
      hook_port: number;
      maximum_duration_seconds: number;
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
    for (const [key, envName] of Object.entries(envByKey)) {
      if ((key.endsWith('_arn') || (typeof envName === 'string' && envName.endsWith('_ARN')))
        && !mpc.arn_keys.includes(key)) {
        invariantErrors.push(
          `microvm_platform_config: ARN-shaped key "${key}" is missing from arn_keys`,
        );
      }
    }
    if (!mpc.arn_keys.includes(mpc.account_anchor_key)) {
      invariantErrors.push(
        'microvm_platform_config.account_anchor_key must be one of arn_keys',
      );
    }
  }
  if (!mpc.required.includes(mpc.account_anchor_key)) {
    invariantErrors.push(
      'microvm_platform_config.account_anchor_key must also be listed in required — '
      + 'an optional anchor would make ARN pinning skippable by omission',
    );
  }

  const mhb = json.microvm_hook_budgets;
  const lifecycle = json.microvm_lifecycle;
  if (!lifecycle || !Number.isSafeInteger(lifecycle.protocol_version) || lifecycle.protocol_version <= 0
    || !Number.isInteger(lifecycle.hook_port) || lifecycle.hook_port < 1 || lifecycle.hook_port > 65535
    || !Number.isInteger(lifecycle.maximum_duration_seconds)
    || lifecycle.maximum_duration_seconds <= 0 || lifecycle.maximum_duration_seconds > 28_800
    || typeof lifecycle.image_protocol_env !== 'string' || !/^ABCA_MICROVM_[A-Z0-9_]+$/.test(lifecycle.image_protocol_env)) {
    invariantErrors.push('microvm_lifecycle requires a positive protocol version, valid hook port, duration within 1–28800 seconds and ABCA_MICROVM_ marker name');
  }
  const BUDGET_FIELDS = [
    'ready_hook_timeout_seconds',
    'warmup_total_budget_seconds',
    'warmup_required_timeout_seconds',
    'lifecycle_hook_timeout_seconds',
    'lifecycle_handler_budget_seconds',
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
  if (mhb.lifecycle_handler_budget_seconds >= mhb.lifecycle_hook_timeout_seconds) {
    invariantErrors.push(
      'microvm_hook_budgets.lifecycle_handler_budget_seconds must be < '
      + 'lifecycle_hook_timeout_seconds (pause/wake must leave time to answer)',
    );
  }


  if (invariantErrors.length > 0) {
    console.error(`Semantic invariant violations in ${CONSTANTS_JSON}:\n`);
    for (const e of invariantErrors) console.error(`  - ${e}`);
    return 1;
  }

  const pythonFiles = sourceFiles(AGENT_SRC, '.py');
  const assigned = new Set<string>();
  const declared = new Set<string>();
  const drifts = [
    ...pythonFiles.flatMap((file) => findDriftInPython(file, assigned)),
    ...TS_CONSUMERS.flatMap((file) => findDriftInTypeScript(file, declared)),
  ];
  const unassigned = [...OWNED_PYTHON_NAMES.keys()].filter((name) => !assigned.has(name));
  const undeclared = [...OWNED_TS_NAMES.keys()].filter((name) => !declared.has(name));
  const parityTest = fs.readFileSync(path.join(REPO_ROOT, PARITY_TEST), 'utf-8');
  const untested = [...OWNED_PYTHON_NAMES.keys()].filter((name) => !parityTest.includes(`"${name}"`));

  if (drifts.length > 0 || unassigned.length > 0 || undeclared.length > 0 || untested.length > 0) {
    console.error('Cross-language constants drift detected:\n');
    for (const d of drifts) {
      console.error(
        `  - ${path.relative(REPO_ROOT, d.file)}:${d.line}: "${d.name}" is not a plain read of its contract value:\n` +
          `      ${d.statement}\n` +
          `    Read from contracts/constants.json instead (see contracts/constants.md): ${d.expected}.`,
      );
    }
    for (const name of unassigned) {
      console.error(
        `  - "${name}" is owned by contracts/constants.json but assigned nowhere under agent/src.\n` +
          `    If the constant was renamed or removed, update OWNED_PYTHON_NAMES in scripts/check-constants-sync.ts.`,
      );
    }
    for (const name of undeclared) {
      console.error(
        `  - "${name}" is owned by contracts/constants.json but declared in none of its TypeScript consumers ` +
          `(${TS_CONSUMERS.map((file) => path.relative(REPO_ROOT, file)).join(', ')}).\n` +
          `    Declare it there as a read of its contract value (const ${name} = <constants.json import>.${OWNED_TS_NAMES.get(name)}).\n` +
          `    If the constant was renamed or removed on purpose, update OWNED_TS_NAMES in scripts/check-constants-sync.ts.`,
      );
    }
    for (const name of untested) {
      console.error(
        `  - "${name}" is owned by contracts/constants.json but ${PARITY_TEST} does not compare its value.\n` +
          `    Add a row for it to _OWNED in that file.`,
      );
    }
    console.error(`\n${drifts.length + unassigned.length + undeclared.length + untested.length} drift issue(s) found.`);
    return 1;
  }

  console.log(
    `Constants sync OK: contracts/constants.json validated; ` +
      `${OWNED_PYTHON_NAMES.size} Python names checked across ` +
      `${pythonFiles.length} files under agent/src, ` +
      `${OWNED_TS_NAMES.size} TypeScript name(s) across ` +
      `${TS_CONSUMERS.length} consumer(s).`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`check-constants-sync: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
