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

import { RemovalPolicy, Stack, ArnFormat } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AgentSessionRole } from './agent-session-role';
import { resolveBedrockModelIds } from './bedrock-models';

export interface EcsAgentClusterProps {
  readonly vpc: ec2.IVpc;
  readonly agentImageAsset: ecr_assets.DockerImageAsset;
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
  readonly userConcurrencyTable: dynamodb.ITable;
  readonly githubTokenSecret: secretsmanager.ISecret;
  readonly memoryId?: string;

  /**
   * S3 bucket holding per-task ECS payloads (#502). The orchestrator writes the
   * payload (incl. the large hydrated_context, which can't fit in the 8 KB
   * RunTask containerOverrides limit) here and passes only an
   * `AGENT_PAYLOAD_S3_URI` pointer; the container fetches it on boot. The task
   * role gets **read-only** on this bucket — the container runs untrusted repo
   * code, so it must not be able to delete payloads (the trusted orchestrator
   * owns write + delete). When omitted (isolated construct tests / deployments
   * that still pass the payload inline), no grant or env var is added.
   */
  readonly payloadBucket?: s3.IBucket;

  /**
   * Per-task SessionRole (#209). When provided, tenant-data DynamoDB access
   * (task/events tables) is NOT granted to the Fargate task role; instead the
   * agent assumes this SessionRole with session tags and the role's
   * tag-scoped policy governs that access. The task role is admitted to the
   * SessionRole's trust and `AGENT_SESSION_ROLE_ARN` is injected into the
   * container. When omitted (e.g. isolated construct tests), the task role
   * retains the legacy direct grants.
   */
  readonly agentSessionRole?: AgentSessionRole;
}

/** HTTPS port — the only egress allowed from the agent task ENIs. */
const HTTPS_PORT = 443;

export class EcsAgentCluster extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly containerName: string;
  public readonly taskRoleArn: string;
  public readonly executionRoleArn: string;

  constructor(scope: Construct, id: string, props: EcsAgentClusterProps) {
    super(scope, id);

    this.containerName = 'AgentContainer';

    // ECS Cluster with Fargate capacity provider and container insights
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsights: true,
    });

    // Security group — egress TCP 443 only
    this.securityGroup = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc: props.vpc,
      description: 'ECS Agent Tasks - egress TCP 443 only',
      allowAllOutbound: false,
    });

    this.securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(HTTPS_PORT),
      'Allow HTTPS egress (GitHub API, AWS services)',
    );

    // CloudWatch log group for agent task output
    const logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Task execution role (used by ECS agent to pull images, write logs)
    // CDK creates this automatically via taskDefinition, but we need to
    // grant additional permissions to the task role.

    // Fargate task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Container
    this.taskDefinition.addContainer(this.containerName, {
      image: ecs.ContainerImage.fromDockerImageAsset(props.agentImageAsset),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'agent',
      }),
      environment: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        LOG_GROUP_NAME: logGroup.logGroupName,
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
        ...(props.memoryId && { MEMORY_ID: props.memoryId }),
        // #502: the payload bucket name so the orchestrator-issued
        // AGENT_PAYLOAD_S3_URI can be fetched. (The orchestrator sets the URI
        // per-task via container override; this is informational parity.)
        ...(props.payloadBucket && { ECS_PAYLOAD_BUCKET: props.payloadBucket.bucketName }),
        // Per-session IAM scoping (#209): when a SessionRole is wired, the
        // agent assumes it for tenant-data access (see aws_session.py).
        ...(props.agentSessionRole && {
          AGENT_SESSION_ROLE_ARN: props.agentSessionRole.role.roleArn,
        }),
      },
    });

    // Task role permissions
    const taskRole = this.taskDefinition.taskRole;

    // DynamoDB: when a SessionRole (#209) is wired, tenant-data access lives on
    // that tag-scoped role and the task role only needs to assume it. Without
    // one (isolated construct tests / legacy), grant the task role directly.
    if (props.agentSessionRole) {
      props.agentSessionRole.admitComputeRole(taskRole);
    } else {
      props.taskTable.grantReadWriteData(taskRole);
      props.taskEventsTable.grantReadWriteData(taskRole);
    }
    // UserConcurrencyTable is user-scoped (not task_id leading-key-able) and is
    // touched by the reconciler/orchestrator path; keep it on the task role.
    props.userConcurrencyTable.grantReadWriteData(taskRole);

    // Secrets Manager read for GitHub token (read once at startup, before the
    // agent assumes the SessionRole — stays on the task role).
    props.githubTokenSecret.grantRead(taskRole);

    // #502: read-only on the ECS payload bucket so the container can fetch its
    // payload (AGENT_PAYLOAD_S3_URI) at boot. READ only — the container runs
    // untrusted repo code, so it must not be able to write or delete payloads
    // (the trusted orchestrator owns write + delete). Stays on the task role
    // (read once at startup, before the agent assumes any SessionRole).
    if (props.payloadBucket) {
      props.payloadBucket.grantRead(taskRole);
    }

    // Bedrock model invocation — scoped to explicit foundation-model and
    // cross-region inference-profile ARNs (parity with the AgentCore runtime
    // grants in agent.ts), NOT a Resource: '*' wildcard. The model set is the
    // shared, context-overridable list (constructs/bedrock-models.ts) so the
    // ECS and AgentCore backends can't drift.
    const stack = Stack.of(this);
    const bedrockResources: string[] = [];
    for (const modelId of resolveBedrockModelIds(this.node)) {
      bedrockResources.push(
        stack.formatArn({
          service: 'bedrock',
          region: '*',
          account: '',
          resource: 'foundation-model',
          resourceName: modelId,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        }),
        stack.formatArn({
          service: 'bedrock',
          resource: 'inference-profile',
          resourceName: `us.${modelId}`,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        }),
      );
    }
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: bedrockResources,
    }));

    // CloudWatch Logs write
    logGroup.grantWrite(taskRole);

    // Expose role ARNs for scoped iam:PassRole in the orchestrator
    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = this.taskDefinition.executionRole!.roleArn;

    NagSuppressions.addResourceSuppressions(this.taskDefinition, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards from CDK grantReadWriteData (UserConcurrencyTable, and task tables only when no SessionRole is wired); Secrets Manager wildcards from CDK grantRead; CloudWatch Logs wildcards from CDK grantWrite; S3 object/* wildcard from CDK grantRead on the ECS payload bucket (read-only, scoped to that bucket — #502). Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard resource).',
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: 'Environment variables contain table names and configuration, not secrets — GitHub token is fetched from Secrets Manager at runtime',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.cluster, [
      {
        id: 'AwsSolutions-ECS4',
        reason: 'Container insights is enabled via the containerInsights prop',
      },
    ], true);
  }
}
