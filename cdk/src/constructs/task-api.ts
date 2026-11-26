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
import { ArnFormat, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture, type LayerVersion } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { CEDAR_WASM_MIN_LAMBDA_MEMORY_MB } from './cedar-wasm-layer';

const DEFAULT_TASK_RETENTION_DAYS = 90;

const DEFAULT_WEBHOOK_RETENTION_DAYS = 30;

const API_HANDLER_TIMEOUT_SECONDS = 15;

const CONFIRM_UPLOADS_TIMEOUT_SECONDS = 180;

const API_HANDLER_MEMORY_MB = 256;

const SCREENING_HANDLER_MEMORY_MB = 512;

const HEAVY_ATTACHMENT_HANDLER_MEMORY_MB = 1024;

const LARGE_BODY_WEBHOOK_PATHS = ['/v1/linear/webhook', '/v1/jira/webhook', '/v1/github/webhook'] as const;
export type LargeBodyWebhookPath = typeof LARGE_BODY_WEBHOOK_PATHS[number];

const SIGNED_WEBHOOK_XSS_METRIC = 'SignedWebhookXssCounted';

const SIGNED_WEBHOOK_XSS_ALARM_PER_HOUR = 20;

const uriPathMatch = (positionalConstraint: 'STARTS_WITH' | 'EXACTLY', searchString: string) => ({
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint,
    searchString,
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
});

/** WAF rejects one-element OR/AND statements, so a single match is used directly. */
const anyOf = (statements: object[]) => statements.length === 1 ? statements[0] : { orStatement: { statements } };
const allOf = (statements: object[]) => statements.length === 1 ? statements[0] : { andStatement: { statements } };

export interface TaskApiProps {
  readonly taskTable: dynamodb.ITable;

  readonly taskEventsTable: dynamodb.ITable;

  /**
   * The DynamoDB task nudges table. When provided, the
   * `POST /tasks/{task_id}/nudge` endpoint is created.
   */
  readonly taskNudgesTable?: dynamodb.ITable;

  /**
   * Cedar HITL approvals table. When provided, POST /approve, POST
   * /deny, and GET /pending endpoints are created.
   */
  readonly taskApprovalsTable?: dynamodb.ITable;

  /**
   * Cedar-wasm Lambda layer (CedarWasmLayer.layer). When provided together
   * with `taskApprovalsTable` and `repoTable`, the
   * `GET /repos/{repo_id}/policies` endpoint is created.
   */
  readonly cedarWasmLayer?: LayerVersion;

  /**
   * Per-task per-minute nudge rate limit.
   * @default 10
   */
  readonly nudgeRateLimitPerMinute?: number;

  /**
   * The DynamoDB repo config table. When provided, task creation checks
   * that the target repository is onboarded before accepting the task.
   */
  readonly repoTable?: dynamodb.ITable;

  /**
   * The DynamoDB webhook table. When provided, webhook endpoints are created.
   */
  readonly webhookTable?: dynamodb.ITable;

  /**
   * The DynamoDB platform API key table. When provided, API key management
   * endpoints are created and the webhook management endpoints accept an API
   * key (with `webhooks:manage`) in addition to a Cognito JWT.
   */
  readonly apiKeyTable?: dynamodb.ITable;

  /**
   * Number of days to retain revoked API key records before DynamoDB TTL
   * deletes them.
   * @default 30
   */
  readonly apiKeyRetentionDays?: number;

  /**
   * ARN of the orchestrator Lambda alias. When set, the create-task handler
   * async-invokes the orchestrator after writing the task record.
   */
  readonly orchestratorFunctionArn?: string;

  /**
   * Maximum concurrent tasks per user. The confirm-uploads handler admits
   * against it and the get-task handler derives the queue-wait ETA from it.
   * Must match ``TaskOrchestrator.maxConcurrentTasksPerUser``.
   * @default 10
   */
  readonly maxConcurrentTasksPerUser?: number;

  /**
   * API Gateway stage name.
   * @default 'v1'
   */
  readonly stageName?: string;

  /**
   * Removal policy for Cognito resources.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  readonly guardrailId?: string;

  readonly guardrailVersion?: string;

  /**
   * Number of days to retain completed task and event records before DynamoDB TTL deletes them.
   * @default 90
   */
  readonly taskRetentionDays?: number;

  /**
   * Number of days to retain revoked webhook records before DynamoDB TTL deletes them.
   * @default 30
   */
  readonly webhookRetentionDays?: number;

  /**
   * AgentCore runtime ARN for which cancel-task may call `StopRuntimeSession`.
   * Also passed as `RUNTIME_ARN` to cancel-task so it can resolve the target
   * runtime when a task record lacks `agent_runtime_arn`.
   */
  readonly agentCoreStopSessionRuntimeArn?: string;

  /**
   * S3 bucket storing ``--trace`` trajectory artifacts. When provided,
   * a ``GET /v1/tasks/{task_id}/trace`` route is created that issues
   * short-lived presigned download URLs.
   */
  readonly traceArtifactsBucket?: s3.IBucket;

  /**
   * ECS cluster ARN for cancel-task to stop ECS-backed tasks.
   * When provided, the cancel Lambda gets `ECS_CLUSTER_ARN` env var and `ecs:StopTask` permission.
   */
  readonly ecsClusterArn?: string;

  /**
   * IAM resource ARN of the MicroVM image this deployment provisioned. When
   * provided, cancel gets TerminateMicrovm and the approval decision handlers
   * get GetMicrovm/ResumeMicrovm, scoped to that one image. Absent ⇒ no grant.
   */
  readonly lambdaMicrovmImageArn?: string;

  /**
   * S3 bucket for task attachments. When provided, the create-task Lambda
   * gets PutObject/DeleteObject grants and the bucket name as env var.
   */
  readonly attachmentsBucket?: s3.IBucket;

  /**
   * User concurrency table for admission control during confirm-uploads.
   * Required when attachmentsBucket is provided.
   */
  readonly userConcurrencyTable?: dynamodb.ITable;

  /**
   * Monthly user/team budget configuration and spend table. When provided,
   * task creation resolves Cognito groups and enforces hard-stop budgets.
   */
  readonly budgetTable?: dynamodb.ITable;

  /**
   * Deployed webhook routes whose payloads exceed CRS SizeRestrictions_BODY.
   * Only these are exempted from it.
   * @default every large-body webhook
   */
  readonly largeBodyWebhookPaths?: readonly LargeBodyWebhookPath[];
}

function signedWebhookRules(paths: readonly string[]): wafv2.CfnWebACL.RuleProperty[] {
  if (paths.length === 0) return [];
  return [
    {
      name: 'AWSManagedRulesCommonRuleSet-SignedWebhooks',
      priority: 5,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: 'AWSManagedRulesCommonRuleSet',
          // WAF rejects `excludedRules` alongside `ruleActionOverrides`, and an excluded
          // rule is a count override.
          ruleActionOverrides: [
            // Matches a body over 8 KB.
            { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
            // Matches the XML-like `promptContext` (`<issue identifier=…>`) of a Linear
            // agent session opened by an @-mention (#1063).
            { name: 'CrossSiteScripting_BODY', actionToUse: { count: {} } },
          ],
          scopeDownStatement: anyOf(paths.map(webhookPath => uriPathMatch('EXACTLY', webhookPath))),
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'CommonRuleSetSignedWebhooks',
        sampledRequestsEnabled: true,
      },
    },
    {
      // A rule counted inside a managed rule group has no metric of its own.
      name: SIGNED_WEBHOOK_XSS_METRIC,
      priority: 6,
      action: { count: {} },
      statement: {
        labelMatchStatement: { scope: 'LABEL', key: 'awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body' },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: SIGNED_WEBHOOK_XSS_METRIC,
        sampledRequestsEnabled: true,
      },
    },
  ];
}

function signedWebhookXssAlarm(scope: Construct, webAcl: wafv2.CfnWebACL, paths: readonly string[]): cloudwatch.Alarm | undefined {
  if (paths.length === 0) return undefined;
  return new cloudwatch.Alarm(scope, 'SignedWebhookXssCountedAlarm', {
    metric: new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'CountedRequests',
      // The ACL's Ref is `name|id|scope`. WAF dimensions its metrics by the web ACL's
      // name, not its visibilityConfig metric name.
      dimensionsMap: { WebACL: Fn.select(0, Fn.split('|', webAcl.ref)), Rule: SIGNED_WEBHOOK_XSS_METRIC, Region: Stack.of(scope).region },
      statistic: 'Sum',
      period: Duration.hours(1),
    }),
    threshold: SIGNED_WEBHOOK_XSS_ALARM_PER_HOUR,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: 'Many XSS-shaped bodies reached a signed webhook route (Linear, Jira, GitHub) in an hour. '
      + 'The WAF counts rather than blocks them there (each receiver verifies the HMAC first); check the '
      + `WAF sampled requests for rule ${SIGNED_WEBHOOK_XSS_METRIC}.`,
  });
}

/**
 * CDK construct that creates the Task API — an API Gateway REST API backed by
 * Cognito User Pool authentication and Lambda handler integrations.
 */
export class TaskApi extends Construct {
  public readonly api: apigw.RestApi;

  public readonly userPool: cognito.UserPool;

  public readonly appClient: cognito.UserPoolClient;

  public readonly appClientId: string;

  /**
   * Raised when many XSS-shaped bodies reach the signed webhook routes, where
   * the WAF counts rather than blocks them. Undefined when no webhook route is
   * deployed.
   */
  public readonly webhookXssCountedAlarm?: cloudwatch.Alarm;

  // eslint-disable-next-line complexity -- predates the ceiling (55; 53 when it landed); must not grow
  constructor(scope: Construct, id: string, props: TaskApiProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    const stageName = props.stageName ?? 'v1';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy,
    });

    this.appClient = this.userPool.addClient('AppClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });
    this.appClientId = this.appClient.userPoolClientId;

    NagSuppressions.addResourceSuppressions(this.userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA not required for dev environment — CLI-based auth flow' },
      { id: 'AwsSolutions-COG8', reason: 'Cognito Plus tier / feature plan not required for dev environment (advanced security)' },
    ]);

    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      removalPolicy,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: 'TaskApi',
      deployOptions: {
        stageName,
        throttlingRateLimit: 60,
        throttlingBurstLimit: 100,
        accessLogDestination: new apigw.LogGroupLogDestination(apiAccessLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigw.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: [...apigw.Cors.DEFAULT_HEADERS, 'Idempotency-Key'],
      },
    });

    const largeBodyWebhookPaths: readonly string[] = props.largeBodyWebhookPaths ?? LARGE_BODY_WEBHOOK_PATHS;
    const signedWebhookPaths = LARGE_BODY_WEBHOOK_PATHS.filter(webhookPath => largeBodyWebhookPaths.includes(webhookPath));
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'TaskApiWebAcl',
        sampledRequestsEnabled: true,
      },
      // WAF keeps every header of a sampled request for three hours (wafv2:GetSampledRequests).
      // The protected header names match in any letter case.
      dataProtectionConfig: {
        dataProtections: [{
          action: 'SUBSTITUTION',
          field: { fieldType: 'SINGLE_HEADER', fieldKeys: ['authorization', 'x-api-key'] },
        }],
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet-TaskPaths',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // API Gateway bounds the payload at 10 MB.
              excludedRules: [{ name: 'SizeRestrictions_BODY' }],
              scopeDownStatement: uriPathMatch('STARTS_WITH', '/v1/tasks'),
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSetTaskPaths',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              scopeDownStatement: allOf(['/v1/tasks', '/v1/jira/webhook', '/v1/linear/webhook', '/v1/github/webhook']
                .filter(uriPath => uriPath === '/v1/tasks' || largeBodyWebhookPaths.includes(uriPath))
                .map(uriPath => ({
                  notStatement: { statement: uriPathMatch(uriPath === '/v1/tasks' ? 'STARTS_WITH' : 'EXACTLY', uriPath) },
                }))),
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputsRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitRule',
          priority: 4,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
            sampledRequestsEnabled: true,
          },
        },
        ...signedWebhookRules(signedWebhookPaths),
      ],
    });
    this.webhookXssCountedAlarm = signedWebhookXssAlarm(this, webAcl, signedWebhookPaths);

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    const cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [this.userPool],
    });

    const requestValidator = new apigw.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const cognitoAuthOptions: apigw.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      requestValidator,
    };

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonEnv = {
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? DEFAULT_TASK_RETENTION_DAYS),
      ABCA_COMPONENT: 'api',
    };
    // The Node.js Lambda runtime ships an AWS SDK whose pinned version lags:
    // a command missing from it (e.g. StopRuntimeSessionCommand of
    // `@aws-sdk/client-bedrock-agentcore`) throws `<Command> is not a
    // constructor` when its client is external.
    const commonBundling: lambda.BundlingOptions = {
      externalModules: [
        '@aws-sdk/client-dynamodb',
        '@aws-sdk/client-ecs',
        '@aws-sdk/client-lambda',
        '@aws-sdk/client-bedrock-runtime',
        '@aws-sdk/client-secrets-manager',
        '@aws-sdk/lib-dynamodb',
        '@aws-sdk/util-dynamodb',
      ],
    };

    const attachmentScreeningBundling: lambda.BundlingOptions = {
      ...commonBundling,
      nodeModules: ['pdf-parse'],
    };

    const createTaskEnv: Record<string, string> = { ...commonEnv };
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
      createTaskEnv.USER_POOL_ID = this.userPool.userPoolId;
    }

    const createTaskFn = new lambda.NodejsFunction(this, 'CreateTaskFn', {
      entry: path.join(handlersDir, 'create-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: createTaskEnv,
      bundling: attachmentScreeningBundling,
      memorySize: SCREENING_HANDLER_MEMORY_MB,
      timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
    });

    const maxConcurrentTasksPerUser = String(props.maxConcurrentTasksPerUser ?? 10);

    const getTaskFn = new lambda.NodejsFunction(this, 'GetTaskFn', {
      entry: path.join(handlersDir, 'get-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: {
        ...commonEnv,
        MAX_CONCURRENT_TASKS_PER_USER: maxConcurrentTasksPerUser,
      },
      bundling: commonBundling,
    });

    const listTasksEnv: Record<string, string> = { ...commonEnv };
    if (props.budgetTable) {
      listTasksEnv.BUDGET_TABLE_NAME = props.budgetTable.tableName;
    }
    const listTasksFn = new lambda.NodejsFunction(this, 'ListTasksFn', {
      entry: path.join(handlersDir, 'list-tasks.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: listTasksEnv,
      bundling: commonBundling,
      timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
      memorySize: API_HANDLER_MEMORY_MB,
    });

    const cancelTaskEnv: Record<string, string> = { ...commonEnv };
    const stopSessionArn = props.agentCoreStopSessionRuntimeArn;
    if (stopSessionArn) {
      cancelTaskEnv.RUNTIME_ARN = stopSessionArn;
    }
    if (props.ecsClusterArn) {
      cancelTaskEnv.ECS_CLUSTER_ARN = props.ecsClusterArn;
    }

    const cancelTaskFn = new lambda.NodejsFunction(this, 'CancelTaskFn', {
      entry: path.join(handlersDir, 'cancel-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: cancelTaskEnv,
      bundling: commonBundling,
      timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
      memorySize: API_HANDLER_MEMORY_MB,
    });

    const getTaskEventsFn = new lambda.NodejsFunction(this, 'GetTaskEventsFn', {
      entry: path.join(handlersDir, 'get-task-events.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: commonEnv,
      bundling: commonBundling,
    });

    const getTaskReplayFn = new lambda.NodejsFunction(this, 'GetTaskReplayFn', {
      entry: path.join(handlersDir, 'get-task-replay.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: commonEnv,
      bundling: commonBundling,
      timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
      memorySize: SCREENING_HANDLER_MEMORY_MB,
    });

    props.taskTable.grantReadWriteData(createTaskFn);
    props.taskEventsTable.grantReadWriteData(createTaskFn);
    props.taskTable.grantReadWriteData(cancelTaskFn);
    props.taskEventsTable.grantReadWriteData(cancelTaskFn);

    if (stopSessionArn) {
      cancelTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:StopRuntimeSession'],
        resources: [stopSessionArn, `${stopSessionArn}/*`],
      }));
    }

    if (props.ecsClusterArn) {
      cancelTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ecs:StopTask'],
        resources: ['*'],
        conditions: {
          ArnEquals: {
            'ecs:cluster': props.ecsClusterArn,
          },
        },
      }));
    }

    // IAM authorizes MicroVM lifecycle actions against the image
    // (`microvm-image:<name>`), not the running MicroVM.
    if (props.lambdaMicrovmImageArn) {
      cancelTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:TerminateMicrovm'],
        resources: [props.lambdaMicrovmImageArn, `${props.lambdaMicrovmImageArn}:*`],
      }));
    }

    if (props.repoTable) {
      props.repoTable.grantReadData(createTaskFn);
    }
    if (props.budgetTable) {
      props.budgetTable.grantReadData(createTaskFn);
      props.budgetTable.grantReadData(listTasksFn);
    }

    props.taskTable.grantReadData(getTaskFn);
    props.taskTable.grantReadData(listTasksFn);
    props.taskTable.grantReadData(getTaskEventsFn);
    props.taskEventsTable.grantReadData(getTaskEventsFn);
    props.taskTable.grantReadData(getTaskReplayFn);
    props.taskEventsTable.grantReadData(getTaskReplayFn);

    if (props.orchestratorFunctionArn) {
      createTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.orchestratorFunctionArn],
      }));
    }

    if (props.guardrailId) {
      createTaskFn.addToRolePolicy(new iam.PolicyStatement({
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
      props.attachmentsBucket.grantPut(createTaskFn);
      props.attachmentsBucket.grantDelete(createTaskFn);
    }

    let confirmUploadsFn: lambda.NodejsFunction | undefined;
    if (props.attachmentsBucket && props.userConcurrencyTable) {
      const confirmUploadsEnv: Record<string, string> = { ...commonEnv };
      confirmUploadsEnv.ATTACHMENTS_BUCKET_NAME = props.attachmentsBucket.bucketName;
      confirmUploadsEnv.USER_CONCURRENCY_TABLE_NAME = props.userConcurrencyTable.tableName;
      confirmUploadsEnv.MAX_CONCURRENT_TASKS_PER_USER = maxConcurrentTasksPerUser;
      if (props.orchestratorFunctionArn) {
        confirmUploadsEnv.ORCHESTRATOR_FUNCTION_ARN = props.orchestratorFunctionArn;
      }
      if (props.guardrailId && props.guardrailVersion) {
        confirmUploadsEnv.GUARDRAIL_ID = props.guardrailId;
        confirmUploadsEnv.GUARDRAIL_VERSION = props.guardrailVersion;
      }

      confirmUploadsFn = new lambda.NodejsFunction(this, 'ConfirmUploadsFn', {
        entry: path.join(handlersDir, 'confirm-uploads.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: confirmUploadsEnv,
        bundling: attachmentScreeningBundling,
        memorySize: HEAVY_ATTACHMENT_HANDLER_MEMORY_MB,
        timeout: Duration.seconds(CONFIRM_UPLOADS_TIMEOUT_SECONDS),
      });

      props.taskTable.grantReadWriteData(confirmUploadsFn);
      props.taskEventsTable.grantReadWriteData(confirmUploadsFn);
      props.attachmentsBucket.grantReadWrite(confirmUploadsFn);
      props.attachmentsBucket.grantDelete(confirmUploadsFn);
      props.userConcurrencyTable.grantReadWriteData(confirmUploadsFn);

      if (props.orchestratorFunctionArn) {
        confirmUploadsFn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [props.orchestratorFunctionArn],
        }));
      }

      if (props.guardrailId) {
        confirmUploadsFn.addToRolePolicy(new iam.PolicyStatement({
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
    }

    const allFunctions: lambda.NodejsFunction[] = [createTaskFn, getTaskFn, listTasksFn, cancelTaskFn, getTaskEventsFn, getTaskReplayFn];
    if (confirmUploadsFn) allFunctions.push(confirmUploadsFn);

    const tasks = this.api.root.addResource('tasks');
    tasks.addMethod('POST', new apigw.LambdaIntegration(createTaskFn, { allowTestInvoke: false }), cognitoAuthOptions);
    tasks.addMethod('GET', new apigw.LambdaIntegration(listTasksFn, { allowTestInvoke: false }), cognitoAuthOptions);

    const taskById = tasks.addResource('{task_id}');
    taskById.addMethod('GET', new apigw.LambdaIntegration(getTaskFn, { allowTestInvoke: false }), cognitoAuthOptions);
    taskById.addMethod('DELETE', new apigw.LambdaIntegration(cancelTaskFn, { allowTestInvoke: false }), cognitoAuthOptions);

    const events = taskById.addResource('events');
    events.addMethod('GET', new apigw.LambdaIntegration(getTaskEventsFn, { allowTestInvoke: false }), cognitoAuthOptions);

    const replay = taskById.addResource('replay');
    replay.addMethod('GET', new apigw.LambdaIntegration(getTaskReplayFn, { allowTestInvoke: false }), cognitoAuthOptions);

    if (confirmUploadsFn) {
      const confirmUploads = taskById.addResource('confirm-uploads');
      confirmUploads.addMethod('POST', new apigw.LambdaIntegration(confirmUploadsFn, { allowTestInvoke: false }), cognitoAuthOptions);
    }

    if (props.traceArtifactsBucket) {
      const traceBucket = props.traceArtifactsBucket;
      const getTraceUrlFn = new lambda.NodejsFunction(this, 'GetTraceUrlFn', {
        entry: path.join(handlersDir, 'get-trace-url.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: {
          ...commonEnv,
          TRACE_ARTIFACTS_BUCKET_NAME: traceBucket.bucketName,
        },
        bundling: {
          ...commonBundling,
          externalModules: commonBundling.externalModules?.filter(
            m => m !== '@aws-sdk/client-s3' && m !== '@aws-sdk/s3-request-presigner',
          ),
        },
        timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
        memorySize: SCREENING_HANDLER_MEMORY_MB,
      });

      props.taskTable.grantReadData(getTraceUrlFn);
      // ``s3:GetObject`` also covers ``s3:HeadObject``.
      getTraceUrlFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${traceBucket.bucketArn}/*`],
      }));

      const trace = taskById.addResource('trace');
      trace.addMethod('GET', new apigw.LambdaIntegration(getTraceUrlFn, { allowTestInvoke: false }), cognitoAuthOptions);

      allFunctions.push(getTraceUrlFn);
    }

    if (props.taskNudgesTable) {
      const nudgeTaskEnv: Record<string, string> = {
        ...commonEnv,
        NUDGES_TABLE_NAME: props.taskNudgesTable.tableName,
        NUDGE_RATE_LIMIT_PER_MINUTE: String(props.nudgeRateLimitPerMinute ?? 10),
      };
      if (props.guardrailId && props.guardrailVersion) {
        nudgeTaskEnv.GUARDRAIL_ID = props.guardrailId;
        nudgeTaskEnv.GUARDRAIL_VERSION = props.guardrailVersion;
      }

      const nudgeTaskFn = new lambda.NodejsFunction(this, 'NudgeTaskFn', {
        entry: path.join(handlersDir, 'nudge-task.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: nudgeTaskEnv,
        bundling: commonBundling,
      });

      props.taskTable.grantReadData(nudgeTaskFn);
      props.taskNudgesTable.grantReadWriteData(nudgeTaskFn);

      if (props.guardrailId) {
        nudgeTaskFn.addToRolePolicy(new iam.PolicyStatement({
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

      const nudge = taskById.addResource('nudge');
      nudge.addMethod('POST', new apigw.LambdaIntegration(nudgeTaskFn, { allowTestInvoke: false }), cognitoAuthOptions);

      allFunctions.push(nudgeTaskFn);
    }

    if (props.taskApprovalsTable) {
      const approvalEnv: Record<string, string> = {
        ...commonEnv,
        TASK_APPROVALS_TABLE_NAME: props.taskApprovalsTable.tableName,
      };

      const approveTaskFn = new lambda.NodejsFunction(this, 'ApproveTaskFn', {
        entry: path.join(handlersDir, 'approve-task.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: approvalEnv,
        bundling: commonBundling,
        timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
        memorySize: API_HANDLER_MEMORY_MB,
      });
      props.taskTable.grantReadWriteData(approveTaskFn);
      props.taskApprovalsTable.grantReadWriteData(approveTaskFn);
      props.taskEventsTable.grantReadWriteData(approveTaskFn);

      const denyTaskFn = new lambda.NodejsFunction(this, 'DenyTaskFn', {
        entry: path.join(handlersDir, 'deny-task.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: approvalEnv,
        bundling: commonBundling,
        timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
        memorySize: API_HANDLER_MEMORY_MB,
      });
      props.taskTable.grantReadWriteData(denyTaskFn);
      props.taskApprovalsTable.grantReadWriteData(denyTaskFn);
      props.taskEventsTable.grantReadWriteData(denyTaskFn);
      if (props.lambdaMicrovmImageArn) {
        for (const decisionFn of [approveTaskFn, denyTaskFn]) {
          decisionFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['lambda:GetMicrovm', 'lambda:ResumeMicrovm'],
            resources: [props.lambdaMicrovmImageArn, `${props.lambdaMicrovmImageArn}:*`],
          }));
        }
      }

      const getPendingFn = new lambda.NodejsFunction(this, 'GetPendingFn', {
        entry: path.join(handlersDir, 'get-pending.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: approvalEnv,
        bundling: commonBundling,
        timeout: Duration.seconds(10),
        memorySize: API_HANDLER_MEMORY_MB,
      });
      getPendingFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [
          props.taskApprovalsTable.tableArn,
          `${props.taskApprovalsTable.tableArn}/index/*`,
        ],
      }));
      getPendingFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [props.taskApprovalsTable.tableArn],
      }));

      const approveTask = taskById.addResource('approve');
      approveTask.addMethod(
        'POST',
        new apigw.LambdaIntegration(approveTaskFn, { allowTestInvoke: false }),
        cognitoAuthOptions,
      );
      const denyTask = taskById.addResource('deny');
      denyTask.addMethod(
        'POST',
        new apigw.LambdaIntegration(denyTaskFn, { allowTestInvoke: false }),
        cognitoAuthOptions,
      );
      const pending = this.api.root.addResource('pending');
      pending.addMethod(
        'GET',
        new apigw.LambdaIntegration(getPendingFn, { allowTestInvoke: false }),
        cognitoAuthOptions,
      );

      allFunctions.push(approveTaskFn, denyTaskFn, getPendingFn);

      if (props.cedarWasmLayer && props.repoTable) {
        const getPoliciesEnv: Record<string, string> = {
          ...approvalEnv,
          REPO_TABLE_NAME: props.repoTable.tableName,
        };
        const getPoliciesFn = new lambda.NodejsFunction(this, 'GetPoliciesFn', {
          entry: path.join(handlersDir, 'get-policies.ts'),
          handler: 'handler',
          runtime: Runtime.NODEJS_24_X,
          architecture: Architecture.ARM_64,
          environment: getPoliciesEnv,
          bundling: {
            ...commonBundling,
            externalModules: [
              ...(commonBundling.externalModules ?? []),
              '@cedar-policy/cedar-wasm',
              '@cedar-policy/cedar-wasm/nodejs',
            ],
          },
          layers: [props.cedarWasmLayer],
          memorySize: CEDAR_WASM_MIN_LAMBDA_MEMORY_MB,
          timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
        });
        props.taskApprovalsTable.grantReadData(getPoliciesFn);
        props.repoTable.grantReadData(getPoliciesFn);
        props.taskApprovalsTable.grantWriteData(getPoliciesFn);

        const repos = this.api.root.addResource('repos');
        const repoById = repos.addResource('{repo_id}');
        const policies = repoById.addResource('policies');
        policies.addMethod(
          'GET',
          new apigw.LambdaIntegration(getPoliciesFn, { allowTestInvoke: false }),
          cognitoAuthOptions,
        );
        allFunctions.push(getPoliciesFn);
      }
    }

    let webhookMgmtAuthOptions: apigw.MethodOptions = cognitoAuthOptions;

    if (props.apiKeyTable) {
      const apiKeyEnv: Record<string, string> = {
        API_KEY_TABLE_NAME: props.apiKeyTable.tableName,
        API_KEY_RETENTION_DAYS: String(props.apiKeyRetentionDays ?? DEFAULT_WEBHOOK_RETENTION_DAYS),
        ABCA_COMPONENT: 'api',
      };

      const apiKeyAuthorizerFn = new lambda.NodejsFunction(this, 'ApiKeyAuthorizerFn', {
        entry: path.join(handlersDir, 'api-key-authorizer.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: {
          API_KEY_TABLE_NAME: props.apiKeyTable.tableName,
          API_KEY_REQUIRED_SCOPE: 'webhooks:manage',
          USER_POOL_ID: this.userPool.userPoolId,
          APP_CLIENT_ID: this.appClient.userPoolClientId,
          ABCA_COMPONENT: 'api',
        },
        bundling: commonBundling,
      });
      props.apiKeyTable.grantReadData(apiKeyAuthorizerFn);

      // API Gateway requires every identity source of a REQUEST authorizer and
      // answers 401 without calling the Lambda when one is missing. It accepts
      // an empty list only with caching off.
      const webhookMgmtAuthorizer = new apigw.RequestAuthorizer(this, 'ApiKeyOrJwtAuthorizer', {
        handler: apiKeyAuthorizerFn,
        identitySources: [],
        resultsCacheTtl: Duration.seconds(0),
      });

      webhookMgmtAuthOptions = {
        authorizer: webhookMgmtAuthorizer,
        authorizationType: apigw.AuthorizationType.CUSTOM,
        requestValidator,
      };

      const createApiKeyFn = new lambda.NodejsFunction(this, 'CreateApiKeyFn', {
        entry: path.join(handlersDir, 'create-api-key.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: apiKeyEnv,
        bundling: commonBundling,
      });

      const listApiKeysFn = new lambda.NodejsFunction(this, 'ListApiKeysFn', {
        entry: path.join(handlersDir, 'list-api-keys.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: apiKeyEnv,
        bundling: commonBundling,
      });

      const deleteApiKeyFn = new lambda.NodejsFunction(this, 'DeleteApiKeyFn', {
        entry: path.join(handlersDir, 'delete-api-key.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: apiKeyEnv,
        bundling: commonBundling,
      });

      props.apiKeyTable.grantReadWriteData(createApiKeyFn);
      props.apiKeyTable.grantReadData(listApiKeysFn);
      props.apiKeyTable.grantReadWriteData(deleteApiKeyFn);

      const apiKeys = this.api.root.addResource('api-keys');
      apiKeys.addMethod('POST', new apigw.LambdaIntegration(createApiKeyFn, { allowTestInvoke: false }), cognitoAuthOptions);
      apiKeys.addMethod('GET', new apigw.LambdaIntegration(listApiKeysFn, { allowTestInvoke: false }), cognitoAuthOptions);

      const apiKeyById = apiKeys.addResource('{key_id}');
      apiKeyById.addMethod('DELETE', new apigw.LambdaIntegration(deleteApiKeyFn, { allowTestInvoke: false }), cognitoAuthOptions);

      allFunctions.push(apiKeyAuthorizerFn, createApiKeyFn, listApiKeysFn, deleteApiKeyFn);
    }

    if (props.webhookTable) {
      const webhookEnv: Record<string, string> = {
        WEBHOOK_TABLE_NAME: props.webhookTable.tableName,
        WEBHOOK_RETENTION_DAYS: String(props.webhookRetentionDays ?? DEFAULT_WEBHOOK_RETENTION_DAYS),
        ABCA_COMPONENT: 'webhook',
      };

      const createWebhookFn = new lambda.NodejsFunction(this, 'CreateWebhookFn', {
        entry: path.join(handlersDir, 'create-webhook.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: webhookEnv,
        bundling: commonBundling,
      });

      const listWebhooksFn = new lambda.NodejsFunction(this, 'ListWebhooksFn', {
        entry: path.join(handlersDir, 'list-webhooks.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: webhookEnv,
        bundling: commonBundling,
      });

      const deleteWebhookFn = new lambda.NodejsFunction(this, 'DeleteWebhookFn', {
        entry: path.join(handlersDir, 'delete-webhook.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: webhookEnv,
        bundling: commonBundling,
      });

      const webhookAuthorizerFn = new lambda.NodejsFunction(this, 'WebhookAuthorizerFn', {
        entry: path.join(handlersDir, 'webhook-authorizer.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: webhookEnv,
        bundling: commonBundling,
      });

      const webhookCreateTaskEnv: Record<string, string> = { ...createTaskEnv, ABCA_COMPONENT: 'webhook' };
      const webhookCreateTaskFn = new lambda.NodejsFunction(this, 'WebhookCreateTaskFn', {
        entry: path.join(handlersDir, 'webhook-create-task.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: webhookCreateTaskEnv,
        bundling: attachmentScreeningBundling,
        memorySize: HEAVY_ATTACHMENT_HANDLER_MEMORY_MB,
        timeout: Duration.seconds(API_HANDLER_TIMEOUT_SECONDS),
      });

      props.webhookTable.grantReadWriteData(createWebhookFn);
      props.webhookTable.grantReadData(listWebhooksFn);
      props.webhookTable.grantReadWriteData(deleteWebhookFn);
      props.webhookTable.grantReadData(webhookAuthorizerFn);

      props.taskTable.grantReadWriteData(webhookCreateTaskFn);
      props.taskEventsTable.grantReadWriteData(webhookCreateTaskFn);
      if (props.repoTable) {
        props.repoTable.grantReadData(webhookCreateTaskFn);
      }
      if (props.budgetTable) {
        props.budgetTable.grantReadData(webhookCreateTaskFn);
        webhookCreateTaskFn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['cognito-idp:AdminListGroupsForUser'],
          resources: [this.userPool.userPoolArn],
        }));
      }

      if (props.orchestratorFunctionArn) {
        webhookCreateTaskFn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [props.orchestratorFunctionArn],
        }));
      }

      if (props.guardrailId) {
        webhookCreateTaskFn.addToRolePolicy(new iam.PolicyStatement({
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

      const secretArnPrefix = Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: 'bgagent/webhook/*',
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      });

      createWebhookFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:CreateSecret'],
        resources: ['*'],
        conditions: {
          StringLike: { 'secretsmanager:Name': 'bgagent/webhook/*' },
        },
      }));

      createWebhookFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:TagResource'],
        resources: [secretArnPrefix],
      }));

      deleteWebhookFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:DeleteSecret'],
        resources: [secretArnPrefix],
      }));

      webhookCreateTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secretArnPrefix],
      }));

      const webhookRequestAuthorizer = new apigw.RequestAuthorizer(this, 'WebhookAuthorizer', {
        handler: webhookAuthorizerFn,
        identitySources: [
          apigw.IdentitySource.header('X-Webhook-Id'),
          apigw.IdentitySource.header('X-Webhook-Signature'),
        ],
        resultsCacheTtl: Duration.seconds(0),
      });

      const webhookAuthOptions: apigw.MethodOptions = {
        authorizer: webhookRequestAuthorizer,
        authorizationType: apigw.AuthorizationType.CUSTOM,
        requestValidator,
      };

      const webhooks = this.api.root.addResource('webhooks');
      const createWebhookMethod = webhooks.addMethod('POST', new apigw.LambdaIntegration(createWebhookFn, { allowTestInvoke: false }), webhookMgmtAuthOptions);
      const listWebhooksMethod = webhooks.addMethod('GET', new apigw.LambdaIntegration(listWebhooksFn, { allowTestInvoke: false }), webhookMgmtAuthOptions);

      const webhookById = webhooks.addResource('{webhook_id}');
      const deleteWebhookMethod = webhookById.addMethod('DELETE', new apigw.LambdaIntegration(deleteWebhookFn, { allowTestInvoke: false }), webhookMgmtAuthOptions);

      if (props.apiKeyTable) {
        NagSuppressions.addResourceSuppressions([createWebhookMethod, listWebhooksMethod, deleteWebhookMethod], [
          {
            id: 'AwsSolutions-COG4',
            reason: 'Webhook management uses a unified REQUEST authorizer accepting a Cognito JWT or a scoped platform API key — by design for headless automation',
          },
        ]);
      }

      const webhookTasks = webhooks.addResource('tasks');
      const webhookTasksMethod = webhookTasks.addMethod('POST', new apigw.LambdaIntegration(webhookCreateTaskFn, { allowTestInvoke: false }), webhookAuthOptions);

      NagSuppressions.addResourceSuppressions(webhookTasksMethod, [
        {
          id: 'AwsSolutions-COG4',
          reason: 'Webhook task creation endpoint uses HMAC-SHA256 REQUEST authorizer instead of Cognito — by design for external system integration',
        },
      ]);

      allFunctions.push(createWebhookFn, listWebhooksFn, deleteWebhookFn, webhookAuthorizerFn, webhookCreateTaskFn);
    }

    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended managed policy for Lambda functions',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData/grantReadData for GSI access; ecs:StopTask is conditioned on the cluster ARN; Lambda MicroVM cancel/wake actions (TerminateMicrovm/GetMicrovm/ResumeMicrovm) are scoped to the single platform MicroVM image ARN plus a <arn>:* version-suffix sibling (delivered as a Lazy.string because TaskApi is built before the MicroVM construct) — ADR-021',
        },
      ], true);
    }

    NagSuppressions.addResourceSuppressions(this.api, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonAPIGatewayPushToCloudWatchLogs is the AWS-recommended managed policy for API Gateway CloudWatch logging',
      },
    ], true);
  }
}
