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
 * Coverage threshold drift check.
 *
 * ``contracts/coverage-thresholds.json`` is the source of truth for
 * jest ``coverageThreshold`` (cdk, cli) and agent pytest ``fail_under``.
 * This script fails CI when package manifests drift from the contract.
 *
 * Run via ``mise run check:coverage-thresholds-sync``.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Thresholds = {
  jest: { cdk: { global: Record<string, number> }; cli: { global: Record<string, number> } };
  pytest: { agent: { fail_under: number; branch: boolean } };
};

const contract = readJson<Thresholds>(join(root, 'contracts/coverage-thresholds.json'));

const cdkPkg = readJson<{ jest?: { coverageThreshold?: unknown } }>(join(root, 'cdk/package.json'));
const cliPkg = readJson<{ jest?: { coverageThreshold?: unknown } }>(join(root, 'cli/package.json'));
const agentToml = readFileSync(join(root, 'agent/pyproject.toml'), 'utf8');
const agentMise = readFileSync(join(root, 'agent/mise.toml'), 'utf8');

const errors: string[] = [];

if (!deepEqual(cdkPkg.jest?.coverageThreshold, contract.jest.cdk)) {
  errors.push('cdk/package.json jest.coverageThreshold does not match contracts/coverage-thresholds.json jest.cdk');
}
if (!deepEqual(cliPkg.jest?.coverageThreshold, contract.jest.cli)) {
  errors.push('cli/package.json jest.coverageThreshold does not match contracts/coverage-thresholds.json jest.cli');
}

const failUnder = contract.pytest.agent.fail_under;
if (!agentToml.includes(`fail_under = ${failUnder}`)) {
  errors.push(`agent/pyproject.toml [tool.coverage.report] fail_under must be ${failUnder}`);
}
if (!agentMise.includes(`--cov-fail-under=${failUnder}`)) {
  errors.push(`agent/mise.toml test task must include --cov-fail-under=${failUnder}`);
}
if (contract.pytest.agent.branch && !agentMise.includes('--cov-branch')) {
  errors.push('agent/mise.toml test task must include --cov-branch');
}

if (errors.length > 0) {
  console.error('Coverage threshold drift detected:\n');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log('Coverage thresholds are in sync with contracts/coverage-thresholds.json');
