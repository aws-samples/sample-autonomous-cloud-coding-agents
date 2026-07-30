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
import { Duration, Stack } from 'aws-cdk-lib';
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
  };

  /**
   * S3 bucket for per-task ECS payloads (#502). When provided (alongside
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
   * AWS Lambda MicroVMs compute strategy configuration (ADR-021 sub-decision 4).
   * When provided, the `MICROVM_*` env vars and the MicroVM lifecycle IAM
   * statements are added to the orchestrator.
   *
   * Grouped into one all-or-nothing object for the same reason `ecsConfig` is:
   * the strategy refuses to start a session unless `imageIdentifier`,
   * `executionRoleArn`, `egressConnectorArns` and `payloadBucket` are ALL
   * present, so the type makes a partial configuration unrepresentable instead
   * of deferring the failure to the first task on the backend.
   */
  readonly microvmConfig?: {
    /** Image name or ARN passed as `imageIdentifier` on every `RunMicrovm`. */
    readonly imageIdentifier: string;
    /**
     * The image's IAM resource ARN, used to scope every MicroVM lifecycle grant
     * to that one platform-created image (ADR-021).
     *
     * REQUIRED, and separate from {@link imageIdentifier} because that field may
     * hold a bare image NAME (valid for `RunMicrovm`, not a valid IAM resource).
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
     * Ingress network connectors. Empty in P1–P3: nothing dials into the
     * MicroVM (no JWE tokens are minted at all), so no ingress is configured.
     * The plumbing exists so #391 operator shell access can add one without a
     * strategy change.
     */
    readonly ingressConnectorArns?: string[];
    /**
     * Bucket for `/run` payloads that exceed the 16 KB `runHookPayload` cap.
     * The orchestrator gets **write only** — unlike the ECS payload bucket
     * there is no finalize-time delete on this backend (the bucket's lifecycle
     * rule is the reaper), so `grantDelete` would be an unused permission.
     */
    readonly payloadBucket: s3.IBucket;
  };
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
        }),
        // #502: bucket the orchestrator writes the ECS payload to (and deletes
        // from at finalize); the ECS strategy reads this to build the S3 URI.
        ...(props.ecsPayloadBucket && { ECS_PAYLOAD_BUCKET: props.ecsPayloadBucket.bucketName }),
        // ADR-021: the MicroVM substrate's deployment-time configuration. Names
        // are the contract `lambda-microvm-strategy.ts` reads verbatim — do not
        // rename one side without the other.
        ...(props.microvmConfig && {
          MICROVM_IMAGE_IDENTIFIER: props.microvmConfig.imageIdentifier,
          MICROVM_EXECUTION_ROLE_ARN: props.microvmConfig.executionRoleArn,
          MICROVM_EGRESS_CONNECTOR_ARNS: props.microvmConfig.egressConnectorArns.join(','),
          MICROVM_PAYLOAD_BUCKET: props.microvmConfig.payloadBucket.bucketName,
          ...(props.microvmConfig.imageVersion && {
            MICROVM_IMAGE_VERSION: props.microvmConfig.imageVersion,
          }),
          // Omitted entirely when empty: the strategy treats an absent/blank
          // value as "no ingress connectors" and omits the field on RunMicrovm.
          ...((props.microvmConfig.ingressConnectorArns?.length ?? 0) > 0 && {
            MICROVM_INGRESS_CONNECTOR_ARNS: props.microvmConfig.ingressConnectorArns!.join(','),
          }),
        }),
        ...(props.attachmentsBucket && { ATTACHMENTS_BUCKET_NAME: props.attachmentsBucket.bucketName }),
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

    // #502: ECS payload bucket — the orchestrator writes the payload before
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
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmPassExecutionRole',
        actions: ['iam:PassRole'],
        resources: [props.microvmConfig.executionRoleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'lambda.amazonaws.com',
          },
        },
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
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; AgentCore runtime/* required for sub-resource invocation; Secrets Manager wildcards generated by CDK grantRead; AgentCore Memory wildcards generated by CDK grantRead/grantWrite; ECS RunTask/DescribeTasks/StopTask conditioned on cluster ARN; iam:PassRole scoped to ECS task/execution roles and conditioned on ecs-tasks.amazonaws.com; S3 object/* wildcard from CDK grantPut on the dedicated MicroVM payload bucket; MicroVM lifecycle actions (RunMicrovm/GetMicrovm/TerminateMicrovm) are scoped to the single platform MicroVM image ARN plus a <arn>:* version-suffix sibling (every one of them authorizes against the image resource, not the per-session instance; no account-wide wildcard is used); lambda:PassNetworkConnector requires Resource:* because the action supports no resource-level permissions and the AWS-managed connectors live outside this account; iam:PassRole is scoped to the MicroVM execution role and conditioned on lambda.amazonaws.com',
      },
    ], true);
  }
}
