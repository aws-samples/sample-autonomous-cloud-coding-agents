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

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LinearVaultConsentPage, renderConsentPage } from '../../src/constructs/linear-vault-consent-page';

function synth(): { template: Template; page: LinearVaultConsentPage } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const page = new LinearVaultConsentPage(stack, 'LinearVaultConsentPage');
  return { template: Template.fromStack(stack), page };
}

describe('LinearVaultConsentPage construct', () => {
  test('serves the page from a PRIVATE bucket via CloudFront + OAC', () => {
    const { template } = synth();
    // Bucket blocks all public access — the page is public via CloudFront only.
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
    // The bucket policy must grant the distribution, never a wildcard principal.
    const policies = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toContain('cloudfront.amazonaws.com');
    expect(policies).not.toContain('"Principal":"*"');
  });

  test('exposes an https consent URL on the distribution domain', () => {
    const { page } = synth();
    // Unresolved token at synth; assert the shape we build around it.
    expect(page.consentUrl.startsWith('https://')).toBe(true);
    expect(page.consentUrl.endsWith('/')).toBe(true);
  });
});

describe('the consent page itself', () => {
  const html = renderConsentPage();

  test('renders the session id with textContent, NEVER innerHTML (reflected-XSS guard)', () => {
    // The session id arrives in the query string, so it is untrusted input
    // reflected onto the page. Assigning it as markup would turn a static page
    // into a reflected-XSS vector — this is the one line that must not regress.
    expect(html).toContain('session.textContent = sessionId');
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('document.write');
    expect(html).not.toContain('outerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
    // No eval-style sinks either.
    expect(html).not.toMatch(/\beval\(/);
  });

  test('is self-contained — no external scripts, styles, fonts or images', () => {
    // Renders on a locked-down browser, and has nothing to exfiltrate the session
    // id to.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  test('reads session_id from the query string and tells the operator what to run', () => {
    expect(html).toContain("params.get('session_id')");
    expect(html).toContain('bgagent linear vault-setup');
  });

  test('degrades to a clear message when opened without a session_id', () => {
    expect(html).toContain('Nothing to finish here');
  });

  test('asks not to be indexed (it is a one-shot operator landing page)', () => {
    expect(html).toContain('noindex');
  });
});
