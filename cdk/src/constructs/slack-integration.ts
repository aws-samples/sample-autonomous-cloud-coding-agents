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
import { Runtime, Architecture, StartingPosition, FilterCriteria, FilterRule } from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { SlackInstallationTable } from './slack-installation-table';
import { SlackUserMappingTable } from './slack-user-mapping-table';

/**
 * Properties for SlackIntegration construct.
 */
export interface SlackIntegrationProps {
  /** The existing REST API to add Slack routes to. */
  readonly api: apigw.RestApi;

  /** Cognito user pool for the /slack/link endpoint (Cognito-authenticated). */
  readonly userPool: cognito.IUserPool;

  /** The DynamoDB task table. */
  readonly taskTable: dynamodb.ITable;

  /** The DynamoDB task events table (must have DynamoDB Streams enabled). */
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

  /** Removal policy for Slack DynamoDB tables. */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * CDK construct that adds Slack integration to the ABCA platform.
 *
 * Creates:
 * - SlackInstallationTable (per-workspace installation records)
 * - SlackUserMappingTable (Slack user → platform user mappings)
 * - Lambda handlers for OAuth, slash commands, events, notifications, and account linking
 * - API Gateway routes under /slack/*
 * - DynamoDB Streams event source for outbound notifications
 */
export class SlackIntegration extends Construct {
  /** The Slack installation table. */
  public readonly installationTable: dynamodb.Table;

  /** The Slack user mapping table. */
  public readonly userMappingTable: dynamodb.Table;

  /** The Slack signing secret (placeholder — user populates after creating the Slack App). */
  public readonly signingSecret: secretsmanager.Secret;

  /** The Slack client secret (placeholder — user populates after creating the Slack App). */
  public readonly clientSecret: secretsmanager.Secret;

  /** The Slack client ID secret (placeholder — user populates after creating the Slack App). */
  public readonly clientIdSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SlackIntegrationProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // --- DynamoDB Tables ---
    const installationTable = new SlackInstallationTable(this, 'InstallationTable', { removalPolicy });
    const userMappingTable = new SlackUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    this.installationTable = installationTable.table;
    this.userMappingTable = userMappingTable.table;

    // --- Slack App Secrets (CDK-created placeholders) ---
    // Users populate these after creating the Slack App via the SlackAppCreateUrl output.
    this.signingSecret = new secretsmanager.Secret(this, 'SigningSecret', {
      description: 'Slack App signing secret — populate after creating the Slack App',
      removalPolicy,
    });
    this.clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      description: 'Slack App client secret (OAuth) — populate after creating the Slack App',
      removalPolicy,
    });
    this.clientIdSecret = new secretsmanager.Secret(this, 'ClientIdSecret', {
      description: 'Slack App client ID — populate after creating the Slack App',
      removalPolicy,
    });

    // --- Shared Lambda configuration ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };

    // Secrets Manager ARN prefix for Slack secrets (bgagent/slack/*)
    const slackSecretArnPrefix = Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'bgagent/slack/*',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // IAM policy for reading Slack secrets from Secrets Manager
    const readSlackSecretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [slackSecretArnPrefix],
    });

    // --- Cognito Authorizer (for /slack/link endpoint) ---
    const cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'SlackCognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
    });

    const cognitoAuthOptions: apigw.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    const noneAuthOptions: apigw.MethodOptions = {
      authorizationType: apigw.AuthorizationType.NONE,
    };

    // --- Task creation environment (matches TaskApi createTaskEnv pattern) ---
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

    // ═══════════════════════════════════════════════════════════════════════════
    // Lambda Handlers
    // ═══════════════════════════════════════════════════════════════════════════

    // --- OAuth Callback ---
    const oauthCallbackFn = new lambda.NodejsFunction(this, 'OAuthCallbackFn', {
      entry: path.join(handlersDir, 'slack-oauth-callback.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(15),
      environment: {
        SLACK_INSTALLATION_TABLE_NAME: this.installationTable.tableName,
        SLACK_CLIENT_ID_SECRET_ARN: this.clientIdSecret.secretArn,
        SLACK_CLIENT_SECRET_ARN: this.clientSecret.secretArn,
      },
      bundling: commonBundling,
    });
    this.installationTable.grantWriteData(oauthCallbackFn);
    this.clientIdSecret.grantRead(oauthCallbackFn);
    this.clientSecret.grantRead(oauthCallbackFn);
    oauthCallbackFn.addToRolePolicy(readSlackSecretsPolicy);
    // CreateSecret + UpdateSecret for bot tokens
    oauthCallbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        StringLike: { 'secretsmanager:Name': 'bgagent/slack/*' },
      },
    }));
    oauthCallbackFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:UpdateSecret', 'secretsmanager:TagResource', 'secretsmanager:RestoreSecret'],
      resources: [slackSecretArnPrefix],
    }));

    // --- Slack Events ---
    // Note: SLACK_COMMAND_PROCESSOR_FUNCTION_NAME is set below after commandProcessorFn is created.
    const slackEventsFn = new lambda.NodejsFunction(this, 'SlackEventsFn', {
      entry: path.join(handlersDir, 'slack-events.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        SLACK_INSTALLATION_TABLE_NAME: this.installationTable.tableName,
        SLACK_SIGNING_SECRET_ARN: this.signingSecret.secretArn,
      },
      bundling: commonBundling,
    });

    // Keep one instance warm — Slack's URL verification during app creation
    // times out on cold starts, and the retry UX is poor.
    const slackEventsAlias = slackEventsFn.addAlias('live', {
      provisionedConcurrentExecutions: 1,
    });
    this.installationTable.grantReadWriteData(slackEventsFn);
    this.signingSecret.grantRead(slackEventsFn);
    slackEventsFn.addToRolePolicy(readSlackSecretsPolicy);
    slackEventsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DeleteSecret'],
      resources: [slackSecretArnPrefix],
    }));

    // --- Slash Command Processor (async worker) ---
    const commandProcessorFn = new lambda.NodejsFunction(this, 'CommandProcessorFn', {
      entry: path.join(handlersDir, 'slack-command-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(30),
      environment: {
        ...createTaskEnv,
        SLACK_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        SLACK_INSTALLATION_TABLE_NAME: this.installationTable.tableName,
      },
      bundling: commonBundling,
    });
    this.userMappingTable.grantReadWriteData(commandProcessorFn);
    this.installationTable.grantReadData(commandProcessorFn);
    commandProcessorFn.addToRolePolicy(readSlackSecretsPolicy);
    props.taskTable.grantReadWriteData(commandProcessorFn);
    props.taskEventsTable.grantReadWriteData(commandProcessorFn);
    if (props.repoTable) {
      props.repoTable.grantReadData(commandProcessorFn);
    }
    if (props.orchestratorFunctionArn) {
      commandProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.orchestratorFunctionArn],
      }));
    }
    if (props.guardrailId) {
      commandProcessorFn.addToRolePolicy(new iam.PolicyStatement({
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

    // Wire events handler to command processor for @mention forwarding.
    slackEventsFn.addEnvironment('SLACK_COMMAND_PROCESSOR_FUNCTION_NAME', commandProcessorFn.functionName);
    commandProcessorFn.grantInvoke(slackEventsFn);

    // --- Slack Interactions (Block Kit button actions) ---
    const slackInteractionsFn = new lambda.NodejsFunction(this, 'SlackInteractionsFn', {
      entry: path.join(handlersDir, 'slack-interactions.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        SLACK_SIGNING_SECRET_ARN: this.signingSecret.secretArn,
        TASK_TABLE_NAME: props.taskTable.tableName,
        SLACK_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
      },
      bundling: commonBundling,
    });
    this.signingSecret.grantRead(slackInteractionsFn);
    slackInteractionsFn.addToRolePolicy(readSlackSecretsPolicy);
    props.taskTable.grantReadWriteData(slackInteractionsFn);
    this.userMappingTable.grantReadData(slackInteractionsFn);

    // --- Slash Command Acknowledger ---
    const slackCommandsFn = new lambda.NodejsFunction(this, 'SlackCommandsFn', {
      entry: path.join(handlersDir, 'slack-commands.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(3),
      environment: {
        SLACK_SIGNING_SECRET_ARN: this.signingSecret.secretArn,
        SLACK_COMMAND_PROCESSOR_FUNCTION_NAME: commandProcessorFn.functionName,
      },
      bundling: commonBundling,
    });
    this.signingSecret.grantRead(slackCommandsFn);
    slackCommandsFn.addToRolePolicy(readSlackSecretsPolicy);
    commandProcessorFn.grantInvoke(slackCommandsFn);

    // --- Account Linking (Cognito-authenticated) ---
    const slackLinkFn = new lambda.NodejsFunction(this, 'SlackLinkFn', {
      entry: path.join(handlersDir, 'slack-link.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      environment: {
        SLACK_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
      },
      bundling: commonBundling,
    });
    this.userMappingTable.grantReadWriteData(slackLinkFn);

    // --- Outbound Notification Handler (DynamoDB Streams trigger) ---
    const slackNotifyFn = new lambda.NodejsFunction(this, 'SlackNotifyFn', {
      entry: path.join(handlersDir, 'slack-notify.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(30),
      environment: {
        TASK_TABLE_NAME: props.taskTable.tableName,
      },
      bundling: commonBundling,
    });
    props.taskTable.grantReadWriteData(slackNotifyFn);
    slackNotifyFn.addToRolePolicy(readSlackSecretsPolicy);

    // DynamoDB Streams event source with filtering
    slackNotifyFn.addEventSource(new lambdaEventSources.DynamoEventSource(props.taskEventsTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 10,
      maxBatchingWindow: Duration.seconds(0),
      retryAttempts: 3,
      bisectBatchOnError: true,
      filters: [
        FilterCriteria.filter({
          eventName: FilterRule.isEqual('INSERT'),
        }),
      ],
    }));

    // ═══════════════════════════════════════════════════════════════════════════
    // API Gateway Routes
    // ═══════════════════════════════════════════════════════════════════════════

    const slack = props.api.root.addResource('slack');

    // OAuth callback: GET /v1/slack/oauth/callback
    const oauthResource = slack.addResource('oauth');
    const oauthCallbackResource = oauthResource.addResource('callback');
    const oauthCallbackMethod = oauthCallbackResource.addMethod(
      'GET',
      new apigw.LambdaIntegration(oauthCallbackFn),
      noneAuthOptions,
    );

    // Slack events: POST /v1/slack/events
    const eventsResource = slack.addResource('events');
    const eventsMethod = eventsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackEventsAlias),
      noneAuthOptions,
    );

    // Slash commands: POST /v1/slack/commands
    const commandsResource = slack.addResource('commands');
    const commandsMethod = commandsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackCommandsFn),
      noneAuthOptions,
    );

    // Block Kit interactions: POST /v1/slack/interactions
    const interactionsResource = slack.addResource('interactions');
    const interactionsMethod = interactionsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackInteractionsFn),
      noneAuthOptions,
    );

    // Account linking: POST /v1/slack/link (Cognito-authenticated)
    const linkResource = slack.addResource('link');
    linkResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackLinkFn),
      cognitoAuthOptions,
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // cdk-nag suppressions
    // ═══════════════════════════════════════════════════════════════════════════

    // Suppress APIG4 and COG4 on routes that use Slack signing secret instead of Cognito
    const slackVerifiedMethods = [oauthCallbackMethod, eventsMethod, commandsMethod, interactionsMethod];
    for (const method of slackVerifiedMethods) {
      NagSuppressions.addResourceSuppressions(method, [
        {
          id: 'AwsSolutions-APIG4',
          reason: 'Slack endpoint uses Slack signing secret verification instead of Cognito — by design for Slack API integration',
        },
        {
          id: 'AwsSolutions-COG4',
          reason: 'Slack endpoint uses Slack signing secret verification instead of Cognito — by design for Slack API integration',
        },
      ]);
    }

    // Slack secrets are managed externally (populated by the user after creating the Slack App)
    for (const secret of [this.signingSecret, this.clientSecret, this.clientIdSecret]) {
      NagSuppressions.addResourceSuppressions(secret, [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Slack App credentials are managed externally — automatic rotation is not applicable',
        },
      ]);
    }

    // Standard Lambda suppressions
    const allFunctions = [oauthCallbackFn, slackEventsFn, slackCommandsFn, commandProcessorFn, slackLinkFn, slackNotifyFn, slackInteractionsFn];
    for (const fn of allFunctions) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended managed policy for Lambda functions',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permissions are scoped by condition (secretsmanager:Name prefix) or by DynamoDB index ARN patterns',
        },
      ], true);
    }
  }
}
