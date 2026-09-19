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
import { Construct, type Node } from 'constructs';
import { AgentMemory } from './agent-memory';
import { AgentSessionRole, grantAgentTaskTableAccess, grantAgentApprovalReadAccess } from './agent-session-role';
import {
  PLATFORM_DEFAULT_AUX_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  inferenceProfileId,
  resolveBedrockGeoRegion,
  resolveBedrockModelIds,
} from './bedrock-models';
import { LinearIdentityVault } from './linear-identity-vault';
import { grantWorkerBootstrap } from './payload-bootstrap-permissions';
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
   * Optional Fargate task sizing overrides. Any unset field uses the generous
   * default; a consumer with a lighter repo should shrink the build task to cut
   * cost. See {@link EcsTaskSizing}.
   */
  readonly taskSizing?: EcsTaskSizing;

  /**
   * S3 storage for deployment manifests, task payloads and private launch
   * references. The v2 coordinator sends AGENT_PAYLOAD_REF, containing a
   * single-object signed download URL. The task role can read only bootstrap/*;
   * object reads elsewhere and bucket listing are explicitly denied. The
   * coordinator owns writes and cleanup. Optional for isolated construct tests;
   * production ECS launches require this bucket and a matching v2 image.
   */
  readonly payloadBucket?: s3.IBucket;

  /**
   * Artifacts bucket for repo-bound artifact workflows (a planning
   * workflow emits its plan JSON here via ``deliver_artifact``). The AgentCore
   * runtime gets ``ARTIFACTS_BUCKET_NAME`` in its env; the ECS task needs the
   * SAME env (but NO bucket grant) or an artifact workflow fails at delivery with
   * "ARTIFACTS_BUCKET_NAME is not configured". The delivery WRITE goes through
   * the assumed per-task SessionRole (scoped to
   * ``artifacts/${aws:PrincipalTag/task_id}/*``), so the task role gets only the
   * env var — parity with the AgentCore runtime role, which likewise has no
   * direct artifacts grant (see the grant block below for the rationale).
   *
   * NOTE: this wires only ``ARTIFACTS_BUCKET_NAME`` (artifact delivery). It does
   * NOT set ``TRACE_ARTIFACTS_BUCKET_NAME`` (telemetry.py reads that for the
   * ``--trace`` upload), so ``--trace`` silently skips on ECS today — a separate
   * ECS-vs-AgentCore parity gap, not wired here.
   * Omitted in isolated construct tests → no env/grant.
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
  readonly approvalRequestsApiUrl?: string;

  /**
   * AgentCore Memory for cross-task learning. When provided, the ECS task role
   * is granted read+write on it so the agent's memory writes (write_task_episode
   * / write_repo_learnings → ``bedrock-agentcore:CreateEvent``) succeed on the
   * ECS substrate. The AgentCore runtime role already gets this via
   * ``agentMemory.grantReadWrite`` in agent.ts; without the same grant here,
   * memory writes hit AccessDenied and no-op on ECS (logged, non-fatal —
   * memory.py treats an AccessDenied as an infra failure), so learning never
   * persists on an ECS-only deployment. Omitted in isolated construct tests /
   * memory-less deployments.
   */
  readonly agentMemory?: AgentMemory;

  /**
   * Tool-federation Gateway (ADR-019 P1). When provided, the ECS task role is
   * granted ``bedrock-agentcore:InvokeGateway`` and the container gets
   * ``ABCA_TOOL_GATEWAY_URL`` — parity with the AgentCore runtime, so a
   * gateway-federated MCP tool works on the ECS substrate too. Omitted when the
   * gateway is not provisioned (the default) or in isolated construct tests →
   * no grant, no env.
   */
  readonly toolGateway?: ToolGateway;

  /**
   * Linear OAuth token vault (RFC #249 Phase 1), so the agent's Linear token
   * resolution works on the ECS substrate too. The agent self-mints through
   * boto3 (`config.py::_resolve_linear_token_via_vault`) against the task role's
   * ambient credentials, so ECS needs BOTH the env vars and the token grant —
   * the AgentCore runtime env does not reach this container. Omitted when the
   * vault is not provisioned (the default) or in isolated construct tests → no
   * grant, no env, and the agent stays on the Secrets-Manager path.
   */
  readonly linearIdentityVault?: LinearIdentityVault;
}

/** HTTPS port — the only egress allowed from the agent task ENIs. */
const HTTPS_PORT = 443;

/**
 * Default Fargate task sizes (vCPU units / MiB / GiB). These defaults are
 * deliberately MODEST, because a default is what an adopter who changes nothing
 * pays for and Fargate bills per requested vCPU-second and RAM-second. Both task
 * sizes are overridable via {@link EcsAgentClusterProps.taskSizing}, reachable at
 * deploy time through context (see {@link resolveEcsTaskSizing}).
 *
 *  - BUILD task: 4 vCPU / 16 GB / 50 GiB disk.
 *
 *    CPU and memory are modest on measured evidence: a full parallel build of a
 *    large TypeScript + Python monorepo (agent + CDK + CLI + docs) peaked at
 *    ~3.1 GB of the 16 GB, because ``MISE_JOBS=1`` serialises the packages so peak
 *    is max-single-package rather than sum-of-all. Nearly 5x headroom.
 *
 *    Disk is the tighter constraint: the same build peaked at ~14.7 GiB, so
 *    Fargate's 20 GiB default leaves
 *    only ~1.4x — a heavier dependency cache or a second build sharing the task
 *    would run it out of space and surface as a spurious build failure. 50 GiB
 *    restores real margin, and ephemeral storage is a small fraction of the
 *    per-task cost next to vCPU and RAM.
 *
 *    A repo that genuinely needs more can go to Fargate's ceiling of
 *    16 vCPU / 120 GB (and up to 200 GiB of disk) through {@link EcsTaskSizing}.
 *    Note a memory-heavy build is helped only by more per-task RAM or fewer
 *    parallel build steps — a build task runs in its own isolated microVM, so
 *    capping how many tasks run at once does not help.
 *  - PLANNING task: 2 vCPU / 8 GB / default disk. For read-only workflows that
 *    clone and read the repo to produce a plan but never build. "Read-only"
 *    describes the WORKFLOW's behaviour, not a reduced IAM role: both task defs
 *    are built by one factory and deliberately share a single task role and
 *    execution role, because splitting them is how a grant silently lands on one
 *    def and not the other. Do not read the name as a privilege boundary.
 */
// Build defaults: 4 vCPU / 16 GiB RAM / 50 GiB disk.
// Planning defaults: 2 vCPU / 8 GiB RAM / Fargate's 20 GiB default disk.
// EcsTaskSizing overrides these values for the target repository's workload.
const DEFAULT_BUILD_TASK_CPU = 4096;
const DEFAULT_BUILD_TASK_MEMORY_MIB = 16384;
const DEFAULT_BUILD_TASK_EPHEMERAL_STORAGE_GIB = 50;
const DEFAULT_PLANNING_TASK_CPU = 2048;
const DEFAULT_PLANNING_TASK_MEMORY_MIB = 8192;

/**
 * Per-task Fargate sizing overrides. Every field is optional; anything left
 * unset uses the default above. A consumer with a lighter repo should shrink the
 * build task to cut cost; a heavy monorepo can keep
 * or raise it up to the Fargate ceiling of 16 vCPU / 120 GB. Values are passed
 * straight to the Fargate task definition, so they must be a valid Fargate
 * cpu/memory combination (see the AWS Fargate docs) — an invalid pair fails at
 * synth/deploy, not silently.
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
   *
   * The platform sets a few build-tool variables that are only meaningful for the
   * toolchain a given repo actually uses — a verify timeout, and parallelism caps
   * for a mise/jest-shaped build. Those values were measured against one
   * monorepo, so they are this deployment's opinion rather than a universal
   * default: a repo that uses none of those tools ignores them, and a repo that
   * uses mise with plenty of memory will want the serialisation cap raised. Set
   * them here rather than editing the construct.
   */
  readonly extraBuildEnvironment?: Record<string, string>;
}

/**
 * Read {@link EcsTaskSizing} out of deploy context, so the sizing and build-tool
 * knobs are reachable without editing this file. Returns undefined when nothing
 * is set, so the construct's own defaults apply untouched.
 *
 * Numeric keys are parsed strictly: a malformed value throws at synth rather
 * than silently falling back to the default, because "I set the flag and the
 * build still OOM'd" is a much worse afternoon than a failed synth.
 *
 * Reserved platform env keys are REJECTED rather than merged. The container's
 * base environment carries load-bearing wiring — table names, the artifacts
 * bucket, and ``AGENT_SESSION_ROLE_ARN``, whose absence turns tenant scoping off
 * without failing the task. A caller reaching for a build-tool override must not
 * be able to unset those by a typo.
 */
/**
 * Container env keys the platform owns. A build-tool override must not be able to
 * reach these: they carry table names, bucket names and the agent-session role.
 * ``AGENT_SESSION_ROLE_ARN`` is the sharp one — when it is absent the agent falls
 * back to ambient credentials and per-tenant scoping is silently OFF, which the
 * agent's own session module calls its most dangerous failure mode. A typo in an
 * override key should fail synth, not disable an isolation control.
 */
const RESERVED_BUILD_ENV_KEYS = new Set([
  'APPROVAL_REQUESTS_API_URL',
  'TASK_TABLE_NAME',
  'TASK_EVENTS_TABLE_NAME',
  'TASK_APPROVALS_TABLE_NAME',
  'USER_CONCURRENCY_TABLE_NAME',
  'LOG_GROUP_NAME',
  'GITHUB_TOKEN_SECRET_ARN',
  'MEMORY_ID',
  'ECS_PAYLOAD_BUCKET',
  'ARTIFACTS_BUCKET_NAME',
  'AGENT_SESSION_ROLE_ARN',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
]);

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
  /** The BUILD task def (default 4 vCPU / 16 GB, raisable to the Fargate ceiling
   *  of 16 vCPU / 120 GB via {@link EcsTaskSizing}) — for coding workflows that
   *  run a full CI-parity build. Selected for non-read-only workflows. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  /**
   * The smaller read-only PLANNING task def (8 GB / 2 vCPU) — for any read-only
   * workflow that clones + reads + emits an artifact but never builds. Both
   * definitions share their image, roles, grants and platform environment.
   * Sizing, disk and build-tool settings differ. The orchestrator selects this
   * definition for read-only workflows on an ECS repo.
   */
  public readonly planningTaskDefinition: ecs.FargateTaskDefinition;
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

    // SHARED task + execution roles for BOTH task defs. The build def and the
    // planning def MUST have identical IAM + env, or a token/grant present on one
    // def and missing on the other causes a bug that only shows up on whichever
    // task type is missing it. Rather than grant twice, we create the roles ONCE
    // here and pass the SAME roles to both task defs, and build the container from
    // a single shared spec. So there is exactly one place grants/env can be
    // edited, and both defs stay in lockstep by construction.
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Outbound SDK solution attribution (#319): botocore reads
    // AWS_SDK_UA_APP_ID natively → `app/uksb-wt64nei4u6#{stack}`. The
    // Lambda-only stack aspect can't reach this container, so set it here on
    // the shared base env so BOTH task defs (build + planning) carry it.
    // `-c sdkUaAppId=''` opts out (buildAppId → undefined → omitted).
    const sdkUaAppId = buildAppId(
      Stack.of(this).stackName,
      this.node.tryGetContext('sdkUaAppId') as string | undefined,
    );

    // The container spec shared by both task defs — image, logging, env are
    // IDENTICAL; only the enclosing task def's cpu/mem differ. BUILD_VERIFY_TIMEOUT_S
    // is a build-tier concern (a read-only planner never runs the post-agent build
    // verify), so it's set per-def below, not here.
    // Resolved once, above baseEnvironment: the env vars below and the IAM grants
    // further down must name the SAME geography, so they read one value.
    const bedrockGeoRegion = resolveBedrockGeoRegion(this.node);

    const baseEnvironment: Record<string, string> = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      // Both models as geo-prefixed inference-profile ids, from the same resolved
      // geography as the IAM grants below. Previously neither was set here, so an
      // ECS task fell through to the literals in agent/src/config.py — which a
      // geography change does not touch — and a non-default `bedrockGeoRegion`
      // granted one geography while the agent called another's profile. Parity with
      // the AgentCore runtime env (stacks/agent.ts) is the point: the two substrates
      // must not disagree about which model a task runs.
      ANTHROPIC_MODEL: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_MODEL_ID),
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_AUX_MODEL_ID),
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      ...(props.taskApprovalsTable && {
        TASK_APPROVALS_TABLE_NAME: props.taskApprovalsTable.tableName,
      }),
      ...(props.approvalRequestsApiUrl && { APPROVAL_REQUESTS_API_URL: props.approvalRequestsApiUrl }),
      USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
      LOG_GROUP_NAME: logGroup.logGroupName,
      GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
      ...(props.memoryId && { MEMORY_ID: props.memoryId }),
      // Deployment metadata; the per-task AGENT_PAYLOAD_REF supplies the
      // manifest URI and signed payload URL. IAM authenticates the manifest.
      ...(props.payloadBucket && { ECS_PAYLOAD_BUCKET: props.payloadBucket.bucketName }),
      // Artifact workflows (planning/analysis) deliver their document to
      // this bucket. The AgentCore runtime has ARTIFACTS_BUCKET_NAME; the ECS task
      // needs it too or deliver_artifact raises "ARTIFACTS_BUCKET_NAME is not
      // configured".
      ...(props.artifactsBucket && { ARTIFACTS_BUCKET_NAME: props.artifactsBucket.bucketName }),
      // Per-session IAM scoping: when a SessionRole is wired, the agent assumes
      // it for tenant-data access (see aws_session.py).
      ...(props.agentSessionRole && {
        AGENT_SESSION_ROLE_ARN: props.agentSessionRole.role.roleArn,
      }),
      // #319 outbound SDK solution attribution — set on the shared base so both
      // task defs emit `app/uksb-wt64nei4u6#{stack}`.
      ...(sdkUaAppId ? { AWS_SDK_UA_APP_ID: sdkUaAppId } : {}),
      // ADR-019 P1: federated-tool Gateway URL, parity with the AgentCore
      // runtime env. Present only when the gateway is provisioned.
      ...(props.toolGateway && { ABCA_TOOL_GATEWAY_URL: props.toolGateway.gatewayUrl }),
      // RFC #249 Phase 1: Linear token vault, parity with the AgentCore runtime
      // env. Without these the ECS agent silently stays on the Secrets-Manager
      // path even when the vault is enabled.
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
        // Raise root-fs storage past Fargate's 20 GiB default for build tasks so
        // a large clone plus build caches don't run the disk out of space
        // mid-build (ENOSPC); omitted → the 20 GiB default.
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

    // Resolve task sizing: each field falls back to its default when the
    // consumer didn't override it. See DEFAULT_BUILD_TASK_* above for why the
    // build default is large, and EcsTaskSizing for how to shrink it.
    const sizing = props.taskSizing ?? {};
    const buildCpu = sizing.buildTaskCpu ?? DEFAULT_BUILD_TASK_CPU;
    const buildMemory = sizing.buildTaskMemoryMiB ?? DEFAULT_BUILD_TASK_MEMORY_MIB;
    const buildDisk = sizing.buildTaskEphemeralStorageGiB ?? DEFAULT_BUILD_TASK_EPHEMERAL_STORAGE_GIB;
    const planningCpu = sizing.planningTaskCpu ?? DEFAULT_PLANNING_TASK_CPU;
    const planningMemory = sizing.planningTaskMemoryMiB ?? DEFAULT_PLANNING_TASK_MEMORY_MIB;

    this.taskDefinition = makeTaskDef('TaskDef', buildCpu, buildMemory, {
      // Heavy CI-parity builds legitimately run longer than the 1800s default.
      BUILD_VERIFY_TIMEOUT_S: '3600',
      // Repositories that honor JEST_MAX_WORKERS use four Jest workers on build
      // tasks. An absolute value keeps that limit stable when task CPU changes;
      // it does not set worker counts for other test runners.
      JEST_MAX_WORKERS: '4',
      // Run one mise task at a time to limit overlap between package builds.
      // Individual tools can still run their own workers, and the coding agent
      // remains resident. This trades build duration for lower peak memory;
      // it does not cap direct pytest/Jest calls or guarantee a workload fits.
      MISE_JOBS: '1',
      // For repositories using this pre-commit/prek hook ID, skip that named
      // pre-push test hook. Other hook IDs remain enabled. This does not establish
      // that the repository's tests already ran; verification depends on its
      // configured workflow. shell.py::_clean_env passes SKIP to git subprocesses.
      SKIP: 'monorepo-tests-pre-push',
      // Caller overrides win: the values above are tuned for one monorepo's
      // toolchain, so a deployment with a different build shape replaces them
      // through `taskSizing.extraBuildEnvironment` rather than editing this file.
      ...(sizing.extraBuildEnvironment ?? {}),
    }, buildDisk);

    // PLANNING task def — for read-only workflows that clone + read + emit a plan
    // artifact but NEVER build. 8 GB / 2 vCPU: a clone + a bounded set of file
    // reads into the model context, no parallel build storm. Same image/roles/env
    // as the build def (so channel OAuth, artifact delivery, payload fetch all
    // work identically); NO BUILD_VERIFY_TIMEOUT_S (a read-only planner runs no
    // build verify). If 8 GB proves tight on a very large clone, 16 GB / 4 vCPU is
    // the next step — size up on Container Insights evidence.
    this.planningTaskDefinition = makeTaskDef('PlanningTaskDef', planningCpu, planningMemory, {});

    // DynamoDB: when a SessionRole is wired, tenant-data access lives on that
    // tag-scoped role and the task role only needs to assume it. Without one
    // (isolated construct tests / no SessionRole), grant the task role directly.
    if (props.agentSessionRole) {
      props.agentSessionRole.admitComputeRole(taskRole);
    } else {
      grantAgentTaskTableAccess(props.taskTable, taskRole, false);
      props.taskEventsTable.grantReadWriteData(taskRole);
      if (props.taskApprovalsTable) grantAgentApprovalReadAccess(props.taskApprovalsTable, taskRole, false);
    }
    // Capacity counters are coordinator-owned. The agent never accesses them.

    // Secrets Manager read for GitHub token (read once at startup, before the
    // agent assumes the SessionRole — stays on the task role).
    props.githubTokenSecret.grantRead(taskRole);

    // Only deployment manifests use worker credentials. The boot helper reads
    // its exact task object through a signed URL and removes that capability
    // from the environment before starting repository code.
    if (props.payloadBucket) {
      grantWorkerBootstrap(props.payloadBucket, taskRole);
    }

    // Artifact workflows (planning/analysis) deliver their document to the
    // artifacts bucket via deliver_artifact — but the write goes through the
    // assumed SessionRole (deliverers.py -> tenant_client), scoped to
    // artifacts/${task_id}/*, exactly like the AgentCore runtime (whose task
    // role likewise has NO direct artifacts grant). So the task role needs only
    // the ARTIFACTS_BUCKET_NAME env (set above), not a bucket grant. Granting
    // whole-bucket read+write here would over-privilege the untrusted-code role
    // and break cross-task isolation (a task could read/clobber other tasks'
    // artifacts/<other_id>/, traces/, attachments/ on the same bucket).
    // (no props.artifactsBucket grant — intentional; see comment)

    // Grant the task role read+write on the AgentCore Memory so the agent's
    // cross-task learning writes (write_task_episode / write_repo_learnings →
    // bedrock-agentcore:CreateEvent) succeed on ECS. The AgentCore runtime role
    // gets this via agentMemory.grantReadWrite(runtime) in agent.ts; without the
    // same grant here the writes hit AccessDenied and no-op on the ECS substrate
    // (logged, non-fatal), so learning never persists on an ECS-only deployment.
    if (props.agentMemory) {
      props.agentMemory.grantReadWrite(taskRole);
    }

    // Same ECS-parity shape as the memory grant above (RFC #249 Phase 1): the
    // AgentCore runtime role gets this via linearIdentityVault.grantMintToken()
    // in agent.ts. Without the identical grant here, the ECS agent's vault
    // token call hits AccessDenied, silently falls back to Secrets Manager
    // (logged, non-fatal), and the vault path is never exercised on ECS.
    if (props.linearIdentityVault) {
      props.linearIdentityVault.grantMintToken(taskRole);
    }

    // ADR-019 P1: parity with the AgentCore runtime's InvokeGateway grant in
    // agent.ts — the ECS task role SigV4-invokes the same tool Gateway. Without
    // this, a gateway-federated MCP tool AccessDenies on the ECS substrate.
    if (props.toolGateway) {
      props.toolGateway.grantInvoke(taskRole);
    }

    // Per-workspace Linear/Jira OAuth tokens live in Secrets Manager under
    // `bgagent-linear-oauth-*` (written by the CLI at setup). For a
    // Linear/Jira-channel task the agent resolves that token at startup
    // (config.resolve_linear_api_token / resolve_jira_oauth_token) to fire the
    // 👀→✅ reaction and drive the channel MCP. The AgentCore runtime role +
    // orchestrator/fanout/screenshot roles all have this prefix grant; the ECS
    // task role did NOT, so on ECS the token fetch hit AccessDenied and
    // reactions/MCP no-op'd — logged by config.py's token resolver, not silent,
    // but the channel effect (no 👀→✅, no MCP) is invisible to the user.
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
    // grants in agent.ts), NOT a Resource: '*' wildcard. The model set and the
    // inference-profile geography are both the shared, context-overridable
    // values (constructs/bedrock-models.ts: `bedrockModels`, `bedrockGeoRegion`)
    // so the ECS and AgentCore backends can't drift.
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
          // Same `<geo>.<modelId>` shape CrossRegionInferenceProfile.fromConfig
          // builds for the AgentCore grant — regional + account-qualified for
          // every geography, `global.` included.
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

    // A CDK-based target repo's build gate runs `cdk synth`, and a stack wired to
    // a concrete env ({account, region}) does a synth-time availability-zone
    // context lookup (ec2:DescribeAvailabilityZones). On a developer box the
    // gitignored cdk.context.json caches the answer so synth is hermetic; the
    // agent clones fresh, so there's no cache and synth fires the live lookup.
    // Without this grant the ECS task role hit AccessDenied → "Synthesis finished
    // with errors" → a FALSE build-gate failure on code that builds fine
    // everywhere else. This is a read-only describe with no resource-level scoping
    // in IAM, so Resource:* is required (suppressed below); it grants no mutation
    // and no data access.
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
    }));

    // CloudWatch Logs write
    logGroup.grantWrite(taskRole);

    // Expose role ARNs for scoped iam:PassRole in the orchestrator. Both task
    // defs share these roles, so one ARN pair covers both defs' PassRole grants.
    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = executionRole.roleArn;

    // cdk-nag suppressions. The task role + execution role are SHARED standalone
    // constructs rather than roles auto-created under a single task def, so the
    // IAM suppressions must target the ROLES directly — a def-level
    // `applyToChildren` suppression no longer reaches them (they're siblings of
    // the task defs, not children). ECS2 (container env-vars-not-secrets) still
    // belongs on each task def.
    NagSuppressions.addResourceSuppressions(taskRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards from the legacy TaskEventsTable grant when no SessionRole is wired (TaskTable allows only reporting updates; the worker has no UserConcurrency access); Secrets Manager wildcards from CDK grantRead (GitHub token) and the bgagent-linear-oauth-*/bgagent-jira-oauth-* prefix grant (ABCA-488 — per-workspace channel OAuth tokens are created by the CLI at setup, name unknown at synth, GetSecretValue only); CloudWatch Logs wildcards from CDK grantWrite; Worker S3 GetObject is restricted to bootstrap/*; other object reads and payload-bucket listing are explicitly denied (#700). Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard resource). ec2:DescribeAvailabilityZones requires Resource:* (EC2 describe actions have no resource-level scoping) — read-only, no mutation/data access; needed so a CDK target repo\'s `cdk synth` build gate can resolve AZ context on a fresh clone (ECS-parity, no cdk.context.json cache in the container).',
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: 'Environment variables contain table names and configuration, not secrets — GitHub token is fetched from Secrets Manager at runtime',
      },
    ], true);
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
    // Same ECS2 posture on BOTH task defs (they share the container spec).
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
        reason: 'Container insights is enabled via the containerInsights prop',
      },
    ], true);
  }
}
