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

import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../../src/bootstrap/version';

describe('bootstrap version module', () => {
  it('BOOTSTRAP_VERSION matches semver format', () => {
    expect(BOOTSTRAP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('computeBootstrapHash returns a 64-char hex string (SHA256)', () => {
    const hash = computeBootstrapHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash is deterministic (calling twice gives same result)', () => {
    const hash1 = computeBootstrapHash();
    const hash2 = computeBootstrapHash();
    expect(hash1).toBe(hash2);
  });

  it('hash is stable', () => {
    const hash = computeBootstrapHash();
    expect(hash).toMatchSnapshot();
  });
});
