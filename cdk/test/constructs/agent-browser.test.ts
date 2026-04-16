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
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AgentBrowser } from '../../src/constructs/agent-browser';

function createStack(props?: { browserName?: string; screenshotRetentionDays?: number }): {
  stack: Stack;
  template: Template;
  agentBrowser: AgentBrowser;
} {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const agentBrowser = new AgentBrowser(stack, 'AgentBrowser', props);
  const template = Template.fromStack(stack);
  return { stack, template, agentBrowser };
}

describe('AgentBrowser construct', () => {
  test('creates a BrowserCustom resource', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::BedrockAgentCore::BrowserCustom', 1);
  });

  test('creates an S3 bucket with encryption and lifecycle', () => {
    const { template } = createStack();
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
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 30,
            Status: 'Enabled',
          }),
        ]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates a Lambda function with correct env vars', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          BROWSER_ID: Match.anyValue(),
          SCREENSHOT_BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('creates a Gateway resource', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
  });

  test('uses default browser name', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', {
      Name: 'bgagent_browser',
    });
  });

  test('accepts custom browser name', () => {
    const { template } = createStack({ browserName: 'custom_browser' });
    template.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', {
      Name: 'custom_browser',
    });
  });

  test('exposes browser, gateway, browserToolFn, screenshotBucket', () => {
    const { agentBrowser } = createStack();
    expect(agentBrowser.browser).toBeDefined();
    expect(agentBrowser.gateway).toBeDefined();
    expect(agentBrowser.browserToolFn).toBeDefined();
    expect(agentBrowser.screenshotBucket).toBeDefined();
  });

  test('grantInvokeBrowserTool grants lambda:InvokeFunction', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const agentBrowser = new AgentBrowser(stack, 'AgentBrowser');

    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    agentBrowser.grantInvokeBrowserTool(role);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('grantReadScreenshots grants S3 read', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const agentBrowser = new AgentBrowser(stack, 'AgentBrowser');

    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    agentBrowser.grantReadScreenshots(role);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              's3:GetObject*',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
      Roles: Match.arrayWith([
        { Ref: Match.stringLikeRegexp('TestRole') },
      ]),
    });
  });
});
