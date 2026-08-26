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
import { AgentSessionRole } from './agent-session-role';
import { resolveBedrockModelIds } from './bedrock-models';
import { buildAppId } from './solution-ua-aspect';
import { ToolGateway } from './tool-gateway';

export interface EcsAgentClusterProps {
  readonly vpc: ec2.IVpc;
  readonly agentImageAsset: ecr_assets.DockerImageAsset;
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
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
   * S3 bucket holding per-task ECS payloads. The orchestrator writes the
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
 *    Disk is the tighter constraint and is sized less aggressively for that
 *    reason: the same build peaked at ~14.7 GiB, so Fargate's 21 GiB floor leaves
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
// A MODEST default: 4 vCPU / 16 GB, and Fargate's own 20 GiB disk.
//
// Deliberately not the Fargate ceiling. A default is what an adopter who changes
// nothing gets, and at 16 vCPU / 120 GB that is roughly 5x the per-build cost of
// this size in us-east-1 on-demand. Under-provisioning surfaces as a slow or
// OOM-ing build, which is diagnosable and fixable with one prop; over-provisioning
// surfaces as a bill, which is not. A large TypeScript + Python monorepo genuinely
// needs more — raise it through {@link EcsTaskSizing}, up to Fargate's 16 vCPU /
// 120 GB maximum, and raise ephemeral storage with it if concurrent builds run the
// disk out of space.
const DEFAULT_BUILD_TASK_CPU = 4096;
const DEFAULT_BUILD_TASK_MEMORY_MIB = 16384;
const DEFAULT_BUILD_TASK_EPHEMERAL_STORAGE_GIB = 50;
const DEFAULT_PLANNING_TASK_CPU = 2048;
const DEFAULT_PLANNING_TASK_MEMORY_MIB = 8192;

/**
 * Per-task Fargate sizing overrides. Every field is optional; anything left
 * unset uses the default above. A consumer with a lighter repo should shrink the
 * build task (for example 4 vCPU / 16 GB) to cut cost; a heavy monorepo can keep
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
  'TASK_TABLE_NAME',
  'TASK_EVENTS_TABLE_NAME',
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
   * workflow that clones + reads + emits an artifact but never builds. Same
   * image/role/env/grants as the build def (shared task+execution role + a shared
   * container spec, so a grant present on one def but missing on the other can't
   * silently diverge); the ONLY difference is cpu/mem. The orchestrator selects
   * this for read-only workflows on an ECS repo, so planning doesn't
   * over-allocate the large build task.
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
    const baseEnvironment: Record<string, string> = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
      LOG_GROUP_NAME: logGroup.logGroupName,
      GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
      ...(props.memoryId && { MEMORY_ID: props.memoryId }),
      // The payload bucket name so the orchestrator-issued AGENT_PAYLOAD_S3_URI
      // can be fetched. (The orchestrator sets the URI per-task via container
      // override; this is set here for parity with the runtime env.)
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
      // Pin the jest test fleet to an ABSOLUTE worker count on ECS. jest's
      // `maxWorkers: 25%` is CORE-relative → 4 workers on this 16-vCPU box.
      // Measured, the test suite at 4 workers peaks at only ~2.2 GB (whole process
      // tree) — not tens of GB. Container OOMs were not driven by this test
      // suite's worker count; they were driven by TOTAL concurrency — a
      // full-parallel `mise run build` running every package's test/build legs
      // plus the resident coding agent all at once. So the real memory driver is
      // cross-package build parallelism, not jest's internal workers. 4 is
      // comfortably safe on the 120 GB box even alongside the other packages +
      // agent. Kept as an explicit env (not core-relative) so a future bigger box
      // can't silently over-spawn. The test script reads JEST_MAX_WORKERS (default
      // 25%), so this only pins the shared ECS box — CI (2–4 cores) and dev
      // machines keep 25%, unaffected.
      JEST_MAX_WORKERS: '4',
      // Serialize the mise task graph so the build steps' peak memory doesn't sum
      // and OOM the task. `mise run build` fans out its `depends` (the per-package
      // build/quality legs) up to MISE_JOBS in parallel (default 4); each package
      // then spawns its OWN worker fleet (jest, pytest, esbuild, cdk synth). The
      // measured memory driver of the OOMs was this CROSS-PACKAGE storm summing on
      // top of the resident coding agent — not any single package. At 120 GB
      // (Fargate's max at 16 vCPU) there is no more RAM to add, so the remedy is to
      // cut peak parallelism. MISE_JOBS=1 runs the packages SEQUENTIALLY → peak ≈
      // max(single package) instead of sum(all packages), while still building
      // every package and keeping BOTH gates (baseline + post-agent).
      // Within-package parallelism (JEST_MAX_WORKERS=4, pytest) is untouched, so a
      // single package still uses the box's cores. Cost is wall-clock (~serial
      // sum, still minutes) — trivial against BUILD_VERIFY_TIMEOUT_S=3600. Without
      // this, the post-agent build OOM'd (exit 137) stacking on the still-resident
      // agent; a gate that OOMs verified NOTHING — serializing lets it actually
      // COMPLETE and gate. Only affects `mise run <task>` (the build legs); the
      // agent's direct `uv run pytest` calls are unaffected.
      MISE_JOBS: '1',
      // Skip the target repo's pre-push TEST hook inside the agent container.
      // `mise run install` installs prek git hooks, incl. a pre-push hook that
      // re-runs the FULL cdk+cli+agent test suite on every `git push`. In this
      // container that suite already ran TWICE (baseline + post-agent build gate)
      // and GitHub CI runs it again — so the pre-push run is pure redundancy, AND
      // it runs UNcapped (no JEST_MAX_WORKERS), stacking on the resident agent →
      // OOM. The agent's only escape was `git push --no-verify`, which silently
      // bypassed ALL hooks (incl. the security scan) and trained a
      // skip-verification habit. SKIP is the pre-commit/prek standard env var
      // (comma-separated hook ids); scoping it to the tests hook lets the push
      // succeed WITHOUT --no-verify while KEEPING the pre-push security scan.
      // Propagates to both the platform push (post_hooks.py) and the agent's own
      // git-tool pushes via shell.py::_clean_env (blacklist — passes SKIP through).
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
      props.taskTable.grantReadWriteData(taskRole);
      props.taskEventsTable.grantReadWriteData(taskRole);
    }
    // UserConcurrencyTable is user-scoped (not task_id leading-key-able) and is
    // touched by the reconciler/orchestrator path; keep it on the task role.
    props.userConcurrencyTable.grantReadWriteData(taskRole);

    // Secrets Manager read for GitHub token (read once at startup, before the
    // agent assumes the SessionRole — stays on the task role).
    props.githubTokenSecret.grantRead(taskRole);

    // Read-only on the ECS payload bucket so the container can fetch its payload
    // (AGENT_PAYLOAD_S3_URI) at boot. READ only — the container runs untrusted
    // repo code, so it must not be able to write or delete payloads (the trusted
    // orchestrator owns write + delete). Stays on the task role (read once at
    // startup, before the agent assumes any SessionRole).
    if (props.payloadBucket) {
      props.payloadBucket.grantRead(taskRole);
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
        reason: 'DynamoDB index/* wildcards from CDK grantReadWriteData (UserConcurrencyTable, and task tables only when no SessionRole is wired); Secrets Manager wildcards from CDK grantRead (GitHub token) and the bgagent-linear-oauth-*/bgagent-jira-oauth-* prefix grant (ABCA-488 — per-workspace channel OAuth tokens are created by the CLI at setup, name unknown at synth, GetSecretValue only); CloudWatch Logs wildcards from CDK grantWrite; S3 object/* wildcard from CDK grantRead on the ECS payload bucket (read-only, scoped to that bucket — #502). Bedrock InvokeModel is scoped to explicit model/inference-profile ARNs (no wildcard resource). ec2:DescribeAvailabilityZones requires Resource:* (EC2 describe actions have no resource-level scoping) — read-only, no mutation/data access; needed so a CDK target repo\'s `cdk synth` build gate can resolve AZ context on a fresh clone (ECS-parity, no cdk.context.json cache in the container).',
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
