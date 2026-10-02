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

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import constants from '../../../contracts/constants.json';

/** Durable task recovery data. Active checkpoints must not expire with debug traces. */
export class ContinuationBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id: 'abandoned-multipart-uploads',
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      }],
    });
    NagSuppressions.addResourceSuppressions(this.bucket, [{
      id: 'AwsSolutions-S1',
      reason: 'Recovery data is private and task-scoped through IAM; coordinator cleanup runs after task closure. No public or anonymous access path. Server access logging is not enabled for task storage.',
    }]);
  }

  /** A worker can save/read its own task versions, never list or remove data. */
  public grantWorker(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      resources: [this.bucket.arnForObjects(
        `${constants.microvm_continuation.object_key_prefix}\${aws:PrincipalTag/task_id}/*`,
      )],
    }));
  }

  /** Coordinator owns launch inputs and cleanup after a task closes. */
  public grantCoordinator(grantee: iam.IGrantable): void {
    const prefix = constants.microvm_continuation.object_key_prefix;
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [this.bucket.arnForObjects(`${prefix}*`)],
    }));
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucketVersions'],
      resources: [this.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': `${prefix}*` } },
    }));
  }
}
