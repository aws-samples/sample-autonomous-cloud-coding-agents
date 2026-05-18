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
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { LinearProjectMappingTable } from './linear-project-mapping-table';
import { LinearUserMappingTable } from './linear-user-mapping-table';

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

  /** Orchestrator Lambda function ARN for async task invocation. */
  readonly orchestratorFunctionArn?: string;

  /** Bedrock Guardrail ID for input screening. */
  readonly guardrailId?: string;

  /** Bedrock Guardrail version for input screening. */
  readonly guardrailVersion?: string;

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

  /** Webhook dedup table — (issue_id, action) keys with 60s TTL. */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Linear webhook signing secret (placeholder — populated by `bgagent linear setup`). */
  public readonly webhookSecret: secretsmanager.Secret;

  /**
   * Linear personal API token used by the agent-side MCP (placeholder —
   * populated by `bgagent linear setup`).
   */
  public readonly apiTokenSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: LinearIntegrationProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- DynamoDB tables ---
    const projectMapping = new LinearProjectMappingTable(this, 'ProjectMappingTable', { removalPolicy });
    const userMapping = new LinearUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    this.projectMappingTable = projectMapping.table;
    this.userMappingTable = userMapping.table;

    // Dedup table: linear webhook retries collapse to a single processor invoke
    // within the 60s TTL window. Keyed on `{issue_id}#{action}`.
    this.webhookDedupTable = new dynamodb.Table(this, 'WebhookDedupTable', {
      partitionKey: { name: 'dedup_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // --- Secrets (CDK-created placeholders, populated by `bgagent linear setup`) ---
    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'Linear webhook signing secret — populate via `bgagent linear setup`',
      removalPolicy,
    });
    this.apiTokenSecret = new secretsmanager.Secret(this, 'ApiTokenSecret', {
      description: 'Linear personal API token for agent-side MCP — populate via `bgagent linear setup`',
      removalPolicy,
    });

    // --- Shared Lambda configuration ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };

    // --- Task creation environment (matches TaskApi / SlackIntegration pattern) ---
    const createTaskEnv: Record<string, string> = {
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? 90),
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
      timeout: Duration.seconds(30),
      environment: {
        ...createTaskEnv,
        LINEAR_PROJECT_MAPPING_TABLE_NAME: this.projectMappingTable.tableName,
        LINEAR_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        LINEAR_API_TOKEN_SECRET_ARN: this.apiTokenSecret.secretArn,
      },
      bundling: commonBundling,
    });
    this.projectMappingTable.grantReadData(webhookProcessorFn);
    this.userMappingTable.grantReadData(webhookProcessorFn);
    this.apiTokenSecret.grantRead(webhookProcessorFn);
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
      entry: path.join(handlersDir, 'linear-webhook.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        LINEAR_WEBHOOK_SECRET_ARN: this.webhookSecret.secretArn,
        LINEAR_WEBHOOK_DEDUP_TABLE_NAME: this.webhookDedupTable.tableName,
        LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME: webhookProcessorFn.functionName,
      },
      bundling: commonBundling,
    });
    this.webhookSecret.grantRead(webhookFn);
    this.webhookDedupTable.grantReadWriteData(webhookFn);
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

    for (const secret of [this.webhookSecret, this.apiTokenSecret]) {
      NagSuppressions.addResourceSuppressions(secret, [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Linear credentials are managed externally (Linear web UI) — automatic rotation is not applicable',
        },
      ]);
    }

    const allFunctions = [webhookFn, webhookProcessorFn, linkFn];
    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended managed policy for Lambda functions',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permissions are scoped by DynamoDB index ARN patterns',
        },
      ], true);
    }
  }
}
