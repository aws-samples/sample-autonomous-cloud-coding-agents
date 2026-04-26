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
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for TaskApi construct.
 */
export interface TaskApiProps {
  /**
   * The DynamoDB task table.
   */
  readonly taskTable: dynamodb.ITable;

  /**
   * The DynamoDB task events table.
   */
  readonly taskEventsTable: dynamodb.ITable;

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
   * ARN of the orchestrator Lambda alias. When set, the create-task handler
   * async-invokes the orchestrator after writing the task record.
   */
  readonly orchestratorFunctionArn?: string;

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

  /**
   * Bedrock Guardrail ID for screening task input.
   */
  readonly guardrailId?: string;

  /**
   * Bedrock Guardrail version for screening task input.
   */
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
   * AgentCore runtime ARNs for which cancel-task may call `StopRuntimeSession`.
   * First ARN is also passed as `RUNTIME_ARN` when the task record has no `agent_runtime_arn`.
   */
  readonly agentCoreStopSessionRuntimeArns?: string[];

  /**
   * ECS cluster ARN for cancel-task to stop ECS-backed tasks.
   * When provided, the cancel Lambda gets `ECS_CLUSTER_ARN` env var and `ecs:StopTask` permission.
   */
  readonly ecsClusterArn?: string;

  /**
   * EC2 fleet configuration for cancel-task to stop EC2-backed tasks.
   * When provided, the cancel Lambda gets `ssm:CancelCommand` permission.
   */
  readonly ec2FleetConfig?: Record<string, never>;
}

/**
 * CDK construct that creates the Task API — an API Gateway REST API backed by
 * Cognito User Pool authentication and Lambda handler integrations.
 *
 * Exposes endpoints:
 * - POST   /tasks                → createTask (Cognito)
 * - GET    /tasks                → listTasks (Cognito)
 * - GET    /tasks/{task_id}      → getTask (Cognito)
 * - DELETE /tasks/{task_id}      → cancelTask (Cognito)
 * - GET    /tasks/{task_id}/events → getTaskEvents (Cognito)
 * - POST   /webhooks             → createWebhook (Cognito)
 * - GET    /webhooks             → listWebhooks (Cognito)
 * - DELETE /webhooks/{webhook_id} → deleteWebhook (Cognito)
 * - POST   /webhooks/tasks       → webhookCreateTask (REQUEST authorizer)
 */
export class TaskApi extends Construct {
  /**
   * The API Gateway REST API.
   */
  public readonly api: apigw.RestApi;

  /**
   * The Cognito User Pool for authentication.
   */
  public readonly userPool: cognito.UserPool;

  /**
   * The Cognito User Pool App Client ID.
   */
  public readonly appClientId: string;

  constructor(scope: Construct, id: string, props: TaskApiProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    const stageName = props.stageName ?? 'v1';

    // --- Cognito User Pool ---
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

    const appClient = this.userPool.addClient('AppClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });
    this.appClientId = appClient.userPoolClientId;

    // Suppress Cognito rules not applicable for dev environment
    NagSuppressions.addResourceSuppressions(this.userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA not required for dev environment — CLI-based auth flow' },
      { id: 'AwsSolutions-COG3', reason: 'Advanced security mode (Plus tier) not required for dev environment' },
    ]);

    // --- REST API ---
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
      },
    });

    // --- WAF Web ACL ---
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'TaskApiWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
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
          priority: 2,
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
          priority: 3,
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
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // --- Cognito Authorizer ---
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

    // --- Shared Lambda configuration ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonEnv = {
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? 90),
    };
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };

    // --- Lambda handlers ---
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

    const createTaskFn = new lambda.NodejsFunction(this, 'CreateTaskFn', {
      entry: path.join(handlersDir, 'create-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: createTaskEnv,
      bundling: commonBundling,
    });

    const getTaskFn = new lambda.NodejsFunction(this, 'GetTaskFn', {
      entry: path.join(handlersDir, 'get-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: commonEnv,
      bundling: commonBundling,
    });

    const listTasksFn = new lambda.NodejsFunction(this, 'ListTasksFn', {
      entry: path.join(handlersDir, 'list-tasks.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: commonEnv,
      bundling: commonBundling,
    });

    const cancelTaskEnv: Record<string, string> = { ...commonEnv };
    const stopSessionArns = props.agentCoreStopSessionRuntimeArns ?? [];
    if (stopSessionArns.length > 0) {
      cancelTaskEnv.RUNTIME_ARN = stopSessionArns[0]!;
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
    });

    const getTaskEventsFn = new lambda.NodejsFunction(this, 'GetTaskEventsFn', {
      entry: path.join(handlersDir, 'get-task-events.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: commonEnv,
      bundling: commonBundling,
    });

    // --- IAM grants ---
    // Read-write for create and cancel (write task + event)
    props.taskTable.grantReadWriteData(createTaskFn);
    props.taskEventsTable.grantReadWriteData(createTaskFn);
    props.taskTable.grantReadWriteData(cancelTaskFn);
    props.taskEventsTable.grantReadWriteData(cancelTaskFn);

    if (stopSessionArns.length > 0) {
      const runtimeResources = stopSessionArns.flatMap(arn => [arn, `${arn}/*`]);
      cancelTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:StopRuntimeSession'],
        resources: runtimeResources,
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

    if (props.ec2FleetConfig) {
      cancelTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:CancelCommand'],
        resources: ['*'],
      }));
    }

    // Repo table read for onboarding gate
    if (props.repoTable) {
      props.repoTable.grantReadData(createTaskFn);
    }

    // Read-only for get, list, and events
    props.taskTable.grantReadData(getTaskFn);
    props.taskTable.grantReadData(listTasksFn);
    props.taskTable.grantReadData(getTaskEventsFn);
    props.taskEventsTable.grantReadData(getTaskEventsFn);

    // Grant createTask permission to invoke the orchestrator
    if (props.orchestratorFunctionArn) {
      createTaskFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.orchestratorFunctionArn],
      }));
    }

    // Grant createTask permission to apply the guardrail
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

    // Collect all Lambda functions for cdk-nag suppressions
    const allFunctions: lambda.NodejsFunction[] = [createTaskFn, getTaskFn, listTasksFn, cancelTaskFn, getTaskEventsFn];

    // --- API resource tree: /tasks ---
    const tasks = this.api.root.addResource('tasks');
    tasks.addMethod('POST', new apigw.LambdaIntegration(createTaskFn), cognitoAuthOptions);
    tasks.addMethod('GET', new apigw.LambdaIntegration(listTasksFn), cognitoAuthOptions);

    const taskById = tasks.addResource('{task_id}');
    taskById.addMethod('GET', new apigw.LambdaIntegration(getTaskFn), cognitoAuthOptions);
    taskById.addMethod('DELETE', new apigw.LambdaIntegration(cancelTaskFn), cognitoAuthOptions);

    const events = taskById.addResource('events');
    events.addMethod('GET', new apigw.LambdaIntegration(getTaskEventsFn), cognitoAuthOptions);

    // --- Webhook endpoints (only when webhookTable is provided) ---
    if (props.webhookTable) {
      const webhookEnv: Record<string, string> = {
        WEBHOOK_TABLE_NAME: props.webhookTable.tableName,
        WEBHOOK_RETENTION_DAYS: String(props.webhookRetentionDays ?? 30),
      };

      // --- Webhook management Lambdas (Cognito-authenticated) ---
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

      // --- Webhook authorizer Lambda ---
      const webhookAuthorizerFn = new lambda.NodejsFunction(this, 'WebhookAuthorizerFn', {
        entry: path.join(handlersDir, 'webhook-authorizer.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: webhookEnv,
        bundling: commonBundling,
      });

      // --- Webhook task creation Lambda ---
      const webhookCreateTaskFn = new lambda.NodejsFunction(this, 'WebhookCreateTaskFn', {
        entry: path.join(handlersDir, 'webhook-create-task.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment: createTaskEnv,
        bundling: commonBundling,
      });

      // --- IAM grants for webhook Lambdas ---
      props.webhookTable.grantReadWriteData(createWebhookFn);
      props.webhookTable.grantReadData(listWebhooksFn);
      props.webhookTable.grantReadWriteData(deleteWebhookFn);
      props.webhookTable.grantReadData(webhookAuthorizerFn);

      // Webhook task creation needs same grants as createTask
      props.taskTable.grantReadWriteData(webhookCreateTaskFn);
      props.taskEventsTable.grantReadWriteData(webhookCreateTaskFn);
      if (props.repoTable) {
        props.repoTable.grantReadData(webhookCreateTaskFn);
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

      // Secrets Manager grants — prefix-scoped
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

      // --- REQUEST authorizer for webhook endpoints ---
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

      // --- API resource tree: /webhooks ---
      const webhooks = this.api.root.addResource('webhooks');
      webhooks.addMethod('POST', new apigw.LambdaIntegration(createWebhookFn), cognitoAuthOptions);
      webhooks.addMethod('GET', new apigw.LambdaIntegration(listWebhooksFn), cognitoAuthOptions);

      const webhookById = webhooks.addResource('{webhook_id}');
      webhookById.addMethod('DELETE', new apigw.LambdaIntegration(deleteWebhookFn), cognitoAuthOptions);

      const webhookTasks = webhooks.addResource('tasks');
      const webhookTasksMethod = webhookTasks.addMethod('POST', new apigw.LambdaIntegration(webhookCreateTaskFn), webhookAuthOptions);

      NagSuppressions.addResourceSuppressions(webhookTasksMethod, [
        {
          id: 'AwsSolutions-COG4',
          reason: 'Webhook task creation endpoint uses HMAC-SHA256 REQUEST authorizer instead of Cognito — by design for external system integration',
        },
      ]);

      // Add webhook functions to nag suppression list
      allFunctions.push(createWebhookFn, listWebhooksFn, deleteWebhookFn, webhookAuthorizerFn, webhookCreateTaskFn);
    }

    // --- cdk-nag suppressions for CDK-generated IAM policies ---
    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended managed policy for Lambda functions',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData/grantReadData for GSI access',
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
