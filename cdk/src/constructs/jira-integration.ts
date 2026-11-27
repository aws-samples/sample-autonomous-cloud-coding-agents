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
import { integrationTable, webhookDedupTable } from './integration-parts';
import { ComponentUaAspect } from './solution-ua-aspect';

/** Default task-record retention used for TTL computation (days). */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/**
 * Webhook-processor Lambda timeout (seconds). The processor is invoked
 * asynchronously (not behind the API Gateway 30s deadline), so it can run
 * longer than the receiver. #577 added serial authenticated download +
 * Bedrock screening of up to 10 Jira attachments; the per-attachment fetch
 * timeout alone (10s) can sum past 60s across a full batch, and a mid-loop
 * kill would orphan objects and force an idempotent retry. 300s covers the
 * worst-case serial batch with headroom. (A future optimization could
 * parallelize the download/screen loop and lower this again.)
 */
const WEBHOOK_PROCESSOR_TIMEOUT_SECONDS = 300;

/**
 * Marker key embedded in the auto-generated stack-wide webhook-secret
 * placeholder. `bgagent jira setup` replaces the complete placeholder with
 * the sole active tenant's admin-console webhook secret.
 */
const JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY = 'abca_jira_webhook_placeholder';

/**
 * Webhook-processor Lambda memory (MB). Matches the Linear processor — the
 * same attachment-screening path bundles pdf-parse + the URL resolver, and
 * the ADF→markdown walker adds a small working set. Keeps p99 cold-start
 * under the API Gateway 30s deadline.
 */
const WEBHOOK_PROCESSOR_MEMORY_MB = 512;

/**
 * Properties for JiraIntegration construct.
 */
export interface JiraIntegrationProps {
  /** The existing REST API to add Jira routes to. */
  readonly api: apigw.RestApi;

  /** Cognito user pool for the /jira/link endpoint (Cognito-authenticated). */
  readonly userPool: cognito.IUserPool;

  /** The DynamoDB task table. */
  readonly taskTable: dynamodb.ITable;

  /** The DynamoDB task events table. */
  readonly taskEventsTable: dynamodb.ITable;

  /** Monthly user/team budget configuration and spend table. */
  readonly budgetTable?: dynamodb.ITable;

  /** Shared orchestration DAG table. Omit to retain one-issue/one-task mode. */
  readonly orchestrationTable?: dynamodb.ITable;

  /**
   * User concurrency counter table. When provided with ``orchestrationTable``,
   * seed and retry releases are limited to the user's current free slots.
   */
  readonly userConcurrencyTable?: dynamodb.ITable;

  /** Per-user concurrency cap shared with task admission. Default 10. */
  readonly maxConcurrentTasksPerUser?: number;

  /** The DynamoDB repo config table (optional — for repo onboarding checks). */
  readonly repoTable?: dynamodb.ITable;

  /** Orchestrator Lambda function ARN for async task invocation. */
  readonly orchestratorFunctionArn?: string;

  /** Bedrock Guardrail ID for input screening. */
  readonly guardrailId?: string;

  /** Bedrock Guardrail version for input screening. */
  readonly guardrailVersion?: string;

  /**
   * S3 bucket for task attachment storage. Required for the webhook processor
   * to fetch, screen, and store Jira `media` file attachments at task-admission
   * time (issue #577). When omitted, issues carrying supported file attachments
   * are rejected with a Jira comment rather than silently dropping them.
   */
  readonly attachmentsBucket?: s3.IBucket;

  /** Task retention in days for TTL computation. */
  readonly taskRetentionDays?: number;

  /** Removal policy for Jira DynamoDB tables. */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * CDK construct that adds Jira Cloud integration to the ABCA platform.
 *
 * This construct owns Jira → webhook → task creation. Outbound progress uses
 * the Forge app actor (or the OAuth migration fallback) through
 * agent/src/jira_reactions.py and the shared fan-out consumer; those writers
 * are wired outside this inbound construct. See ADR-015.
 *
 * Creates:
 * - JiraProjectMappingTable (`{cloudId}#{projectKey}` → GitHub repo)
 * - JiraUserMappingTable (`{cloudId}#{accountId}` → platform user; with
 *   GSI for reverse lookup and `pending#{code}` link rows)
 * - JiraWorkspaceRegistryTable (`cloudId` → per-tenant OAuth secret ARN).
 *   Webhook receiver and processor look up the tenant's `oauth_secret_arn`
 *   here from the inbound webhook's `cloudId`, then read the per-tenant
 *   signing/OAuth secret from Secrets Manager (see jira-oauth-resolver.ts).
 * - JiraWebhookDedupTable (8h TTL dedup for webhook retries)
 * - Lambda handlers for the webhook receiver, async processor, and account linking
 * - API Gateway routes under /jira/*
 * - Webhook signing-secret placeholder (populated by `bgagent jira setup`)
 */
export class JiraIntegration extends Construct {
  /**
   * DynamoDB table mapping Jira Cloud projects to GitHub repositories.
   *
   * Schema: jira_project_identity (PK) — composite key `{cloudId}#{projectKey}`.
   * `cloudId` is the Atlassian tenant identifier; `projectKey` is the human
   * project key (e.g. `ENG`).
   *
   * Fields:
   * - repo — `owner/repo`
   * - cloud_id — duplicated from the PK for filtering by tenant
   * - project_key — duplicated from the PK
   * - label_filter — Jira issue label that triggers a task (default `bgagent`)
   * - status — 'active' | 'removed'
   * - onboarded_at, updated_at — ISO timestamps
   */
  public readonly projectMappingTable: dynamodb.Table;

  /**
   * DynamoDB table for mapping Jira user identities to platform user IDs.
   *
   * Schema: jira_identity (PK) — composite key `{cloudId}#{accountId}` for
   * confirmed mappings, `pending#{code}` for in-flight link codes (with TTL).
   * `accountId` is Atlassian's stable per-tenant user identifier returned by
   * the OAuth identity endpoint and present on issue events.
   *
   * GSIs:
   * - PlatformUserIndex (PK: platform_user_id, SK: linked_at) — list linked Jira accounts for a user
   */
  public readonly userMappingTable: dynamodb.Table;

  /**
   * DynamoDB table tracking Jira Cloud tenants that have completed OAuth onboarding.
   *
   * Schema: jira_cloud_id (PK) — Atlassian's tenant identifier (UUID), the stable
   * key returned from `accessible-resources`.
   *
   * Fields:
   * - site_url — `https://<your-domain>.atlassian.net` (display only; NOT a
   *   valid REST base for the 3LO token, which is minted with
   *   `audience=api.atlassian.com` and must call the
   *   `https://api.atlassian.com/ex/jira/<cloudId>` gateway base instead)
   * - oauth_secret_arn — full ARN of the per-tenant Secrets Manager secret
   *   (`bgagent-jira-oauth-<cloudId>`) holding the OAuth bundle (access/refresh
   *   tokens, client credentials, webhook signing secret, and optional Forge
   *   app-actor proxy configuration). Created by `bgagent jira setup` and
   *   extended by `bgagent jira app-setup`, not by CDK.
   * - outbound_identity — `app` after the Forge identity probe succeeds.
   * - app_actor_account_id / app_actor_display_name / app_actor_configured_at —
   *   non-secret audit metadata for the verified Jira app account. The proxy
   *   URL and HMAC secret remain in Secrets Manager.
   * - installed_by_platform_user_id — Cognito sub of the admin who ran
   *   `bgagent jira setup` (audit only; runtime callers do not need this)
   * - installed_at, updated_at — ISO timestamps
   * - status — 'active' | 'revoked'
   */
  public readonly workspaceRegistryTable: dynamodb.Table;

  /** Webhook dedup table — issue timestamps or stable comment IDs, with an 8h TTL. */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Jira webhook signing secret (placeholder — populated by `bgagent jira setup`). */
  public readonly webhookSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: JiraIntegrationProps) {
    super(scope, id);

    // Solution-attribution component label (#319): every Lambda in this Jira
    // integration is part of the webhook ingest surface. One aspect labels
    // them all (and any future function added here) without per-function env
    // edits; the universal `app/` segment is set by the stack-level aspect.
    // Matches slack/linear/github-screenshot integrations.
    Aspects.of(this).add(new ComponentUaAspect('webhook'));

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- DynamoDB tables ---
    this.projectMappingTable = integrationTable(this, 'ProjectMappingTable', { partitionKey: 'jira_project_identity', removalPolicy });
    this.userMappingTable = integrationTable(this, 'UserMappingTable', {
      partitionKey: 'jira_identity', ttl: true, platformUserIndex: true, removalPolicy,
    });
    this.workspaceRegistryTable = integrationTable(this, 'WorkspaceRegistryTable', { partitionKey: 'jira_cloud_id', removalPolicy });

    // Dedup table: Jira webhook retries collapse to a single processor invoke
    // within the 8h TTL window. Issue events use the event timestamp; comment
    // events use the stable Jira comment ID.
    this.webhookDedupTable = webhookDedupTable(this, removalPolicy);

    // --- Webhook signing secret (placeholder, populated by `bgagent jira setup`) ---
    // Per-tenant OAuth tokens live in `bgagent-jira-oauth-<cloudId>` secrets
    // created by the CLI at runtime — not here. Jira admin-console webhooks
    // omit cloudId, so a single-tenant install verifies them against this
    // stack-wide copy of the tenant's signing secret.
    //
    // The generated JSON is a non-operational initial value. Setup
    // unconditionally replaces the complete value before the webhook is enabled.
    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'Jira webhook signing secret — populate via `bgagent jira setup`',
      removalPolicy,
      generateSecretString: {
        // Yields `{"abca_jira_webhook_placeholder":true,"value":"<random>"}`.
        // No runtime code interprets the marker key.
        secretStringTemplate: JSON.stringify({ [JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY]: true }),
        generateStringKey: 'value',
      },
    });

    // --- Shared Lambda configuration ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };
    // pdf-parse (v2, pdfjs-based) can't be esbuild-bundled — its pdfjs/native
    // (@napi-rs/canvas) deps break at import (`DOMMatrix is not defined`,
    // Ship it unbundled via `nodeModules` so it resolves natively at
    // runtime. Mirrors TaskApi's attachment-screening bundling. Jira's #619
    // attachment path screens PDFs, so its webhook processor needs the carve-out.
    const attachmentScreeningBundling: lambda.BundlingOptions = {
      ...commonBundling,
      nodeModules: ['pdf-parse'],
    };

    // --- Task creation environment (matches LinearIntegration / SlackIntegration pattern) ---
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
    if (props.orchestrationTable) {
      createTaskEnv.ORCHESTRATION_TABLE_NAME = props.orchestrationTable.tableName;
    }
    if (props.orchestrationTable && props.userConcurrencyTable) {
      createTaskEnv.USER_CONCURRENCY_TABLE_NAME = props.userConcurrencyTable.tableName;
      createTaskEnv.MAX_CONCURRENT_TASKS_PER_USER = String(
        props.maxConcurrentTasksPerUser ?? 10,
      );
    }
    if (props.budgetTable) {
      createTaskEnv.BUDGET_TABLE_NAME = props.budgetTable.tableName;
      createTaskEnv.USER_POOL_ID = props.userPool.userPoolId;
    }

    // --- Cognito Authorizer (for /jira/link) ---
    const cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'JiraCognitoAuthorizer', {
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
      entry: path.join(handlersDir, 'jira-webhook-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(WEBHOOK_PROCESSOR_TIMEOUT_SECONDS),
      memorySize: WEBHOOK_PROCESSOR_MEMORY_MB,
      environment: {
        ...createTaskEnv,
        JIRA_PROJECT_MAPPING_TABLE_NAME: this.projectMappingTable.tableName,
        JIRA_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        JIRA_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
      },
      // Uses the PDF attachment-screening path (#619) — pdf-parse must stay unbundled.
      bundling: attachmentScreeningBundling,
    });
    this.projectMappingTable.grantReadData(webhookProcessorFn);
    this.userMappingTable.grantReadData(webhookProcessorFn);
    this.workspaceRegistryTable.grantReadData(webhookProcessorFn);
    // Per-tenant OAuth token secrets are created by the CLI at setup time
    // (`bgagent-jira-oauth-<cloudId>`), not by CDK. Grant the processor
    // Get + Put on the prefix so it can read tokens and write back rotated
    // refresh-token JSON during expiring-token refresh.
    webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
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
    props.taskTable.grantReadWriteData(webhookProcessorFn);
    props.taskEventsTable.grantReadWriteData(webhookProcessorFn);
    if (props.orchestrationTable) {
      props.orchestrationTable.grantReadWriteData(webhookProcessorFn);
    }
    if (props.orchestrationTable && props.userConcurrencyTable) {
      props.userConcurrencyTable.grantReadData(webhookProcessorFn);
    }
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
    // The processor stores the screened bytes and deletes them when the task is not created.
    if (props.attachmentsBucket) {
      props.attachmentsBucket.grantPut(webhookProcessorFn);
      props.attachmentsBucket.grantDelete(webhookProcessorFn);
    }

    // --- Webhook receiver (verifies HMAC, dedups, invokes processor) ---
    const webhookFn = new lambda.NodejsFunction(this, 'WebhookFn', {
      entry: path.join(handlersDir, 'jira-webhook.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        JIRA_WEBHOOK_SECRET_ARN: this.webhookSecret.secretArn,
        JIRA_WEBHOOK_DEDUP_TABLE_NAME: this.webhookDedupTable.tableName,
        JIRA_WEBHOOK_PROCESSOR_FUNCTION_NAME: webhookProcessorFn.functionName,
        // Per-tenant signing-secret lookup — selects the right tenant's
        // `webhook_signing_secret` from the OAuth secret bundle so multi-
        // tenant installs verify correctly. Receiver falls back to
        // JIRA_WEBHOOK_SECRET_ARN when this lookup misses (back-compat for
        // single-tenant installs).
        JIRA_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
      },
      bundling: commonBundling,
    });
    this.webhookSecret.grantRead(webhookFn);
    this.webhookDedupTable.grantReadWriteData(webhookFn);
    this.workspaceRegistryTable.grantReadData(webhookFn);
    // Read-only on the per-tenant OAuth secret prefix — we extract
    // `webhook_signing_secret` for verification but never mutate; the
    // CLI owns the lifecycle of these secrets.
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
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
    webhookProcessorFn.grantInvoke(webhookFn);

    // --- Account linking (Cognito-authenticated) ---
    const linkFn = new lambda.NodejsFunction(this, 'LinkFn', {
      entry: path.join(handlersDir, 'jira-link.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        JIRA_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
      },
      bundling: commonBundling,
    });
    this.userMappingTable.grantReadWriteData(linkFn);

    // ═══════════════════════════════════════════════════════════════════════════
    // API Gateway Routes
    // ═══════════════════════════════════════════════════════════════════════════

    const jira = props.api.root.addResource('jira');

    // POST /v1/jira/webhook — HMAC-verified; no Cognito.
    const webhookResource = jira.addResource('webhook');
    const webhookMethod = webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(webhookFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    // POST /v1/jira/link — Cognito-authenticated.
    const linkResource = jira.addResource('link');
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
        reason: 'Jira webhook endpoint uses X-Hub-Signature HMAC verification instead of Cognito — by design for Jira webhook integration',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'Jira webhook endpoint uses X-Hub-Signature HMAC verification instead of Cognito — by design for Jira webhook integration',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.webhookSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Jira webhook signing secret is managed externally (Atlassian admin UI) — automatic rotation is not applicable',
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
            + 'and (b) the Secrets Manager `bgagent-jira-oauth-*` prefix grant — '
            + 'the per-tenant OAuth secret name is not known at synth time '
            + '(operators add tenants by cloudId at runtime via `bgagent jira setup`).',
        },
      ], true);
    }
  }
}
