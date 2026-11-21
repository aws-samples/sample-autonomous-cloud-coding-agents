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
import { REQUIRED_BOOTSTRAP_VERSION } from '../src/commands/setup';
import { CAPABILITY_CATALOG } from '../src/deployment-capabilities';
import { COMPUTE_BACKENDS } from '../src/deployment-profile';

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * The CLI cannot import ``contracts/`` at runtime (outside the published
 * ``lib`` files), so it carries literal copies. These tests turn drift between
 * the contract, the CDK resolver and the CLI into a CI failure.
 *
 * The profile parser, the feature list, the context-switch names and the
 * per-stack profile file are not compared here: both suites run the cases of
 * ``contracts/deployment-profile-vectors/`` against their own copy
 * (``deployment-profile-vectors.test.ts``).
 */
describe('deployment capability parity', () => {
  test('the CLI catalog equals contracts/deployment-capabilities.json', () => {
    const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'deployment-capabilities.json'), 'utf-8'));
    expect(CAPABILITY_CATALOG).toEqual(contract);
  });

  test('the CLI requires the bootstrap bundle version CDK generates', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'cdk', 'src', 'bootstrap', 'version.ts'), 'utf-8');
    expect(/export const BOOTSTRAP_VERSION = '([^']+)'/.exec(source)?.[1]).toBe(REQUIRED_BOOTSTRAP_VERSION);
  });

  test('the CLI reads the Region override context that the CDK gate reads', () => {
    const cdk = fs.readFileSync(path.join(REPO_ROOT, 'cdk', 'src', 'constructs', 'lambda-microvm-compute.ts'), 'utf-8');
    const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'src', 'commands', 'setup.ts'), 'utf-8');
    const declared = (text: string) => /MICROVM_REGION_OVERRIDE_CONTEXT = '([^']+)'/.exec(text)?.[1];
    expect(declared(cdk)).toBeDefined();
    expect(declared(cli)).toBe(declared(cdk));
  });

  test('the CLI compute backends match the CDK resolver', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'cdk', 'src', 'handlers', 'shared', 'compute-backend.ts'), 'utf-8');
    const declared = /export type ComputeBackend = ([^;]+);/.exec(source)?.[1] ?? '';
    expect([...declared.matchAll(/'([a-z-]+)'/g)].map(m => m[1])).toEqual([...COMPUTE_BACKENDS]);
  });
});
