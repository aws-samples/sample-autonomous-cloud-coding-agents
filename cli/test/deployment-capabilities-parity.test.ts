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
import { CAPABILITY_CATALOG } from '../src/deployment-capabilities';
import { DEPLOYMENT_FEATURES } from '../src/deployment-profile';

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * The CLI cannot import ``contracts/`` at runtime (outside the published
 * ``lib`` files), so it carries literal copies. These tests turn drift between
 * the contract, the CDK resolver and the CLI into a CI failure.
 */
describe('deployment capability parity', () => {
  test('the CLI catalog equals contracts/deployment-capabilities.json', () => {
    const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'deployment-capabilities.json'), 'utf-8'));
    expect(CAPABILITY_CATALOG).toEqual(contract);
  });

  test('the CLI feature list matches the CDK resolver', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'cdk', 'src', 'deployment', 'features.ts'), 'utf-8');
    const declared = /export const DEPLOYMENT_FEATURES = \[([^\]]+)\]/.exec(source)?.[1];
    expect(declared).toBeDefined();
    expect([...declared!.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1])).toEqual([...DEPLOYMENT_FEATURES]);
  });

  test('the CLI context-switch names match the CDK resolver', () => {
    const cdk = fs.readFileSync(path.join(REPO_ROOT, 'cdk', 'src', 'deployment', 'features.ts'), 'utf-8');
    const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'src', 'commands', 'setup.ts'), 'utf-8');
    const extract = (text: string) => {
      const block = /FEATURE_CONTEXT_KEYS[^{]*\{([^}]+)\}/.exec(text)?.[1] ?? '';
      return Object.fromEntries([...block.matchAll(/(\w+): '(\w+)'/g)].map(m => [m[1], m[2]]));
    };
    expect(Object.keys(extract(cdk))).toHaveLength(DEPLOYMENT_FEATURES.length);
    expect(extract(cli)).toEqual(extract(cdk));
  });
});
