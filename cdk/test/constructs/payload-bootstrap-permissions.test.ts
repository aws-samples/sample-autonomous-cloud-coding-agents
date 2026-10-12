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

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { grantCoordinatorPayloads, grantWorkerBootstrap } from '../../src/constructs/payload-bootstrap-permissions';

describe('payload bootstrap permission boundary', () => {
  let template: Template;
  beforeAll(() => {
    const stack = new Stack(new App(), 'PayloadPermissions');
    const bucket = new s3.Bucket(stack, 'Payloads');
    const worker = new iam.Role(stack, 'Worker', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const coordinator = new iam.Role(stack, 'Coordinator', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    grantWorkerBootstrap(bucket, worker);
    grantCoordinatorPayloads(bucket, coordinator);
    template = Template.fromStack(stack);
  });

  test('worker can read only deployment manifests, including against another public bucket', () => {
    const policy = Object.entries(template.findResources('AWS::IAM::Policy'))
      .find(([id]) => id.startsWith('Worker'))![1].Properties.PolicyDocument.Statement;
    expect(policy).toHaveLength(3);
    const allow = policy.find((s: { Effect: string }) => s.Effect === 'Allow');
    expect(allow.Action).toBe('s3:GetObject');
    expect(JSON.stringify(allow.Resource)).toContain('/bootstrap/*');
    const deny = policy.find((s: { NotResource?: unknown }) => s.NotResource);
    expect(deny.Effect).toBe('Deny');
    expect(deny.Action).toBe('s3:GetObject*');
    expect(deny.NotResource).toEqual(allow.Resource);
    expect(policy.find((s: { Action: string }) => s.Action === 's3:List*').Effect).toBe('Deny');
    expect(JSON.stringify(policy)).not.toContain('s3:Put');
    expect(JSON.stringify(policy)).not.toContain('s3:Delete');
  });

  test('coordinator publishes manifests and privately persists, signs and deletes task references', () => {
    const policy = Object.entries(template.findResources('AWS::IAM::Policy'))
      .find(([id]) => id.startsWith('Coordinator'))![1].Properties.PolicyDocument.Statement;
    const writes = policy.find((s: { Action: string }) => s.Action === 's3:PutObject');
    expect(JSON.stringify(writes.Resource)).toContain('/bootstrap/*');
    const reads = policy.find((s: { Action: string[] }) => Array.isArray(s.Action) && s.Action.includes('s3:GetObject'));
    expect(reads.Action).toEqual(['s3:GetObject', 's3:DeleteObject']);
    expect(JSON.stringify(reads.Resource)).toContain('*/payload.json');
    expect(JSON.stringify(reads.Resource)).toContain('*/launch.json');
    expect(JSON.stringify(reads.Resource)).not.toContain('/bootstrap/*');
    const list = policy.find((s: { Action: string }) => s.Action === 's3:ListBucket');
    expect(list.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Payloads/), 'Arn'] });
  });
});
