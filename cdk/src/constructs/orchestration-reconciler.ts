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
import { Architecture, FilterCriteria, FilterRule, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { TERMINAL_STATUSES } from './task-status';

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

/** DLQ message retention (days) — long enough for an operator to inspect a
 *  poison stream record before it ages out. */
const DLQ_RETENTION_DAYS = 14;

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
      // 512 MB (not 256): the reconciler bundles createTaskCore, which
      // pulls in the Bedrock guardrail + S3 attachment-screening SDK
      // stack. At 256 MB it OOMs during init on every stream event
      // (Max Memory Used 255/256 MB) and never releases children. The
      // LinearIntegration webhook processor runs the same code at 512 MB.
      memorySize: 512,
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
        // pdf-parse (v2, pdfjs-based) can't be esbuild-bundled — its pdfjs/native
        // deps break at import. The reconciler screens the parent issue's PDF
        // attachments at decompose-seed time (finding #1), so ship pdf-parse
        // unbundled to resolve natively at runtime. MUST match the webhook
        // processors' attachment-screening bundling — a Lambda that CALLS
        // attachment-screening but omits this carve-out fails every PDF at
        // runtime while passing every unit test (ABCA-745 class; live-caught on
        // the decompose-seed path 2026-07-22).
        nodeModules: ['pdf-parse'],
      },
    });

    // DLQ for poison stream records (a record that repeatedly fails the
    // reconcile). Fan-out uses the same pattern; without it a bad record
    // would block the shard.
    this.dlq = new sqs.Queue(this, 'ReconcilerDlq', {
      retentionPeriod: Duration.days(DLQ_RETENTION_DAYS),
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
    //
    // FilterCriteria: the handler ignores every non-terminal status
    // (parseTerminalTaskRecord returns null unless status ∈ TERMINAL), so the
    // stream itself filters to terminal statuses. This keeps RUNNING/HYDRATING/
    // heartbeat/progress writes — the bulk of TaskTable churn platform-wide —
    // from ever invoking this 512MB reconciler. Behavior-preserving: the records
    // dropped here are exactly the ones the handler already discarded. One filter
    // pattern per terminal status (FilterCriteria ORs the array).
    const terminalFilters = TERMINAL_STATUSES.map((s) => FilterCriteria.filter({
      dynamodb: { NewImage: { status: { S: FilterRule.isEqual(s) } } },
    }));
    this.fn.addEventSource(new DynamoEventSource(props.taskTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 3,
      bisectBatchOnError: true,
      onFailure: new SqsDlq(this.dlq),
      filters: terminalFilters,
      // DE-F6 (2026-07-24): partial-batch reporting. Without this, the handler
      // returning void meant ANY thrown record failed the WHOLE batch — a single
      // poison/throttled record re-drove all its siblings (re-reconciling
      // healthy children) until it aged out. With reportBatchItemFailures the
      // handler returns only the failed record's sequence number, so just that
      // record retries + bisects toward the DLQ while its siblings commit.
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
