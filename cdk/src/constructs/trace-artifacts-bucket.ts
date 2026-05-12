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

/** Lifecycle expiry for trace artifacts (design §10.1). */
export const TRACE_ARTIFACT_TTL_DAYS = 7;

/**
 * Object-key prefix used for all trace artifacts. Key layout:
 * ``traces/<user_id>/<task_id>.jsonl.gz`` (design §10.1). The per-user
 * prefix is load-bearing — the ``get-trace-url`` handler relies on the
 * caller's Cognito ``sub`` matching the TaskRecord's ``user_id`` to
 * authorize a presigned read, so the agent MUST write under its own
 * user prefix and never another user's.
 */
export const TRACE_OBJECT_KEY_PREFIX = 'traces/';

/**
 * Properties for TraceArtifactsBucket construct.
 */
export interface TraceArtifactsBucketProps {
  /**
   * Removal policy for the bucket.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to auto-delete objects when the bucket is removed. Mirrors
   * the developer-ergonomic goal of ``TaskTable`` / ``TaskEventsTable``
   * (no hand-cleanup required before ``cdk destroy``). Unlike DynamoDB
   * tables — which auto-empty on table delete — S3 requires a custom
   * resource to clear out the bucket, so enabling this flag deploys
   * CDK's ``Custom::S3AutoDeleteObjects`` Lambda with delete permissions
   * on this bucket (wider IAM surface than ``grantPut(runtime)`` alone
   * suggests; the auto-delete Lambda role is active, not just during
   * destroy).
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
 *
 * Security / hygiene:
 *  - ``blockPublicAccess: BLOCK_ALL`` + ``enforceSSL: true`` —
 *    no public read, TLS-only transport.
 *  - ``encryption: S3_MANAGED`` — server-side encryption at rest.
 *  - 7-day lifecycle expiry per §10.1 (debug captures are not an
 *    archival concern; tight TTL keeps storage cost bounded and caps
 *    the blast radius of an accidental permission leak).
 */
export class TraceArtifactsBucket extends Construct {
  /** The underlying S3 bucket. */
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
          // Reap incomplete multipart uploads after 1 day. Object
          // expiration does not apply to in-flight MPUs (they are not
          // objects yet), so a separate reaper is needed to keep stale
          // upload parts from lingering and accruing storage cost.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });
  }
}
