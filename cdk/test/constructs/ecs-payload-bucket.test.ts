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
import { ECS_PAYLOAD_TTL_DAYS, EcsPayloadBucket } from '../../src/constructs/ecs-payload-bucket';

describe('EcsPayloadBucket', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new EcsPayloadBucket(stack, 'EcsPayloadBucket');
    template = Template.fromStack(stack);
  });

  test('creates an S3 bucket with all public access blocked', () => {
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

  test('attaches a bucket policy enforcing TLS-only access', () => {
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

  test('configures a 1-day expiration lifecycle rule (payloads are ephemeral)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ecs-payload-ttl',
            Status: 'Enabled',
            ExpirationInDays: ECS_PAYLOAD_TTL_DAYS,
          }),
        ]),
      },
    });
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

  test('sets DESTROY removal policy by default', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test('enables autoDeleteObjects by default (matches TraceArtifactsBucket / AttachmentsBucket)', () => {
    template.hasResourceProperties('Custom::S3AutoDeleteObjects', {
      BucketName: Match.anyValue(),
    });
  });

  test('exposes a bucket handle via the `bucket` property', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const payload = new EcsPayloadBucket(stack, 'EcsPayloadBucket');
    expect(payload.bucket).toBeDefined();
    expect(payload.bucket.bucketName).toBeDefined();
  });
});

describe('EcsPayloadBucket with custom props', () => {
  test('accepts custom removal policy and disables autoDelete', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new EcsPayloadBucket(stack, 'EcsPayloadBucket', {
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    const customResources = template.findResources('Custom::S3AutoDeleteObjects');
    expect(Object.keys(customResources)).toHaveLength(0);
  });
});

describe('EcsPayloadBucket exported constants', () => {
  test('TTL is 1 day (ephemeral payload, deleted promptly at finalize)', () => {
    expect(ECS_PAYLOAD_TTL_DAYS).toBe(1);
  });
});
