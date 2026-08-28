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
import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Durable-execution wall-clock ceiling (hours). Must exceed the longest
 * agent run including HITL approval waits (2h approval stranded-timeout
 * plus the agent's own multi-hour budget).
 */
const DURABLE_EXECUTION_TIMEOUT_HOURS = 9;

/** Durable-execution state retention after completion (days). */
const DURABLE_RETENTION_DAYS = 14;

/** Default task-record retention used for TTL computation (days). */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/** Orchestrator error-alarm metric period (minutes). */
const ERROR_ALARM_PERIOD_MINUTES = 5;

/** Orchestrator Lambda timeout (seconds). */
const ORCHESTRATOR_TIMEOUT_SECONDS = 60;

/** Orchestrator Lambda memory (MB). */
const ORCHESTRATOR_MEMORY_MB = 1024;

/**
 * Properties for TaskOrchestrator construct.
 */
export interface TaskOrchestratorProps {
  /**
   * The DynamoDB task table.
   */
  readonly taskTable: dynamodb.ITable;

  /**
   * The DynamoDB task events table.
   */
  readonly taskEventsTable: dynamodb.ITable;

  /**
   * The DynamoDB user concurrency table.
   */
  readonly userConcurrencyTable: dynamodb.ITable;

  /**
   * ARN of the AgentCore runtime.
   */
  readonly runtimeArn: string;

  /**
   * The DynamoDB repo config table. When provided, the orchestrator loads
   * per-repo blueprint configuration at the start of each task.
   */
  readonly repoTable?: dynamodb.ITable;

  /**
   * Maximum concurrent tasks per user.
   *
   * Raised from 3 to 10 in rev 5 to accommodate power-user CLI flows
   * (developer running `bgagent run` a few times while iterating on a
   * feature, reviewing queued PRs, etc.). 3 was a conservative starter
   * that led to surprise admission rejections in practice. The
   * stranded-task reconciler (scheduled handler) prevents abandoned
   * tasks from permanently consuming slots.
   *
   * @default 10
   */
  readonly maxConcurrentTasksPerUser?: number;

  /**
   * Number of days to retain completed task and event records before DynamoDB TTL deletes them.
   * @default 90
   */
  readonly taskRetentionDays?: number;

  /**
   * ARN of the Secrets Manager secret containing the GitHub token.
   * When provided, the orchestrator fetches issue context from GitHub during hydration.
   */
  readonly githubTokenSecretArn?: string;

  /**
   * Additional AgentCore runtime ARNs the orchestrator may invoke.
   * Required when Blueprints specify per-repo runtime ARN overrides.
   */
  readonly additionalRuntimeArns?: string[];

  /**
   * Additional Secrets Manager ARNs the orchestrator may read.
   * Required when Blueprints specify per-repo GitHub token secrets.
   */
  readonly additionalSecretArns?: string[];

  /**
   * Maximum token budget for the assembled user prompt.
   * @default 100000
   */
  readonly userPromptTokenBudget?: number;

  /**
   * AgentCore Memory resource ID for cross-task learning.
   * When provided, the orchestrator reads memory context during hydration
   * and writes fallback episodes during finalization.
   */
  readonly memoryId?: string;

  /**
   * Bedrock Guardrail ID used by the orchestrator to screen assembled PR prompts
   * for prompt injection during context hydration. The same guardrail is also
   * used by the Task API for submission-time task description screening.
   */
  readonly guardrailId?: string;

  /**
   * Bedrock Guardrail version. Required when guardrailId is provided.
   */
  readonly guardrailVersion?: string;

  /**
   * ECS Fargate compute strategy configuration.
   * When provided, ECS-related env vars and IAM policies are added to the orchestrator.
   * All fields are required — this makes the all-or-nothing constraint self-evident at the type level.
   */
  readonly ecsConfig?: {
    readonly clusterArn: string;
    readonly taskDefinitionArn: string;
    readonly subnets: string;
    readonly securityGroup: string;
    readonly containerName: string;
    readonly taskRoleArn: string;
    readonly executionRoleArn: string;
    /**
     * The smaller read-only PLANNING task def (see
     * docs/design/ECS_RIGHTSIZED_PLANNING.md). The ECS strategy selects it for
     * read-only workflows so planning doesn't run on the larger build box.
     *
     * Required, like its siblings, so the all-or-nothing constraint stays visible
     * at the type level: the strategy reads this ARN from an env var, and an
     * ecsConfig that omitted it would compile but leave the planning def defined
     * and permanently unreachable.
     *
     * Needs no extra IAM — it shares the build def's task and execution roles,
     * and the `ecs:RunTask` grant below is scoped by `ecs:cluster` rather than by
     * task-definition ARN, so it already covers every def in the cluster.
     */
    readonly planningTaskDefinitionArn: string;
  };

  /**
   * S3 bucket for per-task ECS payloads. When provided (alongside
   * ``ecsConfig``), the orchestrator writes the payload here and passes only an
   * ``AGENT_PAYLOAD_S3_URI`` pointer in the RunTask override (the full payload
   * exceeds the 8 KB containerOverrides limit), then deletes the object in the
   * finalize step. The orchestrator gets write + delete; the ECS task role gets
   * read-only (granted on the bucket by ``EcsAgentCluster``).
   */
  readonly ecsPayloadBucket?: s3.IBucket;

  /**
   * S3 bucket for task attachments. When provided, the orchestrator gets
   * ReadWrite grants for URL fetch/screen/upload during hydration.
   */
  readonly attachmentsBucket?: s3.IBucket;

  /**
   * Non-secret platform identifiers the orchestrator FORWARDS to the in-guest
   * agent, for backends that have no deploy-time env block of their own.
   *
   * ## Why the orchestrator carries values it never uses itself
   *
   * On AgentCore these live in the runtime's `environmentVariables` and on ECS in
   * the container's `environment` — CDK sets them directly on the compute. A
   * Lambda MicroVM snapshot cannot have them: ADR-021 sub-decision 3 forbids
   * baking configuration into an image that is shared across tasks and
   * deployments, so the only channel is the `/run` payload the orchestrator
   * writes (`platform_config`, assembled by
   * `handlers/shared/strategies/lambda-microvm-strategy.ts`). That makes the
   * orchestrator's own environment the transport, which is why these appear here
   * rather than on `LambdaMicrovmCompute`.
   *
   * ## Names, ARNs — and NO grants
   *
   * Every field is an identifier, never a secret value, and NONE of them adds an
   * IAM grant to the orchestrator role: it forwards these strings and never calls
   * the resources they name (the agent does, through its own execution role /
   * SessionRole). The approvals and nudges tables in particular stay ungranted to
   * the orchestrator, which is asserted by a unit test — a "while I'm here" grant
   * would hand the orchestration plane tenant-data access it has never needed.
   *
   * ## All-or-nothing, and wired unconditionally
   *
   * Every field is required so a partial configuration is unrepresentable (same
   * rationale as `ecsConfig` / `microvmConfig`). The stack wires it for EVERY
   * compute type rather than under the `lambda-microvm` gate: the strategy fails
   * the session start when a required identifier is missing, and that guard should
   * only ever fire for a hand-edited Lambda environment — never because a
   * deploy-time gate and a per-repo `compute_type` disagreed.
   *
   * Optional as a prop only so isolated construct tests can omit it. Four of the
   * thirteen `platform_config` keys come from env vars the orchestrator already
   * carries for its own work (`TASK_TABLE_NAME`, `TASK_EVENTS_TABLE_NAME`,
   * `GITHUB_TOKEN_SECRET_ARN`) or from the stack-wide `SolutionUaAspect`
   * (`AWS_SDK_UA_APP_ID`), so they are deliberately NOT repeated here.
   */
  readonly agentPlatformConfig?: {
    /**
     * Cedar HITL approvals table (`TASK_APPROVALS_TABLE_NAME`). The agent's
     * approval primitives write PENDING rows here; absent, the PreToolUse hook
     * fails closed with `approval_write_failed`.
     */
    readonly taskApprovalsTableName: string;
    /** Nudges table (`NUDGES_TABLE_NAME`) the agent polls for mid-task nudges. */
    readonly nudgesTableName: string;
    /** Application log group (`LOG_GROUP_NAME`) the agent writes progress logs to. */
    readonly logGroupName: string;
    /**
     * Bucket a `deliver_artifact` step uploads to (`ARTIFACTS_BUCKET_NAME`).
     * Without it an artifact workflow fails at delivery with
     * "ARTIFACTS_BUCKET_NAME is not configured".
     */
    readonly artifactsBucketName: string;
    /** Bucket the `--trace` trajectory upload targets (`TRACE_ARTIFACTS_BUCKET_NAME`). */
    readonly traceArtifactsBucketName: string;
    /**
     * Per-task SessionRole ARN (`AGENT_SESSION_ROLE_ARN`). The sharpest field in
     * this block: when the agent does not receive it, it falls back to ambient
     * compute-role credentials and per-tenant scoping is silently OFF.
     */
    readonly agentSessionRoleArn: string;
    /**
     * Cross-region inference-profile id for the small/fast model
     * (`ANTHROPIC_DEFAULT_HAIKU_MODEL`). Must be a GEO-PREFIXED profile id, not a
     * bare foundation-model id — Claude 4.x rejects on-demand invocation by bare
     * id — and must match a granted profile (`constructs/bedrock-models.ts`).
     *
     * The prefix is whichever geography `resolveBedrockGeoRegion` resolves for the
     * deployment (`bedrockGeoRegion` context, default `us`), NOT a hardcoded `us.`:
     * pass `haikuInferenceProfileId(bedrockGeoRegion)` so this value and the
     * inference-profile ARNs the roles are granted come from the same source (#764).
     */
    readonly anthropicDefaultHaikuModel: string;

    /**
     * The MAIN coding model (`ANTHROPIC_MODEL`), same rules as the auxiliary one
     * above: geo-prefixed profile id from the deployment's resolved geography.
     *
     * Delivered alongside it because only the auxiliary model was, which left the
     * main model coming from a literal in `agent/src/config.py` that a geography
     * change does not touch — so a non-default `bedrockGeoRegion` granted one
     * geography's profiles while the agent asked for another's, and every task with
     * no per-repo override failed at turn 0 with AccessDenied.
     */
    readonly anthropicModel: string;
  };

  /**
   * AWS Lambda MicroVMs compute strategy configuration (ADR-021 sub-decision 4).
   * When provided, the `MICROVM_*` env vars and the MicroVM lifecycle IAM
   * statements are added to the orchestrator.
   *
   * Grouped into one all-or-nothing object for the same reason `ecsConfig` is:
   * the strategy refuses to start a session unless `imageIdentifier`,
   * `executionRoleArn`, `egressConnectorArns` and `payloadBucket` are ALL
   * present, so the type makes a partial configuration unrepresentable instead
   * of deferring the failure to the first task on the backend.
   *
   * `ingressConnectorArns` is required for a different reason — it is a security
   * control whose absence has a *wider* meaning than "off" (see the field). Only
   * `imageVersion` is genuinely optional, and its absent state ("let the service
   * resolve the latest ACTIVE version") is a real, intended configuration.
   */
  readonly microvmConfig?: {
    /**
     * Image **ARN** passed as `imageIdentifier` on every `RunMicrovm`.
     *
     * Must be an ARN, not a bare name: `RunMicrovm` rejects names
     * (`Malformed ARN - doesn't start with 'arn:'`). `LambdaMicrovmCompute`
     * resolves a name to its exact ARN, so in practice this is the same value as
     * {@link imageArn} — both fields are kept because they answer different
     * questions (request field vs IAM resource) and could legitimately diverge
     * if the service ever accepts a version-qualified identifier.
     */
    readonly imageIdentifier: string;
    /**
     * The image's IAM resource ARN, used to scope every MicroVM lifecycle grant
     * to that one platform-created image (ADR-021).
     *
     * REQUIRED, and separate from {@link imageIdentifier} for the reason above.
     * Required rather than optional on purpose: an optional field here would
     * silently re-introduce an account-wide `microvm-image:*` fallback, and no
     * caller needs one — the `microvmImage` ARN shape is fully derivable from an
     * image name plus the stack's partition/Region/account, which
     * `LambdaMicrovmCompute` does.
     */
    readonly imageArn: string;
    /**
     * Optional image version pin. Omitted ⇒ the service resolves the latest
     * active version, which is what a rebuild-in-place flow wants.
     */
    readonly imageVersion?: string;
    /** Role the MicroVM assumes at runtime; passed on `RunMicrovm`. */
    readonly executionRoleArn: string;
    /** Egress network connectors; comma-joined into the env var. */
    readonly egressConnectorArns: string[];
    /**
     * Ingress network connectors. **Required** — and required for a security
     * reason, not a stylistic one.
     *
     * `RunMicrovm` attaches a PUBLIC `HTTP_INGRESS` connector (and mints a public
     * `*.lambda-microvm.<region>.on.aws` endpoint) when the request omits the
     * field, so "nothing dials into the MicroVM" is an ACTIVE control that has to
     * be passed on every launch. An optional field here would let a caller
     * express "no ingress configured" and silently get the widest possible
     * posture — which is exactly the class of bug the omitted-field rule in
     * ADR-021's source-hierarchy note warns about.
     *
     * In P1–P3 `LambdaMicrovmCompute` always supplies the Lambda-managed
     * `NO_INGRESS` connector; #391 operator shell access can widen it without a
     * strategy change.
     */
    readonly ingressConnectorArns: string[];
    /**
     * Bucket for `/run` payloads that exceed the 4 KB `runHookPayload` cap —
     * i.e. nearly all of them, since a hydrated payload is bigger than that.
     * The orchestrator gets **write only**: unlike the ECS payload bucket
     * there is no finalize-time delete on this backend (the bucket's lifecycle
     * rule is the reaper), so `grantDelete` would be an unused permission.
     */
    readonly payloadBucket: s3.IBucket;
  };

  /**
   * Agent Registry id (#246). When provided, the orchestrator resolves the
   * Blueprint's ``registry://`` asset refs at task start and threads the bundle
   * into the agent payload. Requires agent-registry read actions.
   */
  readonly agentRegistryId?: string;
}

/**
 * CDK construct that creates the orchestrator Lambda function with durable execution
 * for managing the task lifecycle (admission → hydration → session → poll → finalize).
 */
export class TaskOrchestrator extends Construct {
  /**
   * The orchestrator Lambda function.
   */
  public readonly fn: lambda.NodejsFunction;

  /**
   * The Lambda alias (required for durable function invocation).
   */
  public readonly alias: iam.IGrantable & { functionArn: string };

  /**
   * CloudWatch alarm that fires when the orchestrator Lambda errors exceed threshold.
   */
  public readonly errorAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: TaskOrchestratorProps) {
    super(scope, id);

    if (props.guardrailId && !props.guardrailVersion) {
      throw new Error('guardrailVersion is required when guardrailId is provided');
    }
    if (!props.guardrailId && props.guardrailVersion) {
      throw new Error('guardrailId is required when guardrailVersion is provided');
    }

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const maxConcurrent = props.maxConcurrentTasksPerUser ?? 10;

    // Hydration pulls in bedrock-agentcore (bundled), durable-execution, and
    // attachment screening (URL resolution). pdf-parse is needed for PDF text
    // extraction during screening. Note we deliberately bundle
    // `@aws-sdk/client-bedrock-agentcore`: newer commands (e.g.
    // StopRuntimeSessionCommand) are not in the Lambda runtime's pinned
    // SDK and throw `<Command> is not a constructor` if externalized — see
    // cancel-task silent-failure mode (task-api.ts commonBundling).
    //
    // `@aws/durable-execution-sdk-js@1.1.3` ships an ESM build at
    // `dist/index.mjs` that uses `fileURLToPath(import.meta.url)` to compute
    // __dirname. When esbuild bundles ESM-into-CJS for Lambda, it stubs
    // `import.meta = {}` so `import.meta.url` is undefined and
    // `fileURLToPath(undefined)` crashes at module-load. Substitute via a
    // banner-defined identifier that holds the file:// URL form of the
    // bundled file's path. Upstream issue: aws/aws-durable-execution-sdk-js#543.
    const orchestratorBundling: lambda.BundlingOptions = {
      externalModules: [
        '@aws-sdk/client-dynamodb',
        '@aws-sdk/client-ecs',
        '@aws-sdk/client-lambda',
        '@aws-sdk/client-bedrock-runtime',
        '@aws-sdk/client-s3',
        '@aws-sdk/client-secrets-manager',
        '@aws-sdk/lib-dynamodb',
        '@aws-sdk/util-dynamodb',
      ],
      nodeModules: ['pdf-parse'],
      define: { 'import.meta.url': '__bundled_import_meta_url' },
      banner: 'const __bundled_import_meta_url = require("url").pathToFileURL(__filename).href;',
    };

    this.fn = new lambda.NodejsFunction(this, 'OrchestratorFn', {
      entry: path.join(handlersDir, 'orchestrate-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(ORCHESTRATOR_TIMEOUT_SECONDS),
      memorySize: ORCHESTRATOR_MEMORY_MB,
      durableConfig: {
        executionTimeout: Duration.hours(DURABLE_EXECUTION_TIMEOUT_HOURS),
        retentionPeriod: Duration.days(DURABLE_RETENTION_DAYS),
      },
      environment: {
        // Solution-attribution component label (#319): orchestration plane.
        ABCA_COMPONENT: 'orchestr',
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        RUNTIME_ARN: props.runtimeArn,
        MAX_CONCURRENT_TASKS_PER_USER: String(maxConcurrent),
        TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? DEFAULT_TASK_RETENTION_DAYS),
        ...(props.repoTable && { REPO_TABLE_NAME: props.repoTable.tableName }),
        ...(props.githubTokenSecretArn && { GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn }),
        ...(props.userPromptTokenBudget !== undefined && {
          USER_PROMPT_TOKEN_BUDGET: String(props.userPromptTokenBudget),
        }),
        ...(props.memoryId && { MEMORY_ID: props.memoryId }),
        ...(props.guardrailId && { GUARDRAIL_ID: props.guardrailId }),
        ...(props.guardrailVersion && { GUARDRAIL_VERSION: props.guardrailVersion }),
        ...(props.ecsConfig && {
          ECS_CLUSTER_ARN: props.ecsConfig.clusterArn,
          ECS_TASK_DEFINITION_ARN: props.ecsConfig.taskDefinitionArn,
          ECS_SUBNETS: props.ecsConfig.subnets,
          ECS_SECURITY_GROUP: props.ecsConfig.securityGroup,
          ECS_CONTAINER_NAME: props.ecsConfig.containerName,
          // Read-only workflows route here instead of the build def. Without this
          // var the strategy's `readOnly && ECS_PLANNING_TASK_DEFINITION_ARN`
          // guard is always falsy, so the planning def would be synthesized and
          // never used.
          ECS_PLANNING_TASK_DEFINITION_ARN: props.ecsConfig.planningTaskDefinitionArn,
        }),
        // Bucket the orchestrator writes the ECS payload to (and deletes
        // from at finalize); the ECS strategy reads this to build the S3 URI.
        ...(props.ecsPayloadBucket && { ECS_PAYLOAD_BUCKET: props.ecsPayloadBucket.bucketName }),
        // ADR-021: the MicroVM substrate's deployment-time configuration. Names
        // are the contract `lambda-microvm-strategy.ts` reads verbatim — do not
        // rename one side without the other.
        ...(props.microvmConfig && {
          MICROVM_IMAGE_IDENTIFIER: props.microvmConfig.imageIdentifier,
          MICROVM_EXECUTION_ROLE_ARN: props.microvmConfig.executionRoleArn,
          MICROVM_EGRESS_CONNECTOR_ARNS: props.microvmConfig.egressConnectorArns.join(','),
          // ALWAYS injected, never conditional — part of the same all-or-nothing
          // block as the four above. The value is a control (`NO_INGRESS`), not a
          // configuration nicety: `RunMicrovm` attaches a PUBLIC HTTP_INGRESS
          // connector when the field is absent from the request, so a deployment
          // that omitted this var would hand every agent MicroVM a public
          // endpoint. Making the prop required is what lets this be
          // unconditional; there is no "no ingress configured" state to express.
          MICROVM_INGRESS_CONNECTOR_ARNS: props.microvmConfig.ingressConnectorArns.join(','),
          MICROVM_PAYLOAD_BUCKET: props.microvmConfig.payloadBucket.bucketName,
          ...(props.microvmConfig.imageVersion && {
            MICROVM_IMAGE_VERSION: props.microvmConfig.imageVersion,
          }),
        }),
        ...(props.attachmentsBucket && { ATTACHMENTS_BUCKET_NAME: props.attachmentsBucket.bucketName }),
        ...(props.agentRegistryId && { AGENT_REGISTRY_ID: props.agentRegistryId }),
        // ADR-021 P2: non-secret identifiers the orchestrator FORWARDS to the
        // in-guest agent as `platform_config` on the MicroVM /run payload, because
        // a MicroVM snapshot must not bake configuration in. Names match the
        // AgentCore runtime env block in `stacks/agent.ts` and the strategy's
        // PLATFORM_CONFIG_ENV_VARS map verbatim — one stack value, one name, three
        // backends. NO IAM grant accompanies any of these (see the prop docs).
        ...(props.agentPlatformConfig && {
          TASK_APPROVALS_TABLE_NAME: props.agentPlatformConfig.taskApprovalsTableName,
          NUDGES_TABLE_NAME: props.agentPlatformConfig.nudgesTableName,
          LOG_GROUP_NAME: props.agentPlatformConfig.logGroupName,
          ARTIFACTS_BUCKET_NAME: props.agentPlatformConfig.artifactsBucketName,
          TRACE_ARTIFACTS_BUCKET_NAME: props.agentPlatformConfig.traceArtifactsBucketName,
          AGENT_SESSION_ROLE_ARN: props.agentPlatformConfig.agentSessionRoleArn,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: props.agentPlatformConfig.anthropicDefaultHaikuModel,
        }),
      },
      bundling: orchestratorBundling,
    });

    // DynamoDB grants
    props.taskTable.grantReadWriteData(this.fn);
    props.taskEventsTable.grantReadWriteData(this.fn);
    props.userConcurrencyTable.grantReadWriteData(this.fn);
    if (props.repoTable) {
      props.repoTable.grantReadData(this.fn);
    }

    // Attachments bucket grants (URL fetch/screen/upload during hydration)
    if (props.attachmentsBucket) {
      props.attachmentsBucket.grantReadWrite(this.fn);
    }

    // ECS payload bucket — the orchestrator writes the payload before
    // RunTask and deletes it at finalize. Write + delete only (it never reads
    // its own payload back; the ECS container is the reader, with its own
    // read-only grant from EcsAgentCluster).
    if (props.ecsPayloadBucket) {
      props.ecsPayloadBucket.grantPut(this.fn);
      props.ecsPayloadBucket.grantDelete(this.fn);
    }

    // ADR-021: MicroVM payload bucket. WRITE only — the strategy uploads an
    // oversized /run payload and never reads it back (the MicroVM execution
    // role is the reader, with its own read-only grant), and it never deletes
    // (the bucket's lifecycle rule reaps). No grantDelete, deliberately: the ECS
    // path has one because the orchestrator deletes at finalize; this one does
    // not, so the grant would be dead permission.
    if (props.microvmConfig) {
      props.microvmConfig.payloadBucket.grantPut(this.fn);
    }

    // Durable execution managed policy
    this.fn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );

    // Secrets Manager grant for GitHub token (context hydration)
    if (props.githubTokenSecretArn) {
      const githubTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'GitHubTokenSecret', props.githubTokenSecretArn,
      );
      githubTokenSecret.grantRead(this.fn);
    }

    // AgentCore runtime invocation permissions
    // The InvokeAgentRuntime API targets a sub-resource (runtime-endpoint/DEFAULT),
    // so we need a wildcard after the runtime ARN.
    //
    // `InvokeAgentRuntimeForUser` is required when the call passes
    // `runtimeUserId` (Phase 2.0a — needed for AgentCore Identity to
    // inject a `WorkloadAccessToken` header into the agent container so
    // `BedrockAgentCoreContext.get_workload_access_token()` returns
    // non-None). Without this grant, `InvokeAgentRuntimeCommand` with
    // `runtimeUserId` set fails with AccessDenied.
    const runtimeArns = [props.runtimeArn, ...(props.additionalRuntimeArns ?? [])];
    const runtimeResources = runtimeArns.flatMap(arn => [arn, `${arn}/*`]);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:InvokeAgentRuntimeForUser',
        'bedrock-agentcore:StopRuntimeSession',
      ],
      resources: runtimeResources,
    }));

    // Registry (#246): read-only access so the orchestrator can resolve the
    // Blueprint's registry:// asset refs at task start. Scoped to THIS registry
    // (the id is in scope here); only the record suffix is a wildcard, because
    // record ids are server-assigned and unknown at synth — mirrors the scoping
    // in registry-api.ts (#246 review nit).
    if (props.agentRegistryId) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'agent-registry:GetRegistryRecord',
          'agent-registry:ListRegistryRecords',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'agent-registry',
            resource: 'registry',
            resourceName: props.agentRegistryId,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
          Stack.of(this).formatArn({
            service: 'agent-registry',
            resource: 'registry',
            resourceName: `${props.agentRegistryId}/record/*`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }));
    }

    // ECS compute strategy permissions (only when ECS is configured)
    if (props.ecsConfig) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'ecs:RunTask',
          'ecs:DescribeTasks',
          'ecs:StopTask',
        ],
        resources: ['*'],
        conditions: {
          ArnEquals: {
            'ecs:cluster': props.ecsConfig.clusterArn,
          },
        },
      }));

      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.ecsConfig.taskRoleArn, props.ecsConfig.executionRoleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      }));
    }

    // Lambda MicroVMs compute strategy permissions (only when configured).
    //
    // EXACTLY the four control-plane actions the P1 strategy calls, per
    // ADR-021's "only the MicroVM lifecycle actions it calls" requirement:
    //   RunMicrovm       — startSession
    //   GetMicrovm       — pollSession
    //   TerminateMicrovm — stopSession / finalize (the active cleanup path)
    //   PassNetworkConnector — required to attach egress connectors, even the
    //                          AWS-managed ones
    //
    // NOT granted, deliberately:
    //   - lambda:SuspendMicrovm / lambda:ResumeMicrovm — the ADR's grant list
    //     names them, but P1 has no suspend/resume code path. They land with the
    //     P3 interface widening (mandatory suspendSession/resumeSession across
    //     all three strategies) together with the approve/deny Lambdas'
    //     conditional ResumeMicrovm + GetMicrovm.
    //   - lambda:CreateMicrovmAuthToken — granted to no role in any phase; no
    //     JWE consumer exists (ADR-021 sub-decision 3).
    if (props.microvmConfig) {
      // RESOURCE SCOPING — every MicroVM lifecycle action authorizes against the
      // *image*, not the running instance: the Service Authorization Reference
      // lists `microvmImage`
      // (`arn:<partition>:lambda:<region>:<account>:microvm-image:<name>`) as the
      // required resource for RunMicrovm, GetMicrovm and TerminateMicrovm alike.
      // That is what makes ADR-021's "scoped to platform-created images"
      // achievable even though `microvmId` is minted per session — the
      // per-session identifier never appears in IAM.
      //
      // There is NO account-wide fallback: `imageArn` is a required prop, and
      // `LambdaMicrovmCompute` resolves a bare image name to its exact ARN, so
      // this statement always names exactly one image.
      //
      // The `<arn>:*` sibling is a version-suffix hedge, not a widening. The SAR
      // pattern ends at the image name, but the CLI and console surface
      // version-qualified `…:microvm-image:<name>:<version>` forms, and the docs
      // are already inconsistent about MicroVM ARN separators. If the authorized
      // resource turns out to carry the version, an exact-only policy would
      // AccessDenied every task; if it does not, this entry is inert. Either way
      // it stays pinned to this image's name (names cannot contain `:`), so it
      // can never match a different image.
      const { imageArn } = props.microvmConfig;
      const microvmImageResources = [imageArn, `${imageArn}:*`];

      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmLifecycle',
        actions: [
          'lambda:RunMicrovm',
          'lambda:GetMicrovm',
          'lambda:TerminateMicrovm',
        ],
        resources: microvmImageResources,
      }));

      // `lambda:PassNetworkConnector` supports NO resource-level permissions
      // (the Service Authorization Reference lists no resource type for it), so
      // `Resource: '*'` is mandatory — a narrowed ARN would simply never match
      // and RunMicrovm would fail with AccessDenied. It is also why the ADR
      // notes the action is needed "even for the default connectors": the
      // AWS-managed connectors live in the `aws` account, outside any ARN we
      // could enumerate. The action only permits *passing* a connector to a
      // service, not creating or reading one.
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmPassNetworkConnector',
        actions: ['lambda:PassNetworkConnector'],
        resources: ['*'],
      }));

      // RunMicrovm hands the MicroVM its execution role, which is a PassRole in
      // IAM's eyes (the Reference lists `iam:PassRole` as a documented dependent
      // of RunMicrovm) — same shape as the ECS branch above passing the task and
      // execution roles to ecs-tasks.amazonaws.com. ADR-021's grant list omits
      // it because it enumerates MicroVM actions, not the IAM plumbing they
      // imply; without it RunMicrovm fails on the role hand-off.
      //
      // ⚠️ NO `iam:PassedToService` CONDITION HERE, AND THAT IS DELIBERATE
      // (ADR-021 P2r2-F10, live 2026-08-07 run 2). This reverses what an earlier
      // revision of this comment asserted — that the condition "was explicitly
      // EXONERATED live … so it stays". It was not. It is a second, independent
      // blocker of exactly the same class as the trust-policy source keys: the
      // Lambda MicroVMs service does not present a usable `iam:PassedToService`
      // value on the `RunMicrovm` PassRole path, so a grant carrying the condition
      // is denied.
      //
      // Proven by a controlled two-arm experiment — SAME exact-ARN resource, SAME
      // ~5-minute IAM settle, one variable:
      //
      //   | grant                                            | result             |
      //   |--------------------------------------------------|--------------------|
      //   | exact ARN + iam:PassedToService (as written then) | DENIED (twice)     |
      //   | exact ARN, no condition                           | RUNNING in 9 s     |
      //
      // …with this denial on the CALLER, which is what makes it so misleading:
      //   "User: …/backgroundagent-dev-TaskOrchestratorOrchestratorFn-… is not
      //    authorized to perform: iam:PassRole on resource:
      //    …role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-… because no
      //    identity-based policy allows the iam:PassRole action"
      // even though the statement below names that exact ARN and
      // `simulate-principal-policy` answers `allowed`.
      //
      // WHY RUN 1 GOT THIS WRONG, because the failure mode is worth knowing: run 1
      // "exonerated" the condition by attaching a temporary UNCONDITIONED
      // `iam:PassRole` and observing that the task still failed — but that
      // temporary grant was **still attached** for the later submissions that
      // reached `RUNNING`, so the conditioned grant was never once tested against
      // a working trust policy. A false negative from a contaminated control.
      // Run 2 removed the workaround first (submission 4: denied) and only then
      // added back the unconditioned grant on the same resource (submission 5:
      // `RUNNING`).
      //
      // Compensating control that REMAINS: the grant is scoped to the execution
      // role's EXACT ARN (`props.microvmConfig.executionRoleArn`), not a name
      // prefix and not `*` — so this Lambda can pass exactly one role, the one
      // this deployment created for this backend. That is now the whole of the
      // scoping, which is why the resource must never be relaxed to a wildcard.
      //
      // If AWS documents (or a bounded probe finds) the value the service does
      // present, add it back as a condition — `microvms.lambda.amazonaws.com`,
      // `lambda-microvms.amazonaws.com` and `microvms.amazonaws.com` are all
      // candidates that were `implicitDeny` against the conditioned policy, so any
      // of them would work as the allowlist entry if it is the right one.
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmPassExecutionRole',
        actions: ['iam:PassRole'],
        resources: [props.microvmConfig.executionRoleArn],
      }));
    }

    // Per-repo Secrets Manager grants (e.g. per-repo GitHub tokens from Blueprints)
    for (const [index, secretArn] of (props.additionalSecretArns ?? []).entries()) {
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this, `AdditionalSecret${index}`, secretArn,
      );
      secret.grantRead(this.fn);
    }

    // Bedrock Guardrail permissions
    if (props.guardrailId) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'bedrock',
            resource: 'guardrail',
            resourceName: props.guardrailId,
          }),
        ],
      }));
    }

    // Create alias for durable function invocation
    const fnAlias = this.fn.currentVersion.addAlias('live');
    this.alias = fnAlias;

    // Retry config: durable execution handles retries; disable Lambda-level retries
    // to avoid duplicate invocations that could lead to double task execution.
    fnAlias.configureAsyncInvoke({
      retryAttempts: 0,
    });

    // CloudWatch alarm on orchestrator errors — alerts when async invocations
    // are consistently failing (throttled, dropped, or crashing).
    this.errorAlarm = new cloudwatch.Alarm(this, 'OrchestratorErrorAlarm', {
      metric: this.fn.metricErrors({
        period: Duration.minutes(ERROR_ALARM_PERIOD_MINUTES),
      }),
      threshold: 3,
      evaluationPeriods: 2,
      alarmDescription: 'Orchestrator Lambda errors exceeded threshold — tasks may be stuck in SUBMITTED state',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    NagSuppressions.addResourceSuppressions(this.fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicDurableExecutionRolePolicy is the AWS-recommended managed policy for durable Lambda functions',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; AgentCore runtime/* required for sub-resource invocation; Secrets Manager wildcards generated by CDK grantRead; AgentCore Memory wildcards generated by CDK grantRead/grantWrite; ECS RunTask/DescribeTasks/StopTask conditioned on cluster ARN; iam:PassRole scoped to ECS task/execution roles and conditioned on ecs-tasks.amazonaws.com; S3 object/* wildcard from CDK grantPut on the dedicated MicroVM payload bucket; MicroVM lifecycle actions (RunMicrovm/GetMicrovm/TerminateMicrovm) are scoped to the single platform MicroVM image ARN plus a <arn>:* version-suffix sibling (every one of them authorizes against the image resource, not the per-session instance; no account-wide wildcard is used); lambda:PassNetworkConnector requires Resource:* because the action supports no resource-level permissions and the AWS-managed connectors live outside this account; iam:PassRole is scoped to the MicroVM execution role and conditioned on lambda.amazonaws.com; Agent Registry read scoped to the wired registry ARN, with a record/* suffix wildcard because record ids are server-assigned and unknown at synth (#246)',
      },
    ], true);
  }
}
