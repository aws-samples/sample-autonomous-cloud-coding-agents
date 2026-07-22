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

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  REGISTRY_ARTIFACT_NONCURRENT_TTL_DAYS,
  RegistryArtifactsBucket,
} from '../../src/constructs/registry-artifacts-bucket';

describe('RegistryArtifactsBucket', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new RegistryArtifactsBucket(stack, 'RegistryArtifactsBucket');
    template = Template.fromStack(stack);
  });

  test('blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('enables S3-managed server-side encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
  });

  test('enables versioning (artifacts are durable, referenced by pinned tasks)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('enforces TLS-only access via bucket policy', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('expires noncurrent versions rather than current objects', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'registry-artifact-noncurrent-expiry',
            Status: 'Enabled',
            NoncurrentVersionExpiration: {
              NoncurrentDays: REGISTRY_ARTIFACT_NONCURRENT_TTL_DAYS,
            },
          }),
        ]),
      },
    });
  });

  test('does NOT set a whole-object expiration (artifacts are durable)', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    const [bucket] = Object.values(buckets);
    const rules = bucket.Properties.LifecycleConfiguration.Rules as Array<Record<string, unknown>>;
    for (const rule of rules) {
      expect(rule.ExpirationInDays).toBeUndefined();
    }
  });

  test('aborts incomplete multipart uploads within a day', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }),
        ]),
      },
    });
  });

  test('sets DESTROY removal policy + autoDelete by default', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    template.hasResourceProperties('Custom::S3AutoDeleteObjects', {
      BucketName: Match.anyValue(),
    });
  });

  test('exposes a bucket handle via the `bucket` property', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const b = new RegistryArtifactsBucket(stack, 'RegistryArtifactsBucket');
    expect(b.bucket).toBeDefined();
    expect(b.bucket.bucketName).toBeDefined();
  });
});

describe('RegistryArtifactsBucket with custom props', () => {
  test('accepts a RETAIN removal policy and disables autoDelete', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new RegistryArtifactsBucket(stack, 'RegistryArtifactsBucket', {
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    expect(Object.keys(template.findResources('Custom::S3AutoDeleteObjects'))).toHaveLength(0);
  });
});
