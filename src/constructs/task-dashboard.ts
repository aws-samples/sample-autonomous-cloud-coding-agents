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
  }
}
