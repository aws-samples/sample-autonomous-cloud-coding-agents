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
import { JiraProjectMappingTable } from './jira-project-mapping-table';
import { JiraUserMappingTable } from './jira-user-mapping-table';
import { JiraWorkspaceRegistryTable } from './jira-workspace-registry-table';
import { ComponentUaAspect } from './solution-ua-aspect';

const DEFAULT_TASK_RETENTION_DAYS = 90;

const WEBHOOK_PROCESSOR_TIMEOUT_SECONDS = 300;

const JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY = 'abca_jira_webhook_placeholder';

const WEBHOOK_PROCESSOR_MEMORY_MB = 512;

export interface JiraIntegrationProps {
  /** The existing REST API to add Jira routes to. */
  readonly api: apigw.RestApi;

  /** Cognito user pool for the /jira/link endpoint (Cognito-authenticated). */
  readonly userPool: cognito.IUserPool;

  readonly taskTable: dynamodb.ITable;

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
   * time. When omitted, issues carrying supported file attachments
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
 * This construct owns Jira → webhook → task creation. Outbound progress
 * writers are wired outside this inbound construct.
 *
 * Creates:
 * - JiraProjectMappingTable (`{cloudId}#{projectKey}` → GitHub repo)
 * - JiraUserMappingTable (`{cloudId}#{accountId}` → platform user; with
 *   GSI for reverse lookup and `pending#{code}` link rows)
 * - JiraWorkspaceRegistryTable (`cloudId` → per-tenant OAuth secret ARN)
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

  /** Webhook dedup table — issue timestamps or stable comment IDs, with an 8h TTL. */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Jira webhook signing secret (placeholder — populated by `bgagent jira setup`). */
  public readonly webhookSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: JiraIntegrationProps) {
    super(scope, id);

    Aspects.of(this).add(new ComponentUaAspect('webhook'));

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    const projectMapping = new JiraProjectMappingTable(this, 'ProjectMappingTable', { removalPolicy });
    const userMapping = new JiraUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    const workspaceRegistry = new JiraWorkspaceRegistryTable(this, 'WorkspaceRegistryTable', { removalPolicy });
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

    // Jira admin-console webhooks omit cloudId, so a single-tenant install
    // verifies them against this stack-wide copy of the tenant's signing secret.
    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'Jira webhook signing secret — populate via `bgagent jira setup`',
      removalPolicy,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ [JIRA_WEBHOOK_SECRET_PLACEHOLDER_KEY]: true }),
        generateStringKey: 'value',
      },
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
      bundling: attachmentScreeningBundling,
    });
    this.projectMappingTable.grantReadData(webhookProcessorFn);
    this.userMappingTable.grantReadData(webhookProcessorFn);
    this.workspaceRegistryTable.grantReadData(webhookProcessorFn);
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
    if (props.attachmentsBucket) {
      props.attachmentsBucket.grantReadWrite(webhookProcessorFn);
    }

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
        JIRA_WORKSPACE_REGISTRY_TABLE_NAME: this.workspaceRegistryTable.tableName,
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
          resourceName: 'bgagent-jira-oauth-*',
        }),
      ],
    }));
    webhookProcessorFn.grantInvoke(webhookFn);

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

    const jira = props.api.root.addResource('jira');

    const webhookResource = jira.addResource('webhook');
    const webhookMethod = webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(webhookFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    const linkResource = jira.addResource('link');
    linkResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(linkFn, { allowTestInvoke: false }),
      cognitoAuthOptions,
    );

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
