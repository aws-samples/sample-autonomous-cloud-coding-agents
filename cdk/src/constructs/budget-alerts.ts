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

import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import {
  BUDGET_EXCEEDED_PERCENT,
  BUDGET_WARNING_PERCENT,
} from '../handlers/shared/budgets';

const ALARM_PERIOD_MINUTES = 1;
const METRIC_NAMESPACE = 'ABCA/Budgets';

/** CloudWatch alarms for one-shot monthly budget threshold metrics. */
export class BudgetAlerts extends Construct {
  public readonly warningAlarm: cloudwatch.Alarm;
  public readonly exceededAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const thresholdMetric = (threshold: number): cloudwatch.Metric => new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: 'BudgetThresholdCrossed',
      dimensionsMap: { Threshold: String(threshold) },
      statistic: 'Sum',
      period: Duration.minutes(ALARM_PERIOD_MINUTES),
    });
    this.warningAlarm = new cloudwatch.Alarm(this, 'WarningAlarm', {
      metric: thresholdMetric(BUDGET_WARNING_PERCENT),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'A user or Cognito-team monthly ABCA budget crossed 80%. '
        + 'Inspect OrchestrationReconciler logs for the scope and spend details (#471).',
    });
    this.exceededAlarm = new cloudwatch.Alarm(this, 'ExceededAlarm', {
      metric: thresholdMetric(BUDGET_EXCEEDED_PERCENT),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'A user or Cognito-team monthly ABCA budget crossed 100%. '
        + 'Hard-stop scopes reject new tasks until the next UTC month (#471).',
    });
  }
}
