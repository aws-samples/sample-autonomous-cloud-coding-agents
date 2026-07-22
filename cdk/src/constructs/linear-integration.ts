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
import { LinearProjectMappingTable } from './linear-project-mapping-table';
import { LinearUserMappingTable } from './linear-user-mapping-table';
import { LinearWorkspaceRegistryTable } from './linear-workspace-registry-table';

/** Default task-record retention used for TTL computation (days). */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/**
 * Webhook-processor Lambda timeout (seconds). ABCA-490: the #299 Mode B
 * decomposition planner makes up to two Bedrock ``InvokeModel`` calls, and the
 * stage-2 decomposer on a large issue can take ~50s (measured: 3055 output
 * tokens ≈ 49s). At the old 30s ceiling the Lambda was killed mid-call — a
 * silent hang + async-retry storm with no user-facing comment. Raised to 120s so
 * a legitimate large decomposition completes; the planner's own per-call budget
 * (PLANNER_INVOKE_TIMEOUT_MS = 75s) is set below this so a genuinely-stuck call
 * still throws into the graceful single-task fallback INSIDE this ceiling. Safe:
 * the receiver returns 200 and async-invokes this processor (InvocationType
 * 'Event'), so nothing waits synchronously on it.
 */
const WEBHOOK_PROCESSOR_TIMEOUT_SECONDS = 120;

/** Webhook-processor Lambda memory (MB). */
const WEBHOOK_PROCESSOR_MEMORY_MB = 512;

/**
 * Properties for LinearIntegration construct.
 */
export interface LinearIntegrationProps {
  /** The existing REST API to add Linear routes to. */
  readonly api: apigw.RestApi;

  /** Cognito user pool for the /linear/link endpoint (Cognito-authenticated). */
  readonly userPool: cognito.IUserPool;

  /** The DynamoDB task table. */
  readonly taskTable: dynamodb.ITable;

  /** The DynamoDB task events table. */
  readonly taskEventsTable: dynamodb.ITable;

  /** The DynamoDB repo config table (optional — for repo onboarding checks). */
  readonly repoTable?: dynamodb.ITable;

  /**
   * OrchestrationTable for #247 Mode A parent/sub-issue orchestration.
   * When provided, the webhook processor probes labeled parent issues for
   * a sub-issue graph (seeds the DAG + releases root children). When
   * omitted, the orchestration path is dormant (ORCHESTRATION_TABLE_NAME
   * unset) and the processor behaves as one-issue → one-task.
   */
  readonly orchestrationTable?: dynamodb.ITable;

  /** Orchestrator Lambda function ARN for async task invocation. */
  readonly orchestratorFunctionArn?: string;

  /**
   * User concurrency counter table (#331). When provided alongside
   * ``orchestrationTable``, the webhook processor throttles the seed-time
   * ROOT release to the user's free concurrency budget so a wide-root epic
   * (many independent sub-issues, no shared foundation) doesn't over-release
   * roots that admission then hard-fails. A failed root is UNRECOVERABLE
   * (the sweep can only re-release a child whose predecessor still shows
   * succeeded — a root has none), so throttling here matters most. Omitted
   * → release all roots (back-compat; admission still gates).
   */
  readonly userConcurrencyTable?: dynamodb.ITable;

  /** Per-user concurrency cap, shared with the orchestrator (#331). Default 10. */
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
}

/**
 * CDK construct that adds Linear integration to the ABCA platform.
 *
 * Inbound-only adapter: Linear → webhook → task creation. Outbound progress
 * updates happen agent-side via the Linear MCP server (see agent/src/channel_mcp.py),
 * so there is NO DynamoDB Streams consumer and NO outbound-notify Lambda here.
 *
 * Creates:
 * - LinearProjectMappingTable (Linear project → GitHub repo mapping)
 * - LinearUserMappingTable (Linear user → platform user mapping)
 * - LinearWorkspaceRegistryTable (Linear workspace → AgentCore credential
 *   provider name; Phase 2.0b OAuth migration). Webhook processor and
 *   orchestrator use this to look up which credential provider holds the
 *   workspace's OAuth token.
 * - LinearWebhookDedupTable (60s TTL dedup for webhook retries)
 * - Lambda handlers for the webhook receiver, async processor, and account linking
 * - API Gateway routes under /linear/*
 * - Two Secrets Manager secrets (webhook signing secret + personal API token)
 */
export class LinearIntegration extends Construct {
  /** Linear project → repo mapping table. */
  public readonly projectMappingTable: dynamodb.Table;

  /** Linear user → platform user mapping table. */
  public readonly userMappingTable: dynamodb.Table;

  /**
   * Registry of Linear workspaces that have completed OAuth onboarding.
   * Lookup `provider_name` (AgentCore credential provider) by Linear
   * `organizationId` from the inbound webhook.
   */
  public readonly workspaceRegistryTable: dynamodb.Table;

  /** Webhook dedup table — (issue_id, action) keys with 60s TTL. */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Linear webhook signing secret (placeholder — populated by `bgagent linear setup`). */
  public readonly webhookSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: LinearIntegrationProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- DynamoDB tables ---
    const projectMapping = new LinearProjectMappingTable(this, 'ProjectMappingTable', { removalPolicy });
    const userMapping = new LinearUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    const workspaceRegistry = new LinearWorkspaceRegistryTable(this, 'WorkspaceRegistryTable', { removalPolicy });
    this.projectMappingTable = projectMapping.table;
    this.userMappingTable = userMapping.table;
    this.workspaceRegistryTable = workspaceRegistry.table;

    // Dedup table: linear webhook retries collapse to a single processor invoke
    // within the 60s TTL window. Keyed on `{issue_id}#{action}`.
    this.webhookDedupTable = new dynamodb.Table(this, 'WebhookDedupTable', {
      partitionKey: { name: 'dedup_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // --- Webhook signing secret (CDK-created placeholder, populated by `bgagent linear setup`) ---
    // Per-workspace OAuth tokens (Phase 2.0b-O2) live in `bgagent-linear-oauth-<slug>`
    // secrets created by the CLI at runtime — not here.
    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'Linear webhook signing secret — populate via `bgagent linear setup`',
      removalPolicy,
    });

    // --- Shared Lambda configuration ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };
    // pdf-parse (v2, pdfjs-based) can't be esbuild-bundled — its pdfjs/native
    // (@napi-rs/canvas) deps break at import (`DOMMatrix is not defined`,
    // ABCA-745). Ship it unbundled via `nodeModules` so it resolves natively at
    // runtime. Mirrors TaskApi's attachment-screening bundling (task-api.ts) and
    // the task-orchestrator. Used by the webhook processor's PDF attachment path.
    const attachmentScreeningBundling: lambda.BundlingOptions = {
      ...commonBundling,
      nodeModules: ['pdf-parse'],
    };

    // --- Task creation environment (matches TaskApi / SlackIntegration pattern) ---
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

    // --- Cognito Authorizer (for /linear/link) ---
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

    // ═══════════════════════════════════════════════════════════════════════════
    // Lambda Handlers
    // ═══════════════════════════════════════════════════════════════════════════

    // --- Webhook processor (async, invoked by receiver) ---
    const webhookProcessorFn = new lambda.NodejsFunction(this, 'WebhookProcessorFn', {
      entry: path.join(handlersDir, 'linear-webhook-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(WEBHOOK_PROCESSOR_TIMEOUT_SECONDS),
      // Default 128 MB OOMs at module init since the attachment-screening
      // path (#176) bundles pdf-parse + URL-resolver libs alongside the
      // existing AWS SDK + bedrock-agentcore deps. 512 MB gives ~4× headroom
      // and lifts CPU enough that p99 startup stays under the API Gateway
      // 30s deadline on cold starts.
      memorySize: WEBHOOK_PROCESSOR_MEMORY_MB,
      environment: {
        ...createTaskEnv,
        LINEAR_PROJECT_MAPPING_TABLE_NAME: this.projectMappingTable.tableName,
        LINEAR_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
        // #247 Mode A: when set, enables parent/sub-issue orchestration
        // (seed DAG + release roots). Unset → orchestration path dormant.
        ...(props.orchestrationTable && {
          ORCHESTRATION_TABLE_NAME: props.orchestrationTable.tableName,
        }),
        // #331: throttle the seed-time root release to the free concurrency
        // budget (see prop doc). Only wired when both tables are present.
        ...(props.orchestrationTable && props.userConcurrencyTable && {
          USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
          MAX_CONCURRENT_TASKS_PER_USER: String(props.maxConcurrentTasksPerUser ?? 10),
        }),
      },
      // Uses the PDF attachment-screening path — pdf-parse must stay unbundled.
      bundling: attachmentScreeningBundling,
    });
    this.projectMappingTable.grantReadData(webhookProcessorFn);
    this.userMappingTable.grantReadData(webhookProcessorFn);
    this.workspaceRegistryTable.grantReadData(webhookProcessorFn);
    // #247: seed the orchestration DAG + release root children.
    if (props.orchestrationTable) {
      props.orchestrationTable.grantReadWriteData(webhookProcessorFn);
    }
    // #331: read the user concurrency counter to throttle the root release.
    if (props.orchestrationTable && props.userConcurrencyTable) {
      props.userConcurrencyTable.grantReadData(webhookProcessorFn);
    }
    // Phase 2.0b-O2: per-workspace OAuth token secrets are created by the
    // CLI at setup time (`bgagent-linear-oauth-<slug>`), not by CDK. Grant
    // the webhook processor Get + Put on the prefix so it can read tokens
    // and write back rotated refresh-token JSON during expiring-token
    // refresh.
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
    props.taskTable.grantReadWriteData(webhookProcessorFn);
    props.taskEventsTable.grantReadWriteData(webhookProcessorFn);
    if (props.repoTable) {
      props.repoTable.grantReadData(webhookProcessorFn);
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
    // #299 BLOCKER-1: the DETERMINISTIC revise path (interpret a plan-edit
    // instruction → structured edits, applied to the current plan in code) makes
    // ONE short bedrock:InvokeModel call to the interpret model. Scoped to the
    // single sonnet foundation-model + its cross-region inference-profile ARN
    // (parity with the ecs-agent-cluster + agent.ts grants), NOT the '*' the
    // retired inline PLANNER once held — the planner itself stays in the
    // ``coding/decompose-v1`` agent. Only the tiny "which edit did they mean"
    // classification runs inline here (full-plan generation never does).
    for (const arn of [
      Stack.of(this).formatArn({
        service: 'bedrock',
        region: '*',
        account: '',
        resource: 'foundation-model',
        resourceName: 'anthropic.claude-sonnet-4-6',
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      }),
      Stack.of(this).formatArn({
        service: 'bedrock',
        resource: 'inference-profile',
        resourceName: 'us.anthropic.claude-sonnet-4-6',
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      }),
    ]) {
      webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [arn],
      }));
    }
    // Issue descriptions can carry markdown `![alt](https://…)` images, which
    // `extractImageUrlAttachments` (linear-webhook-processor.ts) turns into
    // URL attachments. `createTaskCore` then uploads the screened bytes to
    // `ATTACHMENTS_BUCKET_NAME`, mirroring the TaskApi/Slack paths. Without
    // grantPut + grantDelete here, that upload fails closed with 503.
    if (props.attachmentsBucket) {
      props.attachmentsBucket.grantPut(webhookProcessorFn);
      props.attachmentsBucket.grantDelete(webhookProcessorFn);
    }

    // --- Webhook receiver (verifies HMAC, dedups, invokes processor) ---
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
        // Per-workspace signing-secret lookup — selects the right
        // workspace's `webhook_signing_secret` from the OAuth secret
        // bundle so multi-workspace installs verify correctly. Receiver
        // falls back to LINEAR_WEBHOOK_SECRET_ARN when this lookup
        // misses (back-compat for single-workspace installs).
        LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
      },
      bundling: commonBundling,
    });
    this.webhookSecret.grantRead(webhookFn);
    this.webhookDedupTable.grantReadWriteData(webhookFn);
    this.workspaceRegistryTable.grantReadData(webhookFn);
    // Read-only on the per-workspace OAuth secret prefix — we extract
    // `webhook_signing_secret` for verification but never mutate; the
    // CLI owns the lifecycle of these secrets.
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

    // --- Account linking (Cognito-authenticated) ---
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

    // ═══════════════════════════════════════════════════════════════════════════
    // API Gateway Routes
    // ═══════════════════════════════════════════════════════════════════════════

    const linear = props.api.root.addResource('linear');

    // POST /v1/linear/webhook — HMAC-verified; no Cognito.
    const webhookResource = linear.addResource('webhook');
    const webhookMethod = webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(webhookFn),
      noneAuthOptions,
    );

    // POST /v1/linear/link — Cognito-authenticated.
    const linkResource = linear.addResource('link');
    linkResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(linkFn),
      cognitoAuthOptions,
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // cdk-nag suppressions
    // ═══════════════════════════════════════════════════════════════════════════

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

    const allFunctions = [webhookFn, webhookProcessorFn, linkFn];
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
            + '(operators add workspaces by slug at runtime via `bgagent linear add-workspace`).',
        },
      ], true);
    }
  }
}
