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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { SlackChannelMappingTable } from './slack-channel-mapping-table';
import { SlackInstallationTable } from './slack-installation-table';
import { SlackUserMappingTable } from './slack-user-mapping-table';
import { ComponentUaAspect } from './solution-ua-aspect';

const DEFAULT_TASK_RETENTION_DAYS = 90;

const OAUTH_CALLBACK_TIMEOUT_SECONDS = 15;

const COMMAND_PROCESSOR_TIMEOUT_SECONDS = 30;

const COMMAND_ACK_TIMEOUT_SECONDS = 3;

const COMMAND_PROCESSOR_MEMORY_MB = 512;

export interface SlackIntegrationProps {
  /** The existing REST API to add Slack routes to. */
  readonly api: apigw.RestApi;

  /** Cognito user pool for the /slack/link endpoint (Cognito-authenticated). */
  readonly userPool: cognito.IUserPool;

  readonly taskTable: dynamodb.ITable;

  readonly taskEventsTable: dynamodb.ITable;

  readonly budgetTable?: dynamodb.ITable;

  readonly repoTable?: dynamodb.ITable;

  readonly orchestratorFunctionArn?: string;

  readonly guardrailId?: string;

  readonly guardrailVersion?: string;

  readonly taskRetentionDays?: number;

  readonly removalPolicy?: RemovalPolicy;
}

/**
 * CDK construct that adds Slack integration to the ABCA platform.
 *
 * Creates:
 * - SlackInstallationTable (per-workspace installation records)
 * - SlackUserMappingTable (Slack user → platform user mappings)
 * - Lambda handlers for OAuth, slash commands, events, and account linking
 * - API Gateway routes under /slack/*
 */
export class SlackIntegration extends Construct {
  public readonly installationTable: dynamodb.Table;

  public readonly userMappingTable: dynamodb.Table;

  public readonly channelMappingTable: dynamodb.Table;

  /** The Slack signing secret (placeholder — user populates after creating the Slack App). */
  public readonly signingSecret: secretsmanager.Secret;

  /** The Slack client secret (placeholder — user populates after creating the Slack App). */
  public readonly clientSecret: secretsmanager.Secret;

  /** The Slack client ID secret (placeholder — user populates after creating the Slack App). */
  public readonly clientIdSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SlackIntegrationProps) {
    super(scope, id);

    Aspects.of(this).add(new ComponentUaAspect('webhook'));

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    const installationTable = new SlackInstallationTable(this, 'InstallationTable', { removalPolicy });
    const userMappingTable = new SlackUserMappingTable(this, 'UserMappingTable', { removalPolicy });
    const channelMappingTable = new SlackChannelMappingTable(this, 'ChannelMappingTable', { removalPolicy });
    this.installationTable = installationTable.table;
    this.userMappingTable = userMappingTable.table;
    this.channelMappingTable = channelMappingTable.table;

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

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const commonBundling: lambda.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
    };
    // pdf-parse (v2, pdfjs-based) can't be esbuild-bundled — ship it unbundled so
    // it resolves natively at runtime.
    const attachmentScreeningBundling: lambda.BundlingOptions = {
      ...commonBundling,
      nodeModules: ['pdf-parse'],
    };

    const slackSecretArnPrefix = Stack.of(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: 'bgagent/slack/*',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const readSlackSecretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [slackSecretArnPrefix],
    });

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
    if (props.budgetTable) {
      createTaskEnv.BUDGET_TABLE_NAME = props.budgetTable.tableName;
      createTaskEnv.USER_POOL_ID = props.userPool.userPoolId;
    }

    const oauthCallbackFn = new lambda.NodejsFunction(this, 'OAuthCallbackFn', {
      entry: path.join(handlersDir, 'slack-oauth-callback.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(OAUTH_CALLBACK_TIMEOUT_SECONDS),
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

    // Slack gives its URL verification 3 s, which a cold start can miss.
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

    const commandProcessorFn = new lambda.NodejsFunction(this, 'CommandProcessorFn', {
      entry: path.join(handlersDir, 'slack-command-processor.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(COMMAND_PROCESSOR_TIMEOUT_SECONDS),
      memorySize: COMMAND_PROCESSOR_MEMORY_MB,
      environment: {
        ...createTaskEnv,
        SLACK_USER_MAPPING_TABLE_NAME: this.userMappingTable.tableName,
        SLACK_INSTALLATION_TABLE_NAME: this.installationTable.tableName,
        SLACK_CHANNEL_MAPPING_TABLE_NAME: this.channelMappingTable.tableName,
      },
      bundling: attachmentScreeningBundling,
    });
    this.userMappingTable.grantReadWriteData(commandProcessorFn);
    this.installationTable.grantReadData(commandProcessorFn);
    this.channelMappingTable.grantReadData(commandProcessorFn);
    commandProcessorFn.addToRolePolicy(readSlackSecretsPolicy);
    props.taskTable.grantReadWriteData(commandProcessorFn);
    props.taskEventsTable.grantReadWriteData(commandProcessorFn);
    if (props.repoTable) {
      props.repoTable.grantReadData(commandProcessorFn);
    }
    if (props.budgetTable) {
      props.budgetTable.grantReadData(commandProcessorFn);
      commandProcessorFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminListGroupsForUser'],
        resources: [props.userPool.userPoolArn],
      }));
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

    slackEventsFn.addEnvironment('SLACK_COMMAND_PROCESSOR_FUNCTION_NAME', commandProcessorFn.functionName);
    commandProcessorFn.grantInvoke(slackEventsFn);

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

    const slackCommandsFn = new lambda.NodejsFunction(this, 'SlackCommandsFn', {
      entry: path.join(handlersDir, 'slack-commands.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(COMMAND_ACK_TIMEOUT_SECONDS),
      environment: {
        SLACK_SIGNING_SECRET_ARN: this.signingSecret.secretArn,
        SLACK_COMMAND_PROCESSOR_FUNCTION_NAME: commandProcessorFn.functionName,
      },
      bundling: commonBundling,
    });
    this.signingSecret.grantRead(slackCommandsFn);
    commandProcessorFn.grantInvoke(slackCommandsFn);

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

    const slack = props.api.root.addResource('slack');

    const oauthResource = slack.addResource('oauth');
    const oauthCallbackResource = oauthResource.addResource('callback');
    const oauthCallbackMethod = oauthCallbackResource.addMethod(
      'GET',
      new apigw.LambdaIntegration(oauthCallbackFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    const eventsResource = slack.addResource('events');
    const eventsMethod = eventsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackEventsAlias, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    const commandsResource = slack.addResource('commands');
    const commandsMethod = commandsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackCommandsFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    const interactionsResource = slack.addResource('interactions');
    const interactionsMethod = interactionsResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackInteractionsFn, { allowTestInvoke: false }),
      noneAuthOptions,
    );

    const linkResource = slack.addResource('link');
    linkResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(slackLinkFn, { allowTestInvoke: false }),
      cognitoAuthOptions,
    );

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

    for (const secret of [this.signingSecret, this.clientSecret, this.clientIdSecret]) {
      NagSuppressions.addResourceSuppressions(secret, [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Slack App credentials are managed externally — automatic rotation is not applicable',
        },
      ]);
    }

    const allFunctions = [oauthCallbackFn, slackEventsFn, slackCommandsFn, commandProcessorFn, slackLinkFn, slackInteractionsFn];
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
