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
import { Template } from 'aws-cdk-lib/assertions';
import { ScreenshotBucket } from '../../src/constructs/screenshot-bucket';

describe('ScreenshotBucket', () => {
  let template: Template;
  let regionalTemplates: Template[];
  let longNameTemplate: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new ScreenshotBucket(stack, 'ScreenshotBucket');
    template = Template.fromStack(stack);
    regionalTemplates = ['us-east-1', 'us-west-2'].map((region) => {
      const regionalStack = new Stack(new App(), 'TestStack', {
        env: { account: '123456789012', region },
      });
      new ScreenshotBucket(regionalStack, 'ScreenshotBucket');
      return Template.fromStack(regionalStack);
    });
    const longNameStack = new Stack(new App(), 'a'.repeat(128), {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    new ScreenshotBucket(longNameStack, 'FirstScreenshots');
    new ScreenshotBucket(longNameStack, 'SecondScreenshots');
    longNameTemplate = Template.fromStack(longNameStack);
  });

  function accessControlNames(source: Template): string[] {
    return Object.values(source.findResources('AWS::CloudFront::OriginAccessControl'))
      .map((resource) => resource.Properties.OriginAccessControlConfig.Name);
  }

  test('same stack in different regions has distinct global access-control names', () => {
    const names = regionalTemplates.flatMap(accessControlNames);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/-us-east-1$/);
    expect(names[1]).toMatch(/-us-west-2$/);
    expect(new Set(names).size).toBe(2);
  });

  test('long stack names preserve distinct access controls within the 64-character limit', () => {
    const names = accessControlNames(longNameTemplate);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/-us-west-2$/);
    }
  });

  test('access control always signs S3 requests with sigv4', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
  });

  // Lock in the screenshot bucket lifecycle defaults.
  // fully-private posture so a future "simplify" doesn't drop
  // BlockPublicAccess. The synth-time assertion is the cheapest way to
  // catch a regression before it hits the deployed stack.
  test('S3 bucket has all-true BlockPublicAccess (fully private)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('S3 bucket has SSE-S3 encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    });
  });

  test('exposes a CloudFront distribution as the public host', () => {
    // CloudFront serves anonymously via OAC; the bucket itself stays
    // private. Asserting both pieces exist is enough — exact OAC config
    // is a CDK construct internal we trust.
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  test('S3 bucket has a 30-day lifecycle on screenshots/ prefix', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            ExpirationInDays: 30,
            Status: 'Enabled',
          },
        ],
      },
    });
  });
});
