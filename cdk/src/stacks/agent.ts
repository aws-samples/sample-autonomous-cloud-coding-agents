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
import * as bedrock from '@aws-cdk/aws-bedrock-alpha';
import { ArnFormat, AspectPriority, Aspects, Stack, StackProps, RemovalPolicy, CfnOutput, CfnResource, Duration, Fn, Lazy } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';
import { AdmissionQueuePickup } from '../constructs/admission-queue-pickup';
import { AgentMemory } from '../constructs/agent-memory';
import { AgentSessionRole } from '../constructs/agent-session-role';
import { AgentVpc } from '../constructs/agent-vpc';
import { ApiKeyTable } from '../constructs/api-key-table';
import { ApprovalMetricsPublisherConsumer } from '../constructs/approval-metrics-publisher-consumer';
import { AttachmentsBucket } from '../constructs/attachments-bucket';
import {
  PLATFORM_DEFAULT_AUX_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  inferenceProfileId,
  resolveBedrockGeoRegion,
  resolveBedrockModelIds,
} from '../constructs/bedrock-models';
import { Blueprint } from '../constructs/blueprint';
import { CedarWasmLayer } from '../constructs/cedar-wasm-layer';
import { ConcurrencyReconciler } from '../constructs/concurrency-reconciler';
import { DnsFirewall } from '../constructs/dns-firewall';
import { EcsAgentCluster, resolveEcsTaskSizing } from '../constructs/ecs-agent-cluster';
import { EcsPayloadBucket } from '../constructs/ecs-payload-bucket';
import { FanOutConsumer } from '../constructs/fanout-consumer';
import { GitHubScreenshotIntegration } from '../constructs/github-screenshot-integration';
import { IterationHeartbeat } from '../constructs/iteration-heartbeat';
import { JiraIntegration } from '../constructs/jira-integration';
import {
  LambdaMicrovmCompute,
  isLambdaMicrovmImageConfigured,
  type LambdaMicrovmImageInputs,
} from '../constructs/lambda-microvm-compute';
import { LinearIntegration } from '../constructs/linear-integration';
import { OperationalAlerts } from '../constructs/operational-alerts';
import { OrchestrationReconciler } from '../constructs/orchestration-reconciler';
import { OrchestrationTable } from '../constructs/orchestration-table';
import { PendingUploadCleanup } from '../constructs/pending-upload-cleanup';
import { AgentRegistryStack } from '../constructs/registry';
import { RegistryApi } from '../constructs/registry-api';
import { RepoTable } from '../constructs/repo-table';
import { SlackIntegration } from '../constructs/slack-integration';
import { buildAppId } from '../constructs/solution-ua-aspect';
import { StrandedOrchestrationReconciler } from '../constructs/stranded-orchestration-reconciler';
import { StrandedTaskReconciler } from '../constructs/stranded-task-reconciler';
import { TaskApi } from '../constructs/task-api';
import { TaskApprovalsTable } from '../constructs/task-approvals-table';
import { TaskDashboard } from '../constructs/task-dashboard';
import { TaskEventsTable } from '../constructs/task-events-table';
import { TaskNudgesTable } from '../constructs/task-nudges-table';
import { TaskOrchestrator } from '../constructs/task-orchestrator';
import { TaskTable } from '../constructs/task-table';
import { ToolGateway } from '../constructs/tool-gateway';
import { TraceArtifactsBucket } from '../constructs/trace-artifacts-bucket';
import { UserConcurrencyTable } from '../constructs/user-concurrency-table';
import { WebhookTable } from '../constructs/webhook-table';

/** Max length of the Bedrock Guardrail name (CloudFormation constraint). */
const GUARDRAIL_NAME_MAX_LENGTH = 50;

/** AgentCore Runtime session lifecycle ceiling (hours) — the AgentCore maximum. */
const RUNTIME_SESSION_TIMEOUT_HOURS = 8;

/** Index of the stage segment in a split API Gateway URL. */
const API_URL_STAGE_SEGMENT_INDEX = 3;

/** Properties for {@link AgentStack}. */
export interface AgentStackProps extends StackProps {
  /**
   * Availability-zone *names* to pin the AgentCore VPC (and therefore the
   * Runtime ENIs) into, so they land only in AgentCore-supported zones.
   *
   * Resolved in `main.ts` via `resolveAgentCoreAzs` — the validated
   * `agentcore:availabilityZones` context override, else auto-selected from the
   * account's supported zones when synth has a concrete account/region. Leave
   * `undefined` (env-agnostic synth, unlisted region) to keep CDK's default
   * `maxAzs` selection.
   *
   * Deliberately NOT named `availabilityZones`: `Stack` already exposes an
   * `availabilityZones` getter returning the *unpinned* set, and two different
   * values under one name in one class is a trap for `Stack.of(x)` callers.
   */
  readonly agentCoreAvailabilityZones?: string[];
}

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps = {}) {
    super(scope, id, props);

    const enableAgentRegistry = this.node.tryGetContext('enableAgentRegistry');
    if (
      enableAgentRegistry !== undefined
      && enableAgentRegistry !== true
      && enableAgentRegistry !== false
      && enableAgentRegistry !== 'true'
      && enableAgentRegistry !== 'false'
    ) {
      throw new Error(
        `enableAgentRegistry must be true or false, got '${String(enableAgentRegistry)}'`,
      );
    }
    // Default-on for compatibility (contrast enableToolGateway, which is opt-in).
    const agentRegistryEnabled = enableAgentRegistry !== false && enableAgentRegistry !== 'false';

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
    // Parent/sub-issue orchestration DAG state.
    const orchestrationTable = new OrchestrationTable(this, 'OrchestrationTable');
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
    const apiKeyTable = new ApiKeyTable(this, 'ApiKeyTable');
    const repoTable = new RepoTable(this, 'RepoTable');

    // Standalone Agent Registry asset registry (#246). Provisioned via a custom
    // resource because CreateRegistry is async and has no CDK L2. Enabled by
    // default for compatibility; set ``enableAgentRegistry=false`` to omit the
    // registry, its API, permissions, environment variables, and outputs.
    // Registry names allow only alphanumerics + underscores, so sanitize the
    // stack name.
    //
    // Isolated in a NestedStack: the registry + its Provider framework add ~20
    // resources; nesting keeps the root stack under CloudFormation's hard
    // 500-resource limit. registryId/registryArn cross the boundary via CDK's
    // automatic cross-stack export/import.
    const agentRegistry = agentRegistryEnabled
      ? new AgentRegistryStack(this, 'AgentRegistryStack', {
        registryName: `abca_${this.stackName.replace(/[^a-zA-Z0-9]/g, '_')}`,
        description: 'ABCA agent asset registry (#246)',
      })
      : undefined;

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

    // Optional per-repo blueprint pinning registry assets (#246), opt-in via
    // context/env so it does not hardcode a specific fork for other contributors.
    // Set ``forkBlueprintRepo`` (e.g. ``--context forkBlueprintRepo=owner/repo``)
    // to onboard a repo with the AWS Knowledge MCP asset pinned.
    const forkBlueprintRepo = process.env.FORK_BLUEPRINT_REPO ?? this.node.tryGetContext('forkBlueprintRepo');
    if (forkBlueprintRepo) {
      blueprints.push(new Blueprint(this, 'ForkBlueprint', {
        repo: forkBlueprintRepo,
        repoTable: repoTable.table,
        assets: {
          mcpServers: ['registry://mcp_server/acme/aws-knowledge@^1.0.0'],
          cedarPolicyModules: ['registry://cedar_policy_module/acme/guard@^1.0.0'],
          skills: ['registry://skill/acme/readme-helper@^1.0.0'],
        },
      }));
    }

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

    // --- Compute-backend deploy gate (read early) ---
    // Which optional compute substrate this deploy provisions, from the
    // ``compute_type`` deploy context (default 'agentcore' — the AgentCore
    // runtime is always present, the other backends are additive). Read HERE,
    // well above the constructs it gates, because TaskApi is instantiated
    // before them and needs to know whether to wire the cancel Lambda's
    // MicroVM termination grant (ADR-021 sub-decision 4).
    const computeType = this.node.tryGetContext('compute_type') ?? 'agentcore';
    const lambdaMicrovmEnabled = computeType === 'lambda-microvm';

    // --- Tool-federation Gateway deploy gate (ADR-019 P1) ---
    // Whether to provision the AgentCore Gateway that federates the agent's MCP
    // tools (P1: one read-only Lambda target, ``abca_repo_config``). OFF by
    // default and additive — the resources synthesize only under
    // ``--context enableToolGateway=true``, so the default synth (and the
    // synth-coverage test that synths with default context) stays byte-for-byte
    // unchanged and introduces no new CFN types into the bootstrap policy set.
    // Same context-gate shape as the ECS / MicroVM compute backends above.
    const toolGatewayEnabled = this.node.tryGetContext('enableToolGateway') === true
      || this.node.tryGetContext('enableToolGateway') === 'true';

    // The operator-supplied MicroVM image inputs, resolved HERE (pure context
    // reads, no construct dependency) rather than at the construct's call site
    // below, because TaskApi — created well before the MicroVM construct — needs
    // to know whether an image will exist in order to decide whether the cancel
    // Lambda gets a `lambda:TerminateMicrovm` grant at all. The same object is
    // handed to the construct, and `isLambdaMicrovmImageConfigured` is the single
    // shared predicate, so the two cannot drift.
    //
    // Base-image ARNs/versions are Region-scoped service data only discoverable
    // through ``aws lambda-microvms list-managed-microvm-images``, and the
    // artifact has to be uploaded to the bucket THIS stack creates — hence
    // context values rather than defaults. See the construct's "three states"
    // table and cdk/scripts/package-microvm-artifact.sh for the bootstrap
    // sequence.
    const microvmImageInputs: LambdaMicrovmImageInputs = {
      baseImageArn: this.node.tryGetContext('microvm_base_image_arn'),
      baseImageVersion: this.node.tryGetContext('microvm_base_image_version'),
      externalImageIdentifier: this.node.tryGetContext('microvm_image_identifier'),
      externalImageVersion: this.node.tryGetContext('microvm_image_version'),
    };
    const microvmImageConfigured = lambdaMicrovmEnabled
      && isLambdaMicrovmImageConfigured(microvmImageInputs);

    // MicroVM image ARN placeholder — the image is created AFTER TaskApi, but the
    // cancel Lambda's grant must be scoped to it. Same Lazy.string cycle-break as
    // the runtime / orchestrator / SessionRole ARNs below.
    let microvmImageArnHolder: string | undefined;
    const lazyMicrovmImageArn = Lazy.string({
      produce: () => {
        if (!microvmImageArnHolder) {
          throw new Error('MicroVM image ARN was accessed before LambdaMicrovmCompute was created');
        }
        return microvmImageArnHolder;
      },
    });

    // Network isolation — VPC with restricted egress.
    // AgentCore only supports a subset of physical availability zones per
    // region, and AZ *names* are aliased per-account, so the default maxAzs
    // selection can land the Runtime ENIs in an unsupported zone and fail the
    // deploy. `props.agentCoreAvailabilityZones` carries the AZ names resolved in
    // main.ts (`resolveAgentCoreAzs`): the validated `agentcore:availabilityZones`
    // override, else auto-selected from the account's AgentCore-supported zones
    // when synth has a concrete account/region. Left undefined otherwise, so the
    // construct keeps CDK's default AZ selection. See constructs/agentcore-azs.ts.
    const agentVpc = new AgentVpc(this, 'AgentVpc', {
      ...(props.agentCoreAvailabilityZones?.length
        ? { availabilityZones: props.agentCoreAvailabilityZones }
        : {}),
    });

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
      guardrailName: `task-input-guardrail-${this.stackName}`.slice(0, GUARDRAIL_NAME_MAX_LENGTH),
      description: 'Screens task submissions for prompt injection attacks',
      contentFilters: [
        {
          type: bedrock.ContentFilterType.PROMPT_ATTACK,
          // MEDIUM blocks on MEDIUM+HIGH confidence; LOW-confidence
          // detections are ignored. Observed during extended deploy
          // validation: at HIGH (blocks LOW too) the
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

    // SessionRole ARN placeholder — the per-task SessionRole is created
    // AFTER the Runtime (it lists runtime.role as an assuming principal), but
    // its ARN must be injected into the runtime's environment so the agent can
    // assume it. Break the cycle with a Lazy.string, same pattern as above.
    let sessionRoleArnHolder: string | undefined;
    const lazySessionRoleArn = Lazy.string({
      produce: () => {
        if (!sessionRoleArnHolder) {
          throw new Error('SessionRole ARN was accessed before AgentSessionRole was created');
        }
        return sessionRoleArnHolder;
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
      apiKeyTable: apiKeyTable.table,
      orchestratorFunctionArn: lazyOrchestratorArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      agentCoreStopSessionRuntimeArn: lazyRuntimeArn,
      traceArtifactsBucket: traceArtifactsBucket.bucket,
      attachmentsBucket: attachmentsBucket.bucket,
      userConcurrencyTable: userConcurrencyTable.table,
      // ADR-021: gives the cancel Lambda `lambda:TerminateMicrovm`, scoped to the
      // platform MicroVM image, so cancelling a MicroVM-backed task stops compute
      // immediately. Omitted when no image is configured — there can be no
      // MicroVM-backed task to cancel then.
      ...(microvmImageConfigured && { lambdaMicrovmImageArn: lazyMicrovmImageArn }),
    });

    // Agent asset registry API (#246) in its own NestedStack + RestApi so its
    // ~35 resources don't count against this root stack's 500-resource limit.
    // It authorizes against the SHARED Cognito user pool, so a caller's JWT works
    // on both APIs; the CLI targets its distinct URL (RegistryApiUrl output) for
    // `registry` commands.
    const registryApi = agentRegistry
      ? new RegistryApi(this, 'RegistryApi', {
        agentRegistryId: agentRegistry.registryId,
        userPool: taskApi.userPool,
      })
      : undefined;

    // --- Tool-federation Gateway (ADR-019 P1, CONTEXT-GATED) ---
    // Provisioned only under ``--context enableToolGateway=true`` (gate read
    // above). When on, exposes one read-only Lambda tool (``abca_repo_config``)
    // through an AgentCore Gateway with SigV4 inbound + gateway-role outbound.
    // The agent reaches it via an in-process SigV4-signing MCP bridge that reads
    // ``ABCA_TOOL_GATEWAY_URL`` (wired below on every substrate role).
    const toolGateway = toolGatewayEnabled
      ? new ToolGateway(this, 'ToolGateway', { repoTable: repoTable.table })
      : undefined;

    // --- AgentCore Runtime (IAM-authed orchestrator path) ---
    //
    // One runtime, invoked by OrchestratorFn via SigV4. See
    // `docs/design/INTERACTIVE_AGENTS.md` §3.1 and AD-1.
    // Outbound SDK solution attribution (#319): the same app-id the
    // SolutionUaAspect sets on Lambdas, computed here so the AgentCore runtime
    // and ECS container (which the Lambda-only Aspect can't reach) carry it
    // too. Respects the `-c sdkUaAppId` override / empty-string opt-out.
    const sdkUaAppId = buildAppId(
      this.stackName,
      this.node.tryGetContext('sdkUaAppId') as string | undefined,
    );

    // Cross-Region inference-profile geography (`bedrockGeoRegion`, default
    // `us`). Resolved once and used for BOTH the auxiliary-model env var below
    // and the Bedrock grants further down, so a deployment can never grant one
    // geography's profiles while telling the agent to call another's.
    const bedrockGeoRegion = resolveBedrockGeoRegion(this.node);

    const runtimeEnvironmentVariables = {
      GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_LOG: 'debug',
      // Cross-region inference-profile ids (geo prefix), NOT bare foundation-model
      // ids: Claude 4.x can't be invoked on-demand by bare id (400 "on-demand
      // throughput isn't supported"). Both are derived from `bedrockGeoRegion` rather
      // than hardcoded, so neither can silently split from the granted profiles on a
      // non-default deploy, and the model ids come from the same constants the grant
      // list interpolates.
      //
      // The MAIN model is set here deliberately, and was previously absent: only the
      // auxiliary var was injected, so the main model fell through to a literal in
      // agent/src/config.py that a geography change does not touch. A deploy with a
      // different `bedrockGeoRegion` therefore granted one geography's profiles while
      // the agent asked for another's, and every task with no per-repo override failed
      // at turn 0 with AccessDenied.
      //
      // The lambda-microvm `platform_config` block below derives the same two values
      // from the same geography. runner.py re-sets both at spawn time; a per-repo
      // `model_id` still overrides.
      ANTHROPIC_MODEL: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_MODEL_ID),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_AUX_MODEL_ID),
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
      // Per-task SessionRole: the agent assumes this with session tags
      // {user_id, repo, task_id} and uses the scoped creds for tenant-data
      // (DDB/S3) access. Resolved lazily — the role lists runtime.role as an
      // assuming principal, so it is created after the runtime.
      AGENT_SESSION_ROLE_ARN: lazySessionRoleArn,
      // --trace artifact store (§10.1). The agent writes the JSONL
      // trajectory to ``traces/<user_id>/<task_id>.jsonl.gz`` on
      // terminal state when the submit payload enabled ``trace``.
      TRACE_ARTIFACTS_BUCKET_NAME: traceArtifactsBucket.bucket.bucketName,
      // Repo-less deliverable artifacts: a deliver_artifact step
      // uploads its product to ``artifacts/<task_id>/`` in the same bucket.
      ARTIFACTS_BUCKET_NAME: traceArtifactsBucket.bucket.bucketName,
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
      // Outbound SDK solution attribution (#319): botocore reads
      // AWS_SDK_UA_APP_ID natively → `app/uksb-wt64nei4u6#{stack}`. The
      // Lambda-only Aspect can't reach this runtime, so set it explicitly.
      ...(sdkUaAppId ? { AWS_SDK_UA_APP_ID: sdkUaAppId } : {}),
      // ADR-019 P1: the federated-tool Gateway URL (context-gated). Present only
      // when ``--context enableToolGateway=true``; the agent's in-process SigV4
      // MCP bridge (gateway_tools.build_gateway_server) reads it to register the
      // ``abca_gateway`` SDK server. Absent → no gateway tool, unchanged.
      ...(toolGateway ? { ABCA_TOOL_GATEWAY_URL: toolGateway.gatewayUrl } : {}),
    };

    const runtimeNetworkConfig = agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
      vpc: agentVpc.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [agentVpc.runtimeSecurityGroup],
    });

    // LifecycleConfiguration — both timers set to the AgentCore 8h maximum so
    // long-running tasks (approval waits, heavy builds) are not evicted.
    const lifecycleConfiguration: agentcore.LifecycleConfiguration = {
      idleRuntimeSessionTimeout: Duration.hours(RUNTIME_SESSION_TIMEOUT_HOURS),
      maxLifetime: Duration.hours(RUNTIME_SESSION_TIMEOUT_HOURS),
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
      loggingConfigs: [
        {
          logType: agentcore.LogType.APPLICATION_LOGS,
          destination: agentcore.LoggingDestination.cloudWatchLogs(applicationLogGroup),
        },
        {
          logType: agentcore.LogType.USAGE_LOGS,
          destination: agentcore.LoggingDestination.cloudWatchLogs(usageLogGroup),
        },
      ],
    });

    runtimeArnHolder = runtime.agentRuntimeArn;

    // --- AgentCore log-delivery: keep the logical ids STABLE across library
    //     renames, so updating an existing stack never has to be opted into ---
    //
    // The AgentCore Runtime auto-creates AWS::Logs::DeliverySource + Delivery +
    // DeliveryDestination per loggingConfig, naming them from the construct path
    // the library happens to use. When that path changes — as it did between
    // library versions here — the CFN logical ids change with it, and CFN treats
    // renamed resources as new ones: it CREATES before it DELETES.
    //
    // A DeliverySource is unique per (resource ARN, log type) for the whole
    // account, and the runtime ARN does not change across the rename. So the new
    // source collides with the live one that is still there, CloudWatch Logs
    // rejects it with ``AlreadyExists``, and the whole stack rolls back. Note
    // what this means: renaming the resources cannot avoid the collision, because
    // the conflict is on the ARN they point at, not on their own names. Only
    // keeping the logical id stable avoids it, since that is what makes CFN
    // update in place rather than create a second source for the same runtime.
    //
    // Hence: pinned ALWAYS, for every stack, with no context flag. A flag would
    // mean the safe path is the one you have to know to ask for, and the failure
    // it prevents is a mid-update rollback that says nothing about the flag's
    // existence. A fresh stack is unaffected either way — it has no live sources
    // to collide with, and these ids are as valid for it as the library's own.
    pinLogDeliveryLogicalIds(runtime);

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
    // Per-session IAM scoping: tenant-data access (the four
    // task_id-partitioned tables + the agent's trace/attachment S3 objects)
    // is NOT granted to the runtime ExecutionRole. Instead the agent assumes a
    // per-task SessionRole (created below) with session tags
    // {user_id, repo, task_id}, and that role carries the tenant-data grants
    // constrained by aws:PrincipalTag conditions. The runtime role keeps only
    // non-tenant / shared access:
    //   - UserConcurrencyTable: user-scoped counter (agent path does not write
    //     it today; left here for the reconciler/orchestrator parity).
    //   - GitHub PAT secret: read once at startup, before the agent assumes the
    //     SessionRole.
    //   - CloudWatch Logs + AgentCore Memory: shared/non-tenant.
    userConcurrencyTable.table.grantReadWriteData(runtime);
    githubTokenSecret.grantRead(runtime);
    applicationLogGroup.grantWrite(runtime);
    agentMemory.grantReadWrite(runtime);

    // ADR-019 P1 (context-gated): let the runtime SigV4-invoke the tool Gateway
    // (``bedrock-agentcore:InvokeGateway``). No-op unless the gateway is
    // provisioned. The ECS task role gets the parallel grant via the
    // EcsAgentCluster prop below (substrate parity).
    toolGateway?.grantInvoke(runtime);

    // Grant the runtime invoke on each configured foundation model + its
    // cross-Region inference profile in the configured geography
    // (`bedrockGeoRegion` — `global` in the shipped cdk.json, `us` absent any context). The model set is a single source of
    // truth (constructs/bedrock-models.ts), shared with the ECS task role and
    // overridable via the `bedrockModels` CDK context. Each invokable is also
    // collected so the same set is granted to the SessionRole below (for cost
    // attribution) — the two grants derive from one list and can't drift.
    // Scoping stays per-model (no Resource:'*'); account-level Bedrock access
    // remains the outer gate.
    const invokableBedrockModels: bedrock.IBedrockInvokable[] = [];
    const grantedModelIds = resolveBedrockModelIds(this.node);

    // The platform's OWN defaults must be inside the set this deploy grants.
    //
    // Asserted HERE rather than in `resolveBedrockModelIds` because this stack is where
    // the two facts meet: it builds the grant from that list AND injects
    // `PLATFORM_DEFAULT_MODEL_ID` / `PLATFORM_DEFAULT_AUX_MODEL_ID` as `ANTHROPIC_MODEL`
    // / `ANTHROPIC_DEFAULT_HAIKU_MODEL` on all three substrates. The resolver only
    // validates the list's shape and has no business knowing the defaults.
    //
    // Without this, `-c bedrockModels='["anthropic.claude-sonnet-4-6"]'` — a documented,
    // code-change-free override — synthesizes clean while granting only Sonnet profiles
    // and telling every substrate to invoke Opus 5. Every task with no per-repo pin then
    // fails at turn 0 with AccessDenied naming no cause. Verified before fixing.
    //
    // This is the boundary the PR's other guards missed: a repo naming an ungranted model
    // is rejected by `repo onboard --model`, a workflow naming one by admission — the
    // platform naming one for itself was checked nowhere.
    const ungrantedDefaults = [PLATFORM_DEFAULT_MODEL_ID, PLATFORM_DEFAULT_AUX_MODEL_ID]
      .filter((m) => !grantedModelIds.includes(m));
    if (ungrantedDefaults.length > 0) {
      throw new Error(
        'Context \'bedrockModels\' omits the platform default model(s) '
        + `${ungrantedDefaults.map((m) => `'${m}'`).join(' and ')}. Every substrate is told to `
        + 'invoke them regardless of that list, so tasks with no per-repo model would fail at '
        + 'turn 0 with AccessDenied. Add them to the override, or change the platform default '
        + 'in cdk/src/handlers/shared/bedrock-model-constants.ts alongside it.',
      );
    }

    for (const modelId of grantedModelIds) {
      const foundationModel = new bedrock.BedrockFoundationModel(modelId, {
        supportsAgents: true,
        supportsCrossRegion: true,
      });
      const crossRegionProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
        geoRegion: bedrockGeoRegion,
        model: foundationModel,
      });
      foundationModel.grantInvoke(runtime);
      crossRegionProfile.grantInvoke(runtime);
      invokableBedrockModels.push(foundationModel, crossRegionProfile);
    }

    // --- Per-task SessionRole ---
    // Holds the tenant-data grants (the four task_id-partitioned tables, plus
    // per-user-prefixed trace writes and attachment reads), each constrained
    // by aws:PrincipalTag conditions so a compromised session reaches only its
    // own task's data. The agent assumes this with refreshable credentials
    // (1h role-chaining cap, tasks run to 8h). Trust admits the runtime
    // ExecutionRole as the assuming principal; the ECS task role is added in
    // the ECS block below when that backend is enabled.
    const agentSessionRole = new AgentSessionRole(this, 'AgentSessionRole', {
      assumingRoles: [runtime.role],
      taskScopedTables: [
        taskTable.table,
        taskEventsTable.table,
        taskApprovalsTable.table,
        taskNudgesTable.table,
      ],
      traceArtifactsBucket: traceArtifactsBucket.bucket,
      attachmentsBucket: attachmentsBucket.bucket,
      // Session-tagged Bedrock grant for cost attribution — the same
      // invokables grantInvoke-ed to the runtime above, so the grants stay in
      // lockstep.
      invokableModels: invokableBedrockModels,
    });
    sessionRoleArnHolder = agentSessionRole.role.roleArn;

    // X-Ray tracing disabled — requires account-level UpdateTraceSegmentDestination
    // which needs CloudWatch Logs resource policy propagation. Re-enable via
    // tracingEnabled: true once resolved.

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

    new CfnOutput(this, 'ApiKeyTableName', {
      value: apiKeyTable.table.tableName,
      description: 'Name of the DynamoDB platform API key table',
    });

    new CfnOutput(this, 'RepoTableName', {
      value: repoTable.table.tableName,
      description: 'Name of the DynamoDB repo config table',
    });

    new CfnOutput(this, 'GitHubTokenSecretArn', {
      value: githubTokenSecret.secretArn,
      description: 'ARN of the Secrets Manager secret for the GitHub token',
    });

    if (agentRegistry) {
      new CfnOutput(this, 'AgentRegistryId', {
        value: agentRegistry.registryId,
        description: 'ID of the standalone Agent Registry asset registry (#246)',
      });

      new CfnOutput(this, 'AgentRegistryArn', {
        value: agentRegistry.registryArn,
        description: 'ARN of the standalone Agent Registry asset registry (#246)',
      });
    }

    new CfnOutput(this, 'TraceArtifactsBucketName', {
      value: traceArtifactsBucket.bucket.bucketName,
      description: 'Name of the S3 bucket storing --trace trajectory artifacts (design §10.1)',
    });

    // --- ECS Fargate compute backend (CONTEXT-GATED) ---
    // AgentCore's fixed microVM envelope OOM-kills heavy CI-parity builds
    // (a ~2800-test suite, for instance). ECS Fargate
    // gives a bigger, tunable task (see EcsAgentCluster for the exact vCPU/memory
    // sizing and the measurements behind it — a 32 GB task was OOM-killed by a
    // fully parallel build, which is why the build tier serialises with MISE_JOBS=1)
    // for repos that set ``compute_type: 'ecs'``. GATED on the ``compute_type`` deploy context
    // (default 'agentcore') — ECS resources only synthesize when you deploy with
    // ``--context compute_type=ecs``, so the default synth (and the
    // bootstrap-coverage test that synths with default context) stays
    // agentcore-only, matching how other optional constructs are context-gated.
    // (``computeType`` is read near the top of the constructor — TaskApi needs it
    // for the conditional MicroVM cancel grant.)
    // Ephemeral bucket for ECS task payloads — the orchestrator writes the
    // payload here (it exceeds the 8 KB RunTask containerOverrides limit) and
    // passes only an S3 URI pointer; the container fetches it on boot, the
    // orchestrator deletes it at finalize. Only synthesized under the ecs gate.
    const ecsPayloadBucket = computeType === 'ecs'
      ? new EcsPayloadBucket(this, 'EcsPayloadBucket')
      : undefined;
    if (ecsPayloadBucket) {
      NagSuppressions.addResourceSuppressions(ecsPayloadBucket.bucket, [
        {
          id: 'AwsSolutions-S1',
          reason: 'Ephemeral per-task payloads with a 1-day TTL; writes confined to the orchestrator IAM role by grantPut, reads to the ECS task role by grantRead, both scoped to this bucket. Object deleted at finalize. Object-level audit intentionally omitted — CloudTrail data events / a log bucket are not justified for transient boot payloads.',
        },
      ]);
    }
    // ECS build-task sizing, from deploy context. The construct's defaults are
    // deliberately modest so an adopter who changes nothing does not pay for the
    // Fargate ceiling — but a large monorepo genuinely needs more, so the knobs
    // have to be reachable WITHOUT editing the construct. Same shape as
    // ``compute_type`` above:
    //   cdk deploy -c compute_type=ecs -c ecsBuildTaskCpu=16384 \
    //     -c ecsBuildTaskMemoryMiB=122880 -c ecsBuildTaskEphemeralStorageGiB=100
    //   cdk deploy -c ecsExtraBuildEnv='{"MISE_JOBS":"8"}'
    const ecsTaskSizing = resolveEcsTaskSizing(this.node);
    const ecsCluster = computeType === 'ecs'
      ? new EcsAgentCluster(this, 'EcsAgentCluster', {
        ...(ecsTaskSizing !== undefined && { taskSizing: ecsTaskSizing }),
        vpc: agentVpc.vpc,
        agentImageAsset: new ecr_assets.DockerImageAsset(this, 'AgentImage', {
          directory: repoRoot,
          file: 'agent/Dockerfile',
          platform: ecr_assets.Platform.LINUX_ARM64,
        }),
        taskTable: taskTable.table,
        taskEventsTable: taskEventsTable.table,
        userConcurrencyTable: userConcurrencyTable.table,
        githubTokenSecret,
        memoryId: agentMemory.memory.memoryId,
        // ECS parity: pass the Memory construct (not just its id) so the task
        // role gets grantReadWrite — MEMORY_ID alone makes the agent ATTEMPT the
        // write, which fails closed (bedrock-agentcore:CreateEvent AccessDenied)
        // without this grant. The AgentCore runtime gets the equivalent grant
        // where it is created above.
        agentMemory,
        // Read-only grant so the container can fetch its payload from S3.
        payloadBucket: ecsPayloadBucket!.bucket,
        // ECS parity: the same bucket the runtime uses for ARTIFACTS_BUCKET_NAME —
        // a repo-bound artifact workflow delivers here. Wires the
        // ARTIFACTS_BUCKET_NAME env only; delivery writes go through the per-task
        // SessionRole (no direct task-role grant — see construct). Without the
        // env, an ecs-repo artifact task fails at delivery.
        artifactsBucket: traceArtifactsBucket.bucket,
        // Per-session IAM scoping: the ECS task role assumes the same
        // SessionRole as the AgentCore runtime for tenant-data access. The
        // construct admits the task role to the trust and injects
        // AGENT_SESSION_ROLE_ARN into the container.
        agentSessionRole,
        // ADR-019 P1: parity — grants the task role InvokeGateway + injects
        // ABCA_TOOL_GATEWAY_URL. Undefined unless --context enableToolGateway=true.
        toolGateway,
      })
      : undefined;

    // --- AWS Lambda MicroVMs compute backend (CONTEXT-GATED) ---
    // ADR-021 P1: a serverless Firecracker sandbox per session — VM-level
    // isolation with no cluster to operate, and (from P3) suspend/resume so a
    // task parked on a HITL approval gate stops billing compute while keeping
    // its cloned repo and warm build caches in memory.
    //
    // Gated exactly like the ECS backend above: resources synthesize only under
    // ``--context compute_type=lambda-microvm``, so the default synth — and the
    // bootstrap-coverage test that synths with default context — stays
    // agentcore-only. The construct itself enforces the ADR's Region gate, so a
    // deploy into a Region without Lambda MicroVMs fails at synth rather than on
    // the first task.
    const lambdaMicrovm = lambdaMicrovmEnabled
      ? new LambdaMicrovmCompute(this, 'LambdaMicrovmCompute', {
        vpc: agentVpc.vpc,
        // Per-session IAM scoping (#209): the MicroVM execution role is admitted
        // to the same per-task SessionRole the AgentCore runtime and the Fargate
        // task role use, so tenant-data access is tag-scoped on every substrate.
        agentSessionRole,
        // ADR-021 P2 runtime parity on the MicroVM execution role. Same two props
        // EcsAgentCluster takes, for the same reasons: the PAT is read at startup
        // before the SessionRole is assumed, and MEMORY_ID (already delivered in
        // agent_payload) makes the agent ATTEMPT a memory write that fails closed
        // without the grant. The remaining parity grants (channel OAuth, Bedrock,
        // AZ describe) need no stack input and are wired inside the construct.
        githubTokenSecret,
        agentMemory,
        // ADR-021 P2-F4: the SAME log group whose name travels to the guest in
        // `agentPlatformConfig.logGroupName` below (→ `LOG_GROUP_NAME`). P2
        // delivered the name without the grant, so the agent's structured per-task
        // lines and its METRICS_REPORT were AccessDenied on
        // logs:CreateLogStream and the platform's canonical observability streams
        // were empty on this backend. Passing the construct (not the name) keeps the
        // grant and the delivered value derived from one object.
        applicationLogGroup,
        // Resolved above TaskApi — see `microvmImageInputs`.
        ...microvmImageInputs,
      })
      : undefined;

    // Resolve the Lazy TaskApi's cancel grant is scoped by. The invariant the
    // Lazy's `produce` guards: `microvmImageConfigured` (computed from the same
    // inputs, via the same predicate) is true exactly when the construct sets
    // `imageArn`, so a configured deployment always has an ARN to resolve and an
    // unconfigured one never asks for it.
    microvmImageArnHolder = lambdaMicrovm?.imageArn;

    // Advertise which compute substrate this deploy actually provisioned, so the
    // CLI can refuse to onboard a repo as ``compute_type: ecs`` when the ECS gate
    // wasn't on (``--context compute_type=ecs``) — otherwise that mismatch only
    // surfaces per-task as "ECS compute strategy requires ECS_CLUSTER_ARN…" at
    // runtime. ``ecs`` implies the AgentCore runtime is ALSO available (the ECS
    // gate is additive), so an agentcore repo works on either substrate — and the
    // same holds for ``lambda-microvm`` (ADR-021).
    new CfnOutput(this, 'ComputeSubstrate', {
      value: ecsCluster ? 'ecs' : (lambdaMicrovm ? 'lambda-microvm' : 'agentcore'),
      description: 'Compute substrate provisioned by this deploy: "agentcore" (default), "ecs" '
        + '(deployed with --context compute_type=ecs; adds the Fargate substrate alongside AgentCore) '
        + 'or "lambda-microvm" (--context compute_type=lambda-microvm; adds the Lambda MicroVMs '
        + 'substrate alongside AgentCore).',
    });

    // Both outputs are consumed by `platform doctor` and `repo onboard --model` to
    // reject an ungranted or wrong-geography model before a task reaches turn 0.
    new CfnOutput(this, 'BedrockModelIds', {
      value: resolveBedrockModelIds(this.node).join(','),
      description: 'Comma-separated BARE foundation-model ids this deploy grants. '
        + 'Invoked as `<BedrockGeoRegion>.<modelId>`.',
    });

    new CfnOutput(this, 'BedrockGeoRegion', {
      value: bedrockGeoRegion,
      description: 'Cross-Region inference-profile geography this deploy grants (the '
        + '`bedrockGeoRegion` context key; "global" in the shipped cdk.json, "us" if no '
        + 'context is supplied at all). Model ids are invoked as `<geo>.<modelId>`.',
    });

    if (lambdaMicrovm) {
      // Emitted so the packaging helper (cdk/scripts/package-microvm-artifact.sh)
      // can discover where to upload the zip+Dockerfile and which log group /
      // build role to hand `create-microvm-image` — none of which have
      // predictable physical names.
      new CfnOutput(this, 'MicrovmArtifactBucketName', {
        value: lambdaMicrovm.artifactBucket.bucketName,
        description: 'S3 bucket the Lambda MicroVMs zip+Dockerfile artifact is uploaded to (ADR-021)',
      });
      new CfnOutput(this, 'MicrovmArtifactObjectKey', {
        value: lambdaMicrovm.artifactObjectKey,
        description: 'S3 key the Lambda MicroVMs artifact must be uploaded to (matches the build role\'s s3:GetObject scope)',
      });
      new CfnOutput(this, 'MicrovmBuildRoleArn', {
        value: lambdaMicrovm.buildRole.roleArn,
        description: 'IAM role for `aws lambda-microvms create-microvm-image --build-role-arn`',
      });
      new CfnOutput(this, 'MicrovmExecutionRoleArn', {
        value: lambdaMicrovm.executionRole.roleArn,
        description: 'IAM role the running MicroVM assumes (`run-microvm --execution-role-arn`)',
      });
      new CfnOutput(this, 'MicrovmEgressConnectorArns', {
        value: lambdaMicrovm.egressConnectorArns.join(','),
        description: 'Lambda network connector ARNs routing MicroVM egress through the platform VPC',
      });
      new CfnOutput(this, 'MicrovmBuildEgressConnectorArns', {
        value: lambdaMicrovm.buildEgressConnectorArns.join(','),
        description: 'Lambda network connector ARNs for the IMAGE BUILD path (TCP 443 + 80 — '
          + 'agent/Dockerfile runs apt-get over HTTP; pass these to '
          + '`create-microvm-image --egress-network-connectors`, NOT the runtime connectors)',
      });
      new CfnOutput(this, 'MicrovmLogGroupName', {
        value: lambdaMicrovm.logGroup.logGroupName,
        description: 'CloudWatch log group for MicroVM build- and run-time logs',
      });
    }

    // --- Task Orchestrator (durable Lambda function) ---
    // Per-user concurrency cap, shared by the orchestrator (admission control)
    // and the orchestration reconcilers (their release throttle), so the two
    // never drift — the reconciler must throttle to the SAME ceiling admission
    // enforces.
    const maxConcurrentTasksPerUser = 10;
    const orchestrator = new TaskOrchestrator(this, 'TaskOrchestrator', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser,
      repoTable: repoTable.table,
      runtimeArn: runtime.agentRuntimeArn,
      githubTokenSecretArn: githubTokenSecret.secretArn,
      memoryId: agentMemory.memory.memoryId,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      attachmentsBucket: attachmentsBucket.bucket,
      ...(agentRegistry && { agentRegistryId: agentRegistry.registryId }),
      // ADR-021 P2: non-secret platform identifiers the orchestrator forwards to
      // the in-guest agent as `platform_config` on the MicroVM /run payload — the
      // MicroVM equivalent of the AgentCore runtime env block above and the ECS
      // container env, because a snapshot must not bake configuration in.
      //
      // Sourced from the SAME stack-level values that block uses, deliberately, so
      // an agent behaves identically on all three substrates and a value can only
      // be changed in one place. Wired unconditionally (not under the
      // lambda-microvm gate) so the strategy's required-identifier guard can only
      // ever fire for an environment edited outside CDK.
      //
      // No grant rides along: the orchestrator forwards these names and calls none
      // of the resources they identify.
      agentPlatformConfig: {
        taskApprovalsTableName: taskApprovalsTable.table.tableName,
        nudgesTableName: taskNudgesTable.table.tableName,
        logGroupName: applicationLogGroup.logGroupName,
        // INTENTIONAL, not a wiring bug: both keys resolve to the SAME bucket
        // (`traceArtifactsBucket`), exactly as `ARTIFACTS_BUCKET_NAME` and
        // `TRACE_ARTIFACTS_BUCKET_NAME` do in the AgentCore runtime env block above
        // — a live P2 run flagged the coincidence (ADR-021 P2-F8) so it is recorded
        // here rather than re-derived. They stay two keys because the agent reads
        // them from two independent code paths with two different prefixes
        // (`deliver_artifact` → `artifacts/<task_id>/`, `telemetry.py --trace` →
        // `traces/<user_id>/<task_id>.jsonl.gz`), and the per-task SessionRole
        // scopes each prefix separately. Collapsing them to one key would make
        // splitting the buckets later a cross-package contract change; sending one
        // bucket through two keys costs nothing today.
        artifactsBucketName: traceArtifactsBucket.bucket.bucketName,
        traceArtifactsBucketName: traceArtifactsBucket.bucket.bucketName,
        // The SessionRole is created above (before the orchestrator), so this needs
        // no Lazy — it is the same CFN token the runtime env receives.
        agentSessionRoleArn: agentSessionRole.role.roleArn,
        // Same helper, same resolved geography as the AgentCore runtime env
        // above (#764) — the two substrates cannot be told to call different
        // inference profiles.
        anthropicDefaultHaikuModel: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_AUX_MODEL_ID),
        // The MAIN model, delivered the same way for the same reason. Only the auxiliary
        // one was, so on this substrate the main model came from a literal in
        // agent/src/config.py that a geography change does not touch: a non-default
        // `bedrockGeoRegion` granted one geography while the agent asked for another,
        // and every task with no per-repo override failed at turn 0 with AccessDenied.
        anthropicModel: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_MODEL_ID),
      },
      // Route ``compute_type: 'ecs'`` repos to the Fargate cluster above —
      // only when the cluster was synthesized (deploy --context compute_type=ecs).
      ...(ecsCluster && {
        ecsConfig: {
          clusterArn: ecsCluster.cluster.clusterArn,
          taskDefinitionArn: ecsCluster.taskDefinition.taskDefinitionArn,
          // See docs/design/ECS_RIGHTSIZED_PLANNING.md: the smaller read-only planning
          // def, so a read-only task doesn't over-allocate the larger build box.
          planningTaskDefinitionArn: ecsCluster.planningTaskDefinition.taskDefinitionArn,
          subnets: agentVpc.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
          securityGroup: ecsCluster.securityGroup.securityGroupId,
          containerName: ecsCluster.containerName,
          taskRoleArn: ecsCluster.taskRoleArn,
          executionRoleArn: ecsCluster.executionRoleArn,
        },
      }),
      // Pass the payload bucket so the orchestrator writes/deletes the
      // out-of-band payload and the ECS strategy builds the S3 URI pointer.
      ...(ecsPayloadBucket && { ecsPayloadBucket: ecsPayloadBucket.bucket }),
      // ADR-021: route ``compute_type: 'lambda-microvm'`` repos to the MicroVM
      // substrate. Wired only when an image is actually configured — without one
      // the strategy has nothing to run, and injecting a partial MICROVM_* env
      // block would trade the strategy's precise "deployed without the MicroVM
      // substrate" error for an opaque service-side failure. The construct sets
      // ``imageIdentifier`` and ``imageArn`` together (a bare image name is
      // resolved to its exact ARN), so testing both keeps the all-or-nothing
      // contract compile-checked rather than assumed.
      ...(lambdaMicrovm?.imageIdentifier && lambdaMicrovm.imageArn && {
        microvmConfig: {
          imageIdentifier: lambdaMicrovm.imageIdentifier,
          imageArn: lambdaMicrovm.imageArn,
          imageVersion: lambdaMicrovm.imageVersion,
          executionRoleArn: lambdaMicrovm.executionRole.roleArn,
          egressConnectorArns: lambdaMicrovm.egressConnectorArns,
          // Explicit NO_INGRESS, not an omission: RunMicrovm attaches a PUBLIC
          // HTTP_INGRESS connector (and mints a public endpoint) when the field is
          // absent, so ADR-021's "no inbound exposure" posture is a control the
          // construct has to pass on every launch. Still no JWE tokens minted.
          ingressConnectorArns: lambdaMicrovm.ingressConnectorArns,
          payloadBucket: lambdaMicrovm.payloadBucket,
        },
      }),
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

    // --- Admission-queue pickup (#441) ---
    // Drains QUEUED tasks (parked by the orchestrator when the per-user
    // concurrency cap is hit) in FIFO order as slots free up: flips
    // QUEUED -> SUBMITTED and re-invokes the orchestrator, whose atomic
    // admissionControl remains the single writer of the counter.
    new AdmissionQueuePickup(this, 'AdmissionQueuePickup', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
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

    // FanOutConsumer is constructed below LinearIntegration so the
    // Linear dispatcher can receive ``linearIntegration.workspaceRegistryTable``.

    // --- Cedar HITL approval metrics publisher (Chunk 8, §11.3 / IMPL-28) ---
    // The second consumer of the TaskEventsTable stream (FanOutConsumer is the first).
    // Reads agent_milestone records for approval events and emits
    // CloudWatch EMF for the dashboard widgets below. See the
    // 2-consumer architectural note in `task-events-table.ts` —
    // adding a third consumer here requires the Kinesis Data Streams
    // for DynamoDB migration.
    const approvalMetricsPublisher = new ApprovalMetricsPublisherConsumer(this, 'ApprovalMetricsPublisherConsumer', {
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
    const apiStage = Fn.select(API_URL_STAGE_SEGMENT_INDEX, Fn.split('/', taskApi.api.url));
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

    new CfnOutput(this, 'SlackChannelMappingTableName', {
      value: slackIntegration.channelMappingTable.tableName,
      description: 'Name of the DynamoDB Slack channel → default-repo mapping table',
    });

    // --- Linear integration (inbound webhook + agent-side MCP outbound) ---
    const linearIntegration = new LinearIntegration(this, 'LinearIntegration', {
      api: taskApi.api,
      userPool: taskApi.userPool,
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      repoTable: repoTable.table,
      // Enables the webhook processor's orchestration path
      // (seed DAG + release roots). Sets ORCHESTRATION_TABLE_NAME.
      orchestrationTable: orchestrationTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      // Throttle the seed-time root release to the free concurrency
      // budget so a wide-root epic doesn't over-release roots admission then
      // hard-fails (an unrecoverable failure — a root has no predecessor for
      // the sweep to re-release from).
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser,
      // Image attachments extracted from issue descriptions upload here
      // (otherwise createTaskCore 503s "Attachment storage is not configured").
      attachmentsBucket: attachmentsBucket.bucket,
    });

    // The orchestration reconciler consumes the TaskTable stream and
    // releases dependency-unblocked children as predecessors reach
    // terminal-success. It invokes createTaskCore in-process, so it needs
    // the same task-creation env + invoke permission as the webhook
    // processor.
    const orchestrationReconciler = new OrchestrationReconciler(this, 'OrchestrationReconciler', {
      taskTable: taskTable.table,
      orchestrationTable: orchestrationTable.table,
      taskEventsTable: taskEventsTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
    });
    // createTaskCore (run inside the reconciler) screens descriptions with
    // the input guardrail, reads repo onboarding/blueprint config, and
    // async-invokes the orchestrator. Mirror the webhook processor's grants.
    repoTable.table.grantReadData(orchestrationReconciler.fn);
    orchestrationReconciler.fn.addEnvironment('REPO_TABLE_NAME', repoTable.table.tableName);
    orchestrationReconciler.fn.addEnvironment('GUARDRAIL_ID', inputGuardrail.guardrailId);
    orchestrationReconciler.fn.addEnvironment('GUARDRAIL_VERSION', inputGuardrail.guardrailVersion);
    orchestrationReconciler.fn.addEnvironment(
      'ORCHESTRATOR_FUNCTION_ARN',
      orchestrator.alias.functionArn,
    );
    // The reconciler posts the parent rollup comment on completion —
    // needs the workspace registry to resolve the per-workspace OAuth token.
    linearIntegration.workspaceRegistryTable.grantReadData(orchestrationReconciler.fn);
    orchestrationReconciler.fn.addEnvironment(
      'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
      linearIntegration.workspaceRegistryTable.tableName,
    );
    // Read the user concurrency counter so a wide fan-out releases only
    // up to the free budget (the cap throttles, not guillotines, children).
    userConcurrencyTable.table.grantReadData(orchestrationReconciler.fn);
    orchestrationReconciler.fn.addEnvironment(
      'USER_CONCURRENCY_TABLE_NAME',
      userConcurrencyTable.table.tableName,
    );
    orchestrationReconciler.fn.addEnvironment(
      'MAX_CONCURRENT_TASKS_PER_USER',
      String(maxConcurrentTasksPerUser),
    );
    orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [orchestrator.alias.functionArn],
    }));
    orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [
        Stack.of(this).formatArn({
          service: 'bedrock',
          resource: 'guardrail',
          resourceName: inputGuardrail.guardrailId,
        }),
      ],
    }));
    // Released child tasks attributed to linear workspaces need the
    // per-workspace OAuth secret prefix readable (createTaskCore stashes
    // the ARN; agent reads it). Same prefix grant as the webhook processor.
    orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
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
    // Scheduled backstop that recovers orchestrations whose terminal
    // events were lost while the live reconciler was unavailable. Runs the
    // same createTaskCore release path, so it needs the identical grants
    // (repo config, guardrail, orchestrator invoke, linear-oauth secret).
    const strandedOrchestrationReconciler = new StrandedOrchestrationReconciler(
      this, 'StrandedOrchestrationReconciler', {
        orchestrationTable: orchestrationTable.table,
        taskTable: taskTable.table,
        taskEventsTable: taskEventsTable.table,
        orchestratorFunctionArn: orchestrator.alias.functionArn,
      },
    );
    repoTable.table.grantReadData(strandedOrchestrationReconciler.fn);
    strandedOrchestrationReconciler.fn.addEnvironment('REPO_TABLE_NAME', repoTable.table.tableName);
    strandedOrchestrationReconciler.fn.addEnvironment('GUARDRAIL_ID', inputGuardrail.guardrailId);
    strandedOrchestrationReconciler.fn.addEnvironment('GUARDRAIL_VERSION', inputGuardrail.guardrailVersion);
    strandedOrchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [orchestrator.alias.functionArn],
    }));
    strandedOrchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [
        Stack.of(this).formatArn({
          service: 'bedrock',
          resource: 'guardrail',
          resourceName: inputGuardrail.guardrailId,
        }),
      ],
    }));
    strandedOrchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
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
    // The sweep shares the live reconciler's panel refresh + parent settle
    // (refreshPanelAndSettle), which needs a credentials registry to resolve an
    // outbound token — without it that feedback silently no-ops and a recovered
    // epic's panel stays stale. It already had the matching secret grant above,
    // just not the table, so the feedback half of the sweep never ran.
    linearIntegration.workspaceRegistryTable.grantReadData(strandedOrchestrationReconciler.fn);
    strandedOrchestrationReconciler.fn.addEnvironment(
      'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
      linearIntegration.workspaceRegistryTable.tableName,
    );
    // The sweep is the drain path for throttle-deferred children, so it
    // throttles to the same free budget the live reconciler does.
    userConcurrencyTable.table.grantReadData(strandedOrchestrationReconciler.fn);
    strandedOrchestrationReconciler.fn.addEnvironment(
      'USER_CONCURRENCY_TABLE_NAME',
      userConcurrencyTable.table.tableName,
    );
    strandedOrchestrationReconciler.fn.addEnvironment(
      'MAX_CONCURRENT_TASKS_PER_USER',
      String(maxConcurrentTasksPerUser),
    );

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

    // Mid-run liveness heartbeat. A scheduled sweep edits the maturing
    // Linear/Jira comment of RUNNING comment-triggered iterations to show elapsed time
    // ("🔄 Working … _8m elapsed_") so a long run isn't a silent black box
    // (observed in practice: a run went 22 minutes with no visible output).
    // Needs each surface registry and scoped OAuth-secret access to resolve
    // outbound credentials (same as the reconciler's reply path). Read-only on
    // the TaskTable.
    const iterationHeartbeat = new IterationHeartbeat(this, 'IterationHeartbeat', {
      taskTable: taskTable.table,
    });
    linearIntegration.workspaceRegistryTable.grantReadData(iterationHeartbeat.fn);
    iterationHeartbeat.fn.addEnvironment(
      'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
      linearIntegration.workspaceRegistryTable.tableName,
    );
    iterationHeartbeat.fn.addToRolePolicy(new iam.PolicyStatement({
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

    // --- Jira Cloud integration (inbound webhook + agent-side REST outbound) ---
    const jiraIntegration = new JiraIntegration(this, 'JiraIntegration', {
      api: taskApi.api,
      userPool: taskApi.userPool,
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      orchestrationTable: orchestrationTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser: maxConcurrentTasksPerUser,
      repoTable: repoTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      // Lets the processor fetch, screen, and store Jira media attachments at
      // task-admission time. Same bucket the orchestrator hydrates from.
      attachmentsBucket: attachmentsBucket.bucket,
    });

    // Add Jira to the channel-neutral heartbeat sweep. Token resolution can
    // refresh an expiring OAuth bundle, so this trusted Lambda needs scoped
    // Get+Put on the per-tenant secret prefix as well as registry-table read.
    jiraIntegration.workspaceRegistryTable.grantReadData(iterationHeartbeat.fn);
    iterationHeartbeat.fn.addEnvironment(
      'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
      jiraIntegration.workspaceRegistryTable.tableName,
    );
    iterationHeartbeat.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));

    // Agent runtime reads the per-tenant Jira OAuth token directly from
    // Secrets Manager. The CLI (`bgagent jira setup`) creates
    // `bgagent-jira-oauth-<cloudId>` secrets at install time; the secret
    // JSON contains access_token, refresh_token, expires_at, and the
    // OAuth client_id/client_secret. The orchestrator passes
    // `jira_oauth_secret_arn` to the agent via task.channel_metadata,
    // so the agent looks up the exact ARN — no discovery needed.
    //
    // Agent has GetSecretValue ONLY — no Put. Same trust model as the
    // Linear adapter: a compromised agent must not be able to overwrite
    // any tenant's OAuth bundle. Lambdas (trusted code in this stack)
    // own the in-place refresh path; the agent proceeds with whatever
    // token Lambdas have most-recently written.
    runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));

    // Pipe the workspace registry table + per-tenant OAuth-secret-prefix
    // grant into the orchestrator so the concurrency-cap rejection path
    // (`notifyJiraOnConcurrencyCap` in orchestrate-task.ts) can post a Jira
    // comment. The orchestrator only resolves a token when
    // `task.channel_source === 'jira'`, but the IAM grant is unconditional
    // (per-tenant secrets are created lazily by setup). Put is needed because
    // resolving an expiring token refreshes it in place (the orchestrator is
    // a trusted Lambda; unlike the agent it owns the rotated-token write-back).
    jiraIntegration.workspaceRegistryTable.grantReadData(orchestrator.fn);
    orchestrator.fn.addEnvironment(
      'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
      jiraIntegration.workspaceRegistryTable.tableName,
    );
    orchestrator.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));

    // The reconciler picks the feedback surface from each orchestration's own
    // recorded channel, so give it the Jira tenant registry too — otherwise a
    // Jira-sourced orchestration would resolve to no adapter and silently skip
    // its panel/reactions. Read + Put for the same reason as the orchestrator
    // above (resolving an expiring token refreshes it in place). Harmless while
    // only Linear seeds orchestrations; required the moment one can be Jira's.
    jiraIntegration.workspaceRegistryTable.grantReadData(orchestrationReconciler.fn);
    orchestrationReconciler.fn.addEnvironment(
      'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
      jiraIntegration.workspaceRegistryTable.tableName,
    );
    orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));

    new CfnOutput(this, 'JiraWebhookSecretArn', {
      value: jiraIntegration.webhookSecret.secretArn,
      description: 'Secrets Manager ARN for the Jira webhook signing secret — populate via `bgagent jira setup`',
    });

    new CfnOutput(this, 'JiraProjectMappingTableName', {
      value: jiraIntegration.projectMappingTable.tableName,
      description: 'Name of the DynamoDB Jira project → repo mapping table',
    });

    new CfnOutput(this, 'JiraUserMappingTableName', {
      value: jiraIntegration.userMappingTable.tableName,
      description: 'Name of the DynamoDB Jira user mapping table',
    });

    new CfnOutput(this, 'JiraWorkspaceRegistryTableName', {
      value: jiraIntegration.workspaceRegistryTable.tableName,
      description: 'Name of the DynamoDB Jira workspace registry — `bgagent jira setup` writes a row per OAuth-installed tenant',
    });

    // --- Fan-out plane consumer ---
    // Consumes TaskEventsTable DynamoDB Streams and dispatches events to
    // Slack / GitHub / Linear / email per per-channel default filters.
    // GitHub dispatcher edits a single issue comment in place; Slack
    // dispatcher reads per-workspace bot tokens from
    // ``bgagent/slack/*``; Linear dispatcher posts a single
    // deterministic final-status comment with cost/turns/duration.
    // Email remains a log-only stub until SES wires.
    const fanOutConsumer = new FanOutConsumer(this, 'FanOutConsumer', {
      taskEventsTable: taskEventsTable.table,
      taskTable: taskTable.table,
      repoTable: repoTable.table,
      githubTokenSecret,
      // Slack bot-token grant is guarded on this prop — pass the
      // ``bgagent/slack/*`` prefix so the FanOutConsumer can read
      // workspace tokens. Same scope SlackIntegration uses for its
      // own writers.
      slackSecretArnPattern: Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: 'bgagent/slack/*',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
      // Linear dispatcher reads workspace registry rows + per-workspace
      // OAuth-secret JSON. Same scope `bgagent-linear-oauth-*` as the
      // orchestrator and webhook processor — Lambdas in this stack share
      // the rotated-token write path; the agent runtime gets read-only.
      linearWorkspaceRegistryTable: linearIntegration.workspaceRegistryTable,
      linearOauthSecretArnPattern: Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: 'bgagent-linear-oauth-*',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
      // Jira dispatcher posts a deterministic final-status comment with
      // cost/turns/duration on Jira-origin terminal tasks. Same scope
      // `bgagent-jira-oauth-*` as the orchestrator and Jira webhook
      // processor — Lambdas in this stack share the rotated-token write
      // path. Both props are optional on the construct, so omitting them
      // silently disables Jira final-status comments rather than failing
      // synth: keep them wired.
      jiraWorkspaceRegistryTable: jiraIntegration.workspaceRegistryTable,
      jiraOauthSecretArnPattern: Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: 'bgagent-jira-oauth-*',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    });

    // --- GitHub deployment-status → screenshot pipeline ---
    // Listens for GitHub deployment_status events from any provider
    // (Vercel, Amplify Hosting, Netlify, GitHub Actions custom CD),
    // screenshots the `deployment.environment_url` via AgentCore
    // Browser, posts the image into a fresh PR comment. Default-on:
    // any repo whose GitHub webhook is configured will get
    // screenshotted on successful preview deploys; no opt-in flag.
    const githubScreenshot = new GitHubScreenshotIntegration(this, 'GitHubScreenshotIntegration', {
      api: taskApi.api,
      githubTokenSecret,
      // When the screenshot lands on a PR linked to a Linear issue
      // (identifier in the PR title/body), also post the screenshot
      // as a comment on that Linear issue. Wired through the existing
      // workspace registry so token resolution reuses the per-workspace
      // OAuth secrets created by `bgagent linear setup`.
      linearWorkspaceRegistryTable: linearIntegration.workspaceRegistryTable,
      // Persist screenshot_url on the deploy task so the
      // orchestration reconciler can embed the integration node's combined
      // preview in the parent epic panel.
      taskTable: taskTable.table,
    });

    // Re-stacking dependents is NOT a GitHub-webhook path. It runs inside the
    // orchestration reconciler (off the TaskTable stream): when a Linear
    // @bgagent comment re-iterates a sub-issue's PR (coding/pr-iteration-v1)
    // and that task completes, the reconciler cascades coding/restack-v1
    // tasks to the changed node's dependents. No inbound pull_request webhook
    // (those are WAF-blocked by the API's managed rule set anyway), so there
    // is no RestackProcessor Lambda to wire here.

    // --- Operational alerts channel (§11.5 follow-up, issue #629) ---
    // A single stack-wide SNS topic that the DLQ-depth alarms publish to
    // on state change, so poison-pill accumulation pushes a notification
    // instead of sitting silently in the Alarms console. Delivery target
    // is configurable: pass an email via `-c alertEmail=ops@example.com`
    // (AWS sends a confirmation link that must be clicked), or leave it
    // unset and subscribe Slack / PagerDuty manually against the exported
    // topic ARN below.
    const operationalAlerts = new OperationalAlerts(this, 'OperationalAlerts', {
      alertEmail: this.node.tryGetContext('alertEmail') as string | undefined,
    });
    // Wire the DLQ-depth alarms shipped in #117 (FanOut + approval-metrics
    // publisher) plus the screenshot processor's async-invoke DLQ alarm —
    // all three share the threshold-1 "records landed in a DLQ" shape.
    operationalAlerts.addAlarmActions(
      fanOutConsumer.dlqDepthAlarm,
      approvalMetricsPublisher.dlqAlarm,
      githubScreenshot.processorDlqDepthAlarm,
    );

    new CfnOutput(this, 'OperationalAlertsTopicArn', {
      value: operationalAlerts.topic.topicArn,
      description: 'SNS topic for DLQ-depth CloudWatch alarms — subscribe Slack / PagerDuty / email here (#629)',
    });

    new CfnOutput(this, 'GitHubWebhookUrl', {
      value: `${taskApi.api.url}github/webhook`,
      description: 'URL to configure as the GitHub webhook target on demo repos (deployment_status events)',
    });

    new CfnOutput(this, 'GitHubWebhookSecretArn', {
      value: githubScreenshot.webhookSecret.secretArn,
      description: 'Secrets Manager ARN for the GitHub webhook signing secret — paste GitHub\'s value here after configuring the webhook',
    });

    new CfnOutput(this, 'ScreenshotBucketName', {
      value: githubScreenshot.screenshotBucket.bucket.bucketName,
      description: 'Private S3 bucket hosting preview-deploy screenshots (served via CloudFront)',
    });

    new CfnOutput(this, 'ScreenshotCloudFrontDomain', {
      value: githubScreenshot.screenshotBucket.distribution.domainName,
      description: 'CloudFront domain that serves the screenshot bucket anonymously to GitHub PR / Linear renders',
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
              // largeDataDeliveryS3Config is OPTIONAL and intentionally omitted:
              // it only governs S3 delivery of oversized payloads, which this
              // stack does not use (text logs go to CloudWatch). Sending it with
              // an empty bucketName fails client-side validation
              // ("valid min length: 3") — and because the errors below are
              // swallowed and onUpdate never re-fires (static props), that
              // failure silently leaves model-invocation logging DISABLED, which
              // in turn means Bedrock records no requestMetadata — the input
              // per-task cost attribution depends on.
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
        // Scope the ignore to genuine service-side errors (e.g. a concurrent
        // account-level change). Do NOT use '.*' — that also hides client-side
        // ValidationExceptions like the empty-bucket bug above, turning a
        // deploy-time misconfiguration into silently-absent logging.
        ignoreErrorCodesMatching: 'ThrottlingException|ServiceUnavailableException|InternalServerException',
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
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
        ignoreErrorCodesMatching: 'ThrottlingException|ServiceUnavailableException|InternalServerException',
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
        // PutModelInvocationLoggingConfiguration hands bedrockLoggingRole to the
        // Bedrock service (so Bedrock can write to the log group), which requires
        // the caller to hold iam:PassRole on that role. Scoped to the one role —
        // not a wildcard. (Previously masked by the empty-bucket validation error
        // that ignoreErrorCodesMatching: '.*' swallowed; now that the call
        // actually reaches Bedrock, this is required.)
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLoggingRole.roleArn],
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

    if (registryApi) {
      new CfnOutput(this, 'RegistryApiUrl', {
        value: registryApi.apiUrl,
        description: 'URL of the agent asset registry API (#246) — the CLI targets this for `bgagent registry` commands',
      });
    }

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

/**
 * A churned log-delivery resource to re-pin: the construct child id under the
 * Runtime, the logical id CFN already has deployed, and (for the account-unique
 * Source/Destination kinds) the deployed ``Name``. ``liveName`` is omitted for
 * Delivery links, which have no Name.
 */
interface PinnedLogResource {
  readonly childId: string;
  readonly liveLogicalId: string;
  readonly liveName?: string;
}

/**
 * Log-delivery logical ids to keep stable, keyed by stack name. Consulted on
 * every synth — see {@link pinLogDeliveryLogicalIds} for why there is no flag.
 *
 * Each entry records what CloudFormation already has for a stack deployed before
 * the library renamed these resources. Read from `aws cloudformation
 * list-stack-resources` against the live stack, so the ids are observed, not
 * constructed — the hash in each one is not reproducible from the construct path
 * alone, which is precisely why they have to be written down.
 *
 * An entry stays until its stack is gone. Removing one while the stack still
 * exists re-introduces the rename and the failed update that comes with it.
 */
const PINNED_LOG_DELIVERY_BY_STACK: Record<string, readonly PinnedLogResource[]> = {
  'backgroundagent-dev': [
    {
      childId: 'ApplicationLogsDeliverySource',
      liveLogicalId: 'RuntimeCDKSourceAPPLICATIONLOGSbackgroundagentdevRuntimeBC0AE9ED96A02E02',
      liveName: 'cdk-applicationlogs-source-backgroundagentdevRuntimeBC0AE9ED',
    },
    {
      childId: 'UsageLogsDeliverySource',
      liveLogicalId: 'RuntimeCDKSourceUSAGELOGSbackgroundagentdevRuntimeBC0AE9ED544FBB22',
      liveName: 'cdk-usagelogs-source-backgroundagentdevRuntimeBC0AE9ED',
    },
    {
      childId: 'ApplicationLogsDest',
      liveLogicalId: 'RuntimeCdkLogGroupApplicationLogsDeliverybackgroundagentdevRuntimeBC0AE9EDbackgroundagentdevRuntimeApplicationLogGroup454A95E8DestapplicationlogsE09F77DC',
      liveName: 'cdk-cwl-Destapplication-logs-dest-backgrounp454A95E829BF8A27',
    },
    {
      childId: 'UsageLogsDest',
      liveLogicalId: 'RuntimeCdkLogGroupUsageLogsDeliverybackgroundagentdevRuntimeBC0AE9EDbackgroundagentdevRuntimeUsageLogGroup7FA1FA67Destusagelogs9AB608D0',
      liveName: 'cdk-cwl-Destusage-logs-dest-backgroundagroup7FA1FA67A8A16CEE',
    },
    // Delivery links: logical-id pin only (no Name — unique per source/dest pair).
    {
      childId: 'ApplicationLogsDelivery',
      liveLogicalId: 'RuntimeCdkLogGroupApplicationLogsDeliverybackgroundagentdevRuntimeBC0AE9EDbackgroundagentdevRuntimeApplicationLogGroup454A95E8Delivery92FE492C',
    },
    {
      childId: 'UsageLogsDelivery',
      liveLogicalId: 'RuntimeCdkLogGroupUsageLogsDeliverybackgroundagentdevRuntimeBC0AE9EDbackgroundagentdevRuntimeUsageLogGroup7FA1FA67Delivery40F023D7',
    },
  ],
};

/**
 * Pin the auto-created log-delivery resources to stable logical ids, ALWAYS.
 *
 * These resources are created for us by the AgentCore Runtime and named after
 * whatever construct path the library uses internally, so a library-side rename
 * silently renames them — and a renamed resource is, to CloudFormation, a new
 * one to create before the old is deleted. That is fatal here: a DeliverySource
 * is unique per (resource ARN, log type) account-wide, the runtime ARN is
 * unchanged by a rename, so the create collides with the live source and the
 * update rolls the whole stack back. Owning the ids ourselves decouples us from
 * the library's internal naming.
 *
 * Applied unconditionally rather than behind a flag. Three cases, all safe:
 *
 *  - An existing stack in the account that owns these resources: the ids match
 *    what CloudFormation already recorded, so it updates them in place. This is
 *    the case that was broken.
 *  - A fresh stack or account: nothing owns these names yet, so they create
 *    normally. The ids are ours rather than the library's, which is the point;
 *    the values themselves carry no meaning beyond being stable.
 *  - Any other name: the ids embed the stack name, so each stack gets its own.
 *
 * The values were read off a stack deployed before the rename. Do not "tidy"
 * them — they are a record of what CloudFormation already has, and editing one
 * re-breaks exactly the update path this exists to protect.
 */
function pinLogDeliveryLogicalIds(runtime: agentcore.Runtime): void {
  const stack = Stack.of(runtime);
  const pins = PINNED_LOG_DELIVERY_BY_STACK[stack.stackName];
  // Only the stack these ids were recorded from can use them: they embed that
  // stack's name. Any other stack keeps the library's own naming, which is
  // correct for it — it has no pre-rename resources to line up with.
  if (!pins) return;

  for (const pin of pins) {
    const res = runtime.node.tryFindChild(pin.childId) as CfnResource | undefined;
    // A future library rename moves the child, so the pin stops matching. Skip
    // rather than throw: the stack still deploys, and the next update that hits
    // the collision is the signal to re-record the ids from the live stack.
    if (!res) continue;
    res.overrideLogicalId(pin.liveLogicalId);
    if (pin.liveName !== undefined) res.addPropertyOverride('Name', pin.liveName);
  }
}
