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
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for OrchestrationReconciler construct.
 */
export interface OrchestrationReconcilerProps {
  /**
   * TaskTable — MUST have a stream enabled (NEW_IMAGE). This construct is
   * the table's stream consumer; the reconciler reacts to child tasks
   * reaching terminal status.
   */
  readonly taskTable: dynamodb.ITable;

  /** OrchestrationTable — the reconciler reads the DAG + writes child statuses. */
  readonly orchestrationTable: dynamodb.ITable;

  /** TaskTable (for createTaskCore writes when releasing children). */
  readonly taskTableForWrites?: dynamodb.ITable;

  /** Orchestrator function ARN — releaseChild → createTaskCore invokes it. */
  readonly orchestratorFunctionArn?: string;

  /** Forwarded so released child tasks land in the right tables. */
  readonly taskEventsTable: dynamodb.ITable;
}

/**
 * TaskTable-stream consumer that drives Linear parent/sub-issue
 * orchestration (issue #247, Mode A). On each child task reaching a
 * terminal status it releases newly-unblocked children in dependency
 * order (see `handlers/orchestration-reconciler.ts`).
 *
 * Stream-source rationale: TaskEventsTable's stream is at its 2-consumer
 * limit (FanOutConsumer + ApprovalMetricsPublisher); TaskTable had no
 * stream, so the reconciler is its first and only consumer — zero
 * contention with the fan-out plane.
 */
export class OrchestrationReconciler extends Construct {
  public readonly fn: lambda.NodejsFunction;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: OrchestrationReconcilerProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.fn = new lambda.NodejsFunction(this, 'ReconcilerFn', {
      entry: path.join(handlersDir, 'orchestration-reconciler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: {
        ORCHESTRATION_TABLE_NAME: props.orchestrationTable.tableName,
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        ...(props.orchestratorFunctionArn && {
          ORCHESTRATOR_FUNCTION_ARN: props.orchestratorFunctionArn,
        }),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // DLQ for poison stream records (a record that repeatedly fails the
    // reconcile). Fan-out uses the same pattern; without it a bad record
    // would block the shard.
    this.dlq = new sqs.Queue(this, 'ReconcilerDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    // Orchestration child creation/gating reads + writes the DAG table,
    // reads/writes TaskTable (createTaskCore), and writes task events.
    props.orchestrationTable.grantReadWriteData(this.fn);
    props.taskTable.grantReadWriteData(this.fn);
    props.taskEventsTable.grantReadWriteData(this.fn);

    // Subscribe to the TaskTable stream. LATEST: we only care about
    // tasks transitioning to terminal from here on. bisectBatchOnError +
    // DLQ so one poison record can't wedge the shard.
    this.fn.addEventSource(new DynamoEventSource(props.taskTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 3,
      bisectBatchOnError: true,
      onFailure: new SqsDlq(this.dlq),
    }));

    NagSuppressions.addResourceSuppressions(this.fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'DynamoDB index/* + stream ARN wildcards generated by CDK grantReadWriteData '
          + '(ChildTaskIndex query) and the DynamoEventSource read access',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.dlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason:
          'This queue IS the DLQ for the reconciler stream consumer — having its own DLQ would be infinite recursion',
      },
    ]);
  }
}
