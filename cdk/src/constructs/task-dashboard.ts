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

import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { FACTORY_DIMENSIONS, FACTORY_METRIC_NAMESPACE, FACTORY_METRICS, FACTORY_WORK } from '../handlers/shared/scoreboard';
import type { PullRequestState, TaskOutcome } from '../handlers/shared/types';

const HITL_METRIC_PERIOD_MINUTES = 15;

const SCOREBOARD_START = '-P30D';

const OVER_THE_WINDOW = { start: SCOREBOARD_START, setPeriodToTimeRange: true } as const;

const PER_DAY = { stacked: true, period: Duration.days(1), start: SCOREBOARD_START, width: 12, height: 6 } as const;

const SECONDS_PER = { minutes: 60, hours: 3600 } as const;

const VERIFIED_PR: TaskOutcome = 'verified_pr';

const OUTCOME_LABELS: Readonly<Record<TaskOutcome, string>> = {
  verified_pr: 'Verified pull request',
  unverified_pr: 'Pull request without a passed build',
  no_new_pr: 'Finished, no new pull request',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Ran out of time',
};

const PR_OUTCOME_LABELS: Readonly<Record<Extract<PullRequestState, 'merged' | 'closed'>, string>> = {
  merged: 'Merged',
  closed: 'Closed without merging',
};

function factoryMetric(metricName: string, statistic: string, dimensionsMap: Record<string, string> = {}, label?: string): cloudwatch.Metric {
  return new cloudwatch.Metric({ namespace: FACTORY_METRIC_NAMESPACE, metricName, statistic, dimensionsMap, label });
}

function factoryScoreboardWidgets(): cloudwatch.IWidget[] {
  const math = (expression: string, usingMetrics: Record<string, cloudwatch.IMetric>, label: string): cloudwatch.MathExpression =>
    new cloudwatch.MathExpression({ expression, usingMetrics, label });
  const medianAndSpread = (metricName: string, unit: keyof typeof SECONDS_PER): cloudwatch.MathExpression[] => [
    math(`time50 / ${SECONDS_PER[unit]}`, { time50: factoryMetric(metricName, 'p50') }, `Median (${unit})`),
    math(`time90 / ${SECONDS_PER[unit]}`, { time90: factoryMetric(metricName, 'p90') }, `9 in 10 within (${unit})`),
  ];
  const ofCodingTasks = { [FACTORY_DIMENSIONS.work]: FACTORY_WORK.coding };
  const verified = factoryMetric(FACTORY_METRICS.tasksFinished, 'Sum', { [FACTORY_DIMENSIONS.outcome]: VERIFIED_PR });

  return [
    new cloudwatch.TextWidget({
      markdown: '## Factory scoreboard\n'
        + "Every user's tasks that finished in the last 30 days, or since the scoreboard was deployed if that is less. "
        + 'The row keeps that window whatever time range the dashboard shows. '
        + "A verified pull request is one opened after the repository's build passed. "
        + 'The two pull-request widgets count a pull request on the day it was merged or closed, not on the day its task finished, '
        + 'and reach up to 13 days back before the deployment.',
      width: 24,
      height: 2,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Time to verified pull request',
      metrics: medianAndSpread(FACTORY_METRICS.timeToVerifiedPr, 'minutes'),
      width: 8,
      ...OVER_THE_WINDOW,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Time to merged pull request',
      metrics: medianAndSpread(FACTORY_METRICS.timeToMerge, 'hours'),
      width: 8,
      ...OVER_THE_WINDOW,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Verified pull request with no stop for a person',
      metrics: [
        math(
          '100 * untouched',
          { untouched: factoryMetric(FACTORY_METRICS.untouchedVerifiedPrs, 'Average') },
          '% of the tasks that asked for a new pull request',
        ),
      ],
      width: 8,
      ...OVER_THE_WINDOW,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Human touchpoints per verified pull request',
      metrics: [
        math(
          'touchpoints / verified',
          { touchpoints: factoryMetric(FACTORY_METRICS.humanTouchpoints, 'Sum', ofCodingTasks), verified },
          'On coding tasks, failed ones too',
        ),
      ],
      width: 8,
      ...OVER_THE_WINDOW,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Spend per verified pull request',
      metrics: [
        math(
          'spend / verified',
          { spend: factoryMetric(FACTORY_METRICS.costUsd, 'Sum', ofCodingTasks), verified },
          'USD on coding tasks, failed ones too',
        ),
      ],
      width: 8,
      ...OVER_THE_WINDOW,
    }),
    new cloudwatch.SingleValueWidget({
      title: 'Guardrail stops and blanket approvals',
      metrics: [
        factoryMetric(FACTORY_METRICS.guardrailStops, 'Sum', {}, 'Stopped by a guardrail'),
        factoryMetric(FACTORY_METRICS.blanketApprovals, 'Sum', {}, 'Started with blanket approval'),
      ],
      width: 8,
      ...OVER_THE_WINDOW,
    }),
    new cloudwatch.GraphWidget({
      title: 'Tasks finished per day, by outcome',
      left: Object.entries(OUTCOME_LABELS).map(([outcome, label]) =>
        factoryMetric(FACTORY_METRICS.tasksFinished, 'Sum', { [FACTORY_DIMENSIONS.outcome]: outcome }, label)),
      ...PER_DAY,
    }),
    new cloudwatch.GraphWidget({
      title: 'Pull requests merged and closed per day',
      left: Object.entries(PR_OUTCOME_LABELS).map(([state, label]) =>
        factoryMetric(FACTORY_METRICS.pullRequestsResolved, 'Sum', { [FACTORY_DIMENSIONS.prOutcome]: state }, label)),
      ...PER_DAY,
    }),
  ];
}

export interface TaskDashboardProps {
  readonly applicationLogGroup: logs.ILogGroup;

  /**
   * The ARN of the AgentCore runtime, used as the ``Resource`` dimension
   * for native CloudWatch metrics under the ``AWS/Bedrock`` namespace.
   */
  readonly runtimeArn?: string;
}

/**
 * CloudWatch Dashboard providing operator visibility into agent task execution.
 *
 * Logs Insights queries read these events from the agent application logs:
 * - ``METRICS_REPORT`` — task-level outcomes, cost, duration, build/lint status
 * - ``TRAJECTORY_TURN`` — per-turn agent activity (model, thinking, tool calls)
 * - ``TRAJECTORY_RESULT`` — session-level token usage summaries
 *
 * The factory scoreboard row, first on the dashboard, reads no logs: its widgets
 * read the ``ABCA/Factory`` metrics.
 */
export class TaskDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: TaskDashboardProps) {
    super(scope, id);

    const logGroup = props.applicationLogGroup;

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `BackgroundAgent-Tasks-${Stack.of(this).stackName}`,
      defaultInterval: Duration.hours(24),
    });

    this.dashboard.addWidgets(...factoryScoreboardWidgets());

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Task Success Rate (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"status":\\s*"(?<task_status>[^"]+)"/',
          'filter task_status in ["success", "error"]',
          'stats sum(task_status = "success") / count(*) * 100 as success_rate_pct by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 8,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Task Count by Status (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"status":\\s*"(?<task_status>[^"]+)"/',
          'filter task_status in ["success", "error"]',
          'stats count(*) as task_count by task_status',
        ],
        view: cloudwatch.LogQueryVisualizationType.PIE,
        width: 8,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Tasks Over Time (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"status":\\s*"(?<task_status>[^"]+)"/',
          'filter task_status in ["success", "error"]',
          'stats count(*) as tasks by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.BAR,
        width: 8,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Average Cost per Task ($)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"cost_usd":\\s*"?(?<parsed_cost>[\\d.]+)"?/',
          'filter ispresent(parsed_cost) and parsed_cost > 0',
          'stats avg(parsed_cost) as avg_cost, max(parsed_cost) as max_cost, min(parsed_cost) as min_cost by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 8,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Average Turns per Task',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"turns":\\s*"?(?<parsed_turns>[\\d]+)"?/',
          'filter ispresent(parsed_turns)',
          'stats avg(parsed_turns) as avg_turns, max(parsed_turns) as max_turns by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 8,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Task Duration Distribution (minutes)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"duration_s":\\s*"?(?<parsed_dur>[\\d.]+)"?/',
          'filter ispresent(parsed_dur)',
          'stats avg(parsed_dur / 60) as avg_min, max(parsed_dur / 60) as max_min, min(parsed_dur / 60) as min_min by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 8,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Build Pass Rate (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          // [tf][a-z]+, not true|false: AWS's Logs Insights `parse` examples show no `|` (untried).
          'parse @message /"build_passed":\\s*(?<bp_raw>[tf][a-z]+)/',
          'filter ispresent(bp_raw)',
          'stats sum(bp_raw = "true") / count(*) * 100 as build_pass_rate_pct by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 12,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Lint Pass Rate (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"lint_passed":\\s*(?<lp_raw>[tf][a-z]+)/',
          'filter ispresent(lp_raw)',
          'stats sum(lp_raw = "true") / count(*) * 100 as lint_pass_rate_pct by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 12,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent Metrics Events (raw)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'fields @timestamp, @message',
          'sort @timestamp desc',
          'limit 10',
        ],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        width: 24,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent Agent Turns',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter event = "TRAJECTORY_TURN"',
          'fields @timestamp, task_id, turn, model, substr(thinking, 0, 80) as thinking_preview',
          'sort @timestamp desc',
          'limit 20',
        ],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        width: 24,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Token Usage per Task',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "TRAJECTORY_RESULT"',
          'parse @message /"input_tokens":\\s*(?<in_tokens>\\d+)/',
          'parse @message /"output_tokens":\\s*(?<out_tokens>\\d+)/',
          'filter ispresent(in_tokens)',
          'stats avg(in_tokens) as avg_input, avg(out_tokens) as avg_output by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 12,
        height: 6,
      }),
      // Logs Insights `parse` extracts only the first regex match per event.
      new cloudwatch.LogQueryWidget({
        title: 'Tool Call Distribution (first tool per turn)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "TRAJECTORY_TURN"',
          'parse @message /"tool_calls":\\s*\\[.*?"name":\\s*"(?<tool_name>[^"]+)"/',
          'filter ispresent(tool_name)',
          'stats count(*) as calls by tool_name',
          'sort calls desc',
        ],
        view: cloudwatch.LogQueryVisualizationType.BAR,
        width: 12,
        height: 6,
      }),
    );

    if (props.runtimeArn) {
      const metricDimensions = {
        Service: 'AgentCore.Runtime',
        Resource: props.runtimeArn,
      };

      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Runtime Invocations',
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'Invocations',
              dimensionsMap: metricDimensions,
              statistic: 'Sum',
              period: Duration.hours(1),
            }),
          ],
          width: 8,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: 'Runtime Errors',
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'SystemErrors',
              dimensionsMap: metricDimensions,
              statistic: 'Sum',
              period: Duration.hours(1),
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'UserErrors',
              dimensionsMap: metricDimensions,
              statistic: 'Sum',
              period: Duration.hours(1),
            }),
          ],
          width: 8,
          height: 6,
        }),
        new cloudwatch.GraphWidget({
          title: 'Runtime Latency (p50 / p99)',
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'Latency',
              dimensionsMap: metricDimensions,
              statistic: 'p50',
              period: Duration.hours(1),
            }),
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'Latency',
              dimensionsMap: metricDimensions,
              statistic: 'p99',
              period: Duration.hours(1),
            }),
          ],
          width: 8,
          height: 6,
        }),
      );
    }

    const HITL_NAMESPACE = 'ABCA/Cedar-HITL';

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Approval Timeout Clip Rate (%)',
        left: [
          new cloudwatch.MathExpression({
            label: 'rule_annotation',
            expression: 'IF(requested > 0, 100 * clipped_rule / requested, 0)',
            usingMetrics: {
              clipped_rule: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ClippedApprovalCount',
                dimensionsMap: { reason: 'rule_annotation' },
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
            },
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
          }),
          new cloudwatch.MathExpression({
            label: 'maxLifetime_ceiling',
            expression: 'IF(requested > 0, 100 * clipped_ml / requested, 0)',
            usingMetrics: {
              clipped_ml: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ClippedApprovalCount',
                dimensionsMap: { reason: 'maxLifetime_ceiling' },
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
            },
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
          }),
          new cloudwatch.MathExpression({
            label: 'runtime_jwt_ceiling',
            expression: 'IF(requested > 0, 100 * clipped_jwt / requested, 0)',
            usingMetrics: {
              clipped_jwt: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ClippedApprovalCount',
                dimensionsMap: { reason: 'runtime_jwt_ceiling' },
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
            },
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
          }),
          new cloudwatch.MathExpression({
            label: 'unknown',
            expression: 'IF(requested > 0, 100 * clipped_unknown / requested, 0)',
            usingMetrics: {
              clipped_unknown: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ClippedApprovalCount',
                dimensionsMap: { reason: 'unknown' },
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
              }),
            },
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
          }),
        ],
        width: 12,
        height: 6,
      }),
      // No dimensions: CloudWatch does not aggregate a custom metric across
      // dimensions, so these read the series the publisher writes without any.
      new cloudwatch.GraphWidget({
        title: 'Approval Timeout Breakdown — effective timeout on timed-out approvals (s)',
        left: [
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'TimedOutEffectiveTimeout',
            statistic: 'p50',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'TimedOutEffectiveTimeout',
            statistic: 'p90',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'TimedOutEffectiveTimeout',
            statistic: 'p99',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'p99',
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Approval Decision Latency by outcome (ms, p50 / p90 / p99)',
        left: [
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'approved' },
            statistic: 'p50',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'approved p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'approved' },
            statistic: 'p90',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'approved p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'approved' },
            statistic: 'p99',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'approved p99',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'denied' },
            statistic: 'p50',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'denied p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'denied' },
            statistic: 'p90',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'denied p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'denied' },
            statistic: 'p99',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'denied p99',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'timed_out' },
            statistic: 'p50',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'timed_out p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'timed_out' },
            statistic: 'p90',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'timed_out p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'timed_out' },
            statistic: 'p99',
            period: Duration.minutes(HITL_METRIC_PERIOD_MINUTES),
            label: 'timed_out p99',
          }),
        ],
        width: 24,
        height: 6,
      }),
    );
  }
}
