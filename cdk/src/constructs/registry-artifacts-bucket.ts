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
 * How long a noncurrent (superseded) object version is retained before expiry.
 * The registry is immutable-per-version, so overwrites at a live key should not
 * happen; this rule reaps versions left behind by a ``removed`` tombstone or an
 * operational re-put, keeping storage bounded without touching current objects.
 */
export const REGISTRY_ARTIFACT_NONCURRENT_TTL_DAYS = 90;

/**
 * Properties for the RegistryArtifactsBucket construct.
 */
export interface RegistryArtifactsBucketProps {
  /**
   * Removal policy for the bucket. Registry artifacts are referenced by pinned
   * task records for audit/reproducibility, so production should RETAIN; the
   * construct default stays DESTROY for the sample stack's dev-first posture.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to auto-delete objects when the bucket is removed (so ``cdk
   * destroy`` does not need a manual bucket-empty first). Mirrors the other
   * sample-stack buckets.
   * @default true
   */
  readonly autoDeleteObjects?: boolean;
}

/**
 * S3 bucket for agent asset registry artifact bytes (#246; see
 * docs/design/REGISTRY.md §3.4 and ADR-018).
 *
 * Stores the artifact for each published asset version — the MCP server config
 * JSON, Cedar policy text, or skill prompt fragment — under the key
 * ``{kind}/{namespace}/{name}/{version}/artifact``. Metadata lives in
 * ``RegistryAssetsTable``; only the bytes live here.
 *
 * Differs from the ephemeral ``EcsPayloadBucket``: artifacts are durable
 * (referenced by pinned task records for audit and reproducibility), so
 * **versioning is ON** and there is no whole-object TTL — only a noncurrent-
 * version expiry to bound storage. Immutability of a published
 * ``(kind, namespace, name, version)`` is enforced at the DynamoDB write (409
 * on collision), not by S3 object-lock, so a ``removed`` status can tombstone a
 * record without a compliance-grade byte delete.
 *
 * Security / hygiene (parity with the other sample buckets):
 *  - ``blockPublicAccess: BLOCK_ALL`` + ``enforceSSL: true`` — no public read,
 *    TLS-only transport.
 *  - ``encryption: S3_MANAGED`` — server-side encryption at rest.
 *  - ``versioned: true`` — retain superseded bytes for audit.
 */
export class RegistryArtifactsBucket extends Construct {
  /** The underlying S3 bucket. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: RegistryArtifactsBucketProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'registry-artifact-noncurrent-expiry',
          enabled: true,
          noncurrentVersionExpiration: Duration.days(REGISTRY_ARTIFACT_NONCURRENT_TTL_DAYS),
          // Reap incomplete multipart uploads after 1 day so stale upload parts
          // (which object/version expiry does not cover) do not linger.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });
  }
}
