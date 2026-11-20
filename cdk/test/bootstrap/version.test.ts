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

import { PolicyDocument } from 'aws-cdk-lib/aws-iam';
import * as nestedStackPolicy from '../../src/bootstrap/nested-stack-policy';
import * as bootstrapPolicies from '../../src/bootstrap/policies';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../../src/bootstrap/version';

describe('bootstrap version module', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function hashDocument(document: Record<string, unknown>): string {
    const policy = new PolicyDocument();
    jest.spyOn(policy, 'toJSON').mockReturnValue(document);
    jest.spyOn(bootstrapPolicies, 'allPolicies').mockReturnValue([policy]);
    return computeBootstrapHash();
  }

  const statement = {
    Effect: 'Allow',
    Action: 'iam:PassRole',
    Resource: 'arn:aws:iam::123456789012:role/example',
    Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
  };

  it.each([
    { Action: 'iam:CreateRole' },
    { Effect: 'Deny' },
    { Resource: 'arn:aws:iam::123456789012:role/other' },
    { Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } } },
  ])('hash changes when nested permissions change: %j', (change) => {
    const before = hashDocument({ Version: '2012-10-17', Statement: [statement] });
    const after = hashDocument({ Version: '2012-10-17', Statement: [{ ...statement, ...change }] });
    expect(after).not.toBe(before);
  });

  it('ignores object key order at every depth', () => {
    const before = hashDocument({ Version: '2012-10-17', Statement: [statement] });
    const after = hashDocument({
      Statement: [{
        Condition: statement.Condition,
        Resource: statement.Resource,
        Action: statement.Action,
        Effect: statement.Effect,
      }],
      Version: '2012-10-17',
    });
    expect(after).toBe(before);
  });

  it('includes the generated inline execution policy in the hash', () => {
    const before = computeBootstrapHash();
    const policy = nestedStackPolicy.nestedStackExecutionPolicy();
    policy.Statement[0].Action = 'iam:GetRole';
    jest.spyOn(nestedStackPolicy, 'nestedStackExecutionPolicy').mockReturnValue(policy);
    expect(computeBootstrapHash()).not.toBe(before);
  });

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
