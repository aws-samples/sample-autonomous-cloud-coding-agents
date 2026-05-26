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

/** Lifecycle expiry for task attachments — matches task record retention. */
export const ATTACHMENT_TTL_DAYS = 90;

/** S3 key prefix for all attachments. Layout: attachments/<user_id>/<task_id>/<attachment_id>/<filename> */
export const ATTACHMENT_OBJECT_KEY_PREFIX = 'attachments/';

/**
 * Properties for AttachmentsBucket construct.
 */
export interface AttachmentsBucketProps {
  /**
   * Removal policy for the bucket.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to auto-delete objects when the bucket is removed.
   * @default true
   */
  readonly autoDeleteObjects?: boolean;
}

/**
 * S3 bucket for task attachment storage.
 *
 * Attachments (images, files, URL-fetched content) are uploaded during task
 * creation (inline or presigned), screened for security, and delivered to
 * the agent runtime during execution.
 *
 * Security:
 *  - ``blockPublicAccess: BLOCK_ALL`` + ``enforceSSL: true``
 *  - ``encryption: S3_MANAGED`` — server-side encryption at rest.
 *  - Versioning enabled — pins object versions at screening time to prevent
 *    TOCTOU attacks (client uploads benign content, replaces with malicious
 *    content before agent downloads).
 *  - 90-day lifecycle expiry (matches task record TTL).
 *  - 7-day noncurrent version expiration (covers longest-running tasks).
 */
export class AttachmentsBucket extends Construct {
  /** The underlying S3 bucket. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AttachmentsBucketProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'attachments-ttl',
          enabled: true,
          expiration: Duration.days(ATTACHMENT_TTL_DAYS),
          noncurrentVersionExpiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });
  }
}
