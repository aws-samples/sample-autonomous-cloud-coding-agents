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
import { ArnFormat, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Alias, Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const DURABLE_EXECUTION_TIMEOUT_HOURS = 9;

const DURABLE_RETENTION_DAYS = 14;

const DEFAULT_TASK_RETENTION_DAYS = 90;

const ERROR_ALARM_PERIOD_MINUTES = 5;

const ORCHESTRATOR_TIMEOUT_SECONDS = 60;

const ORCHESTRATOR_MEMORY_MB = 1024;

export interface TaskOrchestratorProps {
  readonly taskTable: dynamodb.ITable;

  readonly taskEventsTable: dynamodb.ITable;

  readonly userConcurrencyTable: dynamodb.ITable;

  readonly runtimeArn?: string;
  /**
   * Backends deployed by this stack; the first is the repository default.
   * Omit only for legacy composition.
   */
  readonly deployedComputeTypes?: ReadonlyArray<'agentcore' | 'ecs' | 'lambda-microvm'>;

  /**
   * The DynamoDB repo config table. When provided, the orchestrator loads
   * per-repo blueprint configuration at the start of each task.
   */
  readonly repoTable?: dynamodb.ITable;

  /**
   * Maximum concurrent tasks per user.
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
     */
    readonly planningTaskDefinitionArn: string;
  };

  /**
   * S3 storage for ECS v2 bootstrap manifests, task payloads and private launch
   * references. The coordinator publishes/signs/replays the reference delivered
   * in AGENT_PAYLOAD_REF, then deletes both task objects at finalization.
   */
  readonly ecsPayloadBucket?: s3.IBucket;

  /**
   * S3 bucket for task attachments. When provided, the orchestrator gets
   * ReadWrite grants for URL fetch/screen/upload during hydration.
   */
  readonly attachmentsBucket?: s3.IBucket;

  /**
   * Non-secret platform identifiers the orchestrator forwards to the in-guest
   * agent as `platform_config` on the MicroVM `/run` payload: a MicroVM snapshot
   * must not bake configuration in (ADR-021 sub-decision 3).
   *
   * Every field is an identifier, never a secret value, and none of them adds an
   * IAM grant to the orchestrator role.
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
     * Per-task SessionRole ARN (`AGENT_SESSION_ROLE_ARN`). When the agent does not
     * receive it, it falls back to ambient compute-role credentials and per-tenant
     * scoping is off.
     */
    readonly agentSessionRoleArn: string;
    /**
     * Cross-region inference-profile id for the small/fast model
     * (`ANTHROPIC_DEFAULT_HAIKU_MODEL`). Must be a GEO-PREFIXED profile id, not a
     * bare foundation-model id — Claude 4.x rejects on-demand invocation by bare
     * id — and must match a granted profile (`constructs/bedrock-models.ts`).
     * The prefix is the geography `resolveBedrockGeoRegion` resolves for the
     * deployment (`bedrockGeoRegion` context, default `us`) (#764).
     */
    readonly anthropicDefaultHaikuModel: string;

    /**
     * The MAIN coding model (`ANTHROPIC_MODEL`), same rules as the auxiliary one
     * above: geo-prefixed profile id from the deployment's resolved geography.
     */
    readonly anthropicModel: string;
    /** Optional SigV4 tool gateway, forwarded to the MicroVM guest. */
    readonly toolGatewayUrl?: string;
  };

  /**
   * AWS Lambda MicroVMs compute strategy configuration (ADR-021 sub-decision 4).
   * When provided, the `MICROVM_*` env vars and the MicroVM lifecycle IAM
   * statements are added to the orchestrator.
   */
  readonly microvmConfig?: {
    /**
     * Image **ARN** passed as `imageIdentifier` on every `RunMicrovm`.
     *
     * Must be an ARN, not a bare name: `RunMicrovm` rejects names
     * (`Malformed ARN - doesn't start with 'arn:'`).
     */
    readonly imageIdentifier: string;
    /**
     * The image's IAM resource ARN, used to scope every MicroVM lifecycle grant
     * to that one platform-created image (ADR-021).
     */
    readonly imageArn: string;
    /**
     * Optional image version pin. Omitted ⇒ the service resolves the latest
     * active version.
     */
    readonly imageVersion?: string;
    /** Coordinator reads and condition-checks the current gate before sleeping. */
    readonly approvalsTable: dynamodb.ITable;
    /** Static opt-in and live Parameter Store value for new suspends; default false. */
    readonly approvalSuspendEnabled?: boolean;
    /** Role the MicroVM assumes at runtime; passed on `RunMicrovm`. */
    readonly executionRoleArn: string;
    /** Egress network connectors; comma-joined into the env var. */
    readonly egressConnectorArns: string[];
    /**
     * Ingress network connectors. `RunMicrovm` attaches a PUBLIC `HTTP_INGRESS`
     * connector (and mints a public `*.lambda-microvm.<region>.on.aws` endpoint)
     * when the request omits the field, so one is passed on every launch (ADR-021).
     */
    readonly ingressConnectorArns: string[];
    /**
     * Bucket for `/run` payloads that exceed the 4 KB `runHookPayload` cap.
     * The orchestrator uploads payloads and deletes `<taskId>/payload.json` at
     * finalization. It does not read them; the execution role is the reader.
     * Lifecycle expiry is the fallback if finalization or deletion fails.
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
  public readonly fn: lambda.NodejsFunction;

  /**
   * The Lambda alias (required for durable function invocation).
   */
  public readonly alias: iam.IGrantable & { functionArn: string };

  public readonly errorAlarm: cloudwatch.Alarm;

  // eslint-disable-next-line complexity -- predates the ceiling (50; 45 when it landed); must not grow
  constructor(scope: Construct, id: string, props: TaskOrchestratorProps) {
    super(scope, id);

    if (props.deployedComputeTypes) {
      const backends = props.deployedComputeTypes;
      const agentcore = backends.includes('agentcore');
      const ecs = backends.includes('ecs');
      if (agentcore !== Boolean(props.runtimeArn)
        || (!agentcore && props.additionalRuntimeArns?.length)
        || ecs !== Boolean(props.ecsConfig)
        || (!backends.includes('lambda-microvm') && props.microvmConfig)) {
        throw new Error(`TaskOrchestrator configuration must match the deployed '${backends.join(', ')}' backends`);
      }
    }

    if (props.guardrailId && !props.guardrailVersion) {
      throw new Error('guardrailVersion is required when guardrailId is provided');
    }
    if (!props.guardrailId && props.guardrailVersion) {
      throw new Error('guardrailId is required when guardrailVersion is provided');
    }

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const maxConcurrent = props.maxConcurrentTasksPerUser ?? 10;
    const suspendParameter = props.microvmConfig ? new ssm.StringParameter(this, 'MicrovmApprovalSuspendEnabled', {
      parameterName: `/${Stack.of(this).stackName}/microvm-approval-suspend-enabled`,
      stringValue: String(props.microvmConfig.approvalSuspendEnabled ?? false),
      description: 'Allow new approval suspensions; existing durable executions reread before suspending.',
      allowedPattern: '^(true|false)$',
    }) : undefined;

    // `@aws-sdk/client-bedrock-agentcore` is bundled, not external: the Lambda runtime's
    // pinned SDK lacks its newer commands (e.g. StopRuntimeSessionCommand).
    const orchestratorBundling: lambda.BundlingOptions = {
      externalModules: [
        '@aws-sdk/client-dynamodb',
        '@aws-sdk/client-ecs',
        '@aws-sdk/client-lambda',
        '@aws-sdk/client-bedrock-runtime',
        '@aws-sdk/client-secrets-manager',
        '@aws-sdk/lib-dynamodb',
        '@aws-sdk/util-dynamodb',
      ],
      nodeModules: ['pdf-parse'],
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
      // Durable executions replay their original code and environment after a
      // deployment. Keep published versions until no execution can resume them.
      currentVersionOptions: { removalPolicy: RemovalPolicy.RETAIN },
      environment: {
        ABCA_COMPONENT: 'orchestr',
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        ...(props.runtimeArn && { RUNTIME_ARN: props.runtimeArn }),
        ...(props.deployedComputeTypes && { DEPLOYED_COMPUTE_TYPE: props.deployedComputeTypes.join(',') }),
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
          ECS_PLANNING_TASK_DEFINITION_ARN: props.ecsConfig.planningTaskDefinitionArn,
        }),
        ...(props.ecsPayloadBucket && { ECS_PAYLOAD_BUCKET: props.ecsPayloadBucket.bucketName }),
        ...(props.microvmConfig && {
          MICROVM_IMAGE_IDENTIFIER: props.microvmConfig.imageIdentifier,
          MICROVM_EXECUTION_ROLE_ARN: props.microvmConfig.executionRoleArn,
          MICROVM_EGRESS_CONNECTOR_ARNS: props.microvmConfig.egressConnectorArns.join(','),
          MICROVM_INGRESS_CONNECTOR_ARNS: props.microvmConfig.ingressConnectorArns.join(','),
          MICROVM_PAYLOAD_BUCKET: props.microvmConfig.payloadBucket.bucketName,
          TASK_APPROVALS_TABLE_NAME: props.microvmConfig.approvalsTable.tableName,
          MICROVM_APPROVAL_SUSPEND_ENABLED: String(props.microvmConfig.approvalSuspendEnabled ?? false),
          MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME: suspendParameter!.parameterName,
          ...(props.microvmConfig.imageVersion && {
            MICROVM_IMAGE_VERSION: props.microvmConfig.imageVersion,
          }),
        }),
        ...(props.attachmentsBucket && { ATTACHMENTS_BUCKET_NAME: props.attachmentsBucket.bucketName }),
        ...(props.agentRegistryId && { AGENT_REGISTRY_ID: props.agentRegistryId }),
        ...(props.agentPlatformConfig && {
          TASK_APPROVALS_TABLE_NAME: props.microvmConfig?.approvalsTable.tableName ?? props.agentPlatformConfig.taskApprovalsTableName,
          NUDGES_TABLE_NAME: props.agentPlatformConfig.nudgesTableName,
          LOG_GROUP_NAME: props.agentPlatformConfig.logGroupName,
          ARTIFACTS_BUCKET_NAME: props.agentPlatformConfig.artifactsBucketName,
          TRACE_ARTIFACTS_BUCKET_NAME: props.agentPlatformConfig.traceArtifactsBucketName,
          AGENT_SESSION_ROLE_ARN: props.agentPlatformConfig.agentSessionRoleArn,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: props.agentPlatformConfig.anthropicDefaultHaikuModel,
          ANTHROPIC_MODEL: props.agentPlatformConfig.anthropicModel,
          ...(props.agentPlatformConfig.toolGatewayUrl && { ABCA_TOOL_GATEWAY_URL: props.agentPlatformConfig.toolGatewayUrl }),
        }),
      },
      bundling: orchestratorBundling,
    });

    props.taskTable.grantReadWriteData(this.fn);
    props.taskEventsTable.grantReadWriteData(this.fn);
    props.userConcurrencyTable.grantReadWriteData(this.fn);
    if (props.repoTable) {
      props.repoTable.grantReadData(this.fn);
    }

    if (props.attachmentsBucket) {
      props.attachmentsBucket.grantReadWrite(this.fn);
    }

    if (props.ecsPayloadBucket) {
      props.ecsPayloadBucket.grantPut(this.fn);
      props.ecsPayloadBucket.grantDelete(this.fn);
    }

    if (props.microvmConfig) {
      props.microvmConfig.payloadBucket.grantPut(this.fn);
      props.microvmConfig.payloadBucket.grantDelete(this.fn);
    }

    this.fn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );

    if (props.githubTokenSecretArn) {
      const githubTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'GitHubTokenSecret', props.githubTokenSecretArn,
      );
      githubTokenSecret.grantRead(this.fn);
    }

    // InvokeAgentRuntime authorizes against a sub-resource (runtime-endpoint/DEFAULT), hence
    // `${arn}/*`. A call that passes `runtimeUserId` also needs InvokeAgentRuntimeForUser.
    const runtimeArns = [...(props.runtimeArn ? [props.runtimeArn] : []), ...(props.additionalRuntimeArns ?? [])];
    const runtimeResources = runtimeArns.flatMap(arn => [arn, `${arn}/*`]);
    if (runtimeResources.length) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeForUser',
          'bedrock-agentcore:StopRuntimeSession',
        ],
        resources: runtimeResources,
      }));
    }

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

    if (props.microvmConfig) {
      const { imageArn } = props.microvmConfig;
      const microvmImageResources = [imageArn, `${imageArn}:*`];

      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmLifecycle',
        actions: [
          'lambda:RunMicrovm',
          'lambda:GetMicrovm',
          'lambda:GetMicrovmImageVersion',
          'lambda:TerminateMicrovm',
          'lambda:SuspendMicrovm',
          'lambda:ResumeMicrovm',
        ],
        resources: microvmImageResources,
      }));
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmApprovalObservation',
        actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
        resources: [props.microvmConfig.approvalsTable.tableArn],
      }));
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmSuspendConfiguration',
        actions: ['ssm:GetParameter'],
        resources: [suspendParameter!.parameterArn],
      }));

      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmPassNetworkConnector',
        actions: ['lambda:PassNetworkConnector'],
        resources: ['*'],
      }));

      // No `iam:PassedToService` condition: Lambda MicroVMs presents no usable value for
      // it on the RunMicrovm PassRole path, and a conditioned grant is denied
      // (ADR-021 P2r2-F10).
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MicrovmPassExecutionRole',
        actions: ['iam:PassRole'],
        resources: [props.microvmConfig.executionRoleArn],
      }));
    }

    for (const [index, secretArn] of (props.additionalSecretArns ?? []).entries()) {
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this, `AdditionalSecret${index}`, secretArn,
      );
      secret.grantRead(this.fn);
    }

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

    // Not `fn.addAlias('live')`: it would change the alias's logical ID, and
    // CloudFormation cannot create a second alias named `live`.
    const version = this.fn.currentVersion;
    const fnAlias = new Alias(version, 'Aliaslive', { aliasName: 'live', version });
    this.alias = fnAlias;

    fnAlias.configureAsyncInvoke({
      retryAttempts: 0,
    });

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
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; AgentCore runtime/* required for sub-resource invocation; Secrets Manager wildcards generated by CDK grantRead; AgentCore Memory wildcards generated by CDK grantRead/grantWrite; ECS RunTask/DescribeTasks/StopTask conditioned on cluster ARN; iam:PassRole scoped to ECS task/execution roles and conditioned on ecs-tasks.amazonaws.com; S3 writes restricted to bootstrap manifests and task payload/launch objects; GetObject and DeleteObject restricted to */payload.json and */launch.json for signing, replay and cleanup; ListBucket is scoped to each payload bucket so absent launch records return NoSuchKey; MicroVM launch/state/sleep/wake/cleanup and image-capability actions (RunMicrovm/GetMicrovm/SuspendMicrovm/ResumeMicrovm/TerminateMicrovm/GetMicrovmImageVersion) are scoped to the single platform MicroVM image ARN plus a <arn>:* version-suffix sibling (every one of them authorizes against the image resource, not the per-session instance; no account-wide wildcard is used); lambda:PassNetworkConnector requires Resource:* because the action supports no resource-level permissions and the AWS-managed connectors live outside this account; iam:PassRole is scoped to the exact MicroVM execution role without iam:PassedToService (ADR-021 P2r2-F10); Agent Registry read scoped to the wired registry ARN, with a record/* suffix wildcard because record ids are server-assigned and unknown at synth (#246)',
      },
    ], true);
  }
}
