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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { JiraProjectMappingTable } from './jira-project-mapping-table';
import { JiraUserMappingTable } from './jira-user-mapping-table';
import { JiraWorkspaceRegistryTable } from './jira-workspace-registry-table';

/** Default task-record retention used for TTL computation (days). */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/** Webhook-processor Lambda timeout (seconds). */
const WEBHOOK_PROCESSOR_TIMEOUT_SECONDS = 30;

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

  /** The DynamoDB repo config table (optional — for repo onboarding checks). */
  readonly repoTable?: dynamodb.ITable;

  /** Orchestrator Lambda function ARN for async task invocation. */
  readonly orchestratorFunctionArn?: string;

  /** Bedrock Guardrail ID for input screening. */
  readonly guardrailId?: string;

  /** Bedrock Guardrail version for input screening. */
  readonly guardrailVersion?: string;

  /** Task retention in days for TTL computation. */
  readonly taskRetentionDays?: number;

  /** Removal policy for Jira DynamoDB tables. */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * CDK construct that adds Jira Cloud integration to the ABCA platform.
 *
 * Inbound-only adapter: Jira → webhook → task creation. Outbound progress
 * updates happen agent-side via the Jira REST v3 API (see
 * agent/src/jira_reactions.py; ADR-015 explains why outbound is REST and not
 * the Atlassian Remote MCP), so there is NO DynamoDB Streams consumer and NO
 * outbound-notify Lambda here. Mirrors the Linear adapter shape.
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
  /** Jira `{cloudId}#{projectKey}` → repo mapping table. */
  public readonly projectMappingTable: dynamodb.Table;

  /** Jira `{cloudId}#{accountId}` → platform user mapping table. */
  public readonly userMappingTable: dynamodb.Table;

  /**
   * Registry of Jira tenants that have completed OAuth onboarding.
   * Look up the per-tenant `oauth_secret_arn` by `cloudId` from the inbound
   * webhook, then fetch the OAuth/signing secret from Secrets Manager.
   */
  public readonly workspaceRegistryTable: dynamodb.Table;

  /** Webhook dedup table — `{issueKey}#{webhookEvent}#{timestamp}` keys with 8h TTL. */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Jira webhook signing secret (placeholder — populated by `bgagent jira setup`). */
  public readonly webhookSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: JiraIntegrationProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- DynamoDB tables ---
    const projectMapping = new JiraProjectMappingTable(this, 'ProjectMappingTable', { removalPolicy });
    const userMapping = new JiraUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    const workspaceRegistry = new JiraWorkspaceRegistryTable(this, 'WorkspaceRegistryTable', { removalPolicy });
    this.projectMappingTable = projectMapping.table;
    this.userMappingTable = userMapping.table;
    this.workspaceRegistryTable = workspaceRegistry.table;

    // Dedup table: Jira webhook retries collapse to a single processor invoke
    // within the 8h TTL window. Keyed on `{issueKey}#{webhookEvent}#{timestamp}`.
    this.webhookDedupTable = new dynamodb.Table(this, 'WebhookDedupTable', {
      partitionKey: { name: 'dedup_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // --- Webhook signing secret (placeholder, populated by `bgagent jira setup`) ---
    // Per-tenant OAuth tokens live in `bgagent-jira-oauth-<cloudId>` secrets
    // created by the CLI at runtime — not here. This stack-wide secret is
    // a back-compat fallback for single-tenant installs predating per-
    // tenant signing.
    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'Jira webhook signing secret — populate via `bgagent jira setup`',
      removalPolicy,
    });

    // --- Shared Lambda configuration ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
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
      bundling: commonBundling,
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
      new apigw.LambdaIntegration(webhookFn),
      noneAuthOptions,
    );

    // POST /v1/jira/link — Cognito-authenticated.
    const linkResource = jira.addResource('link');
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
