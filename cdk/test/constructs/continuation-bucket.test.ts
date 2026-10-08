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
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { ContinuationBucket } from '../../src/constructs/continuation-bucket';

test('active version-pinned checkpoints survive time and stack removal; workers cannot list/delete', () => {
  const stack = new Stack(new App(), 'Test');
  const storage = new ContinuationBucket(stack, 'Continuation');
  const worker = new iam.Role(stack, 'Worker', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  storage.grantWorker(worker);
  const template = Template.fromStack(stack);
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [{
          Id: 'abandoned-multipart-uploads',
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        }],
      },
    },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: [Match.objectLike({
        Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
        Resource: Match.anyValue(),
      })],
    },
  });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).toContain('continuations/${aws:PrincipalTag/task_id}/*');
  expect(policies).not.toContain('s3:List');
  expect(policies).not.toContain('s3:Delete');
});
