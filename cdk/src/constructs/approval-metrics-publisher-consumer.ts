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
import { FilterCriteria, FilterRule, StartingPosition, Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const DLQ_RETENTION_DAYS = 14;

const DLQ_ALARM_PERIOD_MINUTES = 5;

const DEFAULT_MAX_BATCHING_WINDOW_SECONDS = 5;

const PUBLISHER_MEMORY_MB = 256;

/**
 * Second consumer of the ``TaskEventsTable`` stream, alongside
 * ``FanOutConsumer``. DynamoDB Streams throttles beyond 2 readers per shard:
 * a third consumer needs Kinesis Data Streams for DynamoDB instead.
 */
export interface ApprovalMetricsPublisherConsumerProps {
  /**
   * The TaskEventsTable whose stream this consumer reads from. Must
   * have ``stream: NEW_IMAGE`` enabled (see ``TaskEventsTable``).
   */
  readonly taskEventsTable: dynamodb.ITable;

  /**
   * Maximum batch size delivered to the Lambda per invocation.
   * @default 100 (DynamoDB Stream default)
   */
  readonly batchSize?: number;

  /**
   * Max age of records in the batch before Lambda is invoked even if
   * batch isn't full.
   * @default Duration.seconds(5)
   */
  readonly maxBatchingWindow?: Duration;
}

/**
 * DynamoDB Stream → Lambda consumer that publishes Cedar-HITL approval
 * metrics to CloudWatch via EMF.
 *
 * The event-source-mapping filter passes only ``agent_milestone`` inserts;
 * the handler applies the ``APPROVAL_METRIC_MILESTONES`` allowlist. Failed
 * records are reported per item, retried 3 times, then sent to the DLQ.
 */
export class ApprovalMetricsPublisherConsumer extends Construct {
  public readonly fn: lambda.NodejsFunction;
  public readonly dlq: sqs.Queue;
  /** CloudWatch alarm that fires when the DLQ has at least one poison-pill record. */
  public readonly dlqAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: ApprovalMetricsPublisherConsumerProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.dlq = new sqs.Queue(this, 'ApprovalMetricsPublisherDlq', {
      retentionPeriod: Duration.days(DLQ_RETENTION_DAYS),
      enforceSSL: true,
    });

    const logGroup = new logs.LogGroup(this, 'ApprovalMetricsPublisherLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new lambda.NodejsFunction(this, 'ApprovalMetricsPublisherFn', {
      entry: path.join(handlersDir, 'approval-metrics-publisher.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(1),
      memorySize: PUBLISHER_MEMORY_MB,
      logGroup,
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    const agentMilestoneFilter = FilterCriteria.filter({
      eventName: FilterRule.isEqual('INSERT'),
      dynamodb: {
        NewImage: {
          event_type: { S: FilterRule.isEqual('agent_milestone') },
        },
      },
    });

    this.fn.addEventSource(new DynamoEventSource(props.taskEventsTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: props.batchSize ?? 100,
      maxBatchingWindow: props.maxBatchingWindow ?? Duration.seconds(DEFAULT_MAX_BATCHING_WINDOW_SECONDS),
      retryAttempts: 3,
      onFailure: new SqsDlq(this.dlq),
      reportBatchItemFailures: true,
      filters: [agentMilestoneFilter],
    }));

    this.dlqAlarm = new cloudwatch.Alarm(this, 'DlqMessageAlarm', {
      metric: this.dlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(DLQ_ALARM_PERIOD_MINUTES),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        'ApprovalMetricsPublisher DLQ has at least one message; investigate poison records. ' +
        'Check CloudWatch Logs for the ApprovalMetricsPublisherFn error that caused the DLQ send. ' +
        'See: https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/117',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    NagSuppressions.addResourceSuppressions(this.fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB stream/index wildcards generated by CDK for event-source-mapping read access',
      },
    ], true);
    NagSuppressions.addResourceSuppressions(this.dlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This queue IS the DLQ for the approval-metrics-publisher Lambda — having its own DLQ would be infinite recursion',
      },
    ]);
  }
}
