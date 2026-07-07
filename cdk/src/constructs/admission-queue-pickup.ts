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
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/** Pickup Lambda timeout (minutes). */
const PICKUP_TIMEOUT_MINUTES = 5;

/** Pickup Lambda memory (MB). */
const PICKUP_MEMORY_MB = 256;

/**
 * Default pickup schedule interval (minutes). Short — queue latency is
 * user-visible wait time; 1 minute keeps the worst-case pickup delay
 * bounded while a QUEUED-empty cycle is a single cheap GSI query.
 */
const DEFAULT_SCHEDULE_MINUTES = 1;

/** Default max queue age before the backstop fails the task (seconds; 24h). */
const DEFAULT_QUEUE_MAX_AGE_SECONDS = 86400;

/** Default task-record retention used for event TTL (days). */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/**
 * Properties for AdmissionQueuePickup construct.
 */
export interface AdmissionQueuePickupProps {
  /** TaskTable (StatusIndex GSI powers the QUEUED FIFO query). */
  readonly taskTable: dynamodb.ITable;

  /** TaskEventsTable (handler writes queue_pickup / task_failed events). */
  readonly taskEventsTable: dynamodb.ITable;

  /** UserConcurrencyTable (read-only capacity check per user). */
  readonly userConcurrencyTable: dynamodb.ITable;

  /** ARN of the orchestrator Lambda alias to re-invoke on pickup. */
  readonly orchestratorFunctionArn: string;

  /**
   * Maximum concurrent tasks per user — must match the orchestrator's
   * value so the capacity pre-check agrees with `admissionControl`.
   * @default 10
   */
  readonly maxConcurrentTasksPerUser?: number;

  /**
   * How often to drain the queue.
   * @default Duration.minutes(1)
   */
  readonly schedule?: Duration;

  /**
   * Max time a task may sit QUEUED before the backstop fails it (seconds).
   * @default 86400 (24 hours)
   */
  readonly queueMaxAgeSeconds?: number;

  /** Forwarded to the handler for event TTL. @default 90 */
  readonly taskRetentionDays?: number;
}

/**
 * Scheduled Lambda that drains the admission queue (#441).
 *
 * Tasks that hit the per-user concurrency cap are parked in QUEUED by the
 * orchestrator instead of FAILED. This Lambda re-attempts admission in
 * FIFO order (StatusIndex GSI, ascending ``created_at``) as slots free
 * up: it flips QUEUED -> SUBMITTED and re-invokes the orchestrator, whose
 * atomic `admissionControl` remains the single writer of the concurrency
 * counter (a lost race simply re-queues the task, preserving position).
 */
export class AdmissionQueuePickup extends Construct {
  public readonly fn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: AdmissionQueuePickupProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.fn = new lambda.NodejsFunction(this, 'PickupFn', {
      entry: path.join(handlersDir, 'reconcile-admission-queue.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(PICKUP_TIMEOUT_MINUTES),
      memorySize: PICKUP_MEMORY_MB,
      environment: {
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        ORCHESTRATOR_FUNCTION_ARN: props.orchestratorFunctionArn,
        MAX_CONCURRENT_TASKS_PER_USER: String(props.maxConcurrentTasksPerUser ?? 10),
        QUEUE_MAX_AGE_SECONDS: String(props.queueMaxAgeSeconds ?? DEFAULT_QUEUE_MAX_AGE_SECONDS),
        TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? DEFAULT_TASK_RETENTION_DAYS),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // TaskTable: StatusIndex query + conditional QUEUED->SUBMITTED /
    // QUEUED->FAILED transitions.
    props.taskTable.grantReadWriteData(this.fn);
    // TaskEvents: queue_pickup / task_failed events.
    props.taskEventsTable.grantWriteData(this.fn);
    // Concurrency: READ-ONLY capacity pre-check — the orchestrator's
    // admissionControl is the only writer of the counter.
    props.userConcurrencyTable.grantReadData(this.fn);

    // Re-invoke the orchestrator alias on pickup.
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.orchestratorFunctionArn],
    }));

    const schedule = props.schedule ?? Duration.minutes(DEFAULT_SCHEDULE_MINUTES);
    const rule = new events.Rule(this, 'PickupSchedule', {
      schedule: events.Schedule.rate(schedule),
    });
    rule.addTarget(new targets.LambdaFunction(this.fn));

    NagSuppressions.addResourceSuppressions(this.fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData/grantReadData for StatusIndex query access',
      },
    ], true);
  }
}
