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
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { StartingPosition, Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const DLQ_RETENTION_DAYS = 14;

const DEFAULT_MAX_BATCHING_WINDOW_SECONDS = 5;

const DLQ_ALARM_PERIOD_MINUTES = 5;

const FANOUT_MEMORY_MB = 256;

export interface FanOutConsumerProps {
  /** The TaskEventsTable whose stream this consumer reads from. Must
   *  have `stream: NEW_IMAGE` enabled (see `TaskEventsTable`). */
  readonly taskEventsTable: dynamodb.ITable;

  /**
   * TaskTable — the GitHub dispatcher needs read access to resolve
   * repo + pr_number + existing github_comment_id for a task, and
   * write access to persist the comment_id + etag after an upsert.
   * Optional: if omitted, the GitHub dispatcher skips (log-only).
   */
  readonly taskTable?: dynamodb.ITable;

  /**
   * RepoTable — GitHub dispatcher reads per-repo
   * `github_token_secret_arn` overrides. Optional: if omitted, falls
   * back to the platform default secret.
   */
  readonly repoTable?: dynamodb.ITable;

  /**
   * Platform default GitHub token secret. Used by the GitHub
   * dispatcher when the per-repo config has no override. Optional: if
   * omitted and the repo has no override, the dispatcher skips.
   */
  readonly githubTokenSecret?: sm.ISecret;

  /**
   * Secrets Manager ARN-prefix pattern for per-workspace Slack bot
   * tokens. Required ONLY when the platform deploys SlackIntegration —
   * the Slack dispatcher reads bot tokens at this scope. Typically passed
   * as ``Stack.of(this).formatArn({ ..., resourceName:
   * 'bgagent/slack/*' })``.
   */
  readonly slackSecretArnPattern?: string;

  /**
   * LinearWorkspaceRegistryTable — the Linear dispatcher reads this to
   * resolve per-workspace OAuth tokens at comment-post time. Optional:
   * when omitted, the dispatcher logs and skips.
   */
  readonly linearWorkspaceRegistryTable?: dynamodb.ITable;

  /**
   * Secrets Manager ARN-prefix pattern for per-workspace Linear OAuth
   * bundles — typically ``bgagent-linear-oauth-*``. Required when
   * ``linearWorkspaceRegistryTable`` is set.
   */
  readonly linearOauthSecretArnPattern?: string;

  /**
   * Linear native agent-session channel. When true, sets
   * ``LINEAR_AGENT_SESSIONS_ENABLED`` so the Linear dispatcher subscribes to
   * per-turn events (session keep-alive). Default false.
   */
  readonly linearAgentSessionsEnabled?: boolean;

  /**
   * JiraWorkspaceRegistryTable — the Jira dispatcher reads this to resolve
   * per-tenant OAuth tokens at comment-post time. Optional:
   * when omitted, the dispatcher logs and skips.
   */
  readonly jiraWorkspaceRegistryTable?: dynamodb.ITable;

  /**
   * Secrets Manager ARN-prefix pattern for per-tenant Jira OAuth bundles —
   * typically ``bgagent-jira-oauth-*``. Required when
   * ``jiraWorkspaceRegistryTable`` is set.
   */
  readonly jiraOauthSecretArnPattern?: string;

  /**
   * Maximum batch size delivered to the Lambda per invocation.
   *
   * @default 100 (DynamoDB Stream default)
   */
  readonly batchSize?: number;

  /**
   * Max age of records in the batch before Lambda is invoked even if
   * batch isn't full.
   *
   * @default Duration.seconds(5)
   */
  readonly maxBatchingWindow?: Duration;
}

/**
 * DynamoDB Stream → Lambda consumer that fans out task events to
 * non-interactive channels.
 *
 * Errors in individual records do NOT fail the batch. Persistent
 * failures land in the DLQ attached to the event source mapping so
 * operators can replay.
 */
export class FanOutConsumer extends Construct {
  public readonly fn: lambda.NodejsFunction;
  public readonly dlq: sqs.Queue;
  /** Fires when records land in the fan-out DLQ. */
  public readonly dlqDepthAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: FanOutConsumerProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.dlq = new sqs.Queue(this, 'FanOutDlq', {
      retentionPeriod: Duration.days(DLQ_RETENTION_DAYS),
      enforceSSL: true,
    });

    const logGroup = new logs.LogGroup(this, 'FanOutFnLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new lambda.NodejsFunction(this, 'FanOutFn', {
      entry: path.join(handlersDir, 'fanout-task-events.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(1),
      memorySize: FANOUT_MEMORY_MB,
      logGroup,
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    this.fn.addEnvironment('ABCA_COMPONENT', 'orchestr');

    if (props.taskTable) {
      props.taskTable.grantReadWriteData(this.fn);
      this.fn.addEnvironment('TASK_TABLE_NAME', props.taskTable.tableName);
    }
    if (props.repoTable) {
      props.repoTable.grantReadData(this.fn);
      this.fn.addEnvironment('REPO_TABLE_NAME', props.repoTable.tableName);
    }
    if (props.githubTokenSecret) {
      props.githubTokenSecret.grantRead(this.fn);
      this.fn.addEnvironment('GITHUB_TOKEN_SECRET_ARN', props.githubTokenSecret.secretArn);
    }

    if (props.slackSecretArnPattern) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.slackSecretArnPattern],
      }));
    }

    if (props.linearWorkspaceRegistryTable) {
      props.linearWorkspaceRegistryTable.grantReadData(this.fn);
      this.fn.addEnvironment(
        'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME',
        props.linearWorkspaceRegistryTable.tableName,
      );
    }
    if (props.linearOauthSecretArnPattern) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [props.linearOauthSecretArnPattern],
      }));
    }

    if (props.linearAgentSessionsEnabled) {
      this.fn.addEnvironment('LINEAR_AGENT_SESSIONS_ENABLED', 'true');
    }

    if (props.jiraWorkspaceRegistryTable) {
      props.jiraWorkspaceRegistryTable.grantReadData(this.fn);
      this.fn.addEnvironment(
        'JIRA_WORKSPACE_REGISTRY_TABLE_NAME',
        props.jiraWorkspaceRegistryTable.tableName,
      );
    }
    if (props.jiraOauthSecretArnPattern) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        resources: [props.jiraOauthSecretArnPattern],
      }));
    }

    this.dlqDepthAlarm = new cloudwatch.Alarm(this, 'FanOutDlqDepthAlarm', {
      metric: this.dlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(DLQ_ALARM_PERIOD_MINUTES),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        'Fan-out DLQ has undelivered task-event records — Slack/GitHub/Linear/Jira notifications are failing. ' +
        'Check CloudWatch Logs for the FanOutFn error that caused the DLQ send. ' +
        'See: https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/117',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.fn.addEventSource(new DynamoEventSource(props.taskEventsTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: props.batchSize ?? 100,
      maxBatchingWindow: props.maxBatchingWindow ?? Duration.seconds(DEFAULT_MAX_BATCHING_WINDOW_SECONDS),
      retryAttempts: 3,
      onFailure: new SqsDlq(this.dlq),
      reportBatchItemFailures: true,
    }));

    NagSuppressions.addResourceSuppressions(this.fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'DynamoDB stream/index wildcards generated by CDK for event-source-mapping read access',
      },
    ], true);
    NagSuppressions.addResourceSuppressions(this.dlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason:
          'This queue IS the DLQ for the fan-out Lambda — having its own DLQ would be infinite recursion',
      },
    ]);
  }
}
