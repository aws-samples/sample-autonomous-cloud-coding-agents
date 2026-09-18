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

import { App, CfnOutput, NestedStack, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AgentSessionRole } from '../../src/constructs/agent-session-role';
import {
  createMicrovmExecutionRole,
  LambdaMicrovmCompute,
  type LambdaMicrovmImageInputs,
} from '../../src/constructs/lambda-microvm-compute';
import { LambdaMicrovmStack } from '../../src/constructs/lambda-microvm-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };
const IMAGE_INPUTS: Array<[string, LambdaMicrovmImageInputs]> = [
  ['bootstrap', {}],
  ['imported', { externalImageIdentifier: 'existing-image', externalImageVersion: '6.0' }],
  ['managed', {
    baseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
    artifactSha256: 'a'.repeat(64),
  }],
];

describe.each(IMAGE_INPUTS)('LambdaMicrovmStack %s', (mode, imageInputs) => {
  let parent: Template;
  let child: Template;
  let compute: LambdaMicrovmCompute;

  beforeAll(() => {
    const stack = new Stack(new App(), 'backgroundagent-dev', { env: ENV });
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
    const executionRole = createMicrovmExecutionRole(
      new Construct(stack, 'LambdaMicrovmCompute'), 'ExecutionRole',
    );
    const sessionRole = new AgentSessionRole(stack, 'AgentSessionRole', {
      assumingRoles: [new iam.Role(stack, 'RuntimeRole', {
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      })],
      taskTable: new dynamodb.Table(stack, 'Tasks', {
        partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      }),
      approvalsTable: new dynamodb.Table(stack, 'ApprovalReadTable', {
        partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      }),
      taskScopedTables: [],
      traceArtifactsBucket: new s3.Bucket(stack, 'TraceBucket'),
      attachmentsBucket: new s3.Bucket(stack, 'AttachmentsBucket'),
    });
    const nested = new LambdaMicrovmStack(stack, 'Microvm', {
      ...imageInputs,
      vpc,
      executionRole,
      agentSessionRole: sessionRole,
      deploymentName: stack.stackName,
    });
    compute = nested.compute;
    // Exercise actual parent consumers and child outputs, not just a detached child.
    new CfnOutput(stack, 'ArtifactBucket', { value: compute.artifactBucket.bucketName });
    new CfnOutput(stack, 'PayloadBucket', { value: compute.payloadBucket.bucketArn });
    if (compute.imageArn) new CfnOutput(stack, 'ImageArn', { value: compute.imageArn });
    parent = Template.fromStack(stack); // Also rejects parent/child dependency cycles.
    child = Template.fromStack(nested);
  });

  test('moves backend resources into the child, preserving parent-owned runtime trust', () => {
    parent.resourceCountIs('AWS::Lambda::NetworkConnector', 0);
    parent.resourceCountIs('AWS::Lambda::MicrovmImage', 0);
    child.resourceCountIs('AWS::Lambda::NetworkConnector', 2);
    child.resourceCountIs('AWS::S3::Bucket', 2);
    child.resourceCountIs('AWS::Lambda::MicrovmImage', mode === 'managed' ? 1 : 0);
    const parentRoles = parent.findResources('AWS::IAM::Role');
    const executionId = Object.keys(parentRoles).find(id => id.startsWith('LambdaMicrovmComputeExecutionRole'))!;
    expect(executionId).toBeDefined();
    parent.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Principal: { AWS: { 'Fn::GetAtt': [executionId, 'Arn'] } },
        })]),
      },
    });
    expect(Object.keys(child.findResources('AWS::IAM::Role')).some(id => id.includes('ExecutionRole'))).toBe(false);
  });

  test('uses concrete parent-derived service and narrowly scoped bootstrap role names', () => {
    expect(compute.imageName).toBe('backgroundagent-dev-abca-agent');
    child.hasResourceProperties('AWS::Lambda::NetworkConnector', { Name: 'backgroundagent-dev-microvm-egress' });
    child.hasResourceProperties('AWS::Lambda::NetworkConnector', { Name: 'backgroundagent-dev-microvm-build-egress' });
    child.hasResourceProperties('AWS::IAM::Role', { RoleName: 'backgroundagent-dev-MicrovmBuildRole' });
    child.hasResourceProperties('AWS::IAM::Role', { RoleName: 'backgroundagent-dev-MicrovmConnectorRole' });
    expect(JSON.stringify(child.toJSON())).not.toContain('Token-TOKEN');
  });

  test('retains build/runtime network separation and backend tags', () => {
    const groups = Object.values(child.findResources('AWS::EC2::SecurityGroup'));
    const egressPorts = groups.map(group =>
      group.Properties.SecurityGroupEgress.map((rule: { FromPort: number }) => rule.FromPort).sort());
    expect(egressPorts).toEqual(expect.arrayContaining([[443], [443, 80]]));
    child.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      Tags: Match.arrayWith([{ Key: 'abca:compute-backend', Value: 'lambda-microvm' }]),
    });
    // CDK's raw cleanup-provider resources inherit tags from CloudFormation;
    // they do not expose a CDK TagManager that emits resource-level Tags.
    parent.hasResourceProperties('AWS::CloudFormation::Stack', {
      Tags: Match.arrayWith([{ Key: 'abca:compute-backend', Value: 'lambda-microvm' }]),
    });
    const executionPolicies = Object.entries(parent.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('LambdaMicrovmComputeExecutionRole'));
    expect(executionPolicies).toHaveLength(1);
    expect(JSON.stringify(executionPolicies)).not.toContain('dynamodb:');
  });

  test('preserves image selection semantics across the boundary', () => {
    if (mode === 'bootstrap') {
      expect(compute.imageIdentifier).toBeUndefined();
    } else if (mode === 'imported') {
      expect(compute.imageArn).toContain(':microvm-image:existing-image');
      expect(compute.imageVersion).toBe('6.0');
    } else {
      child.hasResourceProperties('AWS::Lambda::MicrovmImage', {
        Name: 'backgroundagent-dev-abca-agent',
        Resources: [{ MinimumMemoryInMiB: 8192 }],
        Hooks: { MicrovmHooks: Match.objectLike({ Suspend: 'ENABLED', Resume: 'ENABLED' }) },
      });
      expect(compute.imageVersion).toBeUndefined();
    }
  });
});

test('rejects nested token sanitization and an execution role in the wrong stack', () => {
  const app = new App();
  const parent = new Stack(app, 'Parent', { env: ENV });
  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const child = new NestedStack(parent, 'UnconfiguredChild');
  expect(() => new LambdaMicrovmCompute(child, 'Compute', { vpc }))
    .toThrow(/concrete deploymentName/);
  const sibling = new Stack(app, 'Sibling', { env: ENV });
  expect(() => new LambdaMicrovmStack(parent, 'WrongRole', {
    vpc,
    deploymentName: 'Parent',
    executionRole: createMicrovmExecutionRole(sibling, 'ExecutionRole'),
  })).toThrow(/owned by its parent/);
});

test('rejects a deployment name that would exceed IAM role-name limits', () => {
  const parent = new Stack(new App(), 'LongParent', { env: ENV });
  expect(() => new LambdaMicrovmStack(parent, 'Microvm', {
    vpc: new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 }),
    deploymentName: 'a'.repeat(64),
    executionRole: createMicrovmExecutionRole(parent, 'ExecutionRole'),
  })).toThrow(/at most 64 characters/);
});

test('allows overlapping service names while preserving parent role identity and bootstrap role names', () => {
  const parent = new Stack(new App(), 'backgroundagent-dev', { env: ENV });
  const executionRole = createMicrovmExecutionRole(
    new Construct(parent, 'LambdaMicrovmCompute'), 'ExecutionRole',
  );
  const nested = new LambdaMicrovmStack(parent, 'Microvm', {
    ...IMAGE_INPUTS[2][1],
    vpc: new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 }),
    deploymentName: parent.stackName,
    resourceNamePrefix: 'backgroundagent-dev-p3',
    executionRole,
  });
  const child = Template.fromStack(nested);
  child.hasResourceProperties('AWS::Lambda::MicrovmImage', { Name: 'backgroundagent-dev-p3-abca-agent' });
  child.hasResourceProperties('AWS::Lambda::NetworkConnector', { Name: 'backgroundagent-dev-p3-microvm-egress' });
  child.hasResourceProperties('AWS::Lambda::NetworkConnector', { Name: 'backgroundagent-dev-p3-microvm-build-egress' });
  child.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/aws/lambda-microvms/backgroundagent-dev-p3-abca-agent' });
  child.hasResourceProperties('AWS::IAM::Role', { RoleName: 'backgroundagent-dev-MicrovmBuildRole' });
  child.hasResourceProperties('AWS::IAM::Role', { RoleName: 'backgroundagent-dev-MicrovmConnectorRole' });
  expect(Object.keys(Template.fromStack(parent).findResources('AWS::IAM::Role')))
    .toContain('LambdaMicrovmComputeExecutionRoleAA0C4A0D');
});

test.each(['', '-invalid', 'has/slash', 'a'.repeat(41)])('rejects an unsafe migration name prefix %p', resourceNamePrefix => {
  const parent = new Stack(new App(), 'backgroundagent-dev', { env: ENV });
  expect(() => new LambdaMicrovmStack(parent, 'Microvm', {
    vpc: new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 }),
    deploymentName: parent.stackName,
    resourceNamePrefix,
    executionRole: createMicrovmExecutionRole(parent, 'ExecutionRole'),
  })).toThrow(/microvm_resource_name_prefix/);
});
