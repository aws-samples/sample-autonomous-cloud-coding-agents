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

import { AspectPriority, Aspects, RemovalPolicy, Stack, ArnFormat } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct, type IConstruct, type Node } from 'constructs';
import { CHANNEL_OAUTH_SECRET_PATTERNS } from '../deployment/features';
import { AgentMemory } from './agent-memory';
import { AgentSessionRole } from './agent-session-role';
import {
  PLATFORM_DEFAULT_AUX_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  inferenceProfileId,
  resolveBedrockGeoRegion,
  resolveBedrockModelIds,
} from './bedrock-models';
import { LinearIdentityVault } from './linear-identity-vault';
import { buildAppId } from './solution-ua-aspect';
import { ToolGateway } from './tool-gateway';

export interface EcsAgentClusterProps {
  readonly vpc: ec2.IVpc;
  readonly agentImageAsset: ecr_assets.DockerImageAsset;
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
  /** Approval storage. Required for human approval gates; optional in isolated tests. */
  readonly taskApprovalsTable?: dynamodb.ITable;
  readonly userConcurrencyTable: dynamodb.ITable;
  readonly githubTokenSecret: secretsmanager.ISecret;
  readonly memoryId?: string;

  /**
   * Table of mid-task nudges (`bgagent nudge`). When provided, the container
   * gets `NUDGES_TABLE_NAME`; without it the agent's nudge reader is off, so a
   * nudge the API accepted for an ECS task is never delivered. The agent reads
   * the table through the SessionRole, which must list it; without a SessionRole
   * the task role is granted the two calls the reader makes. Omitted in isolated
   * construct tests → no env, no grant.
   */
  readonly taskNudgesTable?: dynamodb.ITable;

  /** Fargate task sizing overrides. Any unset field uses its default. See {@link EcsTaskSizing}. */
  readonly taskSizing?: EcsTaskSizing;

  /**
   * S3 bucket holding per-task ECS payloads. The orchestrator writes the
   * payload here and passes only an `AGENT_PAYLOAD_S3_URI` pointer; the
   * container fetches it on boot. The task role gets **read-only** on this
   * bucket. When omitted, no grant or env var is added.
   */
  readonly payloadBucket?: s3.IBucket;

  /**
   * Artifacts bucket for repo-bound artifact workflows (``deliver_artifact``).
   * The container gets ``ARTIFACTS_BUCKET_NAME`` and the task role gets NO
   * bucket grant: the delivery write goes through the per-task SessionRole,
   * scoped to ``artifacts/${aws:PrincipalTag/task_id}/*``. Does not set
   * ``TRACE_ARTIFACTS_BUCKET_NAME``. When omitted, no env var is added.
   */
  readonly artifactsBucket?: s3.IBucket;

  /**
   * Per-task SessionRole. When provided, tenant-data DynamoDB access
   * (task/events tables) is NOT granted to the Fargate task role; instead the
   * agent assumes this SessionRole with session tags and the role's
   * tag-scoped policy governs that access. The task role is admitted to the
   * SessionRole's trust and `AGENT_SESSION_ROLE_ARN` is injected into the
   * container. When omitted (e.g. isolated construct tests), the task role
   * retains the direct grants.
   */
  readonly agentSessionRole?: AgentSessionRole;

  /**
   * AgentCore Memory for cross-task learning. When provided, the ECS task role
   * is granted read+write on it. Omitted in isolated construct tests /
   * memory-less deployments.
   */
  readonly agentMemory?: AgentMemory;

  /**
   * Tool-federation Gateway (ADR-019 P1). When provided, the ECS task role is
   * granted ``bedrock-agentcore:InvokeGateway`` and the container gets
   * ``ABCA_TOOL_GATEWAY_URL``. When omitted, no grant, no env.
   */
  readonly toolGateway?: ToolGateway;

  /**
   * Linear OAuth token vault (RFC #249 Phase 1). When provided, the task role
   * is granted token minting and the container gets the vault env vars. When
   * omitted, no grant, no env, and the agent stays on the Secrets-Manager path.
   */
  readonly linearIdentityVault?: LinearIdentityVault;

  /**
   * Secrets Manager name patterns of the channel OAuth bundles the agent may
   * read (ADR-024): only those of deployed trackers, so an omitted Linear or
   * Jira leaves no grant on CLI-created secrets that outlive the feature.
   * @default both `bgagent-linear-oauth-*` and `bgagent-jira-oauth-*` (legacy topology)
   */
  readonly channelOauthSecretPatterns?: readonly string[];
}

const HTTPS_PORT = 443;

const DEFAULT_BUILD_TASK_CPU = 4096;
const DEFAULT_BUILD_TASK_MEMORY_MIB = 16384;
const DEFAULT_BUILD_TASK_EPHEMERAL_STORAGE_GIB = 50;
const DEFAULT_PLANNING_TASK_CPU = 2048;
const DEFAULT_PLANNING_TASK_MEMORY_MIB = 8192;

/**
 * Per-task Fargate sizing overrides. Every field is optional; anything left
 * unset uses its default. Values are passed straight to the Fargate task
 * definition, so they must be a valid Fargate cpu/memory combination (see the
 * AWS Fargate docs) — an invalid pair fails at synth/deploy.
 */
export interface EcsTaskSizing {
  /** Build task vCPU units (1024 = 1 vCPU). Defaults to 4096 (4 vCPU). */
  readonly buildTaskCpu?: number;
  /** Build task memory in MiB. Defaults to 16384 (16 GB). */
  readonly buildTaskMemoryMiB?: number;
  /** Build task root-filesystem storage in GiB (21–200). Defaults to 50. */
  readonly buildTaskEphemeralStorageGiB?: number;
  /** Planning (read-only) task vCPU units. Defaults to 2048 (2 vCPU). */
  readonly planningTaskCpu?: number;
  /** Planning task memory in MiB. Defaults to 8192 (8 GB). */
  readonly planningTaskMemoryMiB?: number;
  /**
   * Extra environment variables for the BUILD task's container, merged over the
   * defaults (a key given here wins).
   */
  readonly extraBuildEnvironment?: Record<string, string>;
}

const RESERVED_BUILD_ENV_KEYS = new Set([
  'TASK_TABLE_NAME',
  'TASK_EVENTS_TABLE_NAME',
  'TASK_APPROVALS_TABLE_NAME',
  'USER_CONCURRENCY_TABLE_NAME',
  'NUDGES_TABLE_NAME',
  'LOG_GROUP_NAME',
  'GITHUB_TOKEN_SECRET_ARN',
  'MEMORY_ID',
  'ECS_PAYLOAD_BUCKET',
  'ARTIFACTS_BUCKET_NAME',
  'AGENT_SESSION_ROLE_ARN',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
]);

/**
 * Read {@link EcsTaskSizing} out of deploy context. Returns undefined when
 * nothing is set. Throws at synth on a malformed numeric value and on a
 * reserved platform env key in `ecsExtraBuildEnv`.
 */
export function resolveEcsTaskSizing(node: Node): EcsTaskSizing | undefined {
  const num = (key: string): number | undefined => {
    const raw = node.tryGetContext(key);
    if (raw === undefined || raw === null || raw === '') return undefined;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Context '${key}' must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return parsed;
  };

  const rawEnv = node.tryGetContext('ecsExtraBuildEnv');
  let extra: Record<string, string> | undefined;
  if (rawEnv !== undefined && rawEnv !== null && rawEnv !== '') {
    const parsed = typeof rawEnv === 'string' ? JSON.parse(rawEnv) : rawEnv;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error("Context 'ecsExtraBuildEnv' must be a JSON object of string values.");
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Context 'ecsExtraBuildEnv' value for '${k}' must be a string.`);
      }
      if (RESERVED_BUILD_ENV_KEYS.has(k)) {
        throw new Error(
          `Context 'ecsExtraBuildEnv' cannot set '${k}' — it is platform wiring, not a build-tool `
          + 'knob. Overriding it can break the task or silently disable tenant scoping.',
        );
      }
    }
    extra = parsed as Record<string, string>;
  }

  const sizing: EcsTaskSizing = {
    ...(num('ecsBuildTaskCpu') !== undefined && { buildTaskCpu: num('ecsBuildTaskCpu') }),
    ...(num('ecsBuildTaskMemoryMiB') !== undefined && { buildTaskMemoryMiB: num('ecsBuildTaskMemoryMiB') }),
    ...(num('ecsBuildTaskEphemeralStorageGiB') !== undefined && {
      buildTaskEphemeralStorageGiB: num('ecsBuildTaskEphemeralStorageGiB'),
    }),
    ...(num('ecsPlanningTaskCpu') !== undefined && { planningTaskCpu: num('ecsPlanningTaskCpu') }),
    ...(num('ecsPlanningTaskMemoryMiB') !== undefined && { planningTaskMemoryMiB: num('ecsPlanningTaskMemoryMiB') }),
    ...(extra !== undefined && { extraBuildEnvironment: extra }),
  };
  return Object.keys(sizing).length > 0 ? sizing : undefined;
}

export class EcsAgentCluster extends Construct {
  public readonly cluster: ecs.Cluster;
  /** The BUILD task def, for coding workflows that run a full CI-parity build. Selected for non-read-only workflows. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  /**
   * The smaller PLANNING task def, for any read-only workflow that clones +
   * reads + emits an artifact but never builds. Same image/role/env/grants as
   * the build def; the only difference is cpu/mem.
   */
  public readonly planningTaskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly containerName: string;
  public readonly taskRoleArn: string;
  public readonly logGroup: logs.LogGroup;
  public readonly executionRoleArn: string;

  constructor(scope: Construct, id: string, props: EcsAgentClusterProps) {
    super(scope, id);

    this.containerName = 'AgentContainer';

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

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

    const logGroup = this.logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const sdkUaAppId = buildAppId(
      Stack.of(this).stackName,
      this.node.tryGetContext('sdkUaAppId') as string | undefined,
    );

    const bedrockGeoRegion = resolveBedrockGeoRegion(this.node);

    const baseEnvironment: Record<string, string> = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_MODEL_ID),
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_AUX_MODEL_ID),
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      ...(props.taskApprovalsTable && {
        TASK_APPROVALS_TABLE_NAME: props.taskApprovalsTable.tableName,
      }),
      USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
      ...(props.taskNudgesTable && { NUDGES_TABLE_NAME: props.taskNudgesTable.tableName }),
      LOG_GROUP_NAME: logGroup.logGroupName,
      GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
      ...(props.memoryId && { MEMORY_ID: props.memoryId }),
      ...(props.payloadBucket && { ECS_PAYLOAD_BUCKET: props.payloadBucket.bucketName }),
      ...(props.artifactsBucket && { ARTIFACTS_BUCKET_NAME: props.artifactsBucket.bucketName }),
      ...(props.agentSessionRole && {
        AGENT_SESSION_ROLE_ARN: props.agentSessionRole.role.roleArn,
      }),
      ...(sdkUaAppId ? { AWS_SDK_UA_APP_ID: sdkUaAppId } : {}),
      ...(props.toolGateway && { ABCA_TOOL_GATEWAY_URL: props.toolGateway.gatewayUrl }),
      ...(props.linearIdentityVault && {
        LINEAR_VAULT_ENABLED: 'true',
        LINEAR_WORKLOAD_IDENTITY_NAME: props.linearIdentityVault.workloadName,
      }),
    };
    const image = ecs.ContainerImage.fromDockerImageAsset(props.agentImageAsset);
    const makeTaskDef = (
      taskDefId: string,
      cpu: number,
      memoryLimitMiB: number,
      extraEnv: Record<string, string>,
      ephemeralStorageGiB?: number,
    ) => {
      const def = new ecs.FargateTaskDefinition(this, taskDefId, {
        cpu,
        memoryLimitMiB,
        taskRole,
        executionRole,
        ...(ephemeralStorageGiB !== undefined && { ephemeralStorageGiB }),
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      def.addContainer(this.containerName, {
        image,
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'agent' }),
        environment: { ...baseEnvironment, ...extraEnv },
      });
      return def;
    };

    const sizing = props.taskSizing ?? {};
    const buildCpu = sizing.buildTaskCpu ?? DEFAULT_BUILD_TASK_CPU;
    const buildMemory = sizing.buildTaskMemoryMiB ?? DEFAULT_BUILD_TASK_MEMORY_MIB;
    const buildDisk = sizing.buildTaskEphemeralStorageGiB ?? DEFAULT_BUILD_TASK_EPHEMERAL_STORAGE_GIB;
    const planningCpu = sizing.planningTaskCpu ?? DEFAULT_PLANNING_TASK_CPU;
    const planningMemory = sizing.planningTaskMemoryMiB ?? DEFAULT_PLANNING_TASK_MEMORY_MIB;

    this.taskDefinition = makeTaskDef('TaskDef', buildCpu, buildMemory, {
      BUILD_VERIFY_TIMEOUT_S: '3600',
      JEST_MAX_WORKERS: '4',
      MISE_JOBS: '1',
      // pre-commit/prek read SKIP as a comma-separated list of hook ids to skip.
      SKIP: 'monorepo-tests-pre-push',
      ...(sizing.extraBuildEnvironment ?? {}),
    }, buildDisk);

    this.planningTaskDefinition = makeTaskDef('PlanningTaskDef', planningCpu, planningMemory, {});

    if (props.agentSessionRole) {
      props.agentSessionRole.admitComputeRole(taskRole);
    } else {
      props.taskTable.grantReadWriteData(taskRole);
      props.taskNudgesTable?.grant(taskRole, 'dynamodb:Query', 'dynamodb:UpdateItem');
      props.taskEventsTable.grantReadWriteData(taskRole);
      props.taskApprovalsTable?.grant(
        taskRole,
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      );
    }
    props.userConcurrencyTable.grantReadWriteData(taskRole);

    props.githubTokenSecret.grantRead(taskRole);

    if (props.payloadBucket) {
      props.payloadBucket.grantRead(taskRole);
    }

    if (props.agentMemory) {
      props.agentMemory.grantReadWrite(taskRole);
    }

    if (props.linearIdentityVault) {
      props.linearIdentityVault.grantMintToken(taskRole);
    }

    if (props.toolGateway) {
      props.toolGateway.grantInvoke(taskRole);
    }

    const channelOauthSecretPatterns = props.channelOauthSecretPatterns ?? CHANNEL_OAUTH_SECRET_PATTERNS;
    if (channelOauthSecretPatterns.length > 0) {
      taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: channelOauthSecretPatterns.map(resourceName => Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName,
        })),
      }));
    }

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
          resourceName: `${bedrockGeoRegion}.${modelId}`,
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

    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
    }));

    logGroup.grantWrite(taskRole);

    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = executionRole.roleArn;

    const taskRoleIam5 = [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards from CDK grantReadWriteData (UserConcurrencyTable, and task tables only when no SessionRole is wired); Secrets Manager wildcards from CDK grantRead (GitHub token) and the bgagent-linear-oauth-*/bgagent-jira-oauth-* prefix grant (ABCA-488 — per-workspace channel OAuth tokens are created by the CLI at setup, name unknown at synth, GetSecretValue only); CloudWatch Logs wildcards from CDK grantWrite; S3 object/* wildcard from CDK grantRead on the ECS payload bucket (read-only, scoped to that bucket — #502). Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard resource). ec2:DescribeAvailabilityZones requires Resource:* (EC2 describe actions have no resource-level scoping) — read-only, no mutation/data access; needed so a CDK target repo\'s `cdk synth` build gate can resolve AZ context on a fresh clone (ECS-parity, no cdk.context.json cache in the container).',
      },
    ];
    NagSuppressions.addResourceSuppressions(taskRole, [
      ...taskRoleIam5,
      {
        id: 'AwsSolutions-ECS2',
        reason: 'Environment variables contain table names and configuration, not secrets — GitHub token is fetched from Secrets Manager at runtime',
      },
    ], true);
    // When the policy outgrows the inline limit, CDK moves statements into managed
    // policies during synthesis. Default priority runs this after cdk-nag.
    Aspects.of(taskRole).add({
      visit(node: IConstruct): void {
        if (node instanceof iam.CfnManagedPolicy) NagSuppressions.addResourceSuppressions(node, taskRoleIam5);
      },
    }, { priority: AspectPriority.MUTATING });
    NagSuppressions.addResourceSuppressions(executionRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonECSTaskExecutionRolePolicy is the AWS-recommended managed policy for ECS Fargate task execution (ECR image pull + CloudWatch Logs); shared by both the build and planning task defs.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'ecr:GetAuthorizationToken requires Resource:* (CDK grantPull for the agent image asset); the remaining ECR pull + CloudWatch Logs wildcards are CDK-generated grants scoped to the image repo and the task log group.',
      },
    ], true);
    for (const def of [this.taskDefinition, this.planningTaskDefinition]) {
      NagSuppressions.addResourceSuppressions(def, [
        {
          id: 'AwsSolutions-ECS2',
          reason: 'Environment variables contain table names and configuration, not secrets — GitHub token is fetched from Secrets Manager at runtime',
        },
      ], true);
    }

    NagSuppressions.addResourceSuppressions(this.cluster, [
      {
        id: 'AwsSolutions-ECS4',
        reason: 'Container insights is enabled via the containerInsightsV2 prop',
      },
    ], true);
  }
}
