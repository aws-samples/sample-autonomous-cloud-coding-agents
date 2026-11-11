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
 * Coverage contract drift check.
 *
 * ``contracts/coverage-thresholds.json`` is the source of truth for every
 * coverage floor and for the settings that decide what a floor measures. The
 * test runners read those values from their own manifests, so each manifest
 * carries a copy; this script fails when a copy says something else.
 *
 * It compares the values a runner will read, never text: package.json through
 * ``JSON.parse`` and TOML through mise's parser (``mise config get``). A number
 * left behind in a comment, a contract value that is a prefix of the real one
 * and a setting that narrows what is measured are all drift.
 *
 *   cdk, cli   the jest block of package.json: collectCoverage,
 *              collectCoverageFrom, coveragePathIgnorePatterns,
 *              coverageThreshold and any further key the contract names;
 *              scripts.test, verbatim
 *   agent      [tool.coverage.run] and [tool.coverage.report] in
 *              pyproject.toml, every key; the coverage flags of the test task
 *              in mise.toml, which win over those tables
 *
 * Run via ``mise run check:coverage-thresholds-sync``. Exits 0 when in sync,
 * 1 on drift or when something it needs cannot be read.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type Json = Record<string, unknown>;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'contracts/coverage-thresholds.json';

/** jest settings that switch coverage on, choose the files it counts and set the floor. */
const JEST_KEYS = ['collectCoverage', 'collectCoverageFrom', 'coveragePathIgnorePatterns', 'coverageThreshold'];

/**
 * The package.json files whose test script is the command the build runs. A flag there wins over
 * the settings of the runner, so the contract pins each script verbatim: a flag in any spelling,
 * a second command or another list of test files is drift.
 */
const TEST_SCRIPTS = ['cdk/package.json', 'cli/package.json'];

const errors: string[] = [];
let checked = 0;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(join(root, file), 'utf8')) as Json;
}

/** A section of the contract. A missing one is an error, not a reason to skip a package. */
function section(contract: Json, ...path: string[]): Json {
  const value = path.reduce<unknown>((node, key) => (node as Json | undefined)?.[key], contract);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${CONTRACT} has no ${path.join('.')} section`);
  }
  return value as Json;
}

/** A value from a TOML file as mise's parser prints it: a scalar bare, a table as ``key = value`` lines. */
function toml(file: string, key: string): string {
  try {
    return execFileSync('mise', ['config', 'get', '--file', join(root, file), key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const reason = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
    throw new Error(`cannot read ${key} from ${file} with \`mise config get\`: ${reason}`);
  }
}

/** A TOML table of plain values (booleans, numbers, strings, arrays of those) as an object. */
function tomlTable(file: string, key: string): Json {
  return Object.fromEntries(toml(file, key).split('\n').filter(Boolean).map((line) => {
    const eq = line.indexOf(' = ');
    try {
      if (eq < 1) throw new Error('not a key = value line');
      return [line.slice(0, eq), JSON.parse(line.slice(eq + ' = '.length))];
    } catch {
      throw new Error(`${file} [${key}]: cannot read "${line}". Keep this table to plain values, one per line.`);
    }
  }));
}

/** The arguments of a shell command line, quotes removed. */
function args(command: unknown): string[] {
  return String(command).replace(/['"]/g, '').split(/\s+/).filter(Boolean);
}

const show = (value: unknown): string => (value === undefined ? 'not set' : JSON.stringify(value));

/** Record drift unless the value a runner reads equals the contract's. */
function pin(where: string, actual: unknown, contractKey: string, expected: unknown): void {
  checked += 1;
  if (!isDeepStrictEqual(actual, expected)) {
    errors.push(`${where}: ${show(actual)} does not match ${CONTRACT} ${contractKey}: ${show(expected)}`);
  }
}

/** Pin ``keys`` and every key the contract names. A key that only one side has is drift. */
function pinKeys(where: string, actual: Json, contractKey: string, expected: Json, keys: string[] = Object.keys(actual)): void {
  for (const key of new Set([...keys, ...Object.keys(expected)])) {
    pin(`${where} ${key}`, actual[key], `${contractKey}.${key}`, expected[key]);
  }
}

function checkJest(contract: Json, pkg: string): void {
  const manifest = readJson(`${pkg}/package.json`);
  pinKeys(`${pkg}/package.json jest`, (manifest.jest ?? {}) as Json, `jest.${pkg}`, section(contract, 'jest', pkg), JEST_KEYS);
}

function checkTestScripts(contract: Json): void {
  const pinned = section(contract, 'commands');
  for (const file of new Set([...TEST_SCRIPTS, ...Object.keys(pinned)])) {
    pin(`${file} scripts.test`, (readJson(file).scripts as Json | undefined)?.test, `commands.${file}`, pinned[file]);
  }
}

function checkAgent(contract: Json): void {
  const run = section(contract, 'pytest', 'agent', 'run');
  const report = section(contract, 'pytest', 'agent', 'report');
  pinKeys('agent/pyproject.toml [tool.coverage.run]', tomlTable('agent/pyproject.toml', 'tool.coverage.run'), 'pytest.agent.run', run);
  pinKeys('agent/pyproject.toml [tool.coverage.report]', tomlTable('agent/pyproject.toml', 'tool.coverage.report'), 'pytest.agent.report', report);

  // pytest-cov flags win over pyproject.toml. --cov-report only chooses output formats.
  const flags = args(toml('agent/mise.toml', 'tasks.test.run')).filter(arg => /^--(no-)?cov/.test(arg) && !arg.startsWith('--cov-report='));
  const expected = [
    ...(run.source as string[]).map(source => `--cov=${source}`),
    ...(run.branch ? ['--cov-branch'] : []),
    `--cov-fail-under=${report.fail_under}`,
  ];
  pin('agent/mise.toml tasks.test.run coverage flags', flags.sort(), 'pytest.agent (run.source, run.branch, report.fail_under)', expected.sort());
}

try {
  const contract = readJson(CONTRACT);
  checkJest(contract, 'cdk');
  checkJest(contract, 'cli');
  checkAgent(contract);
  checkTestScripts(contract);
} catch (err) {
  errors.push(`the check could not finish: ${err instanceof Error ? err.message : String(err)}`);
}

if (errors.length > 0) {
  console.error('Coverage contract drift detected:\n');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  console.error(`\n${CONTRACT} is the source of truth. Put the manifest back in line with it. To change a floor or`);
  console.error('what it measures, change the contract and the manifest together and say why in the pull request.');
  process.exit(1);
}

console.log(`Coverage settings match ${CONTRACT} (${checked} values checked)`);
