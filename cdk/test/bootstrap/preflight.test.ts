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

import { compareVersions, evaluateBootstrap } from '../../src/bootstrap/preflight';

const EXPECTED = { version: '1.7.0', hash: 'a'.repeat(64) };
const outputs = (version?: string, hash?: string) => [
  { OutputKey: 'BootstrapVersion', OutputValue: '32' },
  ...(version ? [{ OutputKey: 'BootstrapPolicyVersion', OutputValue: version }] : []),
  ...(hash ? [{ OutputKey: 'BootstrapPolicyHash', OutputValue: hash }] : []),
];

describe('compareVersions', () => {
  it('orders dotted versions numerically, not lexically', () => {
    expect(compareVersions('1.6.0', '1.7.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.7', '1.7.0')).toBe(0);
  });
});

describe('evaluateBootstrap', () => {
  it('fails when the account was never bootstrapped', () => {
    const verdict = evaluateBootstrap(null, EXPECTED);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/not bootstrapped/);
  });

  it('fails fast on an older policy bundle, naming both versions and the fix', () => {
    const verdict = evaluateBootstrap(outputs('1.6.0', 'b'.repeat(64)), EXPECTED);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/1\.6\.0.*1\.7\.0/);
    expect(verdict.message).toMatch(/mise \/\/cdk:bootstrap/);
  });

  it('fails when the version matches but the policies differ', () => {
    const verdict = evaluateBootstrap(outputs('1.7.0', 'b'.repeat(64)), EXPECTED);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/bump BOOTSTRAP_VERSION/);
  });

  it('passes on an exact match', () => {
    expect(evaluateBootstrap(outputs('1.7.0', EXPECTED.hash), EXPECTED)).toEqual({ ok: true, message: expect.stringMatching(/matches/) });
  });

  it('passes on a newer bundle (forward-compatible accounts)', () => {
    expect(evaluateBootstrap(outputs('1.8.0', 'c'.repeat(64)), EXPECTED).ok).toBe(true);
  });

  it('passes, and says why, on a plain CDK bootstrap without ABCA outputs', () => {
    const verdict = evaluateBootstrap(outputs(), EXPECTED);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toMatch(/not the ABCA least-privilege bootstrap/);
  });
});
