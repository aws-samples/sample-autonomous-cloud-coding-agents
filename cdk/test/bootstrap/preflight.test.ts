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

import { compareVersions, evaluateBootstrap, requiredPolicySet } from '../../src/bootstrap/preflight';

const BASE = ['Infrastructure', 'Application', 'Observability', 'Compute-Agentcore'];
const EXPECTED = { version: '1.7.0', hash: 'a'.repeat(64), policySet: BASE };
const outputs = (version?: string, hash?: string, policySet: string | undefined = BASE.join(',')) => [
  { OutputKey: 'BootstrapVersion', OutputValue: '32' },
  ...(version ? [{ OutputKey: 'BootstrapPolicyVersion', OutputValue: version }] : []),
  ...(hash ? [{ OutputKey: 'BootstrapPolicyHash', OutputValue: hash }] : []),
  ...(version && policySet !== undefined ? [{ OutputKey: 'BootstrapPolicySet', OutputValue: policySet }] : []),
];

describe('compareVersions', () => {
  it('orders dotted versions numerically, not lexically', () => {
    expect(compareVersions('1.6.0', '1.7.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.7', '1.7.0')).toBe(0);
  });
});

describe('requiredPolicySet', () => {
  it('adds the compute policy for each optional backend', () => {
    expect(requiredPolicySet(['agentcore'])).toEqual(BASE);
    expect(requiredPolicySet(['agentcore', 'ecs', 'lambda-microvm'])).toEqual([...BASE, 'Compute-ECS', 'Compute-LambdaMicrovms']);
  });
});

describe('evaluateBootstrap', () => {
  it('FAILs when the account was never bootstrapped', () => {
    expect(evaluateBootstrap(null, EXPECTED)).toEqual({ status: 'FAIL', message: expect.stringMatching(/not bootstrapped/) });
  });

  it('FAILs on a default CDK bootstrap without ABCA outputs', () => {
    expect(evaluateBootstrap(outputs(), EXPECTED)).toEqual({ status: 'FAIL', message: expect.stringMatching(/default CDK bootstrap/) });
  });

  it('FAILs fast on an older policy bundle, naming both versions and the fix', () => {
    const verdict = evaluateBootstrap(outputs('1.6.0', 'b'.repeat(64)), EXPECTED);
    expect(verdict.status).toBe('FAIL');
    expect(verdict.message).toMatch(/1\.6\.0.*1\.7\.0/);
    expect(verdict.message).toMatch(/mise \/\/cdk:bootstrap/);
  });

  it('FAILs when a compute policy the app needs was not bootstrapped', () => {
    const verdict = evaluateBootstrap(outputs('1.7.0', EXPECTED.hash), { ...EXPECTED, policySet: [...BASE, 'Compute-ECS'] });
    expect(verdict.status).toBe('FAIL');
    expect(verdict.message).toMatch(/Compute-ECS/);
  });

  it('WARNs, without blocking, when the version matches but the policies differ', () => {
    expect(evaluateBootstrap(outputs('1.7.0', 'b'.repeat(64)), EXPECTED).status).toBe('WARN');
  });

  it('PASSes on an exact match and on a newer bundle', () => {
    expect(evaluateBootstrap(outputs('1.7.0', EXPECTED.hash), EXPECTED).status).toBe('PASS');
    expect(evaluateBootstrap(outputs('1.8.0', 'c'.repeat(64)), EXPECTED).status).toBe('PASS');
  });

  it('tolerates a bundle that predates the BootstrapPolicySet output', () => {
    expect(evaluateBootstrap(outputs('1.7.0', EXPECTED.hash, undefined), EXPECTED).status).toBe('PASS');
  });
});
