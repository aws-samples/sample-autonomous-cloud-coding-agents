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
import { ArnFormat, Aspects, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { LinearIdentityVault } from './linear-identity-vault';
import { LinearProjectMappingTable } from './linear-project-mapping-table';
import { LinearUserMappingTable } from './linear-user-mapping-table';
import { LinearWorkspaceRegistryTable } from './linear-workspace-registry-table';
import { ComponentUaAspect } from './solution-ua-aspect';

const DEFAULT_TASK_RETENTION_DAYS = 90;

const WEBHOOK_PROCESSOR_TIMEOUT_SECONDS = 120;

const WEBHOOK_PROCESSOR_MEMORY_MB = 512;

const REMOVE_WORKSPACE_TIMEOUT_SECONDS = 10;

export interface LinearIntegrationProps {
  /** The existing REST API to add Linear routes to. */
  readonly api: apigw.RestApi;

  /** Cognito user pool for the /linear/link endpoint (Cognito-authenticated). */
  readonly userPool: cognito.IUserPool;

  readonly taskTable: dynamodb.ITable;

  readonly taskEventsTable: dynamodb.ITable;

  /** Monthly user/team budget configuration and spend table. */
  readonly budgetTable?: dynamodb.ITable;

  /** The DynamoDB repo config table (optional — for repo onboarding checks). */
  readonly repoTable?: dynamodb.ITable;

  /**
   * OrchestrationTable for parent/sub-issue orchestration.
   * When provided, the webhook processor probes labeled parent issues for
   * a sub-issue graph (seeds the DAG + releases root children). When
   * omitted, the orchestration path is dormant (ORCHESTRATION_TABLE_NAME
   * unset) and the processor behaves as one-issue → one-task.
   */
  readonly orchestrationTable?: dynamodb.ITable;

  /** Orchestrator Lambda function ARN for async task invocation. */
  readonly orchestratorFunctionArn?: string;

  /**
   * User concurrency counter table. When provided alongside
   * ``orchestrationTable``, the webhook processor throttles the seed-time
   * ROOT release to the user's free concurrency budget. Omitted
   * → release all roots (admission still gates).
   */
  readonly userConcurrencyTable?: dynamodb.ITable;

  /** Per-user concurrency cap, shared with the orchestrator. Default 10. */
  readonly maxConcurrentTasksPerUser?: number;

  /** Bedrock Guardrail ID for input screening. */
  readonly guardrailId?: string;

  /** Bedrock Guardrail version for input screening. */
  readonly guardrailVersion?: string;

  /**
   * S3 bucket for attachment storage. Required to support image attachments
   * extracted from issue descriptions (markdown `![alt](https://…)` images).
   * When omitted, Linear-triggered tasks with image attachments fail at
   * `createTaskCore` with "Attachment storage is not configured."
   */
  readonly attachmentsBucket?: s3.IBucket;

  /** Task retention in days for TTL computation. */
  readonly taskRetentionDays?: number;

  /** Removal policy for Linear DynamoDB tables. */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Optional AgentCore Identity vault backing Linear OAuth tokens. When
   * provided, the webhook processor is granted the token
   * data-plane permissions and told which workload identity to use via
   * `LINEAR_VAULT_ENABLED` / `LINEAR_WORKLOAD_IDENTITY_NAME`; the resolver then
   * mints tokens through the vault, falling back to the per-workspace Secrets
   * Manager token when issuance is unavailable. Omitted (the default) ⇒ the
   * Secrets-Manager-only path.
   */
  readonly identityVault?: LinearIdentityVault;

  /**
   * Native Linear agent-session channel. When set, the webhook receiver
   * forwards ``AgentSessionEvent`` deliveries and the processor answers them
   * with agent activities (``LINEAR_AGENT_SESSIONS_ENABLED``); the standalone
   * ``@bgagent`` comment trigger yields to the session for the same mention.
   * Omitted (the default) ⇒ agent-session events are acknowledged and ignored.
   */
  readonly agentSessions?: {
    /**
     * Task nudges table. A follow-up prompt into a session whose task is still
     * running is forwarded to the agent as a nudge; without it the processor
     * tells the user to wait for the run to finish.
     */
    readonly nudgesTable?: dynamodb.ITable;
    /**
     * Per-user nudge rate limit, the value TaskApi gives ``POST /tasks/{id}/nudge``.
     * Both paths spend the same counter row, so they must agree. Default 10.
     */
    readonly nudgeRateLimitPerMinute?: number;
    /**
     * Compute backends a session ``stop`` may shut down, mirroring the grants
     * ``DELETE /tasks/{id}`` holds (TaskApi's cancel Lambda).
     * Each is optional so a deployment without that backend gets no grant.
     */
    readonly stopCompute?: {
      /** AgentCore runtime ARN → ``bedrock-agentcore:StopRuntimeSession`` + ``RUNTIME_ARN``. */
      readonly agentCoreRuntimeArn?: string;
      /** ECS cluster ARN → ``ecs:StopTask`` (conditioned on the cluster) + ``ECS_CLUSTER_ARN``. */
      readonly ecsClusterArn?: string;
      /** Platform MicroVM image ARN → ``lambda:TerminateMicrovm``. */
      readonly lambdaMicrovmImageArn?: string;
    };
  };
}

/**
 * CDK construct that adds Linear integration to the ABCA platform.
 *
 * Inbound-only adapter: Linear → webhook → task creation.
 *
 * Creates:
 * - LinearProjectMappingTable (Linear project → GitHub repo mapping)
 * - LinearUserMappingTable (Linear user → platform user mapping)
 * - LinearWorkspaceRegistryTable (onboarded Linear workspaces)
 * - LinearWebhookDedupTable (8h TTL dedup for webhook retries)
 * - Lambda handlers for the webhook receiver, async processor, account linking
 *   and workspace removal
 * - API Gateway routes under /linear/*
 * - Webhook signing-secret placeholder (populated by `bgagent linear setup`)
 */
export class LinearIntegration extends Construct {
  /** Linear project → repo mapping table. */
  public readonly projectMappingTable: dynamodb.Table;

  /** Linear user → platform user mapping table. */
  public readonly userMappingTable: dynamodb.Table;

  /**
   * Registry of Linear workspaces that have completed OAuth onboarding,
   * keyed by Linear `organizationId`.
   */
  public readonly workspaceRegistryTable: dynamodb.Table;

  /** Webhook dedup table — delivery rows keyed on (data.id, action, webhookTimestamp), 8h TTL. */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Linear webhook signing secret (placeholder — populated by `bgagent linear setup`). */
  public readonly webhookSecret: secretsmanager.Secret;

  /** Webhook async processor — resolves the workspace OAuth token (vault or SM). */
  public readonly webhookProcessorFn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: LinearIntegrationProps) {
    super(scope, id);

    Aspects.of(this).add(new ComponentUaAspect('webhook'));

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    const projectMapping = new LinearProjectMappingTable(this, 'ProjectMappingTable', { removalPolicy });
    const userMapping = new LinearUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    const workspaceRegistry = new LinearWorkspaceRegistryTable(this, 'WorkspaceRegistryTable', { removalPolicy });
    this.projectMappingTable = projectMapping.table;
    this.userMappingTable = userMapping.table;
    this.workspaceRegistryTable = workspaceRegistry.table;

    this.webhookDedupTable = new dynamodb.Table(this, 'WebhookDedupTable', {
      partitionKey: { name: 'dedup_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'Linear webhook signing secret — populate via `bgagent linear setup`',
      removalPolicy,
    });

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };
    // pdf-parse (v2, pdfjs-based) can't be esbuild-bundled — its pdfjs/native
    // (@napi-rs/canvas) deps break at import (`DOMMatrix is not defined`).
    const attachmentScreeningBundling: lambda.BundlingOptions = {
      ...commonBundling,
      nodeModules: ['pdf-parse'],
    };
    // The Lambda runtime's own AWS SDK lags current and may not carry the
    // StopRuntimeSession / TerminateMicrovm clients or commands, and an
    // externalized import that is missing fails at module init.
    const webhookProcessorBundling: lambda.BundlingOptions = {
      ...attachmentScreeningBundling,
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
    };

    const createTaskEnv: Record<string, string> = {
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? DEFAULT_TASK_RETENTION_DAYS),
    };
    if (props.repoTable) {
      createTaskEnv.REPO_TABLE_NAME = props.repoTable.tableName;
    }
    if (props.orchestratorFunctionArn) {
      createTaskEnv.ORCHESTRATOR_FUNCTION_ARN = props.orchestratorFunctionArn;
    }
    if (props.guardrailId && props.guardrailVersion) {
      createTaskEnv.GUARDRAIL_ID = props.guardrailId;
      createTaskEnv.GUARDRAIL_VERSION = props.guardrailVersion;
    }
    if (props.attachmentsBucket) {
      createTaskEnv.ATTACHMENTS_BUCKET_NAME = props.attachmentsBucket.bucketName;
    }
    if (props.budgetTable) {
      createTaskEnv.BUDGET_TABLE_NAME = props.budgetTable.tableName;
      createTaskEnv.USER_POOL_ID = props.userPool.userPoolId;
    }

    const cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'LinearCognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
    });
    const cognitoAuthOptions: apigw.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };
    const noneAuthOptions: apigw.MethodOptions = {
      authorizationType: apigw.AuthorizationType.NONE,
    };

    const webhookProcessorFn = new lambda.NodejsFunction(this, 'WebhookProcessorFn', {
      entry: path.join(handlersDir, 'linear-webhook-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(WEBHOOK_PROCESSOR_TIMEOUT_SECONDS),
      memorySize: WEBHOOK_PROCESSOR_MEMORY_MB,
      environment: {
        ...createTaskEnv,
        LINEAR_PROJECT_MAPPING_TABLE_NAME: this.projectMappingTable.tableName,
        LINEAR_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
        LINEAR_WEBHOOK_DEDUP_TABLE_NAME: this.webhookDedupTable.tableName,
        ...(props.orchestrationTable && {
          ORCHESTRATION_TABLE_NAME: props.orchestrationTable.tableName,
        }),
        ...(props.orchestrationTable && props.userConcurrencyTable && {
          USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
          MAX_CONCURRENT_TASKS_PER_USER: String(props.maxConcurrentTasksPerUser ?? 10),
        }),
        ...(props.identityVault && {
          LINEAR_VAULT_ENABLED: 'true',
          LINEAR_WORKLOAD_IDENTITY_NAME: props.identityVault.workloadName,
        }),
        LINEAR_REVOCATION_RECORDING: 'true',
        ...(props.agentSessions && { LINEAR_AGENT_SESSIONS_ENABLED: 'true' }),
        ...agentSessionProcessorEnv(props.agentSessions),
      },
      bundling: webhookProcessorBundling,
    });
    this.webhookProcessorFn = webhookProcessorFn;
    this.projectMappingTable.grantReadData(webhookProcessorFn);
    this.userMappingTable.grantReadData(webhookProcessorFn);
    this.workspaceRegistryTable.grantReadData(webhookProcessorFn);
    webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [this.workspaceRegistryTable.tableArn],
    }));
    webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:DeleteItem'],
      resources: [this.webhookDedupTable.tableArn],
    }));
    if (props.orchestrationTable) {
      props.orchestrationTable.grantReadWriteData(webhookProcessorFn);
    }
    if (props.orchestrationTable && props.userConcurrencyTable) {
      props.userConcurrencyTable.grantReadData(webhookProcessorFn);
    }
    webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
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
    if (props.identityVault) {
      props.identityVault.grantMintToken(webhookProcessorFn);
    }
    props.taskTable.grantReadWriteData(webhookProcessorFn);
    props.taskEventsTable.grantReadWriteData(webhookProcessorFn);
    if (props.repoTable) {
      props.repoTable.grantReadData(webhookProcessorFn);
    }
    if (props.budgetTable) {
      props.budgetTable.grantReadData(webhookProcessorFn);
      webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [props.userPool.userPoolArn],
      }));
    }
    if (props.orchestratorFunctionArn) {
      webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.orchestratorFunctionArn],
      }));
    }
    if (props.guardrailId) {
      webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
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
    if (props.attachmentsBucket) {
      props.attachmentsBucket.grantPut(webhookProcessorFn);
      props.attachmentsBucket.grantDelete(webhookProcessorFn);
    }
    grantAgentSessionAccess(webhookProcessorFn, this.webhookDedupTable, props.agentSessions);

    const webhookFn = new lambda.NodejsFunction(this, 'WebhookFn', {
      entry: path.join(handlersDir, 'linear-webhook.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        LINEAR_WEBHOOK_SECRET_ARN: this.webhookSecret.secretArn,
        LINEAR_WEBHOOK_DEDUP_TABLE_NAME: this.webhookDedupTable.tableName,
        LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME: webhookProcessorFn.functionName,
        LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
        ...(props.agentSessions && { LINEAR_AGENT_SESSIONS_ENABLED: 'true' }),
      },
      bundling: commonBundling,
    });
    this.webhookSecret.grantRead(webhookFn);
    this.webhookDedupTable.grantReadWriteData(webhookFn);
    this.workspaceRegistryTable.grantReadData(webhookFn);
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
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
    webhookProcessorFn.grantInvoke(webhookFn);

    const linkFn = new lambda.NodejsFunction(this, 'LinkFn', {
      entry: path.join(handlersDir, 'linear-link.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        LINEAR_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
      },
      bundling: commonBundling,
    });
    this.userMappingTable.grantReadWriteData(linkFn);

    const removeWorkspaceFn = new lambda.NodejsFunction(this, 'RemoveWorkspaceFn', {
      entry: path.join(handlersDir, 'linear-remove-workspace.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(REMOVE_WORKSPACE_TIMEOUT_SECONDS),
      environment: {
        LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
      },
      bundling: commonBundling,
    });
    this.workspaceRegistryTable.grantReadWriteData(removeWorkspaceFn);
    removeWorkspaceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DeleteSecret'],
      resources: [
        Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-linear-oauth-*',
        }),
      ],
    }));

    const linear = props.api.root.addResource('linear');

    const webhookResource = linear.addResource('webhook');
    const webhookMethod = webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(webhookFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    const linkResource = linear.addResource('link');
    linkResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(linkFn, { allowTestInvoke: false }),
      cognitoAuthOptions,
    );

    const workspacesResource = linear.addResource('workspaces');
    const workspaceBySlug = workspacesResource.addResource('{slug}');
    workspaceBySlug.addMethod(
      'DELETE',
      new apigw.LambdaIntegration(removeWorkspaceFn, { allowTestInvoke: false }),
      cognitoAuthOptions,
    );

    NagSuppressions.addResourceSuppressions(webhookMethod, [
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Linear webhook endpoint uses Linear-Signature HMAC verification instead of Cognito — by design for Linear webhook integration',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'Linear webhook endpoint uses Linear-Signature HMAC verification instead of Cognito — by design for Linear webhook integration',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.webhookSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Linear webhook signing secret is managed externally (Linear web UI) — automatic rotation is not applicable',
      },
    ]);

    const allFunctions = [webhookFn, webhookProcessorFn, linkFn, removeWorkspaceFn];
    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended managed policy for Lambda functions',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcards cover (a) DynamoDB index ARN patterns from CDK grant helpers, '
            + 'and (b) the Secrets Manager `bgagent-linear-oauth-*` prefix grant — '
            + 'the per-workspace OAuth secret name is not known at synth time '
            + '(operators add workspaces by slug at runtime via `bgagent linear add-workspace`). '
            + 'With the agent-session flag on, the webhook processor additionally holds (c) the stop actions a '
            + 'session `stop` needs, scoped like the cancel API: `ecs:StopTask` on `*` conditioned on the one '
            + 'cluster ARN (task ARNs are not known at synth time), `StopRuntimeSession` on the one runtime ARN '
            + 'and its `/*` session children, and `TerminateMicrovm` on the one platform image ARN and its '
            + '`:*` version suffix.',
        },
      ], true);
    }
  }
}

type AgentSessionsProps = NonNullable<LinearIntegrationProps['agentSessions']>;

function agentSessionProcessorEnv(agentSessions: AgentSessionsProps | undefined): Record<string, string> {
  if (!agentSessions) return {};
  const { nudgesTable, stopCompute } = agentSessions;
  return {
    ...(nudgesTable && {
      NUDGES_TABLE_NAME: nudgesTable.tableName,
      NUDGE_RATE_LIMIT_PER_MINUTE: String(agentSessions.nudgeRateLimitPerMinute ?? 10),
    }),
    ...(stopCompute?.agentCoreRuntimeArn && { RUNTIME_ARN: stopCompute.agentCoreRuntimeArn }),
    ...(stopCompute?.ecsClusterArn && { ECS_CLUSTER_ARN: stopCompute.ecsClusterArn }),
  };
}

function grantAgentSessionAccess(
  processorFn: lambda.NodejsFunction,
  webhookDedupTable: dynamodb.ITable,
  agentSessions: AgentSessionsProps | undefined,
): void {
  if (!agentSessions) return;
  if (agentSessions.nudgesTable) {
    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [agentSessions.nudgesTable.tableArn],
    }));
  }
  processorFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem'],
    resources: [webhookDedupTable.tableArn],
  }));
  const stopCompute = agentSessions.stopCompute;
  if (stopCompute?.agentCoreRuntimeArn) {
    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:StopRuntimeSession'],
      resources: [stopCompute.agentCoreRuntimeArn, `${stopCompute.agentCoreRuntimeArn}/*`],
    }));
  }
  if (stopCompute?.ecsClusterArn) {
    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:StopTask'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': stopCompute.ecsClusterArn } },
    }));
  }
  if (stopCompute?.lambdaMicrovmImageArn) {
    // `lambda:TerminateMicrovm` authorizes against the MicroVM image.
    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:TerminateMicrovm'],
      resources: [stopCompute.lambdaMicrovmImageArn, `${stopCompute.lambdaMicrovmImageArn}:*`],
    }));
  }
}
