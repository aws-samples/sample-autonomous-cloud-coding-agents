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
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Blueprint, type BlueprintProps } from '../../src/constructs/blueprint';

function createStack(props?: Partial<BlueprintProps>): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const repoTable = new dynamodb.Table(stack, 'RepoTable', {
    partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
  });

  new Blueprint(stack, 'Blueprint', {
    repo: 'org/my-repo',
    repoTable,
    ...props,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

/**
 * Extract the serialized Fn::Join string parts from the Custom::AWS Create property.
 * AwsCustomResource serializes parameters as Fn::Join when CDK tokens are present.
 */
function getCreateJoinParts(template: Template): string[] {
  const resources = template.findResources('Custom::AWS');
  const resourceKey = Object.keys(resources)[0];
  const create = (resources[resourceKey] as any).Properties.Create;
  if (create && create['Fn::Join']) {
    return create['Fn::Join'][1].filter((part: unknown) => typeof part === 'string');
  }
  return [];
}

function getUpdateJoinParts(template: Template): string[] {
  const resources = template.findResources('Custom::AWS');
  const resourceKey = Object.keys(resources)[0];
  const update = (resources[resourceKey] as any).Properties.Update;
  if (update && update['Fn::Join']) {
    return update['Fn::Join'][1].filter((part: unknown) => typeof part === 'string');
  }
  return [];
}

function getDeleteJoinParts(template: Template): string[] {
  const resources = template.findResources('Custom::AWS');
  const resourceKey = Object.keys(resources)[0];
  const del = (resources[resourceKey] as any).Properties.Delete;
  if (del && del['Fn::Join']) {
    return del['Fn::Join'][1].filter((part: unknown) => typeof part === 'string');
  }
  return [];
}

describe('Blueprint construct', () => {
  test('creates a Custom::AWS resource', () => {
    const { template } = createStack();
    template.resourceCountIs('Custom::AWS', 1);
  });

  test('onCreate uses DynamoDB putItem', () => {
    const { template } = createStack();
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"service":"DynamoDB"');
    expect(serialized).toContain('"action":"putItem"');
  });

  test('onCreate PutItem includes repo and status active', () => {
    const { template } = createStack();
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"repo":{"S":"org/my-repo"}');
    expect(serialized).toContain('"status":{"S":"active"}');
  });

  test('onDelete uses DynamoDB updateItem with status removed', () => {
    const { template } = createStack();
    const parts = getDeleteJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"service":"DynamoDB"');
    expect(serialized).toContain('"action":"updateItem"');
    expect(serialized).toContain(':removed');
    expect(serialized).toContain('"S":"removed"');
  });

  test('maps compute type prop', () => {
    const { template } = createStack({
      compute: { type: 'ecs' },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"compute_type":{"S":"ecs"}');
  });

  test('maps runtime ARN prop', () => {
    const { template } = createStack({
      compute: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/custom' },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"runtime_arn":{"S":"arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/custom"}');
  });

  test('maps agent model ID prop', () => {
    const { template } = createStack({
      agent: { modelId: 'anthropic.claude-sonnet-4-6' },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"model_id":{"S":"anthropic.claude-sonnet-4-6"}');
  });

  test('maps agent max turns prop', () => {
    const { template } = createStack({
      agent: { maxTurns: 50 },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"max_turns":{"N":"50"}');
  });

  test('maps system prompt overrides prop', () => {
    const { template } = createStack({
      agent: { systemPromptOverrides: 'Always use TypeScript.' },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"system_prompt_overrides":{"S":"Always use TypeScript."}');
  });

  test('maps github token secret ARN prop', () => {
    const { template } = createStack({
      credentials: { githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:token' },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"github_token_secret_arn":{"S":"arn:aws:secretsmanager:us-east-1:123:secret:token"}');
  });

  test('maps poll interval prop', () => {
    const { template } = createStack({
      pipeline: { pollIntervalMs: 15000 },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"poll_interval_ms":{"N":"15000"}');
  });

  test('maps networking egress allowlist to DynamoDB list', () => {
    const { template } = createStack({
      networking: { egressAllowlist: ['npm.internal.example.com', '*.private-registry.io'] },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"egress_allowlist":{"L":[{"S":"npm.internal.example.com"},{"S":"*.private-registry.io"}]}');
  });

  test('omits egress_allowlist when networking is absent', () => {
    const { template } = createStack();
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('egress_allowlist');
  });

  test('omits egress_allowlist when egressAllowlist is empty', () => {
    const { template } = createStack({
      networking: { egressAllowlist: [] },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('egress_allowlist');
  });

  test('onUpdate includes egress_allowlist in UpdateExpression', () => {
    const { template } = createStack({
      networking: { egressAllowlist: ['registry.example.com'] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('#egress_allowlist');
    expect(serialized).toContain('"S":"registry.example.com"');
  });

  test('exposes egressAllowlist as public property', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    const blueprint = new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      networking: { egressAllowlist: ['example.com'] },
    });

    expect(blueprint.egressAllowlist).toEqual(['example.com']);
  });

  test('egressAllowlist defaults to empty array', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    const blueprint = new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
    });

    expect(blueprint.egressAllowlist).toEqual([]);
  });

  test('exposes cedarPolicies as public property', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    const blueprint = new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      security: { cedarPolicies: ['permit (principal, action, resource);'] },
    });

    expect(blueprint.cedarPolicies).toEqual(['permit (principal, action, resource);']);
  });

  test('cedarPolicies defaults to empty array', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    const blueprint = new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
    });

    expect(blueprint.cedarPolicies).toEqual([]);
  });

  test('maps security cedar policies to DynamoDB list', () => {
    const { template } = createStack({
      security: { cedarPolicies: ['forbid (principal, action, resource) when { resource == Agent::Tool::"Bash" };'] },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"cedar_policies":{"L":[{"S":"forbid (principal, action, resource) when { resource == Agent::Tool::\\"Bash\\" };"}]}');
  });

  test('omits cedar_policies when security is absent', () => {
    const { template } = createStack();
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('cedar_policies');
  });

  test('omits cedar_policies when cedarPolicies is empty', () => {
    const { template } = createStack({
      security: { cedarPolicies: [] },
    });
    const parts = getCreateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('cedar_policies');
  });

  test('onUpdate includes cedar_policies in UpdateExpression', () => {
    const { template } = createStack({
      security: { cedarPolicies: ['permit (principal, action, resource);'] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('#cedar_policies');
  });

  test('onUpdate uses DynamoDB updateItem to preserve onboarded_at', () => {
    const { template } = createStack();
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"service":"DynamoDB"');
    expect(serialized).toContain('"action":"updateItem"');
    expect(serialized).not.toContain('"onboarded_at"');
    expect(serialized).toContain('#status');
    expect(serialized).toContain('#updated');
  });

  test('onUpdate includes optional fields in UpdateExpression', () => {
    const { template } = createStack({
      compute: { type: 'ecs' },
      agent: { modelId: 'anthropic.claude-sonnet-4-6', maxTurns: 50 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('#compute_type');
    expect(serialized).toContain('"S":"ecs"');
    expect(serialized).toContain('#model_id');
    expect(serialized).toContain('"S":"anthropic.claude-sonnet-4-6"');
    expect(serialized).toContain('#max_turns');
    expect(serialized).toContain('"N":"50"');
  });

  test('grants DynamoDB PutItem and UpdateItem permissions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});

describe('Blueprint validation', () => {
  test('rejects invalid repo format', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'invalid-no-slash',
      repoTable,
    });

    expect(() => app.synth()).toThrow(/Invalid repo format/);
  });

  test('accepts valid repo format', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'my-org/my-repo',
      repoTable,
    });

    expect(() => app.synth()).not.toThrow();
  });

  test('rejects invalid egress allowlist domain', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'my-org/my-repo',
      repoTable,
      networking: { egressAllowlist: ['INVALID_DOMAIN'] },
    });

    expect(() => app.synth()).toThrow(/Invalid egress allowlist domain/);
  });

  test('accepts valid egress allowlist domains', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'my-org/my-repo',
      repoTable,
      networking: { egressAllowlist: ['example.com', '*.internal.example.com', 'registry.npmjs.org'] },
    });

    expect(() => app.synth()).not.toThrow();
  });
});
