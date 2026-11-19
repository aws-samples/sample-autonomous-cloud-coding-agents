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

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LinearIdentityVault } from '../../src/constructs/linear-identity-vault';
import { ToolGateway } from '../../src/constructs/tool-gateway';

const unscopedLinearResources = [
  'arn:*:bedrock-agentcore:us-east-1:123456789012:token-vault/default/oauth2credentialprovider/bgagent-linear-oauth-*',
  'arn:aws:bedrock-agentcore:*:123456789012:token-vault/default/oauth2credentialprovider/bgagent-linear-oauth-*',
  'arn:aws:bedrock-agentcore:us-east-1:*:token-vault/default/oauth2credentialprovider/bgagent-linear-oauth-*',
  'arn:*:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/oauth2/bgagent-linear-oauth-*',
  'arn:aws:secretsmanager:*:123456789012:secret:bedrock-agentcore-identity!default/oauth2/bgagent-linear-oauth-*',
  'arn:aws:secretsmanager:us-east-1:*:secret:bedrock-agentcore-identity!default/oauth2/bgagent-linear-oauth-*',
];

function fixture(addUnrelatedWildcard: boolean, concreteEnvironment: boolean) {
  const stack = new Stack(new App(), 'Audit', concreteEnvironment
    ? { env: { account: '123456789012', region: 'us-east-1' } } : {});
  const table = new dynamodb.Table(stack, 'Repos', { partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING } });
  const gateway = new ToolGateway(stack, 'Gateway', { repoTable: table });
  const vault = new LinearIdentityVault(stack, 'Vault', {
    workloadName: 'linear-audit', allowedReturnUrls: ['http://localhost/callback'],
  });
  const consumer = new iam.Role(stack, 'Consumer', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  // Force CDK to create overflow policies during prepare, after the grant helper
  // runs. Distinct conditions prevent statement merging from hiding the split.
  for (let index = 0; index < 60; index++) {
    consumer.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::fixture-${index}-${'x'.repeat(100)}/object`],
      conditions: { StringEquals: { 'aws:ResourceTag/fixture': String(index) } },
    }));
  }
  vault.grantMintToken(consumer);
  if (addUnrelatedWildcard) {
    consumer.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:unrelated-*'],
    }));
    for (const resource of unscopedLinearResources) {
      consumer.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [resource.includes(':secretsmanager:') ? 'secretsmanager:GetSecretValue' : 'bedrock-agentcore:GetResourceOauth2Token'],
        resources: [resource],
      }));
    }
    gateway.gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'], resources: ['*'],
    }));
  }
  Aspects.of(stack).add(new AwsSolutionsChecks());
  const template = Template.fromStack(stack);
  const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-IAM5'))
    .filter(error => error.id.includes('/Consumer/') || error.id.includes('/Gateway/Gateway/ServiceRole/'))
    .map(error => String(error.entry.data));
  return { template, errors };
}

describe.each([false, true])('grant-specific IAM audit exceptions (concrete environment: %s)', concreteEnvironment => {
  let clean: ReturnType<typeof fixture>;
  let unrelated: ReturnType<typeof fixture>;
  beforeAll(() => {
    clean = fixture(false, concreteEnvironment);
    unrelated = fixture(true, concreteEnvironment);
  });

  test('known Lambda/version and Linear-prefix grants pass, including lazy overflow policies', () => {
    const policies = clean.template.findResources('AWS::IAM::ManagedPolicy');
    expect(Object.keys(policies).some(id => id.includes('ConsumerOverflowPolicy'))).toBe(true);
    expect(clean.errors).toEqual([]);
    expect(JSON.stringify(policies)).toContain('bgagent-linear-oauth-');
  });

  test('the same principals still fail for unrelated wildcard resources', () => {
    expect(unrelated.errors).toHaveLength(2 + unscopedLinearResources.length);
    expect(unrelated.errors.some(error => error.includes('secret:unrelated-*'))).toBe(true);
    expect(unrelated.errors.some(error => error.includes('[Resource::*]'))).toBe(true);
  });

  test('Linear prefixes do not hide wildcard partitions, regions or accounts', () => {
    for (const resource of unscopedLinearResources) {
      expect(unrelated.errors.some(error => error.includes(`[Resource::${resource}]`))).toBe(true);
    }
  });
});
