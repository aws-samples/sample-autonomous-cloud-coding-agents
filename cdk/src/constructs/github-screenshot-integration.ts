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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ScreenshotBucket } from './screenshot-bucket';
import { ComponentUaAspect } from './solution-ua-aspect';

const PROCESSOR_TIMEOUT_SECONDS = 120;

const PROCESSOR_DLQ_RETENTION_DAYS = 14;

const DLQ_ALARM_PERIOD_MINUTES = 5;

const ERROR_ALARM_PERIOD_MINUTES = 5;

const ERROR_ALARM_EVALUATION_PERIODS = 2;

const PROCESSOR_MEMORY_MB = 512;

export interface GitHubScreenshotIntegrationProps {
  /** The existing REST API to add the GitHub webhook route to. */
  readonly api: apigw.RestApi;

  /**
   * Existing GitHub PAT secret. The processor reuses ABCA's main GitHub
   * token to (a) look up which PR a deploy SHA belongs to via the
   * Commits API, and (b) post the screenshot comment on that PR.
   * No new GitHub credential is provisioned by this construct.
   */
  readonly githubTokenSecret: secretsmanager.ISecret;

  /**
   * Optional — when provided, the processor also tries to post the
   * screenshot to a linked Linear issue: the issue of the task that
   * opened the PR, else the one resolved from the GitHub PR
   * branch/title/body via a Linear-identifier regex (e.g. `ENG-42`) and
   * looked up across all `status='active'` workspaces in the registry
   * via Linear's `issueVcsBranchSearch` GraphQL.
   */
  readonly linearWorkspaceRegistryTable?: dynamodb.ITable;

  /** Existing Jira registry for app-authored deployment preview feedback. */
  readonly jiraWorkspaceRegistryTable?: dynamodb.ITable;

  /**
   * Optional — when provided, the processor persists the captured
   * screenshot's public URL onto the deploy task's TaskRecord (keyed by the
   * taskId in the deploy branch), so the orchestration reconciler can
   * embed the integration node's combined preview in the parent epic panel.
   * Unset → persistence is skipped (the PR + Linear comments still post).
   */
  readonly taskTable?: dynamodb.ITable;

  /**
   * Removal policy for the dedup table + screenshot bucket. Defaults
   * to DESTROY.
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Override for the GitHub deployment `environment` value we
   * screenshot. Different providers use different conventions:
   * `Preview` (Vercel's per-PR label, the default), branch names
   * (Amplify Hosting), `Deploy Preview <PR#>` (Netlify), or whatever
   * your GitHub Actions workflow passes. Set this when your provider
   * uses a different name and you want per-PR-only screenshots.
   * Validated Amplify PR preview check runs bypass this filter.
   * @default 'Preview'
   */
  readonly screenshotTargetEnvironment?: string;
}

/**
 * CDK construct that adds the GitHub-deployment-status → screenshot →
 * PR-comment pipeline.
 *
 * Topology:
 *   - Receiver Lambda (HMAC-verifies, dedups, async-invokes processor)
 *   - Async processor Lambda (drives AgentCore Browser, uploads PNG,
 *     posts the PR comment)
 *   - Dedup DynamoDB table
 *   - Webhook signing-secret (Secrets Manager placeholder; populated
 *     manually when the operator pastes GitHub's value into the secret)
 *   - Private screenshot S3 bucket; served anonymously via CloudFront OAC
 *   - API Gateway route `POST /v1/github/webhook`
 */
export class GitHubScreenshotIntegration extends Construct {
  /** Private bucket; served via CloudFront OAC. Hosts the screenshot PNGs. */
  public readonly screenshotBucket: ScreenshotBucket;

  /**
   * GitHub webhook signing secret — placeholder. The operator pastes
   * GitHub's signing-secret value here after configuring the webhook
   * in the demo repo's settings; the secret is otherwise empty.
   */
  public readonly webhookSecret: secretsmanager.Secret;

  /** Webhook dedup table (composite key = `repo#deployment_id#status_id`). */
  public readonly webhookDedupTable: dynamodb.Table;

  /** Webhook receiver Lambda (HMAC verifier + dispatcher). */
  public readonly webhookFn: lambda.NodejsFunction;

  /** Async processor Lambda (browser + S3 + PR comment). */
  public readonly webhookProcessorFn: lambda.NodejsFunction;

  /** Fires when a failed async invocation lands in the processor DLQ. */
  public readonly processorDlqDepthAlarm: cloudwatch.Alarm;

  /** Fires when the processor Lambda's ``Errors`` metric breaches: only
   *  faults that escape the handler (init-time crash, unhandled throw,
   *  hard timeout). */
  public readonly processorErrorAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: GitHubScreenshotIntegrationProps) {
    super(scope, id);

    Aspects.of(this).add(new ComponentUaAspect('webhook'));

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    this.screenshotBucket = new ScreenshotBucket(this, 'ScreenshotBucket', {
      removalPolicy,
    });

    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'GitHub deployment-status webhook signing secret — populate manually after configuring the GitHub webhook',
      removalPolicy,
    });

    this.webhookDedupTable = new dynamodb.Table(this, 'WebhookDedupTable', {
      partitionKey: { name: 'dedup_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };

    const processorDlq = new sqs.Queue(this, 'WebhookProcessorDlq', {
      retentionPeriod: Duration.days(PROCESSOR_DLQ_RETENTION_DAYS),
      enforceSSL: true,
    });

    this.webhookProcessorFn = new lambda.NodejsFunction(this, 'WebhookProcessorFn', {
      entry: path.join(handlersDir, 'github-webhook-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(PROCESSOR_TIMEOUT_SECONDS),
      memorySize: PROCESSOR_MEMORY_MB,
      deadLetterQueue: processorDlq,
      environment: {
        SCREENSHOT_BUCKET_NAME: this.screenshotBucket.bucket.bucketName,
        SCREENSHOT_PUBLIC_HOST: this.screenshotBucket.distribution.domainName,
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
        ...(props.linearWorkspaceRegistryTable && {
          LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: props.linearWorkspaceRegistryTable.tableName,
        }),
        ...(props.jiraWorkspaceRegistryTable && {
          JIRA_WORKSPACE_REGISTRY_TABLE_NAME: props.jiraWorkspaceRegistryTable.tableName,
        }),
        ...(props.taskTable && {
          TASK_TABLE_NAME: props.taskTable.tableName,
        }),
      },
      bundling: commonBundling,
    });

    this.processorDlqDepthAlarm = new cloudwatch.Alarm(this, 'WebhookProcessorDlqDepthAlarm', {
      metric: processorDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(DLQ_ALARM_PERIOD_MINUTES),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription:
        'Screenshot webhook processor DLQ has failed async invocations — the screenshot pipeline is crashing before handling events',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.processorErrorAlarm = new cloudwatch.Alarm(this, 'WebhookProcessorErrorAlarm', {
      metric: this.webhookProcessorFn.metricErrors({
        period: Duration.minutes(ERROR_ALARM_PERIOD_MINUTES),
      }),
      threshold: 1,
      evaluationPeriods: ERROR_ALARM_EVALUATION_PERIODS,
      // Unset, CloudWatch defaults datapointsToAlarm to evaluationPeriods.
      datapointsToAlarm: 1,
      alarmDescription:
        'Screenshot webhook processor Lambda errors breached threshold — deploy-preview screenshots are failing (check IAM, AgentCore Browser quota, and dependency health)',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.screenshotBucket.bucket.grantPut(this.webhookProcessorFn);
    props.githubTokenSecret.grantRead(this.webhookProcessorFn);

    if (props.linearWorkspaceRegistryTable) {
      props.linearWorkspaceRegistryTable.grantReadData(this.webhookProcessorFn);
      this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
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
    }

    if (props.jiraWorkspaceRegistryTable) {
      props.jiraWorkspaceRegistryTable.grantReadData(this.webhookProcessorFn);
      this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          resourceName: 'bgagent-jira-oauth-*',
        })],
      }));
    }

    if (props.taskTable) {
      props.taskTable.grantWriteData(this.webhookProcessorFn);
      const issueIndexes = [
        ...(props.linearWorkspaceRegistryTable ? ['LinearIssueIndex'] : []),
        ...(props.jiraWorkspaceRegistryTable ? ['JiraIssueIndex'] : []),
      ];
      const taskTableName = props.taskTable.tableName;
      if (issueIndexes.length > 0) {
        this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['dynamodb:Query'],
          resources: issueIndexes.map(indexName => Stack.of(this).formatArn({
            service: 'dynamodb',
            resource: 'table',
            resourceName: `${taskTableName}/index/${indexName}`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          })),
        }));
      }
      this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [
          Stack.of(this).formatArn({
            service: 'dynamodb',
            resource: 'table',
            resourceName: props.taskTable.tableName,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }));
    }

    // `bedrock-agentcore:ConnectBrowserAutomationStream` declares no resource
    // types or condition keys, so it requires Resource "*":
    // https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html
    this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:StartBrowserSession',
        'bedrock-agentcore:StopBrowserSession',
        'bedrock-agentcore:ConnectBrowserAutomationStream',
      ],
      resources: ['*'],
    }));

    this.webhookFn = new lambda.NodejsFunction(this, 'WebhookFn', {
      entry: path.join(handlersDir, 'github-webhook.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        GITHUB_WEBHOOK_SECRET_ARN: this.webhookSecret.secretArn,
        GITHUB_WEBHOOK_DEDUP_TABLE_NAME: this.webhookDedupTable.tableName,
        GITHUB_WEBHOOK_PROCESSOR_FUNCTION_NAME: this.webhookProcessorFn.functionName,
        ...(props.screenshotTargetEnvironment && {
          SCREENSHOT_TARGET_ENVIRONMENT: props.screenshotTargetEnvironment,
        }),
      },
      bundling: commonBundling,
    });

    this.webhookSecret.grantRead(this.webhookFn);
    this.webhookDedupTable.grantReadWriteData(this.webhookFn);
    this.webhookProcessorFn.grantInvoke(this.webhookFn);

    const githubResource = props.api.root.addResource('github');
    const webhookResource = githubResource.addResource('webhook');
    const webhookMethod = webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(this.webhookFn, { allowTestInvoke: false }),
      { authorizationType: apigw.AuthorizationType.NONE },
    );

    NagSuppressions.addResourceSuppressions(webhookMethod, [
      {
        id: 'AwsSolutions-APIG4',
        reason: 'GitHub webhook endpoint authenticates via X-Hub-Signature-256 HMAC, not Cognito — required by GitHub webhook protocol.',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'GitHub webhook endpoint authenticates via X-Hub-Signature-256 HMAC, not Cognito — required by GitHub webhook protocol.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.webhookFn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs writes.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB grants from CDK helpers expand to table-arn/index/* wildcards; receiver only writes to the dedup table.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.webhookProcessorFn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda CloudWatch Logs writes.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'AgentCore Browser sessions are ephemeral and have no per-resource ARN; the data-plane API requires wildcards. S3 PutObject uses CDK grant helpers that expand to bucket/* wildcards. Secrets Manager access is prefix-scoped to bgagent-linear-oauth-* and bgagent-jira-oauth-* for tenant token refresh.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.webhookSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'GitHub webhook signing-secret rotation is owned by GitHub (operator regenerates on the GitHub side and pastes the new value here). No automated rotation Lambda needed.',
      },
    ]);
  }
}
