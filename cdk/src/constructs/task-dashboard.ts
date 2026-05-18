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
  readonly runtimeArn: string;
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
    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Build Pass Rate (24h)',
        logGroupNames: [logGroup.logGroupName],
        queryLines: [
          'filter @message like "METRICS_REPORT"',
          'parse @message /"build_passed":\\s*(?<bp_raw>[^,}]+)/',
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
          'parse @message /"lint_passed":\\s*(?<lp_raw>[^,}]+)/',
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
                period: Duration.minutes(15),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(15),
              }),
            },
            period: Duration.minutes(15),
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
                period: Duration.minutes(15),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(15),
              }),
            },
            period: Duration.minutes(15),
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
                period: Duration.minutes(15),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(15),
              }),
            },
            period: Duration.minutes(15),
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
                period: Duration.minutes(15),
              }),
              requested: new cloudwatch.Metric({
                namespace: HITL_NAMESPACE,
                metricName: 'ApprovalRequestCount',
                statistic: 'Sum',
                period: Duration.minutes(15),
              }),
            },
            period: Duration.minutes(15),
          }),
        ],
        width: 12,
        height: 6,
      }),
      // ApprovalTimeoutBreakdown — for timed-out approvals only, the
      // effective_timeout_s that was actually in effect. Aggregated
      // p50/p90/p99 so operators can distinguish "timeout was 30s,
      // obviously the user couldn't respond" from "timeout was 600s
      // and the user really was unavailable." ``rule_id`` dimension
      // is emitted per normalized rule id (allowlist + ``other``
      // bucket to cap cardinality); the three lines below roll up
      // across all dimension values at dashboard-render time.
      new cloudwatch.GraphWidget({
        title: 'Approval Timeout Breakdown — effective timeout on timed-out approvals (s)',
        left: [
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'TimedOutEffectiveTimeout',
            statistic: 'p50',
            period: Duration.minutes(15),
            label: 'p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'TimedOutEffectiveTimeout',
            statistic: 'p90',
            period: Duration.minutes(15),
            label: 'p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'TimedOutEffectiveTimeout',
            statistic: 'p99',
            period: Duration.minutes(15),
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
            period: Duration.minutes(15),
            label: 'approved p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'approved' },
            statistic: 'p90',
            period: Duration.minutes(15),
            label: 'approved p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'approved' },
            statistic: 'p99',
            period: Duration.minutes(15),
            label: 'approved p99',
          }),
          // Denied outcome
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'denied' },
            statistic: 'p50',
            period: Duration.minutes(15),
            label: 'denied p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'denied' },
            statistic: 'p90',
            period: Duration.minutes(15),
            label: 'denied p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'denied' },
            statistic: 'p99',
            period: Duration.minutes(15),
            label: 'denied p99',
          }),
          // Timed-out outcome
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'timed_out' },
            statistic: 'p50',
            period: Duration.minutes(15),
            label: 'timed_out p50',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'timed_out' },
            statistic: 'p90',
            period: Duration.minutes(15),
            label: 'timed_out p90',
          }),
          new cloudwatch.Metric({
            namespace: HITL_NAMESPACE,
            metricName: 'ApprovalDecisionLatencyMs',
            dimensionsMap: { outcome: 'timed_out' },
            statistic: 'p99',
            period: Duration.minutes(15),
            label: 'timed_out p99',
          }),
        ],
        width: 24,
        height: 6,
      }),
    );
  }
}
