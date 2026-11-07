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

/**
 * Lifecycle expiry for ECS task payloads. The payload is consumed once, at
 * container boot, and the orchestrator deletes it promptly in the ``finalize``
 * step. This 1-day rule is only a crash backstop: if the orchestrator dies
 * before finalize (rare — it runs under durable execution), the object is still
 * reaped within a day instead of lingering. Payloads carry the hydrated prompt
 * context, so a tight TTL also keeps the blast radius of an accidental
 * permission leak small.
 */
export const ECS_PAYLOAD_TTL_DAYS = 1;

/**
 * Properties for the EcsPayloadBucket construct.
 */
export interface EcsPayloadBucketProps {
  /**
   * Removal policy for the bucket.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to auto-delete objects when the bucket is removed (so ``cdk
   * destroy`` does not need a manual bucket-empty first). Mirrors
   * ``TraceArtifactsBucket`` / ``AttachmentsBucket``. Deploys CDK's
   * ``Custom::S3AutoDeleteObjects`` Lambda with delete permissions on this
   * bucket — acceptable here because the contents are ephemeral throwaway
   * payloads.
   * @default true
   */
  readonly autoDeleteObjects?: boolean;
}

/**
 * Storage for ECS v2 bootstrap manifests, task payloads and private references.
 *
 * RunTask caps the entire overrides object at 8192 bytes. The coordinator
 * writes task instructions to <taskId>/payload.json and passes AGENT_PAYLOAD_REF,
 * containing an authenticated-manifest URI and a signed one-object URL.
 * EcsAgentCluster grants the worker only bootstrap/* reads and explicitly denies
 * other object reads/listing. The coordinator owns writes, signing and cleanup.
 *
 * A dedicated bucket separates boot data from attachments/traces and gives it
 * a one-day lifecycle backstop. Finalize deletes payload.json and launch.json;
 * shared deployment manifests expire through the lifecycle rule.
 *
 * Security / hygiene (parity with TraceArtifactsBucket):
 *  - ``blockPublicAccess: BLOCK_ALL`` + ``enforceSSL: true`` — no public read,
 *    TLS-only transport.
 *  - ``encryption: S3_MANAGED`` — server-side encryption at rest.
 *  - 1-day lifecycle expiry — payloads are ephemeral (read once at boot,
 *    deleted by the orchestrator at finalize); this is the crash backstop.
 */
export class EcsPayloadBucket extends Construct {
  /** The underlying S3 bucket. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EcsPayloadBucketProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ecs-payload-ttl',
          enabled: true,
          expiration: Duration.days(ECS_PAYLOAD_TTL_DAYS),
          // Reap incomplete multipart uploads after 1 day. Object expiration
          // does not apply to in-flight MPUs (they are not objects yet), so a
          // separate reaper keeps stale upload parts from lingering.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });
  }
}
