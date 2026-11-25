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

/** Metric aggregation period for the Cedar-HITL approval widgets (minutes). */
const HITL_METRIC_PERIOD_MINUTES = 15;

/** The factory scoreboard row looks back 30 days, whatever time range the dashboard shows. */
const SCOREBOARD_START = '-P30D';

/**
 * A number of the factory scoreboard row is one value over its whole window, not the last
 * bucket of a series: the ratio of one bucket is not the ratio of the window, and the
 * percentile of a bucket that holds one task is that task.
 */
const OVER_THE_WINDOW = { start: SCOREBOARD_START, setPeriodToTimeRange: true } as const;

/** A graph of the row: stacked sums per day over the same window, two graphs to a line. */
const PER_DAY = { stacked: true, period: Duration.days(1), start: SCOREBOARD_START, width: 12, height: 6 } as const;

/** The units a time widget of the row can show, each in the seconds the metrics are written in. */
const SECONDS_PER = { minutes: 60, hours: 3600 } as const;

const VERIFIED_PR: TaskOutcome = 'verified_pr';

/** The console's names for the outcomes of a finished task, in the order the graph stacks them. */
const OUTCOME_LABELS: Readonly<Record<TaskOutcome, string>> = {
  verified_pr: 'Verified pull request',
  unverified_pr: 'Pull request without a passed build',
  no_new_pr: 'Finished, no new pull request',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Ran out of time',
};

/** The two final states of a pull request, in the order the graph stacks them. */
const PR_OUTCOME_LABELS: Readonly<Record<Extract<PullRequestState, 'merged' | 'closed'>, string>> = {
  merged: 'Merged',
  closed: 'Closed without merging',
};

/** A metric of the factory scoreboard. The names are those of the module that writes the metric lines. */
function factoryMetric(metricName: string, statistic: string, dimensionsMap: Record<string, string> = {}, label?: string): cloudwatch.Metric {
  return new cloudwatch.Metric({ namespace: FACTORY_METRIC_NAMESPACE, metricName, statistic, dimensionsMap, label });
}

/**
 * The factory scoreboard row: what the finished tasks of every user came to, and what
 * became of the pull requests they opened. The widget titles follow the labels of the
 * console's Scoreboard page, which shows these numbers for the tasks of one user.
 */
function factoryScoreboardWidgets(): cloudwatch.IWidget[] {
  const math = (expression: string, usingMetrics: Record<string, cloudwatch.IMetric>, label: string): cloudwatch.MathExpression =>
    new cloudwatch.MathExpression({ expression, usingMetrics, label });
  // The two values of a time widget. An agent takes minutes and a merge takes days, so each
  // widget has the unit its numbers read well in, and each label names it.
  const medianAndSpread = (metricName: string, unit: keyof typeof SECONDS_PER): cloudwatch.MathExpression[] => [
    math(`time50 / ${SECONDS_PER[unit]}`, { time50: factoryMetric(metricName, 'p50') }, `Median (${unit})`),
    math(`time90 / ${SECONDS_PER[unit]}`, { time90: factoryMetric(metricName, 'p90') }, `9 in 10 within (${unit})`),
  ];
  const ofCodingTasks = { [FACTORY_DIMENSIONS.work]: FACTORY_WORK.coding };
  // The divisor of the two ratios. They have no zero branch: a window without a verified
  // pull request shows no value, where 0 would read as "no touchpoints" or "no spend".
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
        // The metric is 0 or 1 on each task that asked for a new pull request: its average is the share.
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

/**
 * Properties for the TaskDashboard construct.
 */
export interface TaskDashboardProps {
  /**
   * The CloudWatch Log Group containing agent application logs.
   * Used for Logs Insights queries to derive task-level metrics.
   */
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
 * All metrics are derived from agent application logs via Logs Insights queries:
 * - ``METRICS_REPORT`` — task-level outcomes, cost, duration, build/lint status
 * - ``TRAJECTORY_TURN`` — per-turn agent activity (model, thinking, tool calls)
 * - ``TRAJECTORY_RESULT`` — session-level token usage summaries
 *
 * JSON events are written directly to CloudWatch Logs by the agent entrypoint.
 * Queries use either auto-discovered JSON fields or ``parse @message`` with
 * regex patterns for field extraction (when custom field names are needed to
 * avoid conflicts with auto-discovered fields).
 *
 * The factory scoreboard row, first on the dashboard, reads no logs: its widgets
 * read the ``ABCA/Factory`` metrics, written once per finished task by the
 * TaskTable stream consumer (``handlers/scoreboard-metrics.ts``) and once per
 * merged or closed pull request by the hourly read of GitHub
 * (``handlers/sweep-pr-outcomes.ts``).
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

    // --- Factory scoreboard: first, as the summary; the rows below are diagnostics ---
    this.dashboard.addWidgets(...factoryScoreboardWidgets());

    // --- Row 1: Task outcomes ---
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

    // --- Row 2: Cost and efficiency ---
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

    // --- Row 3: Build and lint verification ---
    // The agent writes `null` when no build or lint ran (a task without a
    // repository, a crashed task, a build command that could not run). The two
    // patterns match `true` and `false` but not `null`, so that `ispresent`
    // drops such an event instead of counting it as a failed run.
    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Build Pass Rate (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          // [tf][a-z]+, not true|false: AWS's `parse` examples show no `|`, and it could not be tried here.
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
          // [tf][a-z]+ for the same reason as in the build widget.
          'parse @message /"lint_passed":\\s*(?<lp_raw>[tf][a-z]+)/',
          'filter ispresent(lp_raw)',
          'stats sum(lp_raw = "true") / count(*) * 100 as lint_pass_rate_pct by bin(1h)',
        ],
        view: cloudwatch.LogQueryVisualizationType.LINE,
        width: 12,
        height: 6,
      }),
    );

    // --- Row 4: Raw metrics events (debug) ---
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

    // --- Row 5: Agent trajectory (per-turn visibility) ---
    // TRAJECTORY_TURN events are valid JSON — use auto-discovered fields
    // directly instead of regex parse (avoids ephemeral field name conflicts).
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

    // --- Row 6: Token usage and tool call distribution ---
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
      // NOTE: Logs Insights `parse` extracts only the first regex match per
      // event, so this undercounts tools that appear later in multi-tool turns.
      // The data is directionally useful; for exact counts, query the raw events.
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
      // --- Row 7: AgentCore Runtime native metrics ---
      // Namespace AWS/Bedrock, dimensions { Service, Resource } scoped to this
      // runtime.  Metrics are batched at 1-minute intervals by the runtime.
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

    // --- Row 8+9: Cedar HITL approval widgets (§11.3, IMPL-28) --------------
    //
    // Three native-CloudWatch-metric widgets backed by the
    // ApprovalMetricsPublisher Lambda (see
    // ``approval-metrics-publisher-consumer.ts``), which consumes the
    // TaskEventsTable stream and emits EMF to namespace
    // ``ABCA/Cedar-HITL``. Widget layout per IMPL-28:
    //
    //   Row 8:  [ ApprovalTimeoutClipRate ][ ApprovalTimeoutBreakdown ]
    //   Row 9:  [ ApprovalDecisionLatency (full width)                ]
    //
    // At a glance, an operator can tell whether a "timeout" wave is:
    //   - a policy-authoring problem (clip-rate on ``rule_annotation``),
    //   - a task-sizing problem (clip-rate on ``maxLifetime_ceiling``),
    //   - a UX problem (decision latency high but within timeout), or
    //   - a notification problem (decision latency absent, timeouts
    //     high).
    //
    // Note: §11.3 mentions "Retired the old bundled widget" — that
    // widget never shipped in this codebase; the language is
    // historical framing for the design-doc reader. Nothing to remove.
    const HITL_NAMESPACE = 'ABCA/Cedar-HITL';

    this.dashboard.addWidgets(
      // ApprovalTimeoutClipRate — percentage of approvals whose
      // effective_timeout_s < requested_timeout_s, bucketed by
      // ``reason`` dimension. MathExpression uses IF(requested > 0,
      // ...) so a period with zero approvals renders as 0 rather than
      // NaN (which CloudWatch silently renders as a gap — visually
      // identical to a broken pipeline).
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
          // ``unknown`` surfaces when the publisher Lambda received a
          // clip event with a reason value the normalizer didn't
          // recognize — per ``normalizeClipReason`` in
          // ``shared/approval-metrics.ts``. This series should
          // normally be flat at 0; a sustained non-zero rate is a
          // deploy signal that the agent emitted a new reason value
          // the dashboard (and allowlist) hasn't been taught about.
          // Rendering the line explicitly prevents the "invisible
          // cost bucket" problem a reviewer flagged — otherwise the
          // custom metric would accrue at ~$0.30/month without any
          // operator-visible signal.
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
      // ApprovalTimeoutBreakdown — for timed-out approvals only, the
      // effective_timeout_s that was actually in effect. Aggregated
      // p50/p90/p99 so operators can distinguish "timeout was 30s,
      // obviously the user couldn't respond" from "timeout was 600s
      // and the user really was unavailable." The publisher writes each
      // value twice: with a ``rule_id`` dimension (normalized rule id:
      // allowlist + ``other`` bucket to cap cardinality) and without
      // dimensions. The three lines below read the one without
      // dimensions, because CloudWatch does not aggregate a custom
      // metric across dimensions.
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
      // ApprovalDecisionLatency — decided_at - created_at for each
      // terminal outcome. Three sets of percentiles keyed by
      // ``outcome`` dim so operators can see "users ARE responding,
      // just slowly" (approved p99 climbing) vs "users aren't
      // responding at all" (timed_out p50 ≈ timeout cap).
      new cloudwatch.GraphWidget({
        title: 'Approval Decision Latency by outcome (ms, p50 / p90 / p99)',
        left: [
          // Approved outcome
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
          // Denied outcome
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
          // Timed-out outcome
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
