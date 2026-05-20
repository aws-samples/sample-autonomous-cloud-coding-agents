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

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/** Lifecycle expiry for screenshot artifacts. */
export const SCREENSHOT_TTL_DAYS = 30;

/**
 * Object-key prefix for all screenshots. Key layout:
 * ``screenshots/<task_id>.png``. The bucket policy grants public
 * ``s3:GetObject`` on this prefix only — anything written outside is
 * invisible to anonymous readers.
 */
export const SCREENSHOT_KEY_PREFIX = 'screenshots/';

/**
 * Build the public HTTPS URL for a screenshot object. Path-style URL is
 * intentional — virtual-hosted style breaks for buckets with dots in
 * the name (CDK auto-generated names sometimes include dots when the
 * region is appended).
 */
export function screenshotPublicUrl(bucket: s3.IBucket, key: string): string {
  const region = Stack.of(bucket).region;
  return `https://${bucket.bucketName}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Properties for ScreenshotBucket construct.
 */
export interface ScreenshotBucketProps {
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
 * S3 bucket hosting screenshot PNGs that the agent embeds in GitHub PR
 * + Linear issue comments.
 *
 * The agent writes ``screenshots/<task_id>.png`` after AgentCore Browser
 * captures the deployed GitHub Pages URL. Both GitHub Markdown rendering
 * and Linear's image previews fetch the URL anonymously, so the prefix
 * is configured for unauthenticated reads.
 *
 * Security shape:
 *  - ``blockPublicAcls`` and ``ignorePublicAcls`` true — no per-object ACLs
 *    can grant access; only the bucket policy decides.
 *  - ``blockPublicPolicy`` and ``restrictPublicBuckets`` false — the policy
 *    intentionally grants public read on ``screenshots/*``.
 *  - Bucket policy: anonymous ``s3:GetObject`` limited to the
 *    ``screenshots/*`` key prefix and TLS-only transport. Writes still
 *    require IAM (the agent's runtime role).
 *  - SSE-S3 at rest, ``enforceSSL`` true.
 *  - 30-day lifecycle so screenshots don't accumulate forever.
 */
export class ScreenshotBucket extends Construct {
  /** The underlying S3 bucket. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ScreenshotBucketProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      // Allow public bucket policy (the next statement); deny public ACLs.
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'screenshot-ttl',
          enabled: true,
          expiration: Duration.days(SCREENSHOT_TTL_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });

    // Public read on the screenshots/ prefix only. Both GitHub markdown
    // and Linear's `imageUploadFromUrl` need to GET the URL anonymously.
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAnonymousReadOfScreenshotsPrefix',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject'],
      resources: [`${this.bucket.bucketArn}/${SCREENSHOT_KEY_PREFIX}*`],
      conditions: {
        Bool: { 'aws:SecureTransport': 'true' },
      },
    }));

    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logs are not enabled for this bucket; screenshots are ephemeral artifacts (30-day TTL) embedded in GitHub PR comments and Linear issues. Adding access logging would generate substantial log volume for a low-value security signal — public reads are by design and the prefix is scoped to PNG renders only.',
      },
      {
        id: 'AwsSolutions-S5',
        reason:
          'Public-read on screenshots/* is intentional — GitHub markdown renderers and Linear imageUploadFromUrl both require anonymous GET on the embedded image URL. Followup #79 will move to CloudFront with signed URLs once the feature stabilizes.',
      },
    ], true);
  }
}
