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
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ScreenshotBucket } from './screenshot-bucket';

/**
 * Properties for GitHubScreenshotIntegration construct.
 */
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
   * screenshot to a linked Linear issue. Resolved from the GitHub PR
   * title/body via a Linear-identifier regex (e.g. `ABCA-42`), then
   * looked up across all `status='active'` workspaces in the registry
   * via Linear's `issueVcsBranchSearch` GraphQL.
   */
  readonly linearWorkspaceRegistryTable?: dynamodb.ITable;

  /**
   * Removal policy for the dedup table + screenshot bucket. Defaults
   * to DESTROY so dev stacks don't accumulate orphans on `cdk destroy`.
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Override for the GitHub deployment `environment` value we
   * screenshot. Different providers use different conventions:
   * `Preview` (Vercel's per-PR label, the default), branch names
   * (Amplify Hosting), `Deploy Preview <PR#>` (Netlify), or whatever
   * your GitHub Actions workflow passes. Set this when your provider
   * uses a different name and you want per-PR-only screenshots.
   * @default 'Preview'
   */
  readonly screenshotTargetEnvironment?: string;
}

/**
 * CDK construct that adds the GitHub-deployment-status → screenshot →
 * PR-comment pipeline.
 *
 * Topology mirrors `LinearIntegration`:
 *   - Receiver Lambda (HMAC-verifies, dedups, async-invokes processor)
 *   - Async processor Lambda (drives AgentCore Browser, uploads PNG,
 *     posts the PR comment)
 *   - Dedup DynamoDB table (1h TTL — covers GitHub's 5-attempt retry
 *     window with slack)
 *   - Webhook signing-secret (Secrets Manager placeholder; populated
 *     manually when the operator pastes GitHub's value into the secret)
 *   - Private screenshot S3 bucket; served anonymously via CloudFront OAC
 *   - API Gateway route `POST /v1/github/webhook`
 *
 * Inbound-only adapter — there's no outbound polling or stream
 * consumer, just the webhook → screenshot → comment fan-out.
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

  constructor(scope: Construct, id: string, props: GitHubScreenshotIntegrationProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- Screenshot bucket (private; served via CloudFront with OAC) ---
    this.screenshotBucket = new ScreenshotBucket(this, 'ScreenshotBucket', {
      removalPolicy,
    });

    // --- Webhook signing secret (operator-populated placeholder) ---
    this.webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'GitHub deployment-status webhook signing secret — populate manually after configuring the GitHub webhook',
      removalPolicy,
    });

    // --- Dedup table ---
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

    // --- Async processor (browser + S3 + comment) ---
    // Lambda timeout: 120s. The handler enforces a single wall-clock
    // deadline of 110s (TOTAL_BUDGET_MS in github-webhook-processor.ts)
    // shared across PR-lookup retry + screenshot capture + S3 PUT +
    // comment POST, so no individual sub-step can run past the Lambda
    // timeout even on the worst-case path. The 10s headroom covers
    // SDK auto-retries + the runtime's shutdown grace so a hard timeout
    // never severs an in-flight comment-post. (theagenticguy PR-241
    // review item B1: previous comment under-counted the 35s retry
    // ladder that runs before captureScreenshot's 60s budget.)
    this.webhookProcessorFn = new lambda.NodejsFunction(this, 'WebhookProcessorFn', {
      entry: path.join(handlersDir, 'github-webhook-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(120),
      memorySize: 512,
      environment: {
        SCREENSHOT_BUCKET_NAME: this.screenshotBucket.bucket.bucketName,
        SCREENSHOT_PUBLIC_HOST: this.screenshotBucket.distribution.domainName,
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
        ...(props.linearWorkspaceRegistryTable && {
          LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: props.linearWorkspaceRegistryTable.tableName,
        }),
      },
      bundling: commonBundling,
    });

    this.screenshotBucket.bucket.grantPut(this.webhookProcessorFn);
    props.githubTokenSecret.grantRead(this.webhookProcessorFn);

    // Optional Linear feedback path. Wired only when a registry table
    // is provided. The processor scans the registry for active
    // workspaces, then per-workspace looks up the OAuth token from
    // Secrets Manager (`bgagent-linear-oauth-*` prefix, written by
    // `bgagent linear setup`).
    //
    // PutSecretValue is intentional, not a typo: resolveLinearOauthToken
    // rotates Linear's refresh token in place when it expires (the same
    // pattern as the orchestrator role). This is a write grant by
    // design — see linear-oauth-resolver.ts.
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

    // AgentCore Browser session lifecycle + automation-stream connect.
    // Action set scoped to the three calls the handler actually makes;
    // resource is `*` because Browser sessions are ephemeral and the
    // two `Connect*Stream` data-plane actions in the AWS Service
    // Authorization Reference for `bedrock-agentcore` declare no
    // resource types or condition keys (they require Resource:"*"
    // anyway). cdk-nag IAM5 suppression annotates the resource
    // wildcard.
    //
    // Source: AWS Service Authorization Reference for bedrock-agentcore,
    //   https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html
    //   - bedrock-agentcore:StartBrowserSession (Write)
    //   - bedrock-agentcore:StopBrowserSession (Write)
    //   - bedrock-agentcore:ConnectBrowserAutomationStream (Read; no resource scoping)
    this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:StartBrowserSession',
        'bedrock-agentcore:StopBrowserSession',
        'bedrock-agentcore:ConnectBrowserAutomationStream',
      ],
      resources: ['*'],
    }));

    // --- Webhook receiver (verify, dedup, dispatch) ---
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

    // --- API Gateway route ---
    const githubResource = props.api.root.addResource('github');
    const webhookResource = githubResource.addResource('webhook');
    const webhookMethod = webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(this.webhookFn),
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
        reason: 'AgentCore Browser sessions are ephemeral and have no per-resource ARN; the data-plane API requires wildcards. S3 PutObject uses CDK grant helpers that expand to bucket/* wildcards.',
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
