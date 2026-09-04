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

/** Default task-record retention used for TTL computation (days). */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/**
 * Webhook-processor Lambda timeout (seconds). One event drives a chain of real
 * synchronous work: resolve the workspace OAuth token, probe the issue, fetch +
 * screen + store every attachment (each a network round-trip plus a guardrail
 * call), seed the sub-issue graph, and release the root children — each release
 * being its own task admission. At the old 30s ceiling an issue with several
 * attachments or a wide root layer was killed mid-call, which surfaces as a
 * silent hang plus an async-retry storm and no user-facing comment. 120s leaves
 * room for the worst realistic case. Safe: the receiver returns 200 and
 * async-invokes this processor (InvocationType 'Event'), so nothing waits
 * synchronously on it.
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
   * ROOT release to the user's free concurrency budget so a wide-root epic
   * (many independent sub-issues, no shared foundation) doesn't over-release
   * roots that admission then hard-fails. A failed root is UNRECOVERABLE
   * (the sweep can only re-release a child whose predecessor still shows
   * succeeded — a root has none), so throttling here matters most. Omitted
   * → release all roots (back-compat; admission still gates).
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
   * Optional AgentCore Identity vault backing Linear OAuth tokens (RFC #249
   * Phase 1). When provided, the webhook processor is granted the token
   * data-plane permissions and told which workload identity to use via
   * `LINEAR_VAULT_ENABLED` / `LINEAR_WORKLOAD_IDENTITY_NAME`; the resolver then
   * mints tokens through the vault, falling back to the per-workspace Secrets
   * Manager token when issuance is unavailable. Omitted (the default) ⇒ the
   * existing Secrets-Manager-only path, synthesized byte-for-byte unchanged.
   */
  readonly identityVault?: LinearIdentityVault;
}

/**
 * CDK construct that adds Linear integration to the ABCA platform.
 *
 * Inbound-only adapter: Linear → webhook → task creation. Outbound updates are
 * deterministic (ADR-016 — there is NO Linear MCP): reactions + state transitions
 * from the agent's direct GraphQL (`linear_reactions.py`), and start / PR-opened /
 * terminal comments from the Lambda tier (webhook processor + fan-out dispatcher).
 * So there is NO DynamoDB Streams consumer and NO outbound-notify Lambda here.
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

  /** Webhook async processor — resolves the workspace OAuth token (vault or SM). */
  public readonly webhookProcessorFn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: LinearIntegrationProps) {
    super(scope, id);

    // Solution-attribution component label (#319): every Lambda in this Linear
    // integration is part of the webhook ingest surface. One aspect labels
    // them all (and any future function added here); the universal `app/`
    // segment is set by the stack-level aspect.
    Aspects.of(this).add(new ComponentUaAspect('webhook'));

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
    // (@napi-rs/canvas) deps break at import (`DOMMatrix is not defined`).
    // Ship it unbundled via `nodeModules` so it resolves natively at
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
      // path bundles pdf-parse + URL-resolver libs alongside the
      // existing AWS SDK + bedrock-agentcore deps. 512 MB gives ~4× headroom
      // and lifts CPU enough that p99 startup stays under the API Gateway
      // 30s deadline on cold starts.
      memorySize: WEBHOOK_PROCESSOR_MEMORY_MB,
      environment: {
        ...createTaskEnv,
        LINEAR_PROJECT_MAPPING_TABLE_NAME: this.projectMappingTable.tableName,
        LINEAR_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
        // When set, enables parent/sub-issue orchestration
        // (seed DAG + release roots). Unset → orchestration path dormant.
        ...(props.orchestrationTable && {
          ORCHESTRATION_TABLE_NAME: props.orchestrationTable.tableName,
        }),
        // Throttle the seed-time root release to the free concurrency
        // budget (see prop doc). Only wired when both tables are present.
        ...(props.orchestrationTable && props.userConcurrencyTable && {
          USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
          MAX_CONCURRENT_TASKS_PER_USER: String(props.maxConcurrentTasksPerUser ?? 10),
        }),
        // RFC #249 Phase 1: when an identity vault is wired, resolve Linear
        // tokens through the AgentCore Token Vault (falling back to the
        // per-workspace SM token when issuance is unavailable). Unset ⇒ the
        // resolver stays on the Secrets-Manager-only path.
        ...(props.identityVault && {
          LINEAR_VAULT_ENABLED: 'true',
          LINEAR_WORKLOAD_IDENTITY_NAME: props.identityVault.workloadName,
        }),
        // #812: this role — and ONLY this role — holds registry write, so the recorder
        // runs here; elsewhere the conditional write fails AccessDenied and is swallowed.
        // The cost is that the other minting Lambdas discover a dead grant log-only. Most
        // still get a latch, because the workspace keeps delivering events to this
        // processor; the orchestration reconciler does not — it is driven by the task
        // table's stream, not by Linear — so a workspace dying mid-orchestration with no
        // further Linear activity is never alerted on, and `platform doctor` (which probes
        // live) is the signal there. Granting the reconciler write would widen the grant
        // the threat-model note below argues down, to recover an alert, not a diagnosis.
        LINEAR_REVOCATION_RECORDING: 'true',
      },
      // Uses the PDF attachment-screening path — pdf-parse must stay unbundled.
      bundling: attachmentScreeningBundling,
    });
    this.webhookProcessorFn = webhookProcessorFn;
    this.projectMappingTable.grantReadData(webhookProcessorFn);
    this.userMappingTable.grantReadData(webhookProcessorFn);
    // WRITE, not just read (#812). `markWorkspaceRevoked` has existed since the
    // revocation was first diagnosed but was permanently inert: every
    // token-resolving role held read-only registry access, so the conditional
    // update failed AccessDenied and the failure was deliberately swallowed (a
    // diagnosis must never break token resolution). The feature therefore read as
    // implemented while doing nothing. This processor is the right holder of the
    // write — it is the path a revoked workspace hits on every event, and the
    // update is conditioned on `installed_at` so a verdict can never revoke the
    // successor installation.
    //
    // `UpdateItem` only, NOT `grantReadWriteData`. The handler's entire write
    // vocabulary on this table is three conditional updates (latch, un-latch,
    // announcement claim); `grantReadWriteData` would additionally hand it
    // PutItem/DeleteItem/BatchWriteItem, and on the indexes. That breadth matters
    // more here than usual: this is the Lambda that runs `pdf-parse` over
    // attacker-supplied attachments, and a row in THIS table selects which signing
    // secret verifies an inbound webhook HMAC — so create/delete on it would be a
    // path from a malicious attachment to accepting forged webhooks.
    this.workspaceRegistryTable.grantReadData(webhookProcessorFn);
    webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      // The base table only. No `index/*`: UpdateItem never targets an index.
      resources: [this.workspaceRegistryTable.tableArn],
    }));
    // Seed the orchestration DAG + release root children.
    if (props.orchestrationTable) {
      props.orchestrationTable.grantReadWriteData(webhookProcessorFn);
    }
    // Read the user concurrency counter to throttle the root release.
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
    // RFC #249 Phase 1: grant the vault token data-plane calls when an identity
    // vault is wired. The SM grant above stays regardless — it is the fallback
    // path when vault issuance is unavailable.
    if (props.identityVault) {
      props.identityVault.grantMintToken(webhookProcessorFn);
    }
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
    // No bedrock:InvokeModel grant: this processor never calls a model directly.
    // Its only Bedrock use is ApplyGuardrail above, to screen third-party text and
    // attachment bytes before they reach an agent. All model inference happens
    // inside the agent runtime, under the agent's own role.
    //
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
      new apigw.LambdaIntegration(webhookFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    // POST /v1/linear/link — Cognito-authenticated.
    const linkResource = linear.addResource('link');
    linkResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(linkFn, { allowTestInvoke: false }),
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
