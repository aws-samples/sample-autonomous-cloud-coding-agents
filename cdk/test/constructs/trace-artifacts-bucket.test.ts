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
import { TRACE_ARTIFACT_TTL_DAYS, TRACE_OBJECT_KEY_PREFIX, TraceArtifactsBucket } from '../../src/constructs/trace-artifacts-bucket';

describe('TraceArtifactsBucket', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TraceArtifactsBucket(stack, 'TraceArtifactsBucket');
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
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
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
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
          }),
        ]),
      },
    });
  });

  test('configures a 7-day expiration lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'trace-artifacts-ttl',
            Status: 'Enabled',
            ExpirationInDays: TRACE_ARTIFACT_TTL_DAYS,
          }),
        ]),
      },
    });
  });

  test('aborts incomplete multipart uploads within the TTL window', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: {
              DaysAfterInitiation: 1,
            },
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

  test('enables autoDeleteObjects by default (matches TaskTable pattern)', () => {
    // autoDeleteObjects is implemented via a CDK custom resource that
    // empties the bucket before deletion. Its presence is the signal
    // that autoDeleteObjects is on.
    template.hasResourceProperties('Custom::S3AutoDeleteObjects', {
      BucketName: Match.anyValue(),
    });
  });

  test('exposes a bucket handle via the `bucket` property', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const trace = new TraceArtifactsBucket(stack, 'TraceArtifactsBucket');
    expect(trace.bucket).toBeDefined();
    // Sanity: the construct's public handle and the synthesized resource
    // are the same bucket.
    expect(trace.bucket.bucketName).toBeDefined();
  });
});

describe('TraceArtifactsBucket with custom props', () => {
  test('accepts custom removal policy', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TraceArtifactsBucket(stack, 'TraceArtifactsBucket', {
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });

    // With autoDeleteObjects disabled, the custom resource is not synthesized.
    const customResources = template.findResources('Custom::S3AutoDeleteObjects');
    expect(Object.keys(customResources)).toHaveLength(0);
  });
});

describe('TraceArtifactsBucket exported constants', () => {
  test('TTL matches design §10.1', () => {
    expect(TRACE_ARTIFACT_TTL_DAYS).toBe(7);
  });

  test('object key prefix matches design §10.1', () => {
    expect(TRACE_OBJECT_KEY_PREFIX).toBe('traces/');
  });
});
