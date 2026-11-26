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

import { NestedStack, type NestedStackProps, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface LinearVaultConsentPageProps {
  readonly removalPolicy?: RemovalPolicy;
  readonly autoDeleteObjects?: boolean;
}

/**
 * The consent landing page. `consentUrl` is what gets registered on the workload
 * identity's return-URL allowlist and passed as `resourceOauth2ReturnUrl`.
 */
export class LinearVaultConsentPage extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  /** `https://<dist>.cloudfront.net/` — the allowlisted return URL. */
  public readonly consentUrl: string;

  constructor(scope: Construct, id: string, props: LinearVaultConsentPageProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      enableLogging: false,
      comment: 'ABCA Linear vault consent landing page',
    });

    new s3deploy.BucketDeployment(this, 'Page', {
      destinationBucket: this.bucket,
      sources: [s3deploy.Source.data('index.html', renderConsentPage())],
      distribution: this.distribution,
      distributionPaths: ['/index.html'],
      prune: true,
    });

    this.consentUrl = `https://${this.distribution.distributionDomainName}/`;

    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logs are not enabled. The bucket holds a single public, static HTML page with no user data — access logging would be pure volume for no security signal.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.distribution, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'No geo restriction: operators onboard workspaces from anywhere, and that is the whole point of a hosted consent page.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'No WAF. The distribution serves one immutable static HTML page with no server-side logic, no auth, and no input handling — the session id is rendered client-side into textContent, never interpolated into markup.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'Distribution access logs are not enabled — same rationale as the bucket (single static page, no user data).',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'Uses the default *.cloudfront.net certificate (TLSv1+ enforced by AWS); no custom domain, so no minimum-TLS-version override applies.',
      },
    ], true);

    // BucketDeployment's handler is a CDK-managed SINGLETON created at STACK
    // scope, not inside this construct. Its id carries a version-dependent hash
    // (`Custom::CDKBucketDeployment<hash>`).
    const stack = Stack.of(this);
    for (const child of stack.node.children) {
      if (!child.node.id.startsWith('Custom::CDKBucketDeployment')) continue;
      NagSuppressions.addResourceSuppressions(child, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK BucketDeployment singleton Lambda uses AWS managed AWSLambdaBasicExecutionRole — required by the CDK s3-deployment framework',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK BucketDeployment singleton grants wildcard read on the CDK assets bucket and read/write on the destination bucket objects; the grants are generated by the framework, not authored here',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK BucketDeployment singleton Lambda runtime is managed by the CDK s3-deployment framework',
        },
      ], true);
    }
  }
}

/**
 * {@link LinearVaultConsentPage} in its own nested stack, which keeps its ~10
 * resources out of the root stack's CloudFormation 500-resource limit.
 *
 * `consentUrl` is surfaced so the parent can register it on the workload identity's
 * return-URL allowlist and publish it as an output.
 */
export class LinearVaultConsentPageStack extends NestedStack {
  public readonly consentUrl: string;

  constructor(scope: Construct, id: string, props: LinearVaultConsentPageProps & NestedStackProps = {}) {
    super(scope, id, props);
    const page = new LinearVaultConsentPage(this, 'ConsentPage', {
      ...(props.removalPolicy !== undefined && { removalPolicy: props.removalPolicy }),
      ...(props.autoDeleteObjects !== undefined && { autoDeleteObjects: props.autoDeleteObjects }),
    });
    this.consentUrl = page.consentUrl;
  }
}

/**
 * The page itself. Self-contained: no external scripts, styles, or fonts.
 *
 * The session id comes from the query string, so it is untrusted input reflected
 * onto the page. It is assigned via `textContent` ONLY, never as markup.
 */
export function renderConsentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<!-- Empty data: icon so the browser does not auto-request /favicon.ico. The bucket
     holds only this page, so that request 403s, and an operator watching the
     network tab mid-consent sees a red failure that has nothing to do with them. -->
<link rel="icon" href="data:,">
<title>Linear authorized — ABCA</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 1.5rem; }
  main { max-width: 40rem; width: 100%; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .75rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
  pre { padding: .75rem; border-radius: .5rem; overflow-x: auto;
        border: 1px solid rgba(128,128,128,.35); background: rgba(128,128,128,.10); }
  .muted { opacity: .75; font-size: .875rem; }
</style>
</head>
<body>
<main>
  <h1 id="title">Finishing up…</h1>
  <p id="lede"></p>
  <pre id="session"></pre>
  <p class="muted" id="hint"></p>
</main>
<script>
  (function () {
    var params = new URLSearchParams(window.location.search);
    // Two flows land here. The vault (3LO) bounce carries session_id; the direct
    // OAuth redirect carries code (+ state). Serving both from one page is what
    // lets an operator onboard with NO localhost listener at all.
    var sessionId = params.get('session_id') || '';
    var code = params.get('code') || '';
    var state = params.get('state') || '';
    var title = document.getElementById('title');
    var lede = document.getElementById('lede');
    var session = document.getElementById('session');
    var hint = document.getElementById('hint');
    // The CLI is sitting on a prompt waiting for this value, so the whole job of
    // this page is to show one thing to copy. It used to also print a command to
    // run, which was both a second thing to read and wrong as soon as the command
    // changed — the page ships with the stack and drifts from the CLI silently.
    if (sessionId || code) {
      title.textContent = 'Linear authorized';
      lede.textContent = 'Paste this into your terminal:';
      // The direct flow hands back code AND state as a query fragment, so the CLI can
      // check state against the value it generated — the OAuth correlation check that
      // stops a code obtained elsewhere being pasted in and exchanged. Encoded as one
      // string so the operator still copies a single thing.
      // NOTE: no backticks anywhere in this script — it lives inside a TS template
      // literal, and one would terminate it. Cost a broken build twice.
      // Assigned as TEXT, never as markup — this value is untrusted query input.
      session.textContent = sessionId || (state ? 'code=' + code + '&state=' + state : code);
      hint.textContent = 'You can close this tab.';
    } else {
      title.textContent = 'Nothing to finish here';
      lede.textContent = 'This page shows the value that finishes onboarding, and only after '
        + 'an authorization redirect sends you here. Run: bgagent linear setup <workspace>';
      session.remove();
      hint.remove();
    }
  })();
</script>
</body>
</html>
`;
}
