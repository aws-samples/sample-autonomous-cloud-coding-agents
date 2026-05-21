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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { infrastructurePolicy, applicationPolicy, observabilityPolicy } from '../src/bootstrap/policies';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../src/bootstrap/version';

const outDir = join(__dirname, '..', 'bootstrap', 'policies');
mkdirSync(outDir, { recursive: true });

const policies = [
  { name: 'infrastructure', fn: infrastructurePolicy },
  { name: 'application', fn: applicationPolicy },
  { name: 'observability', fn: observabilityPolicy },
];

for (const { name, fn } of policies) {
  const json = JSON.stringify(fn().toJSON(), null, 2) + '\n';
  writeFileSync(join(outDir, `${name}.json`), json);
}

const bootstrapDir = join(__dirname, '..', 'bootstrap');
writeFileSync(join(bootstrapDir, 'BOOTSTRAP_VERSION'), BOOTSTRAP_VERSION + '\n');
writeFileSync(join(bootstrapDir, 'BOOTSTRAP_HASH'), computeBootstrapHash() + '\n');

console.log(`Generated bootstrap artifacts (v${BOOTSTRAP_VERSION})`);
