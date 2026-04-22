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
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for StrandedTaskReconciler construct.
 */
export interface StrandedTaskReconcilerProps {
  /** TaskTable (has StatusIndex GSI used by the query). */
  readonly taskTable: dynamodb.ITable;

  /** TaskEventsTable (handler writes task_stranded + task_failed events). */
  readonly taskEventsTable: dynamodb.ITable;

  /** UserConcurrencyTable (handler decrements active_count on fail). */
  readonly userConcurrencyTable: dynamodb.ITable;

  /**
   * How often to run the reconciler. Short enough to clear stranded
   * tasks in a reasonable user-facing time, long enough to amortise the
   * Lambda + DDB cost. Defaults to 5 minutes.
   *
   * @default Duration.minutes(5)
   */
  readonly schedule?: Duration;

  /**
   * Stranded-timeout for `execution_mode='interactive'` tasks. Set via
   * the Lambda env `STRANDED_INTERACTIVE_TIMEOUT_SECONDS`.
   *
   * @default 300 (5 minutes)
   */
  readonly interactiveTimeoutSeconds?: number;

  /**
   * Stranded-timeout for `execution_mode='orchestrator'` / legacy tasks.
   * Set via `STRANDED_ORCHESTRATOR_TIMEOUT_SECONDS`.
   *
   * @default 1200 (20 minutes)
   */
  readonly orchestratorTimeoutSeconds?: number;

  /** Forwarded to the handler for event TTL. @default 90 */
  readonly taskRetentionDays?: number;
}

/**
 * Scheduled Lambda that fails stranded tasks (rev-5 P0-c).
 *
 * A stranded task is one admitted into TaskTable (SUBMITTED or HYDRATING)
 * whose pipeline never started — either the CLI died between admission
 * and SSE connect, or the orchestrator Lambda crashed between write and
 * sync invoke. Left alone these permanently consume a user's concurrency
 * slot. The `bgagent run` CLI auto-cancels the common case; this handler
 * catches the rest.
 *
 * RUNNING / FINALIZING tasks are handled separately by `pollTaskStatus`
 * in `orchestrator.ts` via the `agent_heartbeat_at` timeout.
 */
export class StrandedTaskReconciler extends Construct {
  public readonly fn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: StrandedTaskReconcilerProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    const interactiveTimeout = props.interactiveTimeoutSeconds ?? 300;
    const orchestratorTimeout = props.orchestratorTimeoutSeconds ?? 1200;
    const retentionDays = props.taskRetentionDays ?? 90;

    this.fn = new lambda.NodejsFunction(this, 'ReconcilerFn', {
      entry: path.join(handlersDir, 'reconcile-stranded-tasks.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        STRANDED_INTERACTIVE_TIMEOUT_SECONDS: String(interactiveTimeout),
        STRANDED_ORCHESTRATOR_TIMEOUT_SECONDS: String(orchestratorTimeout),
        TASK_RETENTION_DAYS: String(retentionDays),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // TaskTable: read (query by StatusIndex) + conditional UpdateItem to
    // transition stranded rows to FAILED.
    props.taskTable.grantReadWriteData(this.fn);
    // TaskEvents: write task_stranded + task_failed events.
    props.taskEventsTable.grantWriteData(this.fn);
    // Concurrency: decrement active_count on fail.
    props.userConcurrencyTable.grantReadWriteData(this.fn);

    const schedule = props.schedule ?? Duration.minutes(5);
    const rule = new events.Rule(this, 'ReconcilerSchedule', {
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
        reason:
          'DynamoDB index/* wildcards generated by CDK grantReadWriteData for '
          + 'StatusIndex query access + Item update path',
      },
    ], true);
  }
}
