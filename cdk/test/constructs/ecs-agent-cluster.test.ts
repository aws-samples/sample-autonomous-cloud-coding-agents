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

import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { EcsAgentCluster } from '../../src/constructs/ecs-agent-cluster';

function createStack(overrides?: { memoryId?: string }): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });

  const agentImageAsset = new ecr_assets.DockerImageAsset(stack, 'AgentImage', {
    directory: path.join(__dirname, '..', '..', '..', 'agent'),
  });

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

  const githubTokenSecret = new secretsmanager.Secret(stack, 'GitHubTokenSecret');

  new EcsAgentCluster(stack, 'EcsAgentCluster', {
    vpc,
    agentImageAsset,
    taskTable,
    taskEventsTable,
    userConcurrencyTable,
    githubTokenSecret,
    memoryId: overrides?.memoryId,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('EcsAgentCluster construct', () => {
  test('creates an ECS Cluster with container insights', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: Match.arrayWith([
        Match.objectLike({
          Name: 'containerInsights',
          Value: 'enabled',
        }),
      ]),
    });
  });

  test('creates a Fargate task definition with 2 vCPU and 4 GB', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '2048',
      Memory: '4096',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
    });
  });

  test('creates a security group with TCP 443 egress only', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'ECS Agent Tasks - egress TCP 443 only',
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
        }),
      ]),
    });
  });

  test('creates a CloudWatch log group with 3-month retention and CDK-generated name', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
    });
    // Verify no hardcoded log group name — CDK auto-generates a unique name
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    for (const [, lg] of Object.entries(logGroups)) {
      expect((lg as any).Properties).not.toHaveProperty('LogGroupName');
    }
  });

  test('task role has DynamoDB read/write permissions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('task role has Secrets Manager read permission', () => {
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

  test('task role has Bedrock InvokeModel permissions', () => {
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
            Resource: '*',
          }),
        ]),
      },
    });
  });

  test('container has required environment variables', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'AgentContainer',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'CLAUDE_CODE_USE_BEDROCK', Value: '1' }),
            Match.objectLike({ Name: 'TASK_TABLE_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'TASK_EVENTS_TABLE_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'USER_CONCURRENCY_TABLE_NAME', Value: Match.anyValue() }),
            Match.objectLike({ Name: 'LOG_GROUP_NAME', Value: Match.anyValue() }),
          ]),
        }),
      ]),
    });
  });

  test('includes MEMORY_ID in container env when provided', () => {
    const { template } = createStack({ memoryId: 'mem-test-123' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'MEMORY_ID', Value: 'mem-test-123' }),
          ]),
        }),
      ]),
    });
  });
});
