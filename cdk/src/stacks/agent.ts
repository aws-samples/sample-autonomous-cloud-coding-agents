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
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as bedrock from '@aws-cdk/aws-bedrock-alpha';
import * as agentcoremixins from '@aws-cdk/mixins-preview/aws-bedrockagentcore';
import { ArnFormat, AspectPriority, Aspects, Stack, StackProps, RemovalPolicy, CfnOutput, CfnResource, Duration, Fn, Lazy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
// ecr_assets import is only needed when the ECS block below is uncommented
// import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';
import { AgentMemory } from '../constructs/agent-memory';
import { AgentVpc } from '../constructs/agent-vpc';
import { ApprovalMetricsPublisherConsumer } from '../constructs/approval-metrics-publisher-consumer';
import { AttachmentsBucket } from '../constructs/attachments-bucket';
import { Blueprint } from '../constructs/blueprint';
import { CedarWasmLayer } from '../constructs/cedar-wasm-layer';
import { ConcurrencyReconciler } from '../constructs/concurrency-reconciler';
import { DnsFirewall } from '../constructs/dns-firewall';
// import { EcsAgentCluster } from '../constructs/ecs-agent-cluster';
import { FanOutConsumer } from '../constructs/fanout-consumer';
import { LinearIntegration } from '../constructs/linear-integration';
import { PendingUploadCleanup } from '../constructs/pending-upload-cleanup';
import { RepoTable } from '../constructs/repo-table';
import { SlackIntegration } from '../constructs/slack-integration';
import { StrandedTaskReconciler } from '../constructs/stranded-task-reconciler';
import { TaskApi } from '../constructs/task-api';
import { TaskApprovalsTable } from '../constructs/task-approvals-table';
import { TaskDashboard } from '../constructs/task-dashboard';
import { TaskEventsTable } from '../constructs/task-events-table';
import { TaskNudgesTable } from '../constructs/task-nudges-table';
import { TaskOrchestrator } from '../constructs/task-orchestrator';
import { TaskTable } from '../constructs/task-table';
import { TraceArtifactsBucket } from '../constructs/trace-artifacts-bucket';
import { UserConcurrencyTable } from '../constructs/user-concurrency-table';
import { WebhookTable } from '../constructs/webhook-table';

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Build context is repo root (not agent/) so the Dockerfile can COPY
    // sibling trees the agent reads at runtime — currently
    // ``contracts/constants.json`` (S9 cross-language constants — see
    // ``contracts/README.md``). Future shared assets (parity fixtures,
    // schema files) drop into ``contracts/`` without further build-context
    // changes. Pattern lifted from ``merge/akw-integration``.
    const repoRoot = path.join(__dirname, '..', '..', '..');

    const artifact = agentcore.AgentRuntimeArtifact.fromAsset(repoRoot, {
      file: 'agent/Dockerfile',
    });

    // Task state persistence
    const taskTable = new TaskTable(this, 'TaskTable');
    const taskEventsTable = new TaskEventsTable(this, 'TaskEventsTable');
    const taskNudgesTable = new TaskNudgesTable(this, 'TaskNudgesTable');
    // Cedar HITL approval-gate state (design §10.1). Agent writes PENDING
    // rows + GSI query powers `bgagent pending`; Chunk 5 wires the
    // Approve/Deny Lambdas + fan-out consumer.
    //
    // Construct id is ``TaskApprovalsTableV2`` — the original
    // ``TaskApprovalsTable`` logical id was abandoned mid-development
    // after the first ship of the ``user_id-status-index`` GSI. Adding
    // ``matching_rule_ids`` to the projection required a destructive
    // recreate (DDB rejects in-place ``nonKeyAttributes`` edits), so
    // the construct id changed to force CloudFormation to create the
    // new table under a fresh logical resource while tearing down the
    // old one. Acceptable in dev; in a future prod migration the
    // dual-index pattern is preferred (see §10.1 of the design doc).
    const taskApprovalsTable = new TaskApprovalsTable(this, 'TaskApprovalsTableV2');
    const userConcurrencyTable = new UserConcurrencyTable(this, 'UserConcurrencyTable');
    const webhookTable = new WebhookTable(this, 'WebhookTable');
    const repoTable = new RepoTable(this, 'RepoTable');

    // Cedar-wasm Lambda layer (§15.2 task 10). Instantiated here so the
    // asset is in the synthed template; Chunk 5 handlers (Approve,
    // Deny, GetPolicies, CreateTask) attach the layer via
    // ``fn.addLayers(cedarWasmLayer.layer)``.
    const cedarWasmLayer = new CedarWasmLayer(this, 'CedarWasmLayer');

    // --trace trajectory storage (design §10.1). Opt-in per task; only
    // written when the submit payload sets ``trace: true``.
    const traceArtifactsBucket = new TraceArtifactsBucket(this, 'TraceArtifactsBucket');

    // Attachment storage — images, files, and URL-fetched content for tasks.
    const attachmentsBucket = new AttachmentsBucket(this, 'AttachmentsBucket');

    NagSuppressions.addResourceSuppressions(attachmentsBucket.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Task attachments: writes from create-task and orchestrator Lambdas only; reads by agent via IAM role. 90-day lifecycle; versioning + screening prevent TOCTOU. Access logging not justified for this use case.',
      },
    ]);

    // Server access logging intentionally disabled. Rationale:
    //  - writes: only the agent runtime IAM role (``grantPut`` below).
    //  - reads: only via short-lived presigned URL issued by
    //    ``get-trace-url`` after a Cognito auth check + ownership
    //    check against the TaskRecord.
    //  - 7-day object TTL bounds blast radius.
    //  - adding a log bucket would double S3 footprint for a debug-only
    //    feature users explicitly opt into with ``--trace``.
    // Note: default CloudTrail does NOT capture S3 object-level
    // events (PutObject / GetObject via presigned URL), so there is
    // intentionally no object-level audit trail for this bucket. That
    // is an accepted trade-off for a sample-project debug feature —
    // the cost/complexity of CloudTrail data events or a log bucket
    // is not justified for opt-in ``--trace`` usage. If a future
    // requirement needs audit, the right fix is a CloudTrail data
    // event selector on this bucket, not server access logs.
    NagSuppressions.addResourceSuppressions(traceArtifactsBucket.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Debug-only artifacts (design §10.1) with 7-day TTL; writes confined to runtime IAM role by grantPut; reads only via short-lived presigned URLs from an authn\'d handler. Object-level audit intentionally omitted — cost/complexity of CloudTrail data events or a log bucket is not justified for opt-in --trace usage.',
      },
    ]);

    // --- Repository onboarding ---
    const blueprintRepo = process.env.BLUEPRINT_REPO ?? this.node.tryGetContext('blueprintRepo') ?? 'awslabs/agent-plugins';
    const agentPluginsBlueprint = new Blueprint(this, 'AgentPluginsBlueprint', {
      repo: blueprintRepo,
      repoTable: repoTable.table,
    });

    const blueprints = [agentPluginsBlueprint];

    // The AwsCustomResource singleton Lambda used by Blueprint constructs
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
      `${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AwsCustomResource singleton Lambda uses AWS managed AWSLambdaBasicExecutionRole — required by CDK custom-resources framework',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'AwsCustomResource singleton Lambda runtime is managed by the CDK custom-resources framework',
      },
    ]);

    // Log groups (created before runtime so we can reference the name in env vars)
    const applicationLogGroup = new logs.LogGroup(this, 'RuntimeApplicationLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/${this.stackName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const usageLogGroup = new logs.LogGroup(this, 'RuntimeUsageLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/${this.stackName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GitHub token stored in Secrets Manager — agent fetches at startup via ARN
    const githubTokenSecret = new secretsmanager.Secret(this, 'GitHubTokenSecret', {
      description: 'GitHub personal access token for the background agent',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    NagSuppressions.addResourceSuppressions(githubTokenSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'GitHub PAT is managed externally — automatic rotation is not applicable',
      },
    ]);

    // Network isolation — VPC with restricted egress
    const agentVpc = new AgentVpc(this, 'AgentVpc');

    // DNS Firewall — domain-level egress filtering (observation mode for initial deployment)
    const additionalDomains = [...new Set(blueprints.flatMap(b => b.egressAllowlist))];
    new DnsFirewall(this, 'DnsFirewall', {
      vpc: agentVpc.vpc,
      additionalAllowedDomains: additionalDomains,
      observationMode: true,
    });

    // --- AgentCore Memory (cross-task learning) ---
    const agentMemory = new AgentMemory(this, 'AgentMemory');

    // --- Bedrock Guardrail for prompt injection detection ---
    // (Declared early so TaskApi — constructed before the runtimes — can reference it.)
    const inputGuardrail = new bedrock.Guardrail(this, 'InputGuardrail', {
      guardrailName: `task-input-guardrail-${this.stackName}`.slice(0, 50),
      description: 'Screens task submissions for prompt injection attacks',
      contentFilters: [
        {
          type: bedrock.ContentFilterType.PROMPT_ATTACK,
          // MEDIUM blocks on MEDIUM+HIGH confidence; LOW-confidence
          // detections are ignored. Observed during PR #52 Scenario
          // 7-extended deploy validation: at HIGH (blocks LOW too) the
          // PROMPT_ATTACK classifier is stochastic at the LOW tier and
          // flags ordinary imperative-mood task descriptions and
          // ordinary PR bodies (pr_iteration hydration). MEDIUM matches
          // the Bedrock documentation's default for non-adversarial
          // user input. The previous threshold blocked legitimate
          // natural-language submissions (e.g. "Make no changes, just
          // inspect README.md and finish.", "enumerate every plugin in
          // extreme detail") and legitimate pr_iteration hydrations
          // against PRs containing normal imperative documentation.
          inputStrength: bedrock.ContentFilterStrength.MEDIUM,
          outputStrength: bedrock.ContentFilterStrength.NONE,
        },
      ],
    });

    inputGuardrail.createVersion('Initial version');

    // --- TaskApi is constructed before the orchestrator (which it needs the
    // ARN of) and before the Runtime (which it needs the ARN of, for the
    // cancel-task Lambda's stop-session permission). We break both cycles
    // with Lazy strings that resolve to CloudFormation tokens at synth time.
    let orchestratorArnHolder: string | undefined;
    const lazyOrchestratorArn = Lazy.string({
      produce: () => {
        if (!orchestratorArnHolder) {
          throw new Error('Orchestrator ARN was accessed before the TaskOrchestrator was created');
        }
        return orchestratorArnHolder;
      },
    });

    // Runtime ARN placeholder — the runtime is created AFTER TaskApi so the
    // Lambda handlers can get their env var via a Lazy.string reference.
    let runtimeArnHolder: string | undefined;
    const lazyRuntimeArn = Lazy.string({
      produce: () => {
        if (!runtimeArnHolder) {
          throw new Error('Runtime ARN was accessed before Runtime was created');
        }
        return runtimeArnHolder;
      },
    });

    // --- Task API (REST API + Cognito + Lambda handlers) ---
    const taskApi = new TaskApi(this, 'TaskApi', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      taskNudgesTable: taskNudgesTable.table,
      taskApprovalsTable: taskApprovalsTable.table,
      cedarWasmLayer: cedarWasmLayer.layer,
      repoTable: repoTable.table,
      webhookTable: webhookTable.table,
      orchestratorFunctionArn: lazyOrchestratorArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      agentCoreStopSessionRuntimeArn: lazyRuntimeArn,
      traceArtifactsBucket: traceArtifactsBucket.bucket,
      attachmentsBucket: attachmentsBucket.bucket,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- AgentCore Runtime (IAM-authed orchestrator path) ---
    //
    // One runtime, invoked by OrchestratorFn via SigV4. See
    // `docs/design/INTERACTIVE_AGENTS.md` §3.1 and AD-1.
    const runtimeEnvironmentVariables = {
      GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_LOG: 'debug',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      TASK_TABLE_NAME: taskTable.table.tableName,
      TASK_EVENTS_TABLE_NAME: taskEventsTable.table.tableName,
      NUDGES_TABLE_NAME: taskNudgesTable.table.tableName,
      // Cedar HITL approval gates (§6.5). Agent's task_state primitives
      // use this to write PENDING rows + transition tasks to
      // AWAITING_APPROVAL; absent → hook fails closed with
      // ``approval_write_failed`` (the `ApprovalTablesUnavailable` path).
      TASK_APPROVALS_TABLE_NAME: taskApprovalsTable.table.tableName,
      // Hint for the hook's remaining-maxLifetime calculation (§6.5
      // pseudocode line 793). Kept in sync with the AgentCore
      // lifecycle configuration below so drift is visible. 8 hours.
      AGENTCORE_MAX_LIFETIME_S: '28800',
      USER_CONCURRENCY_TABLE_NAME: userConcurrencyTable.table.tableName,
      // --trace artifact store (§10.1). The agent writes the JSONL
      // trajectory to ``traces/<user_id>/<task_id>.jsonl.gz`` on
      // terminal state when the submit payload enabled ``trace``.
      TRACE_ARTIFACTS_BUCKET_NAME: traceArtifactsBucket.bucket.bucketName,
      LOG_GROUP_NAME: applicationLogGroup.logGroupName,
      MEMORY_ID: agentMemory.memory.memoryId,
      MAX_TURNS: '100',
      // Session storage: the S3-backed FUSE mount at /mnt/workspace does NOT
      // support flock(). Only caches whose tools never call flock() go there.
      // Everything else stays on local ephemeral disk.
      //
      // Local disk (tools use flock):
      //   AGENT_WORKSPACE — omitted, defaults to /workspace
      //   MISE_DATA_DIR — mise's pipx backend sets UV_TOOL_DIR inside installs/,
      //     and uv flocks that directory → must be local.
      MISE_DATA_DIR: '/tmp/mise-data',
      UV_CACHE_DIR: '/tmp/uv-cache',
      // Persistent mount (no flock):
      CLAUDE_CONFIG_DIR: '/mnt/workspace/.claude-config',
      npm_config_cache: '/mnt/workspace/.npm-cache',
      // ENABLE_CLI_TELEMETRY: '1',
    };

    const runtimeNetworkConfig = agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
      vpc: agentVpc.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [agentVpc.runtimeSecurityGroup],
    });

    // LifecycleConfiguration — both timers set to the AgentCore 8h maximum so
    // long-running tasks (approval waits, heavy builds) are not evicted.
    const lifecycleConfiguration: agentcore.LifecycleConfiguration = {
      idleRuntimeSessionTimeout: Duration.hours(8),
      maxLifetime: Duration.hours(8),
    };

    // Construct id 'Runtime' is load-bearing — renaming it forces CFN to
    // CREATE the new resource before DELETING the old one, violating
    // AgentCore's account-level runtimeName uniqueness and triggering an
    // UPDATE_ROLLBACK.
    const runtime = new agentcore.Runtime(this, 'Runtime', {
      agentRuntimeArtifact: artifact,
      networkConfiguration: runtimeNetworkConfig,
      environmentVariables: runtimeEnvironmentVariables,
      lifecycleConfiguration: lifecycleConfiguration,
    });

    runtimeArnHolder = runtime.agentRuntimeArn;

    // --- Session storage (preview) ---
    // The L2 construct does not yet expose filesystemConfigurations; use the
    // CFN escape hatch. /mnt/workspace mount backs the persistent cache
    // shared across tasks in the same repo.
    const cfnRuntime = runtime.node.defaultChild as CfnResource;
    cfnRuntime.addPropertyOverride('FilesystemConfigurations', [
      {
        SessionStorage: {
          MountPath: '/mnt/workspace',
        },
      },
    ]);

    // --- IAM grants ---
    taskTable.table.grantReadWriteData(runtime);
    taskEventsTable.table.grantReadWriteData(runtime);
    taskNudgesTable.table.grantReadWriteData(runtime);
    // Cedar HITL: the agent writes PENDING rows via TransactWriteItems
    // (cross-table with TaskTable), reads them with ConsistentRead during
    // the poll loop, and flips status to TIMED_OUT on deadline. The
    // grant must be RW because approve/deny Lambdas (Chunk 5) also
    // need RW; granting twice is idempotent.
    taskApprovalsTable.table.grantReadWriteData(runtime);
    userConcurrencyTable.table.grantReadWriteData(runtime);
    githubTokenSecret.grantRead(runtime);
    applicationLogGroup.grantWrite(runtime);
    agentMemory.grantReadWrite(runtime);
    // Runtime only ever writes trace artifacts (read happens via presigned
    // URL from the ``get-trace-url`` handler, not the runtime).
    //
    // TODO(K2 Stage 2+): tighten to a per-prefix condition so the runtime
    // cannot write outside its own task's ``traces/<user_id>/`` prefix.
    // The current grant expands to ``Resource: <bucket>/*`` with no
    // ``s3:prefix`` / ``aws:PrincipalTag`` condition — per-user isolation
    // is enforced in *agent code* (object-key construction), which is a
    // trust boundary, not an enforcement boundary. Options: propagate
    // ``user_id`` as an IAM session tag on the runtime invocation and
    // condition the policy on ``aws:PrincipalTag/UserId``; or run the
    // upload from a short-lived Lambda with a scoped policy instead of
    // the runtime itself. Deferred because the session-tag plumbing is
    // orthogonal to landing the feature behavior.
    traceArtifactsBucket.bucket.grantPut(runtime);
    // Version-pinned attachment downloads (agent/src/attachments.py uses
    // GetObject + VersionId). grantRead expands to s3:GetObject* including
    // GetObjectVersion on the versioned attachments bucket.
    attachmentsBucket.bucket.grantRead(runtime);

    const model = new bedrock.BedrockFoundationModel('anthropic.claude-sonnet-4-6', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    // Create a cross-region inference profile for Claude Sonnet 4.6
    const inferenceProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model,
    });

    const model3 = new bedrock.BedrockFoundationModel('anthropic.claude-opus-4-20250514-v1:0', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    const inferenceProfile3 = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model3,
    });

    const model2 = new bedrock.BedrockFoundationModel('anthropic.claude-haiku-4-5-20251001-v1:0', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    // Create a cross-region inference profile for Claude Haiku 4.5
    const inferenceProfile2 = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model2,
    });

    model.grantInvoke(runtime);
    inferenceProfile.grantInvoke(runtime);
    model3.grantInvoke(runtime);
    inferenceProfile3.grantInvoke(runtime);
    model2.grantInvoke(runtime);
    inferenceProfile2.grantInvoke(runtime);

    runtime.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.APPLICATION_LOGS.toLogGroup(applicationLogGroup));
    // X-Ray tracing disabled — requires account-level UpdateTraceSegmentDestination
    // which needs CloudWatch Logs resource policy propagation. Re-enable once resolved.
    // runtime.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.TRACES.toXRay());
    runtime.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.USAGE_LOGS.toLogGroup(usageLogGroup));

    NagSuppressions.addResourceSuppressions(runtime, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'AgentCore runtime requires wildcard permissions for CloudWatch Logs, Bedrock model invocation, and cross-region inference profiles — generated by CDK L2 construct grants',
      },
    ], true);

    // Chunk 10 deploy-prep: the Cedar HITL additions (TaskApprovalsTable
    // grant + extra env vars) pushed the runtime
    // execution role past CDK's per-inline-policy size limit, causing CDK
    // to auto-split excess statements into ``OverflowPolicy1`` / etc.
    // Those overflow policies inherit the same wildcard
    // ``bedrock:InvokeModel*`` / CloudWatch / cross-region-inference
    // actions as the base policy but live at paths that any suppression
    // placed at constructor time does NOT reach (CDK creates the
    // overflow policies lazily during synth ``prepare()``, after the
    // construct tree has been frozen). Use an Aspect that visits every
    // node during synth and matches overflow-policy children of the
    // runtime ExecutionRole so any present or future overflow is
    // suppressed automatically without hardcoding
    // ``OverflowPolicy<N>`` indices.
    const overflowSuppressionAspect = {
      visit(node: IConstruct) {
        const nodePath = node.node.path;
        if (
          nodePath.includes('/Runtime/ExecutionRole/OverflowPolicy')
          && nodePath.endsWith('/Resource')
        ) {
          NagSuppressions.addResourceSuppressions(node, [
            {
              id: 'AwsSolutions-IAM5',
              reason:
                'CDK-generated overflow policy on the runtime ExecutionRole inherits the same wildcard Bedrock / CloudWatch actions suppressed on the base policy. Auto-split triggers when the role exceeds the inline-policy size limit; suppression applies to all overflow policies via an Aspect so future splits are covered.',
            },
          ]);
        }
      },
    };
    // MUTATING priority: runs before cdk-nag's READONLY aspect so the
    // suppression is in place when the nag checks visit the overflow
    // policy. Default priority would race with cdk-nag (registered in
    // ``main.ts``) and the suppression would arrive too late.
    Aspects.of(this).add(overflowSuppressionAspect, { priority: AspectPriority.MUTATING });

    new CfnOutput(this, 'RuntimeArn', {
      value: runtime.agentRuntimeArn,
      description: 'ARN of the AgentCore runtime',
    });

    new CfnOutput(this, 'TaskTableName', {
      value: taskTable.table.tableName,
      description: 'Name of the DynamoDB task state table',
    });

    new CfnOutput(this, 'TaskEventsTableName', {
      value: taskEventsTable.table.tableName,
      description: 'Name of the DynamoDB task events audit table',
    });

    new CfnOutput(this, 'TaskNudgesTableName', {
      value: taskNudgesTable.table.tableName,
      description: 'Name of the DynamoDB task nudges table (Phase 2)',
    });

    new CfnOutput(this, 'TaskApprovalsTableName', {
      value: taskApprovalsTable.table.tableName,
      description: 'Name of the DynamoDB task approvals table (Cedar HITL)',
    });

    new CfnOutput(this, 'CedarWasmLayerArn', {
      value: cedarWasmLayer.layer.layerVersionArn,
      description: 'ARN of the Cedar-wasm Lambda layer (consumed by Chunk 5 REST handlers)',
    });

    new CfnOutput(this, 'UserConcurrencyTableName', {
      value: userConcurrencyTable.table.tableName,
      description: 'Name of the DynamoDB user concurrency table',
    });

    new CfnOutput(this, 'WebhookTableName', {
      value: webhookTable.table.tableName,
      description: 'Name of the DynamoDB webhook table',
    });

    new CfnOutput(this, 'RepoTableName', {
      value: repoTable.table.tableName,
      description: 'Name of the DynamoDB repo config table',
    });

    new CfnOutput(this, 'GitHubTokenSecretArn', {
      value: githubTokenSecret.secretArn,
      description: 'ARN of the Secrets Manager secret for the GitHub token',
    });

    new CfnOutput(this, 'TraceArtifactsBucketName', {
      value: traceArtifactsBucket.bucket.bucketName,
      description: 'Name of the S3 bucket storing --trace trajectory artifacts (design §10.1)',
    });

    // --- ECS Fargate compute backend (optional) ---
    // To enable ECS as an alternative compute backend, uncomment the block below
    // and the EcsAgentCluster import at the top of this file. Repos can then use
    // compute_type: 'ecs' in their blueprint config to route tasks to ECS Fargate.
    //
    // const agentImageAsset = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
    //   directory: repoRoot,
    //   file: 'agent/Dockerfile',
    //   platform: ecr_assets.Platform.LINUX_ARM64,
    // });
    //
    // const ecsCluster = new EcsAgentCluster(this, 'EcsAgentCluster', {
    //   vpc: agentVpc.vpc,
    //   agentImageAsset,
    //   taskTable: taskTable.table,
    //   taskEventsTable: taskEventsTable.table,
    //   userConcurrencyTable: userConcurrencyTable.table,
    //   githubTokenSecret,
    //   memoryId: agentMemory.memory.memoryId,
    // });

    // --- Task Orchestrator (durable Lambda function) ---
    const orchestrator = new TaskOrchestrator(this, 'TaskOrchestrator', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      repoTable: repoTable.table,
      runtimeArn: runtime.agentRuntimeArn,
      githubTokenSecretArn: githubTokenSecret.secretArn,
      memoryId: agentMemory.memory.memoryId,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      attachmentsBucket: attachmentsBucket.bucket,
      // To wire ECS, uncomment the ecsCluster block above and add:
      // ecsConfig: {
      //   clusterArn: ecsCluster.cluster.clusterArn,
      //   taskDefinitionArn: ecsCluster.taskDefinition.taskDefinitionArn,
      //   subnets: agentVpc.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
      //   securityGroup: ecsCluster.securityGroup.securityGroupId,
      //   containerName: ecsCluster.containerName,
      //   taskRoleArn: ecsCluster.taskRoleArn,
      //   executionRoleArn: ecsCluster.executionRoleArn,
      // },
    });

    // Now that the orchestrator exists, resolve the Lazy used by TaskApi at synth.
    orchestratorArnHolder = orchestrator.alias.functionArn;

    // Grant the orchestrator Lambda read+write access to memory
    // (reads during context hydration, writes for fallback episodes)
    agentMemory.grantReadWrite(orchestrator.fn);

    // --- Concurrency counter reconciler (drift correction) ---
    new ConcurrencyReconciler(this, 'ConcurrencyReconciler', {
      taskTable: taskTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- Stranded-task reconciler ---
    // Catches SUBMITTED / HYDRATING tasks whose pipeline never started
    // (orchestrator Lambda crash between TaskTable write and InvokeAgentRuntime,
    // container crash during startup, etc.). Transitions to FAILED with a
    // `task_stranded` event.
    new StrandedTaskReconciler(this, 'StrandedTaskReconciler', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- Pending-upload cleanup rule ---
    // Auto-cancels PENDING_UPLOADS tasks that were never confirmed within
    // 30 minutes (client crash, abandoned session, network failure).
    // Cleans up orphaned S3 objects under the task's attachment prefix.
    new PendingUploadCleanup(this, 'PendingUploadCleanup', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      attachmentsBucket: attachmentsBucket.bucket,
    });

    // --- Fan-out plane consumer ---
    // Consumes TaskEventsTable DynamoDB Streams and dispatches events to
    // Slack / GitHub / email per per-channel default filters. GitHub
    // dispatcher edits a single issue comment in place; Slack
    // dispatcher (issue #64) reads per-workspace bot tokens from
    // ``bgagent/slack/*``. Email remains a log-only stub until Phase 2.
    new FanOutConsumer(this, 'FanOutConsumer', {
      taskEventsTable: taskEventsTable.table,
      taskTable: taskTable.table,
      repoTable: repoTable.table,
      githubTokenSecret,
      // Slack bot-token grant is guarded on this prop — pass the
      // ``bgagent/slack/*`` prefix so the FanOutConsumer can read
      // workspace tokens. Same scope SlackIntegration uses for its
      // own writers (PR #79 review #2).
      slackSecretArnPattern: Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: 'bgagent/slack/*',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    });

    // --- Cedar HITL approval metrics publisher (Chunk 8, §11.3 / IMPL-28) ---
    // Consumer #2 of the TaskEventsTable stream (FanOutConsumer is #1).
    // Reads agent_milestone records for approval events and emits
    // CloudWatch EMF for the dashboard widgets below. See the
    // 2-consumer architectural note in `task-events-table.ts` —
    // adding a third consumer here requires the Kinesis Data Streams
    // for DynamoDB migration.
    new ApprovalMetricsPublisherConsumer(this, 'ApprovalMetricsPublisherConsumer', {
      taskEventsTable: taskEventsTable.table,
    });

    // --- Operator dashboard ---
    new TaskDashboard(this, 'TaskDashboard', {
      applicationLogGroup,
      runtimeArn: runtime.agentRuntimeArn,
    });

    // --- Slack integration (always deployed — secrets populated post-deploy) ---
    const slackIntegration = new SlackIntegration(this, 'SlackIntegration', {
      api: taskApi.api,
      userPool: taskApi.userPool,
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      repoTable: repoTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
    });

    // --- Slack App setup outputs ---
    // Pre-filled manifest URL: opens Slack's "Create New App" page with all
    // URLs, scopes, and events pre-configured. User just clicks Create.
    const apiHost = Fn.select(2, Fn.split('/', taskApi.api.url));
    const apiStage = Fn.select(3, Fn.split('/', taskApi.api.url));
    const apiBase = Fn.join('', ['https://', apiHost, '/', apiStage]);

    // Build the YAML manifest as a string using Fn.join (API URL tokens resolve at deploy time).
    // Slack's ?new_app=1&manifest_json= endpoint accepts URL-encoded JSON.
    const manifestJson = Fn.join('', [
      '{"_metadata":{"major_version":1,"minor_version":1},',
      '"display_information":{"name":"Shoof","description":"Submit coding tasks to autonomous background agents","background_color":"#1a1a2e"},',
      '"features":{"app_home":{"messages_tab_enabled":true,"messages_tab_read_only_enabled":false},"bot_user":{"display_name":"Shoof","always_online":true},',
      '"slash_commands":[{"command":"/bgagent","url":"', apiBase, '/slack/commands","description":"Link your account or get help with Shoof","usage_hint":"link | help","should_escape":false}]},',
      '"oauth_config":{"scopes":{"bot":["app_mentions:read","commands","chat:write","chat:write.public","channels:read","groups:read","im:history","im:write","users:read","reactions:write"]},',
      '"redirect_urls":["', apiBase, '/slack/oauth/callback"]},',
      '"settings":{"event_subscriptions":{"request_url":"', apiBase, '/slack/events","bot_events":["app_mention","message.im","app_uninstalled","tokens_revoked"]},',
      '"interactivity":{"is_enabled":true,"request_url":"', apiBase, '/slack/interactions"},',
      '"org_deploy_enabled":false,"socket_mode_enabled":false,"token_rotation_enabled":false}}',
    ]);

    new CfnOutput(this, 'SlackAppManifestJson', {
      value: manifestJson,
      description: 'Slack App manifest JSON — the CLI URL-encodes this into the create URL',
    });

    new CfnOutput(this, 'SlackSigningSecretArn', {
      value: slackIntegration.signingSecret.secretArn,
      description: 'Secrets Manager ARN for the Slack signing secret — populate after creating the Slack App',
    });

    new CfnOutput(this, 'SlackClientSecretArn', {
      value: slackIntegration.clientSecret.secretArn,
      description: 'Secrets Manager ARN for the Slack client secret — populate after creating the Slack App',
    });

    new CfnOutput(this, 'SlackClientIdSecretArn', {
      value: slackIntegration.clientIdSecret.secretArn,
      description: 'Secrets Manager ARN for the Slack client ID — populate after creating the Slack App',
    });

    new CfnOutput(this, 'SlackInstallationTableName', {
      value: slackIntegration.installationTable.tableName,
      description: 'Name of the DynamoDB Slack installation table',
    });

    new CfnOutput(this, 'SlackUserMappingTableName', {
      value: slackIntegration.userMappingTable.tableName,
      description: 'Name of the DynamoDB Slack user mapping table',
    });

    // --- Linear integration (inbound webhook + agent-side MCP outbound) ---
    const linearIntegration = new LinearIntegration(this, 'LinearIntegration', {
      api: taskApi.api,
      userPool: taskApi.userPool,
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      repoTable: repoTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
    });

    // Phase 2.0b-O2: agent runtime reads the per-workspace Linear OAuth
    // token directly from Secrets Manager. The CLI (`bgagent linear setup`)
    // creates `bgagent-linear-oauth-<slug>` secrets at install time;
    // the secret JSON contains access_token, refresh_token, expires_at,
    // and the OAuth client_id/client_secret. The orchestrator passes
    // `linear_oauth_secret_arn` to the agent via task.channel_metadata,
    // so the agent looks up the exact ARN — no discovery needed.
    //
    // Agent has GetSecretValue ONLY — no Put. Review item S1: agent
    // runtime executes untrusted repo code, so write access to all
    // workspace tokens is too broad a blast radius (a compromised
    // agent could overwrite any workspace's token). Lambdas (trusted
    // code in this stack) handle the in-place refresh path; the agent
    // proceeds with whatever token Lambdas have most-recently written.
    // For a 24h Linear access-token TTL, the practical impact is that
    // a stale token in the cache forces the agent's next call to fail
    // closed — preferable to a trust gap.
    runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-linear-oauth-*',
        }),
      ],
    }));

    // Phase 2.0b-O2: pipe the workspace registry table + per-workspace
    // OAuth-secret-prefix grant into the orchestrator so the concurrency-cap
    // rejection path can post a Linear comment + ❌. The orchestrator only
    // resolves a token when `task.channel_source === 'linear'`, but the
    // IAM grant is unconditional (per-workspace secrets are created lazily
    // by `bgagent linear setup`).
    linearIntegration.workspaceRegistryTable.grantReadData(orchestrator.fn);
    orchestrator.fn.addEnvironment(
      'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
      linearIntegration.workspaceRegistryTable.tableName,
    );
    orchestrator.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-linear-oauth-*',
        }),
      ],
    }));

    new CfnOutput(this, 'LinearWebhookSecretArn', {
      value: linearIntegration.webhookSecret.secretArn,
      description: 'Secrets Manager ARN for the Linear webhook signing secret — populate via `bgagent linear setup`',
    });

    new CfnOutput(this, 'LinearProjectMappingTableName', {
      value: linearIntegration.projectMappingTable.tableName,
      description: 'Name of the DynamoDB Linear project → repo mapping table',
    });

    new CfnOutput(this, 'LinearUserMappingTableName', {
      value: linearIntegration.userMappingTable.tableName,
      description: 'Name of the DynamoDB Linear user mapping table',
    });

    new CfnOutput(this, 'LinearWorkspaceRegistryTableName', {
      value: linearIntegration.workspaceRegistryTable.tableName,
      description: 'Name of the DynamoDB Linear workspace registry — `bgagent linear setup` writes a row per OAuth-installed workspace',
    });

    // --- Bedrock model invocation logging (account-level) ---
    const invocationLogGroup = new logs.LogGroup(this, 'ModelInvocationLogGroup', {
      logGroupName: `/aws/bedrock/model-invocation-logs/${this.stackName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    invocationLogGroup.grantWrite(bedrockLoggingRole);

    // Bedrock model invocation logging is a non-critical observability feature.
    // ignoreErrorCodesMatching prevents a Bedrock API error from rolling back
    // the entire stack deployment.
    const invocationLogging = new cr.AwsCustomResource(this, 'ModelInvocationLogging', {
      onCreate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
              // Required by API schema but unused — text logs go to CloudWatch only.
              largeDataDeliveryS3Config: { bucketName: '', keyPrefix: '' },
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
        ignoreErrorCodesMatching: '.*',
      },
      // onUpdate re-applies the same config to handle drift (e.g., if another
      // stack or manual action changed the account-level logging config).
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
              largeDataDeliveryS3Config: { bucketName: '', keyPrefix: '' },
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
        ignoreErrorCodesMatching: '.*',
      },
      // onDelete intentionally omitted — model invocation logging is account-level;
      // deleting one stack should not disable logging that another stack relies on.
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
      ]),
    });

    NagSuppressions.addResourceSuppressions(invocationLogging, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Bedrock model invocation logging configuration APIs are account-level and do not support resource-level permissions',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(bedrockLoggingRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudWatch Logs grantWrite generates wildcards for log stream creation — required by Bedrock logging service',
      },
    ], true);

    new CfnOutput(this, 'ApiUrl', {
      value: taskApi.api.url,
      description: 'URL of the Task API',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: taskApi.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new CfnOutput(this, 'AppClientId', {
      value: taskApi.appClientId,
      description: 'Cognito App Client ID',
    });
  }
}
