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

import { createHash } from 'node:crypto';
import * as path from 'path';
import * as bedrock from '@aws-cdk/aws-bedrock-alpha';
import { ArnFormat, AspectPriority, Aspects, Stack, StackProps, NestedStack, RemovalPolicy, CfnOutput, CfnResource, Duration, Fn, Lazy } from 'aws-cdk-lib';
import { CfnGuardrail, CfnGuardrailVersion } from 'aws-cdk-lib/aws-bedrock';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions, type NagPackSuppression } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';
import { BlueprintDefinition, blueprintEgressDomains, resolveBlueprintDefinitions } from '../blueprints/definitions';
import { AdmissionQueuePickup } from '../constructs/admission-queue-pickup';
import { AgentMemory } from '../constructs/agent-memory';
import { AgentSessionRole } from '../constructs/agent-session-role';
import { AgentNetwork, AgentVpc } from '../constructs/agent-vpc';
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
import { BudgetAlerts } from '../constructs/budget-alerts';
import { BudgetTable } from '../constructs/budget-table';
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
  createMicrovmExecutionRole,
  isLambdaMicrovmImageConfigured,
  type LambdaMicrovmImageInputs,
  LambdaMicrovmStack,
} from '../constructs/lambda-microvm-compute';
import { LinearIdentityVault } from '../constructs/linear-identity-vault';
import { LinearIntegration } from '../constructs/linear-integration';
import { LinearVaultConsentPageStack } from '../constructs/linear-vault-consent-page';
import { OperationalAlerts } from '../constructs/operational-alerts';
import { OrchestrationReconciler } from '../constructs/orchestration-reconciler';
import { OrchestrationTable } from '../constructs/orchestration-table';
import { PendingUploadCleanup } from '../constructs/pending-upload-cleanup';
import { PrOutcomeSweep } from '../constructs/pr-outcome-sweep';
import { AgentRegistryStack } from '../constructs/registry';
import { RegistryApi } from '../constructs/registry-api';
import { RepoTable } from '../constructs/repo-table';
import { SlackIntegration } from '../constructs/slack-integration';
import { buildAppId } from '../constructs/solution-ua-aspect';
import { StrandedOrchestrationReconciler } from '../constructs/stranded-orchestration-reconciler';
import { StrandedTaskReconciler } from '../constructs/stranded-task-reconciler';
import { LargeBodyWebhookPath, TaskApi } from '../constructs/task-api';
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
import { assertCapabilitiesAvailable } from '../deployment/capabilities';
import { channelOauthSecretPatterns, DeploymentFeatures, enabledFeatures, resolveDeploymentFeatures } from '../deployment/features';
import { resolveComputeBackends } from '../handlers/shared/compute-backend';
import { WEBHOOK_METRIC_NAMESPACE, WEBHOOK_SCREENING_FAILED_METRIC } from '../handlers/shared/webhook-screening-metric';

const GUARDRAIL_NAME_MAX_LENGTH = 50;

const GUARDRAIL_VERSION_HASH_LENGTH = 16;

/**
 * Publishes a version of the guardrail and returns its number.
 *
 * The construct id ends in a hash of the guardrail's CloudFormation properties (tags
 * excluded) and of the description, so a deploy publishes a version when the guardrail
 * changed and only then. `createVersion()` of the alpha library names the version after
 * an unresolved token, whose text differs from one synthesis to the next
 * (aws/aws-cdk#38674). Bedrock has a quota of versions per guardrail, which a version
 * per deploy uses up (#1079).
 *
 * Call this once the guardrail is fully configured: the properties are rendered here,
 * and the synthesis fails when they are no longer what they were at this call.
 */
export function publishGuardrailVersion(guardrail: bedrock.Guardrail, description: string): string {
  const resource = guardrail.node.children.find(child => child instanceof CfnGuardrail)!;
  const configuration = (): string => {
    const rendered: { Resources: Record<string, { Properties: Record<string, unknown> }> }
      = Stack.of(guardrail).resolve(resource._toCloudFormation());
    const { Tags: _tags, ...properties } = Object.values(rendered.Resources)[0].Properties;
    return JSON.stringify([properties, description]);
  };
  // The alpha construct renders these members through cached `Lazy.any` values, which keep
  // their first non-empty rendering: a later change of a member never reaches the template.
  const sources = (): string => JSON.stringify([
    guardrail.contentFilters, guardrail.deniedTopics, guardrail.piiFilters, guardrail.regexFilters, guardrail.wordFilters,
    guardrail.managedWordListFilters, guardrail.contextualGroundingFilters,
    guardrail.contentFiltersTierConfig, guardrail.topicsTierConfig, guardrail.crossRegionConfig,
  ]);
  const published = configuration();
  const publishedSources = sources();
  const hash = createHash('sha256').update(published).digest('hex');
  const version = new CfnGuardrailVersion(guardrail, `Version${hash.slice(0, GUARDRAIL_VERSION_HASH_LENGTH)}`, {
    guardrailIdentifier: guardrail.guardrailId,
    description,
  });
  guardrail.node.addValidation({
    validate: () => configuration() === published && sources() === publishedSources ? [] : [
      'The guardrail does not have the properties its version was named after: it was changed after '
      + 'publishGuardrailVersion(), or one of its properties takes a value from another stack.',
    ],
  });
  version.applyRemovalPolicy(RemovalPolicy.RETAIN);
  return version.attrVersion;
}

/** The AgentCore maximum for a runtime session's idle timeout and for its lifetime. */
const RUNTIME_SESSION_TIMEOUT_HOURS = 8;

const API_URL_STAGE_SEGMENT_INDEX = 3;

const LINEAR_VAULT_WORKLOAD_PREFIX = 'abca_linear_oauth';

const WORKLOAD_NAME_MAX_LENGTH = 64;

/**
 * AgentCore workload identity names are unique per account and Region, and a Token Vault
 * consent is bound to (workload identity, user id): a renamed identity loses every consent.
 */
function linearVaultWorkloadName(stack: Stack): string {
  const override = stack.node.tryGetContext('linearVaultWorkloadName');
  if (typeof override === 'string' && override.trim()) return override.trim();
  const suffix = stack.stackName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const room = WORKLOAD_NAME_MAX_LENGTH - LINEAR_VAULT_WORKLOAD_PREFIX.length - 1;
  return suffix
    ? `${LINEAR_VAULT_WORKLOAD_PREFIX}_${suffix.slice(0, room)}`
    : LINEAR_VAULT_WORKLOAD_PREFIX;
}

const WEBHOOK_SCREENING_ALARM_PERIOD_MINUTES = 5;

function webhookScreeningAlarms(scope: Construct, trackerDeployed: boolean): cloudwatch.Alarm[] {
  if (!trackerDeployed) return [];
  return [new cloudwatch.Alarm(scope, 'WebhookScreeningFailedAlarm', {
    metric: new cloudwatch.Metric({
      namespace: WEBHOOK_METRIC_NAMESPACE,
      metricName: WEBHOOK_SCREENING_FAILED_METRIC,
      statistic: 'Sum',
      period: Duration.minutes(WEBHOOK_SCREENING_ALARM_PERIOD_MINUTES),
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription:
      'Guardrail screening of Jira or Linear comments, Linear project documents or the session context of a '
      + 'Linear agent session failed, so that content was dropped. '
      + 'A task created from the event runs without it. '
      + 'Search the Jira and Linear webhook processor logs for "screening unavailable" (#794).',
  })];
}

export interface AgentStackProps extends StackProps {
  /**
   * Availability-zone *names* to pin the AgentCore VPC (and therefore the
   * Runtime ENIs) into, so they land only in AgentCore-supported zones.
   * Leave `undefined` to keep CDK's default `maxAzs` selection.
   */
  readonly agentCoreAvailabilityZones?: string[];
  /** Network owned by a separate stack. Omit to preserve the inline topology. */
  readonly network?: AgentNetwork;
  /** Shared plain configuration, resolved before network/application construction. */
  readonly blueprints?: readonly BlueprintDefinition[];
  /**
   * Optional modules to synthesize (ADR-024). Omitted, only context switches
   * apply over the legacy topology.
   */
  readonly features?: DeploymentFeatures;
}

const NUDGE_RATE_LIMIT_PER_MINUTE = 10;

/** `--context enableLinearAgentSessions=true` arrives as a string from the CLI, a boolean from cdk.json. */
function isLinearAgentSessionsContextOn(value: unknown): boolean {
  return value === true || value === 'true';
}

type LinearAgentSessionsProps = NonNullable<ConstructorParameters<typeof LinearIntegration>[2]['agentSessions']>;
type LinearStopComputeKey = keyof NonNullable<LinearAgentSessionsProps['stopCompute']>;

function linearAgentSessionsProps(
  enabled: boolean,
  nudgesTable: LinearAgentSessionsProps['nudgesTable'],
  backends: ReadonlyArray<readonly [deployed: boolean, key: LinearStopComputeKey, arn: string]>,
): LinearAgentSessionsProps | undefined {
  if (!enabled) return undefined;
  return {
    nudgesTable,
    nudgeRateLimitPerMinute: NUDGE_RATE_LIMIT_PER_MINUTE,
    stopCompute: Object.fromEntries(backends.filter(([deployed]) => deployed).map(([, key, arn]) => [key, arn])),
  };
}

export class AgentStack extends Stack {
  /** The REST API and its Cognito user pool; the operator console stack signs users in against these. */
  public readonly taskApi: TaskApi;
  /** Onboarded repositories; the console's issue picker serves only these. */
  public readonly repoTable: RepoTable;
  /** Platform GitHub token, read server-side by the console's issue picker. */
  public readonly githubTokenSecret: secretsmanager.ISecret;
  /** Linear tables and webhook wiring; the console lists and starts Linear issues through them. */
  /** Undefined when the deployment profile omits Linear (ADR-024). */
  public readonly linearIntegration?: LinearIntegration;
  /** The task table (its Linear-issue index tells the console which issues already have a task). */
  public readonly taskTable: TaskTable;
  /** Set when deployed with the Linear identity vault; the console then mints tokens through it. */
  public readonly linearIdentityVault?: LinearIdentityVault;

  // eslint-disable-next-line complexity -- predates the ceiling (120; 108 when it landed); must not grow
  constructor(scope: Construct, id: string, props: AgentStackProps = {}) {
    super(scope, id, props);

    const features = props.features ?? resolveDeploymentFeatures(this.node);
    assertCapabilitiesAvailable(features, this.region);
    const issueOrchestrationEnabled = features.linear || features.jira;

    const repoRoot = path.join(__dirname, '..', '..', '..');

    const computeTypes = resolveComputeBackends(
      this.node.tryGetContext('compute_types'), this.node.tryGetContext('compute_type'));
    const agentCoreEnabled = computeTypes.includes('agentcore');
    const ecsEnabled = computeTypes.includes('ecs');
    const lambdaMicrovmEnabled = computeTypes.includes('lambda-microvm');

    const taskTable = this.taskTable = new TaskTable(this, 'TaskTable');
    const taskEventsTable = new TaskEventsTable(this, 'TaskEventsTable');
    const taskNudgesTable = new TaskNudgesTable(this, 'TaskNudgesTable');
    const orchestrationTable = new OrchestrationTable(this, 'OrchestrationTable');
    // DynamoDB rejects an in-place change of a GSI's `nonKeyAttributes`: a changed projection
    // needs a new construct id, which replaces the table.
    const taskApprovalsTable = new TaskApprovalsTable(this, 'TaskApprovalsTableV2');
    const userConcurrencyTable = new UserConcurrencyTable(this, 'UserConcurrencyTable');
    const budgetTable = new BudgetTable(this, 'BudgetTable');
    const budgetAlerts = new BudgetAlerts(this, 'BudgetAlerts');
    const webhookTable = new WebhookTable(this, 'WebhookTable');
    const apiKeyTable = new ApiKeyTable(this, 'ApiKeyTable');
    const repoTable = this.repoTable = new RepoTable(this, 'RepoTable');

    const agentRegistry = features.agentRegistry
      ? new AgentRegistryStack(this, 'AgentRegistryStack', {
        registryName: `abca_${this.stackName.replace(/[^a-zA-Z0-9]/g, '_')}`,
        description: 'ABCA agent asset registry (#246)',
      })
      : undefined;

    const cedarWasmLayer = new CedarWasmLayer(this, 'CedarWasmLayer');

    const traceArtifactsBucket = new TraceArtifactsBucket(this, 'TraceArtifactsBucket');

    const attachmentsBucket = new AttachmentsBucket(this, 'AttachmentsBucket');

    NagSuppressions.addResourceSuppressions(attachmentsBucket.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Task attachments: writes from create-task and orchestrator Lambdas only; reads by agent via IAM role. 90-day lifecycle; versioning + screening prevent TOCTOU. Access logging not justified for this use case.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(traceArtifactsBucket.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Debug-only artifacts (design §10.1) with 7-day TTL; uploads confined to the per-task SessionRole, tag-scoped to its own user and task prefixes; reads only via short-lived presigned URLs from an authn\'d handler. Object-level audit intentionally omitted — cost/complexity of CloudTrail data events or a log bucket is not justified for opt-in --trace usage.',
      },
    ]);

    const blueprintDefinitions = props.blueprints ?? resolveBlueprintDefinitions(this.node);
    for (const { id: blueprintId, ...definition } of blueprintDefinitions) {
      new Blueprint(this, blueprintId, { ...definition, repoTable: repoTable.table });
    }

    const githubTokenSecret = new secretsmanager.Secret(this, 'GitHubTokenSecret', {
      description: 'GitHub personal access token for the background agent',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.githubTokenSecret = githubTokenSecret;

    NagSuppressions.addResourceSuppressions(githubTokenSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'GitHub PAT is managed externally — automatic rotation is not applicable',
      },
    ]);

    const microvmNestedContext = this.node.tryGetContext('microvm_nested_stack');
    if (microvmNestedContext !== undefined && ![true, false, 'true', 'false'].includes(microvmNestedContext)) {
      throw new Error('microvm_nested_stack must be true or false');
    }
    const microvmNested = microvmNestedContext !== false && microvmNestedContext !== 'false';
    if (lambdaMicrovmEnabled && microvmNestedContext === undefined) {
      throw new Error(
        'microvm_nested_stack must be explicitly selected: use --context microvm_nested_stack=true '
        + 'for new or already-nested deployments, or --context microvm_nested_stack=false for existing flat deployments. '
        + 'Changing an existing flat deployment to nested can erase artifacts and pending payloads; '
        + 'setting true does not perform a migration. See docs/verification/645-p3-nested-stack.md.',
      );
    }
    const microvmResourceNamePrefix = this.node.tryGetContext('microvm_resource_name_prefix');
    if (microvmResourceNamePrefix !== undefined) {
      if (typeof microvmResourceNamePrefix !== 'string') {
        throw new Error('microvm_resource_name_prefix must be a string');
      }
      if (!microvmNested) {
        throw new Error('microvm_resource_name_prefix cannot be used with microvm_nested_stack=false');
      }
    }
    const suspendContext = this.node.tryGetContext('microvm_approval_suspend_enabled');
    if (suspendContext !== undefined && ![true, false, 'true', 'false'].includes(suspendContext)) {
      throw new Error('microvm_approval_suspend_enabled must be true or false');
    }
    const microvmApprovalSuspendEnabled = suspendContext === true || suspendContext === 'true';

    const toolGatewayEnabled = features.toolGateway;

    const linearIdentityVaultEnabled = this.node.tryGetContext('enableLinearIdentityVault') === true
      || this.node.tryGetContext('enableLinearIdentityVault') === 'true';
    if (linearIdentityVaultEnabled && !features.linear) {
      throw new Error('enableLinearIdentityVault requires the linear feature; enable Linear or drop the vault switch');
    }
    const linearVaultWorkload = linearVaultWorkloadName(this);

    const linearAgentSessionsEnabled = isLinearAgentSessionsContextOn(this.node.tryGetContext('enableLinearAgentSessions'));

    const microvmImageInputs: LambdaMicrovmImageInputs = {
      baseImageArn: this.node.tryGetContext('microvm_base_image_arn'),
      baseImageVersion: this.node.tryGetContext('microvm_base_image_version'),
      artifactSha256: this.node.tryGetContext('microvm_artifact_sha256'),
      managedImageVersion: this.node.tryGetContext('microvm_managed_image_version'),
      externalImageIdentifier: this.node.tryGetContext('microvm_image_identifier'),
      externalImageVersion: this.node.tryGetContext('microvm_image_version'),
    };
    const microvmImageConfigured = lambdaMicrovmEnabled
      && isLambdaMicrovmImageConfigured(microvmImageInputs);

    let microvmImageArnHolder: string | undefined;
    const lazyMicrovmImageArn = Lazy.string({
      produce: () => {
        if (!microvmImageArnHolder) {
          throw new Error('MicroVM image ARN was accessed before LambdaMicrovmCompute was created');
        }
        return microvmImageArnHolder;
      },
    });

    const agentVpc = props.network ?? new AgentVpc(this, 'AgentVpc', {
      ...(props.agentCoreAvailabilityZones?.length
        ? { availabilityZones: props.agentCoreAvailabilityZones }
        : {}),
    });

    if (!props.network) {
      new DnsFirewall(this, 'DnsFirewall', {
        vpc: agentVpc.vpc,
        additionalAllowedDomains: blueprintEgressDomains(blueprintDefinitions),
        observationMode: true,
      });
    }

    const agentMemory = new AgentMemory(this, 'AgentMemory');

    const inputGuardrail = new bedrock.Guardrail(this, 'InputGuardrail', {
      guardrailName: `task-input-guardrail-${this.stackName}`.slice(0, GUARDRAIL_NAME_MAX_LENGTH),
      description: 'Screens task submissions for prompt injection attacks',
      contentFilters: [
        {
          type: bedrock.ContentFilterType.PROMPT_ATTACK,
          // Bedrock blocks detections of MEDIUM and HIGH confidence at MEDIUM, and of LOW too at HIGH.
          // Observed: at HIGH, ordinary imperative task descriptions and PR bodies are blocked.
          inputStrength: bedrock.ContentFilterStrength.MEDIUM,
          outputStrength: bedrock.ContentFilterStrength.NONE,
        },
      ],
    });

    // `inputGuardrail.guardrailVersion` of the alpha library is the working draft.
    const inputGuardrailVersion = publishGuardrailVersion(inputGuardrail, 'Initial version');

    let orchestratorArnHolder: string | undefined;
    const lazyOrchestratorArn = Lazy.string({
      produce: () => {
        if (!orchestratorArnHolder) {
          throw new Error('Orchestrator ARN was accessed before the TaskOrchestrator was created');
        }
        return orchestratorArnHolder;
      },
    });

    let runtimeArnHolder: string | undefined;
    const lazyRuntimeArn = Lazy.string({
      produce: () => {
        if (!runtimeArnHolder) {
          throw new Error('Runtime ARN was accessed before Runtime was created');
        }
        return runtimeArnHolder;
      },
    });

    let sessionRoleArnHolder: string | undefined;
    const lazySessionRoleArn = Lazy.string({
      produce: () => {
        if (!sessionRoleArnHolder) {
          throw new Error('SessionRole ARN was accessed before AgentSessionRole was created');
        }
        return sessionRoleArnHolder;
      },
    });

    let ecsClusterArnHolder: string | undefined;
    const lazyEcsClusterArn = Lazy.string({
      produce: () => {
        if (!ecsClusterArnHolder) throw new Error('ECS cluster ARN was accessed before compute was created');
        return ecsClusterArnHolder;
      },
    });

    const maxConcurrentTasksPerUser = 10;

    const taskApi = this.taskApi = new TaskApi(this, 'TaskApi', {
      nudgeRateLimitPerMinute: NUDGE_RATE_LIMIT_PER_MINUTE,
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
      guardrailVersion: inputGuardrailVersion,
      ...(agentCoreEnabled && { agentCoreStopSessionRuntimeArn: lazyRuntimeArn }),
      ...(ecsEnabled && { ecsClusterArn: lazyEcsClusterArn }),
      traceArtifactsBucket: traceArtifactsBucket.bucket,
      attachmentsBucket: attachmentsBucket.bucket,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser,
      budgetTable: budgetTable.table,
      ...(microvmImageConfigured && { lambdaMicrovmImageArn: lazyMicrovmImageArn }),
      largeBodyWebhookPaths: ([
        features.linear && '/v1/linear/webhook',
        features.jira && '/v1/jira/webhook',
        features.deployPreviewScreenshots && '/v1/github/webhook',
      ] as const).filter((webhookPath): webhookPath is LargeBodyWebhookPath => webhookPath !== false),
    });

    const registryApi = agentRegistry
      ? new RegistryApi(this, 'RegistryApi', {
        agentRegistryId: agentRegistry.registryId,
        userPool: taskApi.userPool,
      })
      : undefined;

    const toolGateway = toolGatewayEnabled
      ? new ToolGateway(this, 'ToolGateway', { repoTable: repoTable.table })
      : undefined;

    const sdkUaAppId = buildAppId(
      this.stackName,
      this.node.tryGetContext('sdkUaAppId') as string | undefined,
    );

    const bedrockGeoRegion = resolveBedrockGeoRegion(this.node);

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

    let runtime: agentcore.Runtime | undefined;
    let agentLogGroup: logs.ILogGroup | undefined;
    if (agentCoreEnabled) {
      const artifact = agentcore.AgentRuntimeArtifact.fromAsset(repoRoot, { file: 'agent/Dockerfile' });
      const runtimeEnvironmentVariables = {
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_LOG: 'debug',
        // Bedrock rejects an on-demand call that names a Claude 4.x model by its bare id
        // (400 "on-demand throughput isn't supported"): it takes an inference-profile id.
        ANTHROPIC_MODEL: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_MODEL_ID),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_AUX_MODEL_ID),
        TASK_TABLE_NAME: taskTable.table.tableName,
        TASK_EVENTS_TABLE_NAME: taskEventsTable.table.tableName,
        NUDGES_TABLE_NAME: taskNudgesTable.table.tableName,
        TASK_APPROVALS_TABLE_NAME: taskApprovalsTable.table.tableName,
        AGENTCORE_MAX_LIFETIME_S: '28800',
        USER_CONCURRENCY_TABLE_NAME: userConcurrencyTable.table.tableName,
        AGENT_SESSION_ROLE_ARN: lazySessionRoleArn,
        TRACE_ARTIFACTS_BUCKET_NAME: traceArtifactsBucket.bucket.bucketName,
        ARTIFACTS_BUCKET_NAME: traceArtifactsBucket.bucket.bucketName,
        LOG_GROUP_NAME: applicationLogGroup.logGroupName,
        MEMORY_ID: agentMemory.memory.memoryId,
        MAX_TURNS: '100',
        // The AgentCore session-storage mount at /mnt/workspace does not support flock(),
        // which mise and uv call on their data and cache directories.
        MISE_DATA_DIR: '/tmp/mise-data',
        UV_CACHE_DIR: '/tmp/uv-cache',
        CLAUDE_CONFIG_DIR: '/mnt/workspace/.claude-config',
        npm_config_cache: '/mnt/workspace/.npm-cache',
        ...(sdkUaAppId ? { AWS_SDK_UA_APP_ID: sdkUaAppId } : {}),
        ...(toolGateway ? { ABCA_TOOL_GATEWAY_URL: toolGateway.gatewayUrl } : {}),
        ...(linearIdentityVaultEnabled
          ? { LINEAR_VAULT_ENABLED: 'true', LINEAR_WORKLOAD_IDENTITY_NAME: linearVaultWorkload }
          : {}),
      };

      const runtimeNetworkConfig = agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
        vpc: agentVpc.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [agentVpc.runtimeSecurityGroup],
      });

      const lifecycleConfiguration: agentcore.LifecycleConfiguration = {
        idleRuntimeSessionTimeout: Duration.hours(RUNTIME_SESSION_TIMEOUT_HOURS),
        maxLifetime: Duration.hours(RUNTIME_SESSION_TIMEOUT_HOURS),
      };

      runtime = new agentcore.Runtime(this, 'Runtime', {
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
      agentLogGroup = applicationLogGroup;

      // The L2 construct does not expose filesystemConfigurations.
      const cfnRuntime = runtime.node.defaultChild as CfnResource;
      cfnRuntime.addPropertyOverride('FilesystemConfigurations', [
        {
          SessionStorage: {
            MountPath: '/mnt/workspace',
          },
        },
      ]);

      userConcurrencyTable.table.grantReadWriteData(runtime);
      githubTokenSecret.grantRead(runtime);
      applicationLogGroup.grantWrite(runtime);
      agentMemory.grantReadWrite(runtime);

      toolGateway?.grantInvoke(runtime);
    }

    const invokableBedrockModels: bedrock.IBedrockInvokable[] = [];
    const grantedModelIds = resolveBedrockModelIds(this.node);

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
      if (runtime) {
        foundationModel.grantInvoke(runtime);
        crossRegionProfile.grantInvoke(runtime);
      }
      invokableBedrockModels.push(foundationModel, crossRegionProfile);
    }

    const agentSessionRole = new AgentSessionRole(this, 'AgentSessionRole', {
      ...(runtime ? { assumingRoles: [runtime.role] } : { deferComputeRoleBinding: true }),
      taskScopedTables: [
        taskTable.table,
        taskEventsTable.table,
        taskApprovalsTable.table,
        taskNudgesTable.table,
      ],
      traceArtifactsBucket: traceArtifactsBucket.bucket,
      attachmentsBucket: attachmentsBucket.bucket,
      invokableModels: invokableBedrockModels,
    });
    sessionRoleArnHolder = agentSessionRole.role.roleArn;

    if (runtime) {
      NagSuppressions.addResourceSuppressions(runtime, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'AgentCore runtime requires wildcard permissions for CloudWatch Logs, Bedrock model invocation, and cross-region inference profiles — generated by CDK L2 construct grants',
        },
      ], true);
    }

    // CDK moves the excess of a large role policy into OverflowPolicy<N> constructs at
    // synthesis, after constructor-time suppressions have visited the role's children.
    const OVERFLOW_SUPPRESSIONS: readonly {
      readonly pathFragment: string;
      readonly reason: string;
      readonly appliesTo?: NagPackSuppression['appliesTo'];
    }[] = [
      {
        pathFragment: '/Runtime/ExecutionRole/OverflowPolicy',
        reason:
          'CDK-generated overflow policy on the runtime ExecutionRole inherits the same wildcard Bedrock / CloudWatch actions suppressed on the base policy. Auto-split triggers when the role exceeds the inline-policy size limit; suppression applies to all overflow policies via an Aspect so future splits are covered.',
      },
      {
        pathFragment: '/LinearIntegration/WebhookProcessorFn/ServiceRole/OverflowPolicy',
        reason:
          'CDK-generated overflow policy on the Linear webhook processor role carries the kms:GenerateDataKey* that SNS Topic.grantPublish emits for the CMK-encrypted operational-alerts topic. Scoped to that single topic key; the wildcard only spans the GenerateDataKey/GenerateDataKeyWithoutPlaintext pair.',
      },
      {
        pathFragment: '/TaskOrchestrator/OrchestratorFn/ServiceRole/OverflowPolicy',
        reason:
          'Channel setup creates workspace-specific OAuth secrets and Linear vault providers after deployment. These grants retain the configured account and Region and match only the Linear/Jira secret prefixes and Linear vault provider/client-secret prefixes. Wide backend selections can also spill the MicroVM lifecycle grant, which is scoped to the single platform image ARN plus its <arn>:* version suffix.',
        appliesTo: [{
          regex: '/^Resource::<[A-Za-z0-9]+\\.ImageArn>:\\*$/',
        }, {
          regex: '/^Resource::arn:.*:secretsmanager:.*:secret:bgagent-jira-oauth-\\*$/',
        }, {
          regex: '/^Resource::arn:.*:secretsmanager:.*:secret:bgagent-linear-oauth-\\*$/',
        }, {
          regex: '/^Resource::arn:.*:bedrock-agentcore:.*:token-vault/default/oauth2credentialprovider/bgagent-linear-oauth-\\*$/',
        }, {
          regex: '/^Resource::arn:.*:secretsmanager:.*:secret:bedrock-agentcore-identity!default/oauth2/bgagent-linear-oauth-\\*$/',
        }],
      },
      {
        pathFragment: '/OrchestrationReconciler/ReconcilerFn/ServiceRole/OverflowPolicy',
        reason:
          'The reconciler mints Linear feedback tokens for workspace providers created during channel setup. The grant matches only Linear vault provider/client-secret prefixes in this account and Region.',
        appliesTo: [{
          regex: '/^Resource::arn:.*:bedrock-agentcore:.*:token-vault/default/oauth2credentialprovider/bgagent-linear-oauth-\\*$/',
        }, {
          regex: '/^Resource::arn:.*:secretsmanager:.*:secret:bedrock-agentcore-identity!default/oauth2/bgagent-linear-oauth-\\*$/',
        }],
      },
    ];
    const overflowSuppressionAspect = {
      visit(node: IConstruct) {
        const nodePath = node.node.path;
        if (!nodePath.endsWith('/Resource')) return;
        for (const { pathFragment, reason, appliesTo } of OVERFLOW_SUPPRESSIONS) {
          if (nodePath.includes(pathFragment)) {
            NagSuppressions.addResourceSuppressions(node, [{ id: 'AwsSolutions-IAM5', reason, appliesTo }]);
            return;
          }
        }
      },
    };
    // CDK applies aspects in order of priority: MUTATING comes before the default priority
    // of the cdk-nag checks, which would otherwise inspect the policy before its suppression.
    Aspects.of(this).add(overflowSuppressionAspect, { priority: AspectPriority.MUTATING });

    if (runtime) {
      new CfnOutput(this, 'RuntimeArn', {
        value: runtime.agentRuntimeArn,
        description: 'ARN of the AgentCore runtime',
      });
    }

    new CfnOutput(this, 'TaskTableName', {
      value: taskTable.table.tableName,
      description: 'Name of the DynamoDB task state table',
    });

    new CfnOutput(this, 'TaskEventsTableName', {
      value: taskEventsTable.table.tableName,
      description: 'Name of the DynamoDB task events audit table',
    });

    new CfnOutput(this, 'BudgetTableName', {
      value: budgetTable.table.tableName,
      description: 'Name of the monthly user/team budget configuration and spend table',
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

    const ecsPayloadBucket = ecsEnabled
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
    const ecsTaskSizing = resolveEcsTaskSizing(this.node);

    let linearIdentityVault: LinearIdentityVault | undefined;
    let linearVaultConsentPage: LinearVaultConsentPageStack | undefined;
    if (linearIdentityVaultEnabled) {
      const hostedReturnUrlOverride = this.node.tryGetContext('linearVaultHostedReturnUrl') as string | undefined;
      if (!hostedReturnUrlOverride) {
        linearVaultConsentPage = new LinearVaultConsentPageStack(this, 'LinearVaultConsentPageStack');
      }
      const hostedReturnUrl = hostedReturnUrlOverride ?? linearVaultConsentPage?.consentUrl;

      linearIdentityVault = this.linearIdentityVault = new LinearIdentityVault(this, 'LinearIdentityVault', {
        workloadName: linearVaultWorkload,
        allowedReturnUrls: [
          'http://localhost:8080/oauth/callback',
          ...(hostedReturnUrl ? [hostedReturnUrl] : []),
        ],
      });

      new CfnOutput(this, 'LinearVaultWorkloadName', {
        value: linearVaultWorkload,
        description: 'AgentCore workload identity backing the Linear token vault — read by `bgagent linear setup`',
      });

      if (hostedReturnUrl) {
        new CfnOutput(this, 'LinearVaultConsentUrl', {
          value: hostedReturnUrl,
          description: 'Hosted Linear vault consent landing page — used by `bgagent linear setup`',
        });
      }
    }

    const ecsCluster = ecsEnabled
      ? new EcsAgentCluster(this, 'EcsAgentCluster', {
        ...(ecsTaskSizing !== undefined && { taskSizing: ecsTaskSizing }),
        ...(linearIdentityVault && { linearIdentityVault }),
        channelOauthSecretPatterns: channelOauthSecretPatterns(features),
        vpc: agentVpc.vpc,
        agentImageAsset: new ecr_assets.DockerImageAsset(this, 'AgentImage', {
          directory: repoRoot,
          file: 'agent/Dockerfile',
          platform: ecr_assets.Platform.LINUX_ARM64,
        }),
        taskTable: taskTable.table,
        taskEventsTable: taskEventsTable.table,
        taskApprovalsTable: taskApprovalsTable.table,
        userConcurrencyTable: userConcurrencyTable.table,
        taskNudgesTable: taskNudgesTable.table,
        githubTokenSecret,
        memoryId: agentMemory.memory.memoryId,
        agentMemory,
        payloadBucket: ecsPayloadBucket!.bucket,
        artifactsBucket: traceArtifactsBucket.bucket,
        agentSessionRole,
        toolGateway,
      })
      : undefined;

    const microvmProps = {
      vpc: agentVpc.vpc,
      channelOauthSecretPatterns: channelOauthSecretPatterns(features),
      agentSessionRole,
      githubTokenSecret,
      agentMemory,
      ...microvmImageInputs,
    };
    let lambdaMicrovm: LambdaMicrovmCompute | undefined;
    if (lambdaMicrovmEnabled) {
      if (microvmNested) {
        const roleScope = new Construct(this, 'LambdaMicrovmCompute');
        const executionRole = createMicrovmExecutionRole(roleScope, 'ExecutionRole');
        lambdaMicrovm = new LambdaMicrovmStack(this, 'Microvm', {
          ...microvmProps,
          deploymentName: this.stackName,
          resourceNamePrefix: microvmResourceNamePrefix,
          executionRole,
        }).compute;
      } else {
        lambdaMicrovm = new LambdaMicrovmCompute(this, 'LambdaMicrovmCompute', microvmProps);
      }
    }

    microvmImageArnHolder = lambdaMicrovm?.imageArn;

    const computeRoles = [runtime?.role, ecsCluster?.taskDefinition.taskRole, lambdaMicrovm?.executionRole]
      .filter((role): role is iam.IRole => role !== undefined);
    const selectedComputeRole = computeRoles[0];
    ecsClusterArnHolder = ecsCluster?.cluster.clusterArn;
    agentLogGroup ??= ecsCluster?.logGroup ?? lambdaMicrovm?.logGroup;
    if (!selectedComputeRole || !agentLogGroup) throw new Error('Selected compute backend did not provide its role and logs');
    if (lambdaMicrovm) {
      agentLogGroup.grantWrite(lambdaMicrovm.executionRole);
      toolGateway?.grantInvoke(lambdaMicrovm.executionRole);
    }

    new CfnOutput(this, 'ComputeSubstrate', {
      value: computeTypes.join(','),
      description: 'Deployed compute backends; with ComputeDeploymentMode=exclusive, the only one.',
    });
    new CfnOutput(this, 'ComputeTypes', {
      value: computeTypes.join(','),
      description: 'Every deployed compute backend in order; the first is the repository default.',
    });
    new CfnOutput(this, 'ComputeDeploymentMode', {
      value: computeTypes.length === 1 ? 'exclusive' : 'additive',
      description: 'exclusive: ComputeSubstrate is the only deployed backend. additive: see ComputeTypes.',
    });

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
      new CfnOutput(this, 'MicrovmArtifactBucketName', {
        value: lambdaMicrovm.artifactBucket.bucketName,
        description: 'S3 bucket the Lambda MicroVMs zip+Dockerfile artifact is uploaded to (ADR-021)',
      });
      new CfnOutput(this, 'MicrovmArtifactObjectKey', {
        value: lambdaMicrovm.artifactObjectKey,
        description: 'S3 key the Lambda MicroVMs artifact must be uploaded to (matches the build role\'s s3:GetObject scope)',
      });
      new CfnOutput(this, 'MicrovmArtifactBaseObjectKey', {
        value: lambdaMicrovm.artifactBaseObjectKey,
        description: 'Base artifact key; managed packaging adds the ZIP SHA-256, manual builds use this key',
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

    const orchestrator = new TaskOrchestrator(this, 'TaskOrchestrator', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser,
      repoTable: repoTable.table,
      deployedComputeTypes: computeTypes,
      runtimeArn: runtime?.agentRuntimeArn,
      githubTokenSecretArn: githubTokenSecret.secretArn,
      memoryId: agentMemory.memory.memoryId,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrailVersion,
      attachmentsBucket: attachmentsBucket.bucket,
      ...(agentRegistry && { agentRegistryId: agentRegistry.registryId }),
      agentPlatformConfig: {
        taskApprovalsTableName: taskApprovalsTable.table.tableName,
        nudgesTableName: taskNudgesTable.table.tableName,
        logGroupName: agentLogGroup.logGroupName,
        artifactsBucketName: traceArtifactsBucket.bucket.bucketName,
        traceArtifactsBucketName: traceArtifactsBucket.bucket.bucketName,
        agentSessionRoleArn: agentSessionRole.role.roleArn,
        anthropicDefaultHaikuModel: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_AUX_MODEL_ID),
        anthropicModel: inferenceProfileId(bedrockGeoRegion, PLATFORM_DEFAULT_MODEL_ID),
        ...(toolGateway && { toolGatewayUrl: toolGateway.gatewayUrl }),
      },
      ...(ecsCluster && {
        ecsConfig: {
          clusterArn: ecsCluster.cluster.clusterArn,
          taskDefinitionArn: ecsCluster.taskDefinition.taskDefinitionArn,
          planningTaskDefinitionArn: ecsCluster.planningTaskDefinition.taskDefinitionArn,
          subnets: agentVpc.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
          securityGroup: ecsCluster.securityGroup.securityGroupId,
          containerName: ecsCluster.containerName,
          taskRoleArn: ecsCluster.taskRoleArn,
          executionRoleArn: ecsCluster.executionRoleArn,
        },
      }),
      ...(ecsPayloadBucket && { ecsPayloadBucket: ecsPayloadBucket.bucket }),
      ...(lambdaMicrovm?.imageIdentifier && lambdaMicrovm.imageArn && {
        microvmConfig: {
          imageIdentifier: lambdaMicrovm.imageIdentifier,
          imageArn: lambdaMicrovm.imageArn,
          imageVersion: lambdaMicrovm.imageVersion,
          approvalsTable: taskApprovalsTable.table,
          approvalSuspendEnabled: microvmApprovalSuspendEnabled,
          executionRoleArn: lambdaMicrovm.executionRole.roleArn,
          egressConnectorArns: lambdaMicrovm.egressConnectorArns,
          ingressConnectorArns: lambdaMicrovm.ingressConnectorArns,
          payloadBucket: lambdaMicrovm.payloadBucket,
        },
      }),
    });

    orchestratorArnHolder = orchestrator.alias.functionArn;

    agentMemory.grantReadWrite(orchestrator.fn);

    // CloudFormation limits a stack to 500 resources.
    const concurrencyMaintenance = new NestedStack(this, 'ConcurrencyMaintenance');

    new ConcurrencyReconciler(concurrencyMaintenance, 'ConcurrencyReconciler', {
      taskTable: taskTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    new AdmissionQueuePickup(concurrencyMaintenance, 'AdmissionQueuePickup', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
    });

    new StrandedTaskReconciler(concurrencyMaintenance, 'StrandedTaskReconciler', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    new PendingUploadCleanup(concurrencyMaintenance, 'PendingUploadCleanup', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      attachmentsBucket: attachmentsBucket.bucket,
    });

    const prOutcomeSweep = new PrOutcomeSweep(concurrencyMaintenance, 'PrOutcomeSweep', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      githubTokenSecret,
    });

    const approvalMetricsPublisher = new ApprovalMetricsPublisherConsumer(this, 'ApprovalMetricsPublisherConsumer', {
      taskEventsTable: taskEventsTable.table,
    });

    new TaskDashboard(this, 'TaskDashboard', {
      applicationLogGroup: agentLogGroup,
      runtimeArn: runtime?.agentRuntimeArn,
    });

    if (features.slack) {
      const slackIntegration = new SlackIntegration(this, 'SlackIntegration', {
        api: taskApi.api,
        userPool: taskApi.userPool,
        taskTable: taskTable.table,
        taskEventsTable: taskEventsTable.table,
        budgetTable: budgetTable.table,
        repoTable: repoTable.table,
        orchestratorFunctionArn: orchestrator.alias.functionArn,
        guardrailId: inputGuardrail.guardrailId,
        guardrailVersion: inputGuardrailVersion,
      });

      const apiHost = Fn.select(2, Fn.split('/', taskApi.api.url));
      const apiStage = Fn.select(API_URL_STAGE_SEGMENT_INDEX, Fn.split('/', taskApi.api.url));
      const apiBase = Fn.join('', ['https://', apiHost, '/', apiStage]);

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
    }

    if (linearIdentityVault) {
      if (runtime) linearIdentityVault.grantMintToken(runtime.role);
      if (lambdaMicrovm) {
        linearIdentityVault.grantMintToken(lambdaMicrovm.executionRole);
      }
    }

    const linearIntegration = this.linearIntegration = features.linear ? new LinearIntegration(this, 'LinearIntegration', {
      identityVault: linearIdentityVault,
      api: taskApi.api,
      userPool: taskApi.userPool,
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      budgetTable: budgetTable.table,
      repoTable: repoTable.table,
      orchestrationTable: orchestrationTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrailVersion,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser,
      attachmentsBucket: attachmentsBucket.bucket,
      agentSessions: linearAgentSessionsProps(linearAgentSessionsEnabled, taskNudgesTable.table, [
        [agentCoreEnabled, 'agentCoreRuntimeArn', lazyRuntimeArn],
        [ecsEnabled, 'ecsClusterArn', lazyEcsClusterArn],
        [microvmImageConfigured, 'lambdaMicrovmImageArn', lazyMicrovmImageArn],
      ]),
    }) : undefined;
    const linearOauthSecretArn = Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      resourceName: 'bgagent-linear-oauth-*',
    });

    const orchestrationReconciler = new OrchestrationReconciler(this, 'OrchestrationReconciler', {
      taskTable: taskTable.table,
      orchestrationTable: orchestrationTable.table,
      taskEventsTable: taskEventsTable.table,
      budgetTable: budgetTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
    });
    repoTable.table.grantReadData(orchestrationReconciler.fn);
    orchestrationReconciler.fn.addEnvironment('REPO_TABLE_NAME', repoTable.table.tableName);
    orchestrationReconciler.fn.addEnvironment('GUARDRAIL_ID', inputGuardrail.guardrailId);
    orchestrationReconciler.fn.addEnvironment('GUARDRAIL_VERSION', inputGuardrailVersion);
    orchestrationReconciler.fn.addEnvironment(
      'ORCHESTRATOR_FUNCTION_ARN',
      orchestrator.alias.functionArn,
    );
    if (linearIntegration) {
      linearIntegration.workspaceRegistryTable.grantReadData(orchestrationReconciler.fn);
      orchestrationReconciler.fn.addEnvironment(
        'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
        linearIntegration.workspaceRegistryTable.tableName,
      );
    }
    userConcurrencyTable.table.grantReadData(orchestrationReconciler.fn);
    orchestrationReconciler.fn.addEnvironment(
      'USER_CONCURRENCY_TABLE_NAME',
      userConcurrencyTable.table.tableName,
    );
    orchestrationReconciler.fn.addEnvironment(
      'MAX_CONCURRENT_TASKS_PER_USER',
      String(maxConcurrentTasksPerUser),
    );
    orchestrationReconciler.fn.addEnvironment('USER_POOL_ID', taskApi.userPool.userPoolId);
    orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminListGroupsForUser'],
      resources: [taskApi.userPool.userPoolArn],
    }));
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
    if (linearIntegration) {
      orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [linearOauthSecretArn],
      }));
    }
    if (issueOrchestrationEnabled) {
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
      strandedOrchestrationReconciler.fn.addEnvironment('GUARDRAIL_VERSION', inputGuardrailVersion);
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
      if (linearIntegration) {
        strandedOrchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [linearOauthSecretArn],
        }));
        linearIntegration.workspaceRegistryTable.grantReadData(strandedOrchestrationReconciler.fn);
        strandedOrchestrationReconciler.fn.addEnvironment(
          'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
          linearIntegration.workspaceRegistryTable.tableName,
        );
      }
      userConcurrencyTable.table.grantReadData(strandedOrchestrationReconciler.fn);
      strandedOrchestrationReconciler.fn.addEnvironment(
        'USER_CONCURRENCY_TABLE_NAME',
        userConcurrencyTable.table.tableName,
      );
      strandedOrchestrationReconciler.fn.addEnvironment(
        'MAX_CONCURRENT_TASKS_PER_USER',
        String(maxConcurrentTasksPerUser),
      );
      budgetTable.table.grantReadData(strandedOrchestrationReconciler.fn);
      strandedOrchestrationReconciler.fn.addEnvironment('BUDGET_TABLE_NAME', budgetTable.table.tableName);
      strandedOrchestrationReconciler.fn.addEnvironment('USER_POOL_ID', taskApi.userPool.userPoolId);
      strandedOrchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [taskApi.userPool.userPoolArn],
      }));
    }

    for (const role of linearIntegration ? computeRoles : []) {
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [linearOauthSecretArn],
      }));
    }

    if (linearIntegration) {
      linearIntegration.workspaceRegistryTable.grantReadData(orchestrator.fn);
      orchestrator.fn.addEnvironment(
        'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
        linearIntegration.workspaceRegistryTable.tableName,
      );
      orchestrator.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [linearOauthSecretArn],
      }));
    }

    const iterationHeartbeat = issueOrchestrationEnabled
      ? new IterationHeartbeat(this, 'IterationHeartbeat', { taskTable: taskTable.table })
      : undefined;
    if (linearIntegration && iterationHeartbeat) {
      linearIntegration.workspaceRegistryTable.grantReadData(iterationHeartbeat.fn);
      iterationHeartbeat.fn.addEnvironment(
        'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
        linearIntegration.workspaceRegistryTable.tableName,
      );
      iterationHeartbeat.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [linearOauthSecretArn],
      }));
    }

    if (linearIntegration) {
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
    }

    const jiraIntegration = features.jira ? new JiraIntegration(this, 'JiraIntegration', {
      api: taskApi.api,
      userPool: taskApi.userPool,
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      budgetTable: budgetTable.table,
      orchestrationTable: orchestrationTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      maxConcurrentTasksPerUser: maxConcurrentTasksPerUser,
      repoTable: repoTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrailVersion,
      attachmentsBucket: attachmentsBucket.bucket,
    }) : undefined;
    const jiraOauthSecretArn = Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      resourceName: 'bgagent-jira-oauth-*',
    });

    if (jiraIntegration && iterationHeartbeat) {
      jiraIntegration.workspaceRegistryTable.grantReadData(iterationHeartbeat.fn);
      iterationHeartbeat.fn.addEnvironment(
        'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
        jiraIntegration.workspaceRegistryTable.tableName,
      );
      iterationHeartbeat.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [jiraOauthSecretArn],
      }));
    }

    if (jiraIntegration) {
      for (const role of computeRoles) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [jiraOauthSecretArn],
        }));
      }

      jiraIntegration.workspaceRegistryTable.grantReadData(orchestrator.fn);
      orchestrator.fn.addEnvironment(
        'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
        jiraIntegration.workspaceRegistryTable.tableName,
      );
      orchestrator.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [jiraOauthSecretArn],
      }));

      jiraIntegration.workspaceRegistryTable.grantReadData(orchestrationReconciler.fn);
      orchestrationReconciler.fn.addEnvironment(
        'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
        jiraIntegration.workspaceRegistryTable.tableName,
      );
      orchestrationReconciler.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [jiraOauthSecretArn],
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
    }

    const fanOutConsumer = new FanOutConsumer(this, 'FanOutConsumer', {
      taskEventsTable: taskEventsTable.table,
      taskTable: taskTable.table,
      repoTable: repoTable.table,
      githubTokenSecret,
      ...(features.slack && {
        slackSecretArnPattern: Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: 'bgagent/slack/*',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      }),
      ...(linearIntegration && {
        linearWorkspaceRegistryTable: linearIntegration.workspaceRegistryTable,
        linearOauthSecretArnPattern: linearOauthSecretArn,
      }),
      linearAgentSessionsEnabled,
      ...(jiraIntegration && {
        jiraWorkspaceRegistryTable: jiraIntegration.workspaceRegistryTable,
        jiraOauthSecretArnPattern: jiraOauthSecretArn,
      }),
    });

    const githubScreenshot = features.deployPreviewScreenshots
      ? new GitHubScreenshotIntegration(this, 'GitHubScreenshotIntegration', {
        api: taskApi.api,
        githubTokenSecret,
        ...(linearIntegration && { linearWorkspaceRegistryTable: linearIntegration.workspaceRegistryTable }),
        ...(jiraIntegration && { jiraWorkspaceRegistryTable: jiraIntegration.workspaceRegistryTable }),
        taskTable: taskTable.table,
      })
      : undefined;

    if (linearIdentityVault) {
      for (const linearWriter of [
        fanOutConsumer.fn,
        orchestrator.fn,
        githubScreenshot?.webhookProcessorFn,
        orchestrationReconciler.fn,
        iterationHeartbeat?.fn,
      ].filter((fn): fn is NonNullable<typeof fn> => fn !== undefined)) {
        linearWriter.addEnvironment('LINEAR_VAULT_ENABLED', 'true');
        linearWriter.addEnvironment('LINEAR_WORKLOAD_IDENTITY_NAME', linearVaultWorkload);
        linearIdentityVault.grantMintToken(linearWriter);
      }
    }

    const operationalAlerts = new OperationalAlerts(this, 'OperationalAlerts', {
      alertEmail: this.node.tryGetContext('alertEmail') as string | undefined,
    });
    operationalAlerts.addAlarmActions(
      orchestrator.errorAlarm,
      fanOutConsumer.dlqDepthAlarm,
      approvalMetricsPublisher.dlqAlarm,
      ...(githubScreenshot
        ? [githubScreenshot.processorDlqDepthAlarm, githubScreenshot.processorErrorAlarm]
        : []),
      budgetAlerts.warningAlarm,
      budgetAlerts.exceededAlarm,
      budgetAlerts.teamMembershipUnresolvedAlarm,
      ...[taskApi.webhookXssCountedAlarm].filter(alarm => alarm !== undefined),
      ...webhookScreeningAlarms(concurrencyMaintenance, issueOrchestrationEnabled),
      prOutcomeSweep.errorAlarm,
    );

    if (linearIntegration) {
      operationalAlerts.grantPublish(linearIntegration.webhookProcessorFn);
      linearIntegration.webhookProcessorFn.addEnvironment(
        'OPERATIONAL_ALERT_TOPIC_ARN',
        operationalAlerts.topic.topicArn,
      );
    }

    new CfnOutput(this, 'OperationalAlertsTopicArn', {
      value: operationalAlerts.topic.topicArn,
      description: 'SNS topic that every CloudWatch alarm of this stack notifies — subscribe Slack / PagerDuty / email here (#629)',
    });

    if (githubScreenshot) {
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
    }

    const invocationLogGroup = new logs.LogGroup(this, 'ModelInvocationLogGroup', {
      logGroupName: `/aws/bedrock/model-invocation-logs/${this.stackName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    invocationLogGroup.grantWrite(bedrockLoggingRole);

    const invocationLogging = new cr.AwsCustomResource(this, 'ModelInvocationLogging', {
      onCreate: {
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
      // Bedrock keeps one model invocation logging configuration per account and Region,
      // which other stacks may use: no onDelete.
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLoggingRole.roleArn],
        }),
      ]),
    });

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

    NagSuppressions.addResourceSuppressions(invocationLogging, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Bedrock model invocation logging configuration APIs are account-level and do not support resource-level permissions',
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

    new CfnOutput(this, 'DeploymentFeatures', {
      value: enabledFeatures(features).join(',') || 'none',
      description: 'Optional features deployed in this stack (ADR-024) - read by `bgagent setup`',
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
