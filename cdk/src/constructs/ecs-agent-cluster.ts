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
   * Optional Fargate task sizing overrides. Any unset field uses the generous
   * default; a consumer with a lighter repo should shrink the build task to cut
   * cost. See {@link EcsTaskSizing}.
   */
  readonly taskSizing?: EcsTaskSizing;

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

/**
 * Default Fargate task sizes (vCPU units / MiB / GiB). These defaults are
 * deliberately generous because they're tuned for a worst case: a large
 * TypeScript + Python monorepo whose full build runs many jobs in parallel and
 * peaks near the Fargate memory ceiling. Most repos are lighter and will want
 * less — Fargate bills per requested vCPU-second and RAM-second — so both task
 * sizes are overridable via {@link EcsAgentClusterProps.taskSizing} rather than
 * fixed to one workload.
 *
 *  - BUILD task: 16 vCPU / 120 GB / 100 GiB disk. Sized for a full,
 *    CI-parity build. 120 GB is the maximum Fargate allows at 16 vCPU; a build
 *    task runs in its own isolated microVM, so a single memory-heavy build can
 *    only be helped by more per-task RAM or by running fewer build steps in
 *    parallel — not by capping how many tasks run at once. The 100 GiB root
 *    filesystem (Fargate defaults to 20 GiB) leaves headroom for the clone plus
 *    dependency/build caches; without it, concurrent builds can run the disk out
 *    of space and surface as a spurious build failure.
 *  - PLANNING task: 2 vCPU / 8 GB / default disk. For read-only workflows that
 *    clone and read the repo to produce a plan but never build.
 */
const DEFAULT_BUILD_TASK_CPU = 16384;
const DEFAULT_BUILD_TASK_MEMORY_MIB = 122880;
const DEFAULT_BUILD_TASK_EPHEMERAL_STORAGE_GIB = 100;
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
  /** Build task vCPU units (1024 = 1 vCPU). Defaults to 16384 (16 vCPU). */
  readonly buildTaskCpu?: number;
  /** Build task memory in MiB. Defaults to 122880 (120 GB). */
  readonly buildTaskMemoryMiB?: number;
  /** Build task root-filesystem storage in GiB (21–200). Defaults to 100. */
  readonly buildTaskEphemeralStorageGiB?: number;
  /** Planning (read-only) task vCPU units. Defaults to 2048 (2 vCPU). */
  readonly planningTaskCpu?: number;
  /** Planning task memory in MiB. Defaults to 8192 (8 GB). */
  readonly planningTaskMemoryMiB?: number;
}

export class EcsAgentCluster extends Construct {
  public readonly cluster: ecs.Cluster;
  /** The 64 GB / 16 vCPU BUILD task def — for coding workflows that run a full
   *  CI-parity build. Selected by the orchestrator for non-read-only workflows. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  /**
   * The smaller read-only PLANNING task def (8 GB / 2 vCPU) — for
   * ``coding/decompose-v1`` (and any read_only workflow) that clones + reads +
   * emits an artifact but never builds. Same image/role/env/grants as the build
   * def (shared task+execution role + a shared container spec, so grants can't
   * drift — the ABCA-488/#502 parity lesson); the ONLY difference is cpu/mem.
   * The orchestrator selects this for read-only workflows on an ECS repo, so
   * planning doesn't over-allocate the 64 GB build box. (#299 / ECS_RIGHTSIZED_PLANNING.)
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

    // SHARED task + execution roles for BOTH task defs (#299 ECS_RIGHTSIZED_PLANNING).
    // The build def and the planning def MUST have identical IAM + env or an
    // ECS-parity bug hides on one substrate (the ABCA-488/#502 class: a token or
    // grant present on one def and missing on the other). Rather than grant twice,
    // we create the roles ONCE here and pass the SAME roles to both task defs, and
    // build the container from a single shared spec. So there is exactly one place
    // grants/env can be edited, and both defs stay in lockstep by construction.
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

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
        // Raise root-fs storage past Fargate's 20 GiB default for build tasks
        // (ENOSPC mid-build on ABCA-659); omitted → the 20 GiB default.
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
      // Pin the ABCA cdk-test jest fleet to an ABSOLUTE worker count on ECS.
      // jest `maxWorkers: 25%` is CORE-relative → 4 workers on this 16-vCPU box.
      // MEASURED: cdk:test at 4 workers peaks at only ~2.2 GB (whole process tree,
      // sampled locally on a 16 GB Mac with no swap) — NOT the tens-of-GB once
      // assumed. The ABCA-685 OOM was NOT cdk:test's worker count; it was TOTAL
      // concurrency — full-parallel mise ran cdk:test + agent:test + cli + docs +
      // cdk:synth + the resident coding agent all at once. So the real memory
      // driver is cross-package build parallelism, not jest's internal workers.
      // 4 is therefore comfortably safe on the 120 GB box even alongside the other
      // packages + agent. Kept as an explicit env (not core-relative) so a future
      // bigger box can't silently over-spawn. The ABCA test script reads
      // JEST_MAX_WORKERS (default 25%), so this only pins the shared ECS box — CI
      // (2–4 cores) and dev machines keep 25%, unaffected.
      JEST_MAX_WORKERS: '4',
      // Serialize the mise task DAG (K14 OOM prevention). `mise run build` fans
      // out its `depends` (agent:quality ‖ cdk:build ‖ cli:build ‖ docs:build) up
      // to MISE_JOBS in parallel (default 4); each package then spawns its OWN
      // worker fleet (jest, pytest, esbuild, cdk synth). The MEASURED memory
      // driver of the 32/64/120 GB OOMs was this CROSS-PACKAGE storm summing on
      // top of the resident coding agent — not any single package. At 120 GB
      // (Fargate's max at 16 vCPU) there is no more RAM to add, so the documented
      // remedy is to cut peak parallelism. MISE_JOBS=1 runs the four packages
      // SEQUENTIALLY → peak ≈ max(single package) instead of sum(all four),
      // while still building every package and keeping BOTH gates (baseline +
      // post-agent). Within-package parallelism (JEST_MAX_WORKERS=4, pytest) is
      // untouched, so a single package still uses the box's cores. Cost is
      // wall-clock (~serial sum, still minutes) — trivial against
      // BUILD_VERIFY_TIMEOUT_S=3600. Live-caught on ABCA-691: the POST-agent
      // build OOM'd (exit 137) stacking on the still-resident agent; the platform
      // now classifies that 137 as infra (non-gating) rather than a false build
      // failure, but a gate that OOMs verified NOTHING — serializing lets it
      // actually COMPLETE and gate. Only affects `mise run <task>` (the build
      // legs); the agent's direct `uv run pytest` calls are unaffected.
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
    }, buildDisk);

    // PLANNING task def (#299 ECS_RIGHTSIZED_PLANNING) — for read-only workflows
    // (coding/decompose-v1) that clone + read + emit a plan artifact but NEVER
    // build. 8 GB / 2 vCPU: a clone + a bounded set of file reads into the model
    // context, no parallel build storm. Same image/roles/env as the build def (so
    // Linear OAuth, artifact delivery, payload fetch all work identically); NO
    // BUILD_VERIFY_TIMEOUT_S (a read-only planner runs no build verify). If 8 GB
    // proves tight on a very large clone, 16 GB / 4 vCPU is the next step — size up
    // on Container-Insights evidence, mirroring the build def's empirical history.
    this.planningTaskDefinition = makeTaskDef('PlanningTaskDef', planningCpu, planningMemory, {});

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

    // Expose role ARNs for scoped iam:PassRole in the orchestrator. Both task
    // defs share these roles, so one ARN pair covers both defs' PassRole grants.
    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = executionRole.roleArn;

    // cdk-nag suppressions. The task role + execution role are now SHARED standalone
    // constructs (#299 ECS_RIGHTSIZED_PLANNING) rather than roles auto-created under a
    // single task def, so the IAM suppressions must target the ROLES directly — a
    // def-level `applyToChildren` suppression no longer reaches them (they're siblings
    // of the task defs, not children). ECS2 (container env-vars-not-secrets) still
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
