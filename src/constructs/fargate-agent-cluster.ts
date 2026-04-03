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
import { Aws, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for FargateAgentCluster construct.
 */
export interface FargateAgentClusterProps {
  /**
   * The VPC to place the ECS cluster in.
   */
  readonly vpc: ec2.IVpc;

  /**
   * Security group for the Fargate tasks.
   */
  readonly securityGroup: ec2.ISecurityGroup;

  /**
   * The DynamoDB task table.
   */
  readonly taskTable: dynamodb.ITable;

  /**
   * The DynamoDB task events table.
   */
  readonly taskEventsTable: dynamodb.ITable;

  /**
   * The DynamoDB user concurrency table.
   */
  readonly userConcurrencyTable: dynamodb.ITable;

  /**
   * The Secrets Manager secret containing the GitHub token.
   */
  readonly githubTokenSecret: secretsmanager.ISecret;

  /**
   * AgentCore Memory resource ID for cross-task learning.
   * When provided, the task role is granted AgentCore Memory permissions.
   */
  readonly memoryId?: string;
}

/**
 * CDK construct that creates the Fargate cluster, task definition, and container
 * for running autonomous coding agents.
 */
export class FargateAgentCluster extends Construct {
  /**
   * The ECS cluster.
   */
  public readonly cluster: ecs.Cluster;

  /**
   * The Fargate task definition.
   */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  /**
   * The agent container definition.
   */
  public readonly containerDefinition: ecs.ContainerDefinition;

  /**
   * Security group for the Fargate tasks.
   */
  public readonly securityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: FargateAgentClusterProps) {
    super(scope, id);

    this.securityGroup = props.securityGroup;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 4096,
      memoryLimitMiB: 16384,
      ephemeralStorageGiB: 100,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/fargate-agent',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.containerDefinition = this.taskDefinition.addContainer('AgentContainer', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', '..', 'agent')),
      command: ['python', '/app/entrypoint.py'],
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'agent',
      }),
      environment: {
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
        AWS_REGION: Stack.of(this).region,
        AWS_DEFAULT_REGION: Stack.of(this).region,
        ...(props.memoryId && { MEMORY_ID: props.memoryId }),
      },
    });

    // DynamoDB grants
    props.taskTable.grantReadWriteData(this.taskDefinition.taskRole);
    props.taskEventsTable.grantReadWriteData(this.taskDefinition.taskRole);
    props.userConcurrencyTable.grantReadWriteData(this.taskDefinition.taskRole);

    // Secrets Manager grant for GitHub token
    props.githubTokenSecret.grantRead(this.taskDefinition.taskRole);

    // Bedrock model invocation permissions
    this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:${Aws.PARTITION}:bedrock:*:*:foundation-model/*`,
        `arn:${Aws.PARTITION}:bedrock:*:*:inference-profile/*`,
      ],
    }));

    // AgentCore Memory permissions (only when memoryId is provided)
    if (props.memoryId) {
      this.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:CreateEvent',
        ],
        resources: ['*'],
      }));
    }

    NagSuppressions.addResourceSuppressions(this.taskDefinition, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; Secrets Manager wildcards generated by CDK grantRead; Bedrock foundation-model/* and inference-profile/* wildcards required for model invocation; AgentCore Memory wildcards required for cross-task learning',
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: 'Environment variables contain DynamoDB table names and secret ARNs (not secret values) — safe to pass directly; Secrets Manager handles actual secret retrieval at runtime',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.cluster, [
      {
        id: 'AwsSolutions-ECS4',
        reason: 'Container insights enabled on the cluster',
      },
    ], true);
  }
}
