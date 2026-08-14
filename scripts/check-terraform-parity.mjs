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
 * CDK <-> Terraform parity census (ADR-XXX sub-decision 4, tier 1; issue #644).
 *
 * ABCA ships two independent IaC paths. The CDK app is the source of truth; the
 * `terraform/` module is an additive port. Nothing structural stops the two from
 * silently diverging the moment someone adds a construct, so this is the gate
 * that turns that divergence into a build failure.
 *
 * ─── Why a TYPE census and never a COUNT diff ────────────────────────────────
 *
 * Idiomatic HCL legitimately uses a DIFFERENT NUMBER of resources than
 * CloudFormation for identical behavior, in both directions:
 *
 *   - collapse: 3 `Custom::S3AutoDeleteObjects` resources become one
 *     `force_destroy = true` ARGUMENT. 3 -> 0.
 *   - expand:   1 `AWS::S3::Bucket` becomes `aws_s3_bucket` plus 5-8 sibling
 *     `aws_s3_bucket_versioning` / `_public_access_block` / ... resources,
 *     because the AWS provider split them out in v4. 1 -> 6.
 *   - expand:   1 `AWS::ApiGateway::Method` becomes `aws_api_gateway_method` +
 *     `_integration` + two `_response` resources. 1 -> 4.
 *
 * A count-based check fires on every one of those, which are all CORRECT. It
 * would be red on day one, get muted within a week, and then catch nothing. So
 * this compares the SET of resource types and asks a much narrower, actually
 * actionable question:
 *
 *     Has CDK grown a capability the Terraform module neither implements
 *     nor has explicitly declared it is not porting?
 *
 * The answer is only ever "no" (pass) or "yes, and here is the type" (fail with
 * exactly two remedies: implement it, or add an allowlist row with a reason).
 *
 * ─── Inputs ──────────────────────────────────────────────────────────────────
 *
 *   1. `cdk/cdk.out/*.template.json`  — CFN types CDK actually emits, INCLUDING
 *      `*.nested.template.json`. Read from synth output, never from the
 *      TypeScript: CDK resolves defaults at synth (ADR sub-decision 4a), and a
 *      construct that only appears in a nested stack is invisible to a source
 *      scan.
 *   2. a `terraform show -json` plan  — provider resource types the module
 *      declares. Produced credential-free from
 *      `terraform/examples/parity-check` with mock creds + `skip_*` flags +
 *      `-refresh=false` (verified 2026-08-13; see the ADR).
 *   3. `scripts/terraform-parity-map.json`  — CFN type -> provider type(s).
 *      Data, not logic, so it is reviewable in isolation. Mapping names are only
 *      ever tested for PRESENCE, so a typo yields a false FAILURE, never a false
 *      pass — the safe direction for a blocking gate.
 *   4. `terraform/PARITY_ALLOWLIST.md`  — CFN types intentionally not ported,
 *      each with a reason and a revisit-when.
 *
 * ─── What it asserts ─────────────────────────────────────────────────────────
 *
 *   A. Every CFN type is COVERED (>= 1 of its mapped provider types is in the
 *      plan) or DECLARED (an allowlist row). Otherwise: fail, exit 1.
 *   B. Every Terraform module DIRECTORY declares `provider_meta "aws"` carrying
 *      `md/uksb-wt64nei4u6`. Solution attribution (#319) is per-module and does
 *      NOT inherit, so a missing block is SILENT attribution loss — nothing
 *      fails, calls just stop being attributed. Directory granularity is the
 *      Terraform semantic: a module is a directory, the block may live in any
 *      one of its `.tf` files (conventionally `versions.tf`).
 *
 * Assertion B needs no plan file, so it runs even when the census is skipped.
 *
 * ─── Graceful degradation, and why ───────────────────────────────────────────
 *
 * A missing plan JSON is a SKIP (exit 0), not a failure. This is deliberate and
 * narrow: the check is wired into `mise run build` while `terraform/` is still
 * being built out across a PR stack, so a hard failure here would make the
 * build red for every contributor for reasons unrelated to their change — the
 * fastest way to get a gate disabled. Generating the plan needs Terraform
 * installed and `terraform init` run, which is a CI/opt-in step, not something
 * every `mise run build` should shell out to.
 *
 * The skip is loud (it prints the exact command to produce the plan) and it does
 * NOT weaken CI: the CI job generates the plan first, so the census always runs
 * there. Assertion B still runs in the skip path, so the credential-free half of
 * the gate is never skipped.
 *
 * ─── Exit codes (matching the other scripts/check-*.mjs) ─────────────────────
 *
 *   0  pass, or skipped-with-message
 *   1  parity gap / missing provider_meta  (actionable, author must fix)
 *   2  harness error — unreadable or malformed input (fail loud, never open)
 *
 * Usage:
 *   node scripts/check-terraform-parity.mjs [--plan <path>] [--cdk-out <dir>]
 *                                           [--terraform-dir <dir>]
 *                                           [--allowlist <path>] [--map <path>]
 *
 * The path flags exist so unit tests can point the differ at synthetic
 * fixtures; normal runs need no arguments.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SCRIPT = 'check-terraform-parity';

/**
 * The solution id every outbound AWS call must carry (#319, AGENTS.md).
 * Byte-identical to `SOLUTION_ID` in cdk/src/handlers/shared/ua.ts, cli/src/ua.ts
 * and agent/src/ua.py. Terraform appends the `provider_meta` string verbatim, so
 * the `#` separator is written literally in the HCL.
 */
const SOLUTION_UA = 'md/uksb-wt64nei4u6';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────────────────────
// argv
// ─────────────────────────────────────────────────────────────────────────────

/** Parse `--flag value` pairs. Unknown flags are an error, not a silent no-op. */
function parseArgs(argv) {
  const known = new Set(['--plan', '--cdk-out', '--terraform-dir', '--allowlist', '--map']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!known.has(flag)) {
      fatal(
        `unknown argument "${flag}". Known: ${[...known].join(', ')}.`,
      );
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fatal(`${flag} requires a path argument.`);
    }
    out[flag.replace(/^--/, '')] = value;
    i++;
  }
  return out;
}

/** Harness error: bad input, not a parity gap. Exit 2 so CI can tell them apart. */
function fatal(message) {
  console.error(`${SCRIPT}: ${message}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));

const cdkOutDir = args['cdk-out'] ?? join(repoRoot, 'cdk', 'cdk.out');
const terraformDir = args['terraform-dir'] ?? join(repoRoot, 'terraform');
const allowlistPath = args.allowlist ?? join(terraformDir, 'PARITY_ALLOWLIST.md');
const mapPath = args.map ?? join(repoRoot, 'scripts', 'terraform-parity-map.json');
const planPath = args.plan ?? join(terraformDir, 'examples', 'parity-check', 'plan.json');

// ─────────────────────────────────────────────────────────────────────────────
// input readers
// ─────────────────────────────────────────────────────────────────────────────

function readJson(path, what) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fatal(`cannot read ${what} at ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fatal(`${what} at ${path} is not valid JSON: ${err.message}`);
  }
}

/**
 * Census CloudFormation resource TYPES from every template in `dir`.
 *
 * Includes `*.nested.template.json`: ABCA puts the registry stack and its API in
 * nested stacks, so a root-template-only scan would miss a whole subtree of
 * capability. Returns Map<type, count>; the count is reported for context only
 * and is never compared against anything (see the header).
 */
function censusCloudFormation(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fatal(
      `cdk.out directory not found at ${dir}. Run \`MISE_EXPERIMENTAL=1 mise //cdk:synth\` first.`,
    );
  }
  const templates = readdirSync(dir).filter((f) => f.endsWith('.template.json'));
  if (templates.length === 0) {
    fatal(
      `no *.template.json under ${dir} — cdk.out looks stale or partial. ` +
        'Run `MISE_EXPERIMENTAL=1 mise //cdk:synth` and retry.',
    );
  }
  const types = new Map();
  let resourceCount = 0;
  for (const file of templates) {
    const template = readJson(join(dir, file), 'CloudFormation template');
    const resources = template.Resources;
    if (resources === undefined) continue; // a template may legitimately have none
    if (typeof resources !== 'object' || Array.isArray(resources)) {
      fatal(`${file}: \`Resources\` is not an object — not a CloudFormation template?`);
    }
    for (const [logicalId, resource] of Object.entries(resources)) {
      const type = resource?.Type;
      if (typeof type !== 'string') {
        // Fail loud rather than skipping: a resource we cannot type is a resource
        // we cannot census, i.e. a hole in the gate.
        fatal(`${file}: resource "${logicalId}" has no string \`Type\`.`);
      }
      resourceCount++;
      types.set(type, (types.get(type) ?? 0) + 1);
    }
  }
  return { types, resourceCount, templateCount: templates.length };
}

/**
 * Census provider resource TYPES from a `terraform show -json` plan.
 *
 * Reads BOTH shapes, because neither alone is complete:
 *   - `planned_values.root_module` (+ recursive `child_modules`) — the resolved
 *     plan; nested modules only appear here.
 *   - `resource_changes[]` — flat, and includes resources being destroyed, which
 *     `planned_values` omits.
 * Union, since this is a presence test: a type declared anywhere in the module
 * tree counts as implemented. `data` blocks are excluded — a data source reads
 * infrastructure, it does not manage it, so counting one as coverage would let a
 * lookup masquerade as an implementation.
 */
function censusTerraformPlan(path) {
  const plan = readJson(path, 'Terraform plan JSON');
  const types = new Set();

  const walkModule = (mod, where) => {
    if (mod === undefined) return;
    if (typeof mod !== 'object' || Array.isArray(mod)) {
      fatal(`plan JSON: ${where} is not an object — unexpected \`terraform show -json\` shape.`);
    }
    for (const resource of mod.resources ?? []) {
      if (resource?.mode === 'data') continue;
      if (typeof resource?.type === 'string') types.add(resource.type);
    }
    for (const child of mod.child_modules ?? []) {
      walkModule(child, `${where}.child_modules[]`);
    }
  };

  const planned = plan.planned_values;
  if (planned !== undefined) walkModule(planned.root_module, 'planned_values.root_module');

  for (const change of plan.resource_changes ?? []) {
    if (change?.mode === 'data') continue;
    if (typeof change?.type === 'string') types.add(change.type);
  }

  if (types.size === 0) {
    // An empty census would mark EVERY CFN type as a gap, which is a confusing
    // way to report "your plan file is not what I think it is".
    fatal(
      `plan JSON at ${path} yielded ZERO managed resource types. Expected the output of ` +
        '`terraform show -json tfplan.bin`. Check that the plan is not empty and that ' +
        'the file is a plan (not a state file).',
    );
  }
  return types;
}

/**
 * Load the CFN -> provider type mapping. Returns Map<cfnType, string[]>.
 * An empty array is meaningful: "no provider resource corresponds to this type",
 * i.e. only an allowlist row can satisfy it.
 */
function loadMap(path) {
  const data = readJson(path, 'parity map');
  const mappings = data.mappings;
  if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
    fatal(`${path}: expected a top-level \`mappings\` object.`);
  }
  const map = new Map();
  for (const [cfnType, entry] of Object.entries(mappings)) {
    const terraform = entry?.terraform;
    if (!Array.isArray(terraform) || terraform.some((t) => typeof t !== 'string')) {
      fatal(`${path}: mappings["${cfnType}"].terraform must be an array of strings.`);
    }
    map.set(cfnType, terraform);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARITY_ALLOWLIST.md
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Values that look like a reason but are not one. An allowlist whose rows say
 * "TBD" is strictly worse than no allowlist: it launders an undecided gap as a
 * decided one, which is the exact failure mode this gate exists to prevent.
 */
const SHRUG_REASONS = new Set(['', '-', '—', '–', 'n/a', 'na', 'tbd', 'todo', '?', 'none', 'no reason']);
const MIN_REASON_LENGTH = 15;

/**
 * Parse the allowlist's strict 3-column table (format contract stated at the top
 * of PARITY_ALLOWLIST.md itself). Returns Map<cfnType, {reason, revisitWhen}>.
 *
 * Rows are recognized by the FIRST cell being a backticked CFN type, so prose,
 * headings, and the header/separator rows need no special handling. A row that
 * looks like an entry but is malformed is a hard error — silently dropping it
 * would turn a declared gap back into an undeclared one without telling anyone.
 */
function parseAllowlist(path) {
  if (!existsSync(path)) {
    fatal(
      `allowlist not found at ${path}. Create it (see ADR-XXX sub-decision 4) — an ` +
        'empty allowlist is a valid state, a missing one is not.',
    );
  }
  const text = readFileSync(path, 'utf8');
  const entries = new Map();
  const problems = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;

    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

    // Only rows whose first cell is a backticked CFN/Custom type are entries.
    const typeMatch = /^`(((AWS|Custom)::)[A-Za-z0-9:]*[A-Za-z0-9])`$/.exec(cells[0] ?? '');
    if (typeMatch === null) continue;
    const cfnType = typeMatch[1];
    const at = `${path}:${i + 1}`;

    if (cells.length !== 3) {
      problems.push(
        `${at}: row for \`${cfnType}\` has ${cells.length} column(s), expected exactly 3 ` +
          '(CFN type | reason not ported | revisit when).',
      );
      continue;
    }
    const [, reason, revisitWhen] = cells;
    const normalizedReason = reason.toLowerCase().replace(/[.*_`]/g, '').trim();
    if (SHRUG_REASONS.has(normalizedReason) || reason.length < MIN_REASON_LENGTH) {
      problems.push(
        `${at}: \`${cfnType}\` has no real reason (got "${reason}"). State WHY it is not ` +
          'ported — a placeholder launders an undecided gap as a decided one.',
      );
      continue;
    }
    if (SHRUG_REASONS.has(revisitWhen.toLowerCase().replace(/[.*_`]/g, '').trim())) {
      problems.push(
        `${at}: \`${cfnType}\` has no revisit-when (got "${revisitWhen}"). Name the event ` +
          'that would make this worth reconsidering, or say "never" and why.',
      );
      continue;
    }
    if (entries.has(cfnType)) {
      problems.push(`${at}: duplicate allowlist row for \`${cfnType}\`.`);
      continue;
    }
    entries.set(cfnType, { reason, revisitWhen });
  }

  if (problems.length > 0) {
    console.error(`${SCRIPT}: ${path} is malformed:\n`);
    for (const p of problems) console.error(`  ✖ ${p}`);
    console.error(`\nSee the format contract at the top of ${relative(repoRoot, path)}.`);
    process.exit(2);
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// provider_meta assertion (#319)
// ─────────────────────────────────────────────────────────────────────────────

/** Strip `#`/`//` line comments and `/* *\/` block comments from HCL. */
function stripHclComments(hcl) {
  let out = '';
  let i = 0;
  while (i < hcl.length) {
    const two = hcl.slice(i, i + 2);
    if (two === '/*') {
      const end = hcl.indexOf('*/', i + 2);
      i = end === -1 ? hcl.length : end + 2;
      continue;
    }
    if (hcl[i] === '#' || two === '//') {
      const end = hcl.indexOf('\n', i);
      i = end === -1 ? hcl.length : end;
      continue;
    }
    if (hcl[i] === '"') {
      // Copy the string literal verbatim so a `#` inside it is not read as a
      // comment. This matters directly: the UA string we are looking for
      // ("md/uksb-wt64nei4u6#terraform") CONTAINS a `#`.
      const start = i++;
      while (i < hcl.length && hcl[i] !== '"') {
        i += hcl[i] === '\\' ? 2 : 1;
      }
      out += hcl.slice(start, Math.min(i + 1, hcl.length));
      i++;
      continue;
    }
    out += hcl[i++];
  }
  return out;
}

/** Body of the first `{...}` block starting at or after `from`, brace-matched. */
function blockBodyAt(hcl, from) {
  const open = hcl.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < hcl.length; i++) {
    if (hcl[i] === '"') {
      i++;
      while (i < hcl.length && hcl[i] !== '"') i += hcl[i] === '\\' ? 2 : 1;
      continue;
    }
    if (hcl[i] === '{') depth++;
    else if (hcl[i] === '}') {
      depth--;
      if (depth === 0) return { body: hcl.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * True iff `hcl` declares `provider_meta "aws"` carrying the solution UA, nested
 * inside a `terraform {}` block. The nesting is checked because a `provider_meta`
 * block anywhere else is not valid HCL and would never take effect — accepting
 * it would pass a module that silently loses attribution.
 */
function declaresSolutionUa(hcl) {
  const clean = stripHclComments(hcl);
  const terraformBlock = /(^|[\s}])terraform\s*\{/g;
  let m;
  while ((m = terraformBlock.exec(clean)) !== null) {
    const block = blockBodyAt(clean, m.index);
    if (block === null) continue;
    const meta = /provider_meta\s+"aws"\s*\{/.exec(block.body);
    if (meta === null) continue;
    const metaBlock = blockBodyAt(block.body, meta.index);
    if (metaBlock !== null && metaBlock.body.includes(SOLUTION_UA)) return true;
  }
  return false;
}

/**
 * Every module DIRECTORY under `dir` (a Terraform module is a directory of .tf
 * files) must have the solution UA in at least one of its .tf files.
 * `.terraform/` is skipped — it holds downloaded provider/module copies, not
 * ABCA source.
 */
function findModulesMissingUa(dir) {
  const missing = [];
  const checked = [];

  const walk = (current) => {
    const names = readdirSync(current, { withFileTypes: true });
    const tfFiles = names.filter((n) => n.isFile() && n.name.endsWith('.tf'));
    if (tfFiles.length > 0) {
      const rel = relative(repoRoot, current) || '.';
      checked.push(rel);
      const hasUa = tfFiles.some((f) =>
        declaresSolutionUa(readFileSync(join(current, f.name), 'utf8')),
      );
      if (!hasUa) missing.push(rel);
    }
    for (const entry of names) {
      if (entry.isDirectory() && entry.name !== '.terraform') {
        walk(join(current, entry.name));
      }
    }
  };

  walk(dir);
  return { missing, checked };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const failures = [];

  // ── Assertion B: solution attribution. Needs no plan, so it always runs. ──
  if (!existsSync(terraformDir)) {
    fatal(`terraform directory not found at ${terraformDir}.`);
  }
  const { missing: uaMissing, checked: uaChecked } = findModulesMissingUa(terraformDir);
  if (uaMissing.length > 0) {
    failures.push(
      `${uaMissing.length} Terraform module(s) do not declare provider_meta "aws" with ` +
        `"${SOLUTION_UA}":\n` +
        uaMissing.map((m) => `      ✖ ${m}/`).join('\n') +
        '\n\n    Solution attribution (#319) is PER-MODULE and does NOT inherit from the ' +
        'parent,\n    so a missing block loses attribution silently — nothing errors, the ' +
        'calls just\n    stop being attributed. Add to one .tf file in each module (by ' +
        'convention versions.tf):\n\n' +
        '      terraform {\n' +
        '        provider_meta "aws" {\n' +
        `          user_agent = ["${SOLUTION_UA}#terraform"]\n` +
        '        }\n' +
        '      }',
    );
  }

  // ── Assertion A: the type census. Needs the plan. ──
  const cfn = censusCloudFormation(cdkOutDir);
  const map = loadMap(mapPath);
  const allowlist = parseAllowlist(allowlistPath);

  if (!existsSync(planPath)) {
    // Documented graceful degradation — see the header for why this is a skip.
    console.log(
      `${SCRIPT}: SKIPPED the resource-type census — no plan JSON at ${planPath}.\n` +
        `  CDK census is ready (${cfn.resourceCount} resources / ${cfn.types.size} types ` +
        `across ${cfn.templateCount} template(s)); the Terraform side is missing.\n` +
        '  Generate it (credential-free, no AWS contact):\n' +
        '    cd terraform/examples/parity-check\n' +
        '    AWS_ACCESS_KEY_ID=mock_access_key AWS_SECRET_ACCESS_KEY=mock_secret_key \\\n' +
        '      AWS_EC2_METADATA_DISABLED=true terraform init \\\n' +
        '      && terraform plan -refresh=false -input=false -out=tfplan.bin \\\n' +
        '      && terraform show -json tfplan.bin > plan.json',
    );
    if (failures.length > 0) return reportFailures(failures);
    console.log(
      `${SCRIPT}: provider_meta OK — ${uaChecked.length} module(s) carry the solution UA ` +
        `(${uaChecked.join(', ')}).`,
    );
    return 0;
  }

  const tf = censusTerraformPlan(planPath);

  const covered = [];
  const declared = [];
  const gaps = [];
  for (const cfnType of [...cfn.types.keys()].sort()) {
    const mapped = map.get(cfnType);
    if (mapped !== undefined && mapped.some((t) => tf.has(t))) {
      covered.push(cfnType);
      continue;
    }
    if (allowlist.has(cfnType)) {
      declared.push(cfnType);
      continue;
    }
    gaps.push({ cfnType, mapped, count: cfn.types.get(cfnType) });
  }

  if (gaps.length > 0) {
    const lines = [
      `${gaps.length} CloudFormation resource type(s) are in NEITHER the Terraform ` +
        'module nor the allowlist:',
    ];
    for (const { cfnType, mapped, count } of gaps) {
      lines.push(`\n      ✖ ${cfnType}  (${count} resource(s) in cdk.out)`);
      if (mapped === undefined) {
        lines.push(
          '          not in scripts/terraform-parity-map.json at all — this type is brand new ' +
            'to CDK.',
        );
        lines.push(
          '          Add a mapping entry (find the provider resource name in the AWS provider ' +
            'docs),',
        );
        lines.push('          then either implement it or allowlist it.');
      } else if (mapped.length === 0) {
        lines.push(
          '          mapped to NO provider resource (a collapsed argument, or unsupported by ' +
            'the provider).',
        );
        lines.push(
          `          It can only be satisfied by an allowlist row in ${relative(repoRoot, allowlistPath)}.`,
        );
      } else {
        lines.push(`          maps to: ${mapped.join(', ')} — none present in the plan.`);
        lines.push('          Implement one of those in terraform/, or allowlist the CFN type.');
      }
    }
    lines.push(
      '\n    Two remedies, pick one:\n' +
        '      (a) implement the capability in terraform/ so a mapped provider resource ' +
        'appears in the plan; or\n' +
        `      (b) add a row to ${relative(repoRoot, allowlistPath)} with a real reason and a ` +
        'revisit-when.\n' +
        '    Do NOT edit this script to make the gate pass.',
    );
    failures.push(lines.join('\n'));
  }

  if (failures.length > 0) return reportFailures(failures);

  // Allowlist rows for types not currently synthesized are NOT a failure: the
  // ECS and Lambda-MicroVM types only appear under `-c compute_type=...`, so a
  // default-context cdk.out legitimately lacks them. Reported so a genuinely
  // stale row (capability deleted from CDK) is still visible.
  const stale = [...allowlist.keys()].filter((t) => !cfn.types.has(t)).sort();

  console.log(
    `${SCRIPT}: OK — ${cfn.types.size} CFN type(s) from ${cfn.templateCount} template(s) ` +
      `(${cfn.resourceCount} resources) reconciled against ${tf.size} Terraform type(s).\n` +
      `  covered by the module: ${covered.length}\n` +
      `  declared not-ported:   ${declared.length}${declared.length ? ` (${declared.join(', ')})` : ''}\n` +
      `  provider_meta:         ${uaChecked.length} module(s) carry ${SOLUTION_UA}`,
  );
  if (stale.length > 0) {
    console.log(
      `  note: ${stale.length} allowlist row(s) name types absent from this cdk.out ` +
        `(${stale.join(', ')}).\n` +
        '        Expected for the context-gated compute variants (-c compute_type=ecs / ' +
        'lambda-microvm);\n' +
        '        if a capability was removed from CDK outright, drop the row.',
    );
  }
  return 0;
}

function reportFailures(failures) {
  console.error(`${SCRIPT}: CDK <-> Terraform parity FAILED.\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  return 1;
}

process.exit(main());
