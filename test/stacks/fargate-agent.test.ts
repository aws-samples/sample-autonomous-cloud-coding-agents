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
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { FargateAgentStack } from '../../src/stacks/fargate-agent';

function createStack(): { template: Template } {
  const app = new App();

  // Create a shared-resources stack to simulate AgentStack
  const sharedStack = new Stack(app, 'SharedStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(sharedStack, 'Vpc', { maxAzs: 2 });
  const sg = new ec2.SecurityGroup(sharedStack, 'RuntimeSG', {
    vpc,
    allowAllOutbound: false,
  });
  const taskTable = new dynamodb.Table(sharedStack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });
  const taskEventsTable = new dynamodb.Table(sharedStack, 'TaskEventsTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
  });
  const userConcurrencyTable = new dynamodb.Table(sharedStack, 'UserConcurrencyTable', {
    partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
  });
  const repoTable = new dynamodb.Table(sharedStack, 'RepoTable', {
    partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
  });
  const githubTokenSecret = new secretsmanager.Secret(sharedStack, 'GitHubToken');

  const fargateStack = new FargateAgentStack(app, 'TestFargateStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    vpc,
    runtimeSecurityGroup: sg,
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    repoTable,
    githubTokenSecret,
    memoryId: 'mem-test-123',
  });

  const template = Template.fromStack(fargateStack);
  return { template };
}

describe('FargateAgentStack', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createStack());
  });

  test('synthesizes without errors', () => {
    expect(template).toBeDefined();
  });

  test('creates an ECS Cluster', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('creates a Fargate task definition', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '16384',
    });
  });

  test('creates a Step Functions state machine', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  });

  test('creates 6 Lambda functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 6);
  });

  test('outputs StateMachineArn', () => {
    template.hasOutput('StateMachineArn', {
      Description: 'ARN of the Fargate task orchestration state machine',
    });
  });

  test('outputs ClusterArn', () => {
    template.hasOutput('ClusterArn', {
      Description: 'ARN of the ECS Fargate cluster',
    });
  });

  test('outputs TaskDefinitionArn', () => {
    template.hasOutput('TaskDefinitionArn', {
      Description: 'ARN of the Fargate task definition',
    });
  });
});
