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
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { FargateAgentCluster } from '../../src/constructs/fargate-agent-cluster';

interface StackOverrides {
  memoryId?: string;
}

function createStack(overrides?: StackOverrides): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const vpc = new ec2.Vpc(stack, 'Vpc');
  const securityGroup = new ec2.SecurityGroup(stack, 'SG', { vpc });

  const taskTable = new dynamodb.Table(stack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });

  const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
  });

  const userConcurrencyTable = new dynamodb.Table(stack, 'UserConcurrencyTable', {
    partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
  });

  const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubToken');

  new FargateAgentCluster(stack, 'FargateAgentCluster', {
    vpc,
    securityGroup,
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    githubTokenSecret,
    ...(overrides?.memoryId && { memoryId: overrides.memoryId }),
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('FargateAgentCluster construct', () => {
  test('creates a Fargate task definition with correct resource properties', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '16384',
      EphemeralStorage: { SizeInGiB: 100 },
    });
  });

  test('creates an ECS Cluster', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('creates a log group with /ecs/fargate-agent prefix and 90-day retention', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/fargate-agent',
      RetentionInDays: 90,
    });
  });

  test('IAM policy includes DynamoDB actions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:BatchGetItem',
              'dynamodb:GetItem',
              'dynamodb:PutItem',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('IAM policy includes Secrets Manager actions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'secretsmanager:GetSecretValue',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('IAM policy includes Bedrock model invocation actions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
            ],
            Effect: 'Allow',
            Resource: [
              { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:*:*:foundation-model/*']] },
              { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:*:*:inference-profile/*']] },
            ],
          }),
        ]),
      },
    });
  });

  test('container has correct environment variables', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'TASK_TABLE_NAME' }),
            Match.objectLike({ Name: 'TASK_EVENTS_TABLE_NAME' }),
            Match.objectLike({ Name: 'USER_CONCURRENCY_TABLE_NAME' }),
            Match.objectLike({ Name: 'GITHUB_TOKEN_SECRET_ARN' }),
          ]),
        }),
      ]),
    });
  });

  test('includes MEMORY_ID when provided', () => {
    const { template } = createStack({ memoryId: 'mem-abc-123' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'MEMORY_ID', Value: 'mem-abc-123' }),
          ]),
        }),
      ]),
    });
  });

  test('includes AgentCore Memory permissions when memoryId is provided', () => {
    const { template } = createStack({ memoryId: 'mem-abc-123' });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:RetrieveMemoryRecords',
              'bedrock-agentcore:CreateEvent',
            ],
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      },
    });
  });

  test('does not include MEMORY_ID when not provided', () => {
    const { template } = createStack();
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const [, taskDef] of Object.entries(taskDefs)) {
      const containers = (taskDef as any).Properties.ContainerDefinitions ?? [];
      for (const container of containers) {
        const envVars = (container.Environment ?? []) as Array<{ Name: string }>;
        const names = envVars.map(e => e.Name);
        expect(names).not.toContain('MEMORY_ID');
      }
    }
  });

  test('does not include AgentCore Memory permissions when memoryId is not provided', () => {
    const { template } = createStack();
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = (policy as any).Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        if (Array.isArray(stmt.Action)) {
          expect(stmt.Action).not.toContain('bedrock-agentcore:RetrieveMemoryRecords');
        }
      }
    }
  });
});
