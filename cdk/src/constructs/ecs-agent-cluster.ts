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
   * Artifacts bucket for repo-bound artifact workflows (#299 coding/decompose-v1
   * emits its plan JSON here via ``deliver_artifact``; also the ``--trace``
   * upload target). The AgentCore runtime gets ``ARTIFACTS_BUCKET_NAME`` in its
   * env; the ECS task needs the SAME env + read/write grant or an artifact
   * workflow fails at delivery with "ARTIFACTS_BUCKET_NAME is not configured"
   * (live-caught: a :decompose on an ecs-configured repo). Read/WRITE because the
   * container DELIVERS the artifact (unlike the read-only payload bucket).
   * Omitted in isolated construct tests → no env/grant.
   */
  readonly artifactsBucket?: s3.IBucket;

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

/**
 * Bedrock model IDs the agent may invoke (kept in sync with the AgentCore
 * runtime grants in agent.ts). Used to scope the ECS task role's Bedrock
 * permissions to explicit foundation-model + inference-profile ARNs instead of
 * a `Resource: '*'` wildcard.
 */
const BEDROCK_MODEL_IDS = [
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-20250514-v1:0',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
];

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

    // Fargate task definition. Sized for heavy CI-parity builds (e.g. ABCA's
    // own ~2800-test `mise run build` + cdk synth). Sizing history (all
    // live-caught dogfooding ABCA-on-ABCA, 2026-06-29):
    //   - 4 GB / 2 vCPU  → OOM-killed even the AgentCore microVM.
    //   - 32 GB / 8 vCPU → ran ~50 min then OOM-killed (exit 137) at the cap;
    //     peak working set ~31.6 GB when the root build fans out 4 heavy jobs
    //     in PARALLEL (agent:quality ‖ cdk:build ‖ cli:build ‖ docs:build),
    //     each spawning its own worker fleet (jest maxWorkers, pytest, esbuild
    //     Lambda bundling). 32 GB had no headroom for that concurrent peak.
    //   - 64 GB / 16 vCPU (current) → 2× the memory headroom for the parallel
    //     storm, and 16 vCPU shortens wall-clock (paired with
    //     BUILD_VERIFY_TIMEOUT_S=3600 below so the ~longer-than-30-min build
    //     isn't mis-reported as a timeout). Valid Fargate ARM64 combo (16 vCPU
    //     admits 32–120 GB in 8 GB steps).
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 16384,
      memoryLimitMiB: 65536,
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
        // Heavy CI-parity builds on this big-box substrate legitimately run
        // longer than the 1800s default (ABCA's own `mise run build` is
        // ~50 min cold). Raise the post-agent build-verify cap so a slow-but-
        // healthy build isn't mis-reported as a timeout (see post_hooks.py
        // BUILD_VERIFY_TIMEOUT_S). ECS-only: AgentCore repos keep the default.
        BUILD_VERIFY_TIMEOUT_S: '3600',
        ...(props.memoryId && { MEMORY_ID: props.memoryId }),
        // #502: the payload bucket name so the orchestrator-issued
        // AGENT_PAYLOAD_S3_URI can be fetched. (The orchestrator sets the URI
        // per-task via container override; this is informational parity.)
        ...(props.payloadBucket && { ECS_PAYLOAD_BUCKET: props.payloadBucket.bucketName }),
        // #299 ECS-parity: artifact workflows (coding/decompose-v1) deliver their
        // plan JSON to this bucket. The AgentCore runtime has ARTIFACTS_BUCKET_NAME;
        // the ECS task needs it too or deliver_artifact raises "ARTIFACTS_BUCKET_NAME
        // is not configured" (live-caught on an ecs-repo :decompose).
        ...(props.artifactsBucket && { ARTIFACTS_BUCKET_NAME: props.artifactsBucket.bucketName }),
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

    // #299 ECS-parity: an artifact workflow (coding/decompose-v1) WRITES its plan
    // to the artifacts bucket via deliver_artifact, so grant read+write (the
    // AgentCore runtime's SessionRole/exec-role has the equivalent). Scoped to
    // this bucket. Stays on the task role — delivery is a terminal step.
    if (props.artifactsBucket) {
      props.artifactsBucket.grantReadWrite(taskRole);
    }

    // ABCA-488: per-workspace Linear/Jira OAuth tokens live in Secrets Manager
    // under `bgagent-linear-oauth-*` (written by the CLI at setup). For a
    // Linear/Jira-channel task the agent resolves that token at startup
    // (config.resolve_linear_api_token / resolve_jira_oauth_token) to fire the
    // 👀→✅ reaction and drive the channel MCP. The AgentCore runtime role +
    // orchestrator/fanout/screenshot roles all have this prefix grant; the ECS
    // task role did NOT, so on ECS the token fetch hit AccessDenied and
    // reactions/MCP silently no-op'd (ECS-parity gap, live-caught on ABCA-488).
    // GetSecretValue only — the container reads the token; the orchestrator owns
    // refresh/PutSecretValue.
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-linear-oauth-*',
        }),
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));

    // Bedrock model invocation — scoped to explicit foundation-model and
    // cross-region inference-profile ARNs (parity with the AgentCore runtime
    // grants in agent.ts), replacing the prior Resource: '*' wildcard.
    const stack = Stack.of(this);
    const bedrockResources: string[] = [];
    for (const modelId of BEDROCK_MODEL_IDS) {
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
        reason: 'DynamoDB index/* wildcards from CDK grantReadWriteData (UserConcurrencyTable, and task tables only when no SessionRole is wired); Secrets Manager wildcards from CDK grantRead (GitHub token) and the bgagent-linear-oauth-*/bgagent-jira-oauth-* prefix grant (ABCA-488 — per-workspace channel OAuth tokens are created by the CLI at setup, name unknown at synth, GetSecretValue only); CloudWatch Logs wildcards from CDK grantWrite; S3 object/* wildcard from CDK grantRead on the ECS payload bucket (read-only, scoped to that bucket — #502) and from grantReadWrite on the artifacts bucket (scoped to that bucket — coding/decompose-v1 delivers its plan artifact there, #299). Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard resource).',
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
