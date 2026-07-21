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
import { AgentMemory } from './agent-memory';
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
   * Artifacts bucket for repo-bound artifact workflows (#299 coding/decompose-v1
   * emits its plan JSON here via ``deliver_artifact``). The AgentCore runtime
   * gets ``ARTIFACTS_BUCKET_NAME`` in its env; the ECS task needs the SAME env
   * (but NO bucket grant) or an artifact workflow fails at delivery with
   * "ARTIFACTS_BUCKET_NAME is not configured" (live-caught: a :decompose on an
   * ecs-configured repo). The delivery WRITE goes through the assumed per-task
   * SessionRole (scoped to ``artifacts/${aws:PrincipalTag/task_id}/*``), so the
   * task role gets only the env var — parity with the AgentCore runtime role,
   * which likewise has no direct artifacts grant (see the grant block below for
   * the rationale).
   *
   * NOTE: this wires only ``ARTIFACTS_BUCKET_NAME`` (artifact delivery). It does
   * NOT set ``TRACE_ARTIFACTS_BUCKET_NAME`` (telemetry.py reads that for the
   * ``--trace`` upload), so ``--trace`` silently skips on ECS today — a separate
   * ECS-parity gap, not wired here.
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

  /**
   * AgentCore Memory for cross-task learning (F-2 / ABCA-488-class parity). When
   * provided, the ECS task role is granted read+write on it so the agent's
   * memory writes (write_task_episode / write_repo_learnings →
   * ``bedrock-agentcore:CreateEvent``) succeed on the ECS substrate. The
   * AgentCore runtime role already gets this via ``agentMemory.grantReadWrite``
   * in agent.ts; without the same grant here, memory writes hit AccessDenied and
   * no-op on ECS (logged, non-fatal — memory.py treats an AccessDenied as an
   * infra failure), so learning never persists on an ECS-only deployment.
   * Omitted in isolated construct tests / memory-less deployments.
   */
  readonly agentMemory?: AgentMemory;
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

    // Fargate task definition. Sized for heavy CI-parity builds (e.g. ABCA's
    // own ~2800-test `mise run build` + cdk synth). Sizing history (all
    // live-caught dogfooding ABCA-on-ABCA, 2026-06-29):
    //   - 4 GB / 2 vCPU  → OOM-killed even the AgentCore microVM.
    //   - 32 GB / 8 vCPU → ran ~50 min then OOM-killed (exit 137) at the cap;
    //     peak working set ~31.6 GB when the root build fans out 4 heavy jobs
    //     in PARALLEL (agent:quality ‖ cdk:build ‖ cli:build ‖ docs:build),
    //     each spawning its own worker fleet (jest maxWorkers, pytest, esbuild
    //     Lambda bundling). 32 GB had no headroom for that concurrent peak.
    //   - 64 GB / 16 vCPU → still OOM-killed (exit 137) on ABCA-662's baseline
    //     build: the parallel storm's peak exceeded 64 GB too. The false
    //     "build_before=broken" that followed is fixed in repo.py, but the build
    //     itself genuinely needs more RAM.
    //   - 120 GB / 16 vCPU (current) → the MAX Fargate admits at 16 vCPU (32–120
    //     GB in 8 GB steps). If a build OOMs even here, the fix is to cut the
    //     build's peak parallelism (serialize the mise DAG / cap jest workers),
    //     not more RAM — there is none. Paired with BUILD_VERIFY_TIMEOUT_S=3600.
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 16384,
      memoryLimitMiB: 122880,
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

    // #299 ECS-parity: coding/decompose-v1 delivers its plan to the artifacts
    // bucket via deliver_artifact — but the write goes through the assumed
    // SessionRole (deliverers.py -> tenant_client), scoped to
    // artifacts/${task_id}/*, exactly like the AgentCore runtime (whose task
    // role likewise has NO direct artifacts grant). So the task role needs only
    // the ARTIFACTS_BUCKET_NAME env (set above), not a bucket grant. Granting
    // whole-bucket read+write here would over-privilege the untrusted-code role
    // and break cross-task isolation (a task could read/clobber other tasks'
    // artifacts/<other_id>/, traces/, attachments/ on the same bucket).
    // (no props.artifactsBucket grant — intentional; see comment)

    // F-2 (ABCA-488-class parity): grant the task role read+write on the
    // AgentCore Memory so the agent's cross-task learning writes
    // (write_task_episode / write_repo_learnings → bedrock-agentcore:CreateEvent)
    // succeed on ECS. The AgentCore runtime role gets this via
    // agentMemory.grantReadWrite(runtime) in agent.ts; without the same grant
    // here the writes hit AccessDenied and no-op on the ECS substrate (logged,
    // non-fatal), so learning never persists on an ECS-only deployment.
    if (props.agentMemory) {
      props.agentMemory.grantReadWrite(taskRole);
    }

    // ABCA-488: per-workspace Linear/Jira OAuth tokens live in Secrets Manager
    // under `bgagent-linear-oauth-*` (written by the CLI at setup). For a
    // Linear/Jira-channel task the agent resolves that token at startup
    // (config.resolve_linear_api_token / resolve_jira_oauth_token) to fire the
    // 👀→✅ reaction and drive the channel MCP. The AgentCore runtime role +
    // orchestrator/fanout/screenshot roles all have this prefix grant; the ECS
    // task role did NOT, so on ECS the token fetch hit AccessDenied and
    // reactions/MCP no-op'd — logged by config.py's token resolver, not silent,
    // but the channel effect (no 👀→✅, no MCP) is invisible to the user
    // (ECS-parity gap, live-caught on ABCA-488).
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

    // ECS-parity: a CDK-based target repo's build gate runs `cdk synth`, and a
    // stack wired to a concrete env ({account, region}) does a synth-time
    // availability-zone context lookup (ec2:DescribeAvailabilityZones). On a
    // developer box the gitignored cdk.context.json caches the answer so synth
    // is hermetic; the agent clones fresh, so there's no cache and synth fires
    // the live lookup. Without this grant the ECS task role hit AccessDenied →
    // "Synthesis finished with errors" → a FALSE build-gate failure on code that
    // builds fine everywhere else (live-caught on the ABCA fork; same class as
    // the ABCA-488 GetSecretValue and F-2 CreateEvent ECS-parity gaps). This is a
    // read-only describe with no resource-level scoping in IAM, so Resource:* is
    // required (suppressed below); it grants no mutation and no data access.
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
    }));

    // CloudWatch Logs write
    logGroup.grantWrite(taskRole);

    // Expose role ARNs for scoped iam:PassRole in the orchestrator
    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = this.taskDefinition.executionRole!.roleArn;

    NagSuppressions.addResourceSuppressions(this.taskDefinition, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards from CDK grantReadWriteData (UserConcurrencyTable, and task tables only when no SessionRole is wired); Secrets Manager wildcards from CDK grantRead (GitHub token) and the bgagent-linear-oauth-*/bgagent-jira-oauth-* prefix grant (ABCA-488 — per-workspace channel OAuth tokens are created by the CLI at setup, name unknown at synth, GetSecretValue only); CloudWatch Logs wildcards from CDK grantWrite; S3 object/* wildcard from CDK grantRead on the ECS payload bucket (read-only, scoped to that bucket — #502). Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard resource). ec2:DescribeAvailabilityZones requires Resource:* (EC2 describe actions have no resource-level scoping) — read-only, no mutation/data access; needed so a CDK target repo\'s `cdk synth` build gate can resolve AZ context on a fresh clone (ECS-parity, no cdk.context.json cache in the container).',
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
