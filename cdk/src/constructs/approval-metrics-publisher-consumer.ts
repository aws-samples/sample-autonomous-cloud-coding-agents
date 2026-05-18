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
import { FilterCriteria, FilterRule, StartingPosition, Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for ``ApprovalMetricsPublisherConsumer`` — the Chunk 8
 * consumer that reads ``TaskEventsTable`` via DynamoDB Streams and
 * emits CloudWatch EMF log lines for the Cedar-HITL approval
 * dashboard widgets (§11.3, IMPL-28).
 *
 * This is **consumer #2** of the ``TaskEventsTable`` stream alongside
 * ``FanOutConsumer`` (consumer #1). DynamoDB Streams support up to 2
 * concurrent consumers per shard before throughput degradation; any
 * future third consumer should migrate the stream to Kinesis Data
 * Streams for DynamoDB rather than stacking a third
 * ``DynamoEventSource`` on this table. See the companion code comment
 * in ``task-events-table.ts``.
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
   * batch isn't full. Keeps metric latency bounded for low-volume
   * periods.
   * @default Duration.seconds(5)
   */
  readonly maxBatchingWindow?: Duration;
}

/**
 * DynamoDB Stream → Lambda consumer that publishes Cedar-HITL approval
 * metrics to CloudWatch via EMF.
 *
 * The service-layer event-source-mapping filter pattern rejects
 * non-``agent_milestone`` records before invocation so the Lambda is
 * only billed for relevant traffic. The handler still applies a
 * secondary milestone-name allowlist (``APPROVAL_METRIC_MILESTONES``)
 * so an unexpected milestone reaching the classifier is observable
 * rather than silently dropped at the service layer. Both layers
 * matter: the filter pattern saves cost; the handler allowlist
 * preserves visibility.
 *
 * Poison-pill handling mirrors ``FanOutConsumer``: per-record
 * try/catch in the handler + ``reportBatchItemFailures: true`` +
 * 3-retry DLQ so one bad record doesn't stall the stream cursor.
 */
export class ApprovalMetricsPublisherConsumer extends Construct {
  public readonly fn: lambda.NodejsFunction;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ApprovalMetricsPublisherConsumerProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.dlq = new sqs.Queue(this, 'ApprovalMetricsPublisherDlq', {
      // Persistent failures (malformed records the handler's
      // per-record try/catch throws on three times in a row) land
      // here for operator inspection. Alarm wiring is deferred to
      // Chunk 10 follow-ups — until a notification channel is wired
      // to SNS, an alarm on ``ApproximateNumberOfMessagesVisible``
      // would fire into the void.
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    // Explicit log group: without this declaration Lambda auto-creates
    // the group on first invocation at the default retention (never
    // expires) and the CDK IAM grant path is implicit. Declaring it
    // here locks the retention window and keeps the grant graph
    // discoverable by cdk-nag. Pattern mirrors
    // ``ecs-agent-cluster.ts::TaskLogGroup``.
    const logGroup = new logs.LogGroup(this, 'ApprovalMetricsPublisherLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new lambda.NodejsFunction(this, 'ApprovalMetricsPublisherFn', {
      entry: path.join(handlersDir, 'approval-metrics-publisher.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      // Publisher work is tiny (parse record, classify, emit EMF
      // lines) — 256 MB is more than enough. Timeout is 1 minute to
      // match fanout; actual invocations should finish in tens of ms.
      timeout: Duration.minutes(1),
      memorySize: 256,
      logGroup,
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Event-source-mapping filter pattern. Rejects non-
    // ``agent_milestone`` records at the service layer so the Lambda
    // is not billed for fanout-only records (``task_created``,
    // ``pr_created``, etc.). The filter can only match top-level
    // attributes (``event_type``, not ``metadata.milestone``) — the
    // inner milestone check runs in the handler.
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
      maxBatchingWindow: props.maxBatchingWindow ?? Duration.seconds(5),
      retryAttempts: 3,
      onFailure: new SqsDlq(this.dlq),
      reportBatchItemFailures: true,
      filters: [agentMilestoneFilter],
    }));

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
