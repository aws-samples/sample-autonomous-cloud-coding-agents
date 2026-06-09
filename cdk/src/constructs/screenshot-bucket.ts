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
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/** Lifecycle expiry for screenshot artifacts. */
export const SCREENSHOT_TTL_DAYS = 30;

/**
 * Object-key prefix for all screenshots. Key layout:
 * ``screenshots/<repo>/<sha>.png``. The CloudFront distribution serves
 * the entire bucket, but the processor only ever writes under this
 * prefix.
 */
export const SCREENSHOT_KEY_PREFIX = 'screenshots/';

/**
 * Properties for ScreenshotBucket construct.
 */
export interface ScreenshotBucketProps {
  /**
   * Removal policy for the bucket + distribution.
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
 * Private S3 bucket fronted by a CloudFront distribution that serves
 * screenshot PNGs to GitHub Markdown / Linear render pipelines.
 *
 * Why CloudFront and not a public-read bucket: the AWS account-level
 * Block Public Access is on (S3 control plane refuses to attach any
 * public bucket policy), and disabling it would change the security
 * posture of the whole account. CloudFront with Origin Access Control
 * is the AWS-recommended path for "S3 object served anonymously over
 * HTTPS." Bucket stays fully private; only the distribution principal
 * has GetObject.
 *
 * Layout:
 *   s3://<bucket>/screenshots/<repo>/<sha>.png   (private)
 *   https://<dist>.cloudfront.net/screenshots/<repo>/<sha>.png   (anon)
 *
 * The 30-day lifecycle on the bucket is the source of truth for
 * expiry — CloudFront's edge caches will see 403s after the TTL
 * lapses, which is fine for stale PR comments.
 */
export class ScreenshotBucket extends Construct {
  /** The underlying private S3 bucket. */
  public readonly bucket: s3.Bucket;

  /** CloudFront distribution serving the bucket anonymously. */
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ScreenshotBucketProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
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

    // CloudFront → S3 via Origin Access Control. The bucket policy is
    // generated automatically by `S3BucketOrigin.withOriginAccessControl`
    // and grants `s3:GetObject` to the distribution's CF service principal
    // only — no anonymous principal in the policy, so account-level BPA
    // doesn't reject it.
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Screenshots are immutable per (repo, sha) — long TTL is safe
        // and minimizes origin S3 requests on hot PRs.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      // No alternate domain or ACM cert — the default
      // *.cloudfront.net hostname is fine for a backend artifact host.
      enableLogging: false,
      comment: 'ABCA screenshot artifacts (private S3 + OAC)',
    });

    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logs are not enabled for this bucket; screenshots are ephemeral artifacts (30-day TTL) embedded in GitHub PR comments. Adding access logging would generate substantial log volume for a low-value security signal.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.distribution, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'No geo restrictions are needed — screenshots are referenced from GitHub.com which is global; restricting origins would break cross-region PR reviewers.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'AWS WAF is not attached to this distribution. The content is read-only PNGs of preview deploys; no app logic, no input handling, no auth — WAF would only add cost without reducing risk.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'Access logs are not enabled on the distribution for the same reason as the bucket — low-value high-volume signal for ephemeral artifacts.',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'Distribution uses the default *.cloudfront.net certificate (TLSv1+ enforced by AWS). No custom domain, so no minimum-TLS-version override needed.',
      },
      {
        id: 'AwsSolutions-CFR7',
        reason: 'OAC is in use (the construct calls `S3BucketOrigin.withOriginAccessControl`). cdk-nag misclassifies the L2 helper as an OAI deployment.',
      },
    ], true);
  }
}
