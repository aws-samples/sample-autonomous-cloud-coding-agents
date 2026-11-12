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
 * Cedar engine pair check.
 *
 * The agent evaluates Cedar policies with `cedarpy` and the CDK Lambdas with
 * `@cedar-policy/cedar-wasm`: two bindings over one Rust core that must be
 * pinned EXACTLY and move together (docs/design/CEDAR_HITL_GATES.md §15.6,
 * decision #23). The golden fixtures under contracts/cedar-parity/ prove that
 * one pair of versions agrees; they say nothing once a manifest drifts to a
 * range or one side is bumped alone and happens to keep the fixtures green.
 *
 * `contracts/cedar-parity/engines/versions.json` names the pair the fixtures
 * were verified against. This check fails unless every manifest pins exactly
 * that version, so an engine bump is always an edit to that file, next to the
 * fixtures it has to keep true.
 *
 * Run via `mise run check:cedar-engine-pair`. Exit 0 when the pins match, 1
 * otherwise (a file that is missing or unreadable is a mismatch, never a pass).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAIR_FILE = 'contracts/cedar-parity/engines/versions.json';
const WASM = '@cedar-policy/cedar-wasm';
const PY = 'cedarpy';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/** A `cedarpy` requirement string in pyproject.toml, with whatever specifier follows the name. */
const PY_REQUIREMENT = /["']cedarpy(?![\w-])([^"']*)["']/g;

const errors = [];

/**
 * Run `check` on the parsed content of one file. A file that cannot be read
 * or parsed is reported like any other mismatch, and its checks do not run.
 */
function inspect(file, parse, check) {
  let content;
  let readable = true;
  try {
    content = parse(readFileSync(join(repoRoot, file), 'utf8'));
  } catch (err) {
    readable = false;
    errors.push(`${file}: cannot be read or parsed (${err.code ?? err.message}).`);
  }
  if (readable) check(content);
}

/** The verified pair; stays undefined when the pair file is unusable. */
let pair;
inspect(PAIR_FILE, JSON.parse, (json) => {
  pair = json;
  const names = Object.keys(pair).sort().join(', ');
  if (names !== [WASM, PY].sort().join(', ')) {
    errors.push(`${PAIR_FILE}: must name exactly "${WASM}" and "${PY}", found: ${names || 'nothing'}.`);
  }
  for (const name of [WASM, PY]) {
    if (name in pair && !EXACT_VERSION.test(String(pair[name]))) {
      errors.push(`${PAIR_FILE}: "${name}" must be one exact version such as 4.12.0, found "${pair[name]}".`);
    }
  }
});

/** Hold one pinned version to the pair file, or say what to change. */
function expectPin(file, name, pinned, howToPin) {
  const expected = pair?.[name];
  if (pinned === expected) return;
  errors.push(
    `${file}: ${name} is pinned to "${pinned ?? 'nothing'}", but ${PAIR_FILE} names ${expected ?? 'no version'}. ` +
      `Pin it exactly (${howToPin(expected ?? '<version>')}). To move to another engine version, bump both engines and ` +
      `${PAIR_FILE} in one change and keep the contracts/cedar-parity fixtures green on both runners.`,
  );
}

for (const manifest of ['cdk/package.json', 'cdk/layers/cedar-wasm/package.json']) {
  inspect(manifest, JSON.parse, (pkg) => {
    expectPin(manifest, WASM, pkg.dependencies?.[WASM], (version) => `"${WASM}": "${version}", no ^ or ~`);
  });
}

inspect('agent/pyproject.toml', String, (pyproject) => {
  const requirements = [...pyproject.matchAll(PY_REQUIREMENT)].map((match) => match[1].trim());
  if (requirements.length !== 1) {
    errors.push(`agent/pyproject.toml: expected one "${PY}" requirement, found ${requirements.length}.`);
    return;
  }
  const [specifier] = requirements;
  const pinned = specifier.startsWith('==') ? specifier.slice(2).trim() : specifier;
  expectPin('agent/pyproject.toml', PY, pinned, (version) => `"${PY}==${version}"`);
});

if (errors.length > 0) {
  console.error('check-cedar-engine-pair: the Cedar engines are not pinned to the verified pair.\n');
  for (const error of errors) console.error(`  ✖ ${error}`);
  process.exit(1);
}

console.log(`check-cedar-engine-pair: OK — ${WASM} ${pair[WASM]} (cdk, Lambda layer) and ${PY} ${pair[PY]} (agent) match ${PAIR_FILE}.`);
