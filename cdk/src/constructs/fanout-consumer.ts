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

/**
 * Properties for `FanOutConsumer` — the Phase 1b §8.9 fan-out plane
 * consumer that reads `TaskEventsTable` via DynamoDB Streams and
 * dispatches interesting events to non-interactive channels (Slack,
 * GitHub PR comments, email).
 */
export interface FanOutConsumerProps {
  /** The TaskEventsTable whose stream this consumer reads from. Must
   *  have `stream: NEW_IMAGE` enabled (see `TaskEventsTable`). */
  readonly taskEventsTable: dynamodb.ITable;

  /**
   * TaskTable — the GitHub dispatcher needs read access to resolve
   * repo + pr_number + existing github_comment_id for a task, and
   * write access to persist the comment_id + etag after an upsert.
   * Optional: if omitted, the GitHub dispatcher skips (log-only) and
   * Slack / Email continue to run as stubs.
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
   * the Slack dispatcher reads bot tokens at this scope. Matches the
   * other "guarded by prop" grants (taskTable, repoTable,
   * githubTokenSecret): a deployment without Slack onboarding gets no
   * dangling IAM permission to ``bgagent/slack/*``. Typically passed
   * as ``Stack.of(this).formatArn({ ..., resourceName:
   * 'bgagent/slack/*' })``. Found in PR #79 review (#2 CRITICAL).
   */
  readonly slackSecretArnPattern?: string;

  /**
   * Maximum batch size delivered to the Lambda per invocation.
   *
   * @default 100 (DynamoDB Stream default)
   */
  readonly batchSize?: number;

  /**
   * Max age of records in the batch before Lambda is invoked even if
   * batch isn't full. Keeps fan-out latency bounded for low-volume
   * periods.
   *
   * @default Duration.seconds(5)
   */
  readonly maxBatchingWindow?: Duration;
}

/**
 * DynamoDB Stream → Lambda consumer that fans out task events to
 * non-interactive channels. Ships as a skeleton per design §8.9 —
 * per-channel dispatcher integrations land incrementally without any
 * change to the agent or CLI.
 *
 * Errors in individual records do NOT fail the batch. Persistent
 * failures land in the DLQ attached to the event source mapping so
 * operators can replay.
 */
export class FanOutConsumer extends Construct {
  public readonly fn: lambda.NodejsFunction;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: FanOutConsumerProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.dlq = new sqs.Queue(this, 'FanOutDlq', {
      // Persistent failures (e.g., dispatcher throws non-caught error
      // five times in a row) land here for operator inspection.
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    // Explicit log group: without this Lambda auto-creates the group
    // at first invocation with no retention cap. Declaring it here
    // locks retention, makes the IAM grant graph discoverable by
    // cdk-nag, and matches the pattern used in
    // ``ApprovalMetricsPublisherConsumer`` and ``ecs-agent-cluster``.
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
      memorySize: 256,
      logGroup,
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // GitHub dispatcher plumbing. Each grant/env var is guarded so the
    // fan-out plane still deploys cleanly in a dev environment that
    // hasn't onboarded the RepoTable or a platform GitHub token yet —
    // the dispatcher will log-and-skip rather than crash.
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

    // Slack dispatcher reads per-workspace bot tokens from Secrets
    // Manager (``bgagent/slack/<team_id>``). Scope the grant to the
    // caller-provided prefix so the fan-out Lambda cannot read
    // unrelated platform secrets — matches the policy the old
    // standalone ``SlackNotifyFn`` held before issue #64. Guarded on
    // ``slackSecretArnPattern`` so deployments without Slack
    // onboarding don't get a dangling IAM grant (PR #79 review #2).
    if (props.slackSecretArnPattern) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.slackSecretArnPattern],
      }));
    }

    this.fn.addEventSource(new DynamoEventSource(props.taskEventsTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: props.batchSize ?? 100,
      maxBatchingWindow: props.maxBatchingWindow ?? Duration.seconds(5),
      // Fan-out delivery is best-effort; don't block the stream if one
      // poisonous record blows up the Lambda. After 3 retries, send the
      // record batch to the DLQ and advance the iterator.
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
