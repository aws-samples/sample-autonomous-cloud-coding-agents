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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { infrastructurePolicy, applicationPolicy, observabilityPolicy } from '../../src/bootstrap/policies';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../../src/bootstrap/version';

const artifactsDir = join(__dirname, '..', '..', 'bootstrap');

describe('Bootstrap artifact sync', () => {
  it('committed BOOTSTRAP_HASH matches computed hash', () => {
    const committed = readFileSync(join(artifactsDir, 'BOOTSTRAP_HASH'), 'utf-8').trim();
    expect(committed).toBe(computeBootstrapHash());
  });

  it('committed BOOTSTRAP_VERSION matches source constant', () => {
    const committed = readFileSync(join(artifactsDir, 'BOOTSTRAP_VERSION'), 'utf-8').trim();
    expect(committed).toBe(BOOTSTRAP_VERSION);
  });

  describe('committed JSON artifacts match current policy output', () => {
    const cases = [
      { name: 'infrastructure', fn: infrastructurePolicy },
      { name: 'application', fn: applicationPolicy },
      { name: 'observability', fn: observabilityPolicy },
    ] as const;

    for (const { name, fn } of cases) {
      it(`${name}.json is in sync`, () => {
        const committed = JSON.parse(
          readFileSync(join(artifactsDir, 'policies', `${name}.json`), 'utf-8'),
        );
        const generated = fn().toJSON();
        expect(committed).toEqual(generated);
      });
    }
  });
});
