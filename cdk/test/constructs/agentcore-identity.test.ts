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

import { App, SecretValue, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AgentCoreIdentity } from '../../src/constructs/agentcore-identity';

function createStack(): { stack: Stack; template: Template; identity: AgentCoreIdentity } {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });

  const identity = new AgentCoreIdentity(stack, 'Identity', {
    workloadIdentityName: 'test-agent',
    githubOAuth: {
      credentialProviderName: 'test-github',
      clientId: 'Iv1.test123',
      clientSecret: SecretValue.unsafePlainText('test-secret'),
    },
  });

  const template = Template.fromStack(stack);
  return { stack, template, identity };
}

describe('AgentCoreIdentity construct', () => {
  test('creates a CfnWorkloadIdentity with the correct name', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::BedrockAgentCore::WorkloadIdentity', {
      Name: 'test-agent',
    });
  });

  test('creates a CfnOAuth2CredentialProvider with GithubOauth2 vendor', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::BedrockAgentCore::OAuth2CredentialProvider', {
      Name: 'test-github',
      CredentialProviderVendor: 'GithubOauth2',
      Oauth2ProviderConfigInput: {
        GithubOauth2ProviderConfig: {
          ClientId: 'Iv1.test123',
          ClientSecret: 'test-secret',
        },
      },
    });
  });

  test('exposes workloadIdentityName and credentialProviderName', () => {
    const { identity } = createStack();
    expect(identity.workloadIdentityName).toBe('test-agent');
    expect(identity.credentialProviderName).toBe('test-github');
  });

  test('creates a CfnOutput for the callback URL', () => {
    const { template } = createStack();
    // CfnOutput logical IDs include the construct path prefix
    const outputs = template.findOutputs('*');
    const callbackOutput = Object.entries(outputs).find(
      ([key]) => key.includes('GitHubOAuthCallbackUrl'),
    );
    expect(callbackOutput).toBeDefined();
    expect(callbackOutput![1].Description).toMatch(/OAuth callback/);
  });

  test('grantTokenVaultAccess adds correct IAM policy', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });

    const identity = new AgentCoreIdentity(stack, 'Identity', {
      workloadIdentityName: 'test-agent',
      githubOAuth: {
        credentialProviderName: 'test-github',
        clientId: 'Iv1.test123',
        clientSecret: SecretValue.unsafePlainText('test-secret'),
      },
    });

    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    identity.grantTokenVaultAccess(role);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:GetWorkloadAccessToken',
              'bedrock-agentcore:GetResourceOauth2Token',
            ],
            Effect: 'Allow',
            Resource: [
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([
                    Match.stringLikeRegexp('workload-identity-directory/default$'),
                  ]),
                ]),
              }),
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([
                    Match.stringLikeRegexp('workload-identity-directory/default/\\*'),
                  ]),
                ]),
              }),
            ],
          }),
        ]),
      },
    });
  });
});
