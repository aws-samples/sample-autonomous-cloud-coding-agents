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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { TaskTable } from './task-table';

const SWEEP_TIMEOUT_MINUTES = 5;

const SWEEP_MEMORY_MB = 256;

const DEFAULT_TASK_RETENTION_DAYS = 90;

export interface PrOutcomeSweepProps {
  /** TaskTable: the sweep queries its StatusIndex for COMPLETED tasks, and updates the ones whose pull request it reads. */
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
  readonly githubTokenSecret: secretsmanager.ISecret;
  /**
   * How long the event of a recorded final state is kept (days).
   * @default 90
   */
  readonly taskRetentionDays?: number;
}

/**
 * Hourly read of pull-request outcomes (scheduled).
 *
 * A scheduled Lambda that asks GitHub what became of each new pull request that ABCA
 * follows, and records the answer on the task that opened it: the factory scoreboard
 * reads merges, closes and reviews from there. A merge or a close also becomes an event
 * in the history of the task.
 */
export class PrOutcomeSweep extends Construct {
  /** Fires when the sweep throws or times out before its summary. A refused token is not this: the handler logs it and returns. */
  public readonly errorAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: PrOutcomeSweepProps) {
    super(scope, id);

    const fn = new lambda.NodejsFunction(this, 'SweepFn', {
      entry: path.join(__dirname, '..', 'handlers', 'sweep-pr-outcomes.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(SWEEP_TIMEOUT_MINUTES),
      memorySize: SWEEP_MEMORY_MB,
      environment: {
        ABCA_COMPONENT: 'orchestr',
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_STATUS_INDEX_NAME: TaskTable.STATUS_INDEX,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
        TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? DEFAULT_TASK_RETENTION_DAYS),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // CDK's table grants are wider: the read and write grants add Scan and the other item writes,
    // and each grant, `grant` with a single action too, adds `index/*` on a table that has an index.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${props.taskTable.tableArn}/index/${TaskTable.STATUS_INDEX}`],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [props.taskTable.tableArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [props.taskEventsTable.tableArn],
    }));
    props.githubTokenSecret.grantRead(fn);

    const rule = new events.Rule(this, 'SweepSchedule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
    });
    rule.addTarget(new targets.LambdaFunction(fn, { retryAttempts: 0 }));

    this.errorAlarm = new cloudwatch.Alarm(this, 'SweepErrorAlarm', {
      metric: fn.metricErrors({ period: Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Pull-request outcome sweep failed before its summary — the next hour is the retry',
    });

    NagSuppressions.addResourceSuppressions(fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
      },
    ], true);
  }
}
