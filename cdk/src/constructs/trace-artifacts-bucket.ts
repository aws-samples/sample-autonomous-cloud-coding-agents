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
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export const TRACE_ARTIFACT_TTL_DAYS = 7;

export { TRACE_OBJECT_KEY_PREFIX } from '../handlers/shared/storage-names';

export interface TraceArtifactsBucketProps {
  /**
   * Removal policy for the bucket.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to auto-delete objects when the bucket is removed. Enabling it
   * deploys CDK's ``Custom::S3AutoDeleteObjects`` Lambda with delete permissions
   * on this bucket.
   * @default true
   */
  readonly autoDeleteObjects?: boolean;
}

/**
 * S3 bucket for ``--trace`` trajectory artifacts (design §10.1).
 *
 * On terminal state, agents submitted with ``--trace`` upload a gzipped
 * JSONL dump of the full trajectory (SDK message log + tool I/O + hook
 * callbacks) to ``s3://<bucket>/traces/<user_id>/<task_id>.jsonl.gz``.
 * The CLI retrieves it via a presigned URL issued by the
 * ``get-trace-url`` handler.
 */
export class TraceArtifactsBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: TraceArtifactsBucketProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'trace-artifacts-ttl',
          enabled: true,
          expiration: Duration.days(TRACE_ARTIFACT_TTL_DAYS),
          // S3 object expiration does not apply to incomplete multipart uploads.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });
  }
}
