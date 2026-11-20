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

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { TaskDashboard } from '../../src/constructs/task-dashboard';

function createStack(): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const logGroup = new logs.LogGroup(stack, 'AppLogGroup');

  new TaskDashboard(stack, 'TaskDashboard', {
    applicationLogGroup: logGroup,
    runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime',
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('TaskDashboard construct', () => {
  test('creates a CloudWatch Dashboard', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('dashboard name includes stack name', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'BackgroundAgent-Tasks-TestStack',
    });
  });

  // --- Chunk 8b: Cedar HITL approval widgets (§11.3, IMPL-28) ------------

  // The dashboard body is serialized as CloudFormation ``Fn::Join`` parts
  // with CDK tokens for the stack region/account. Use ``Match.serializedJson``
  // / substring checks via template rendering.
  function dashboardBodyContains(template: Template, needle: string): boolean {
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    for (const res of Object.values(dashboards)) {
      const body = (res as any).Properties?.DashboardBody;
      if (typeof body === 'string') {
        if (body.includes(needle)) return true;
      } else if (body && body['Fn::Join']) {
        // Join parts: array of string / token. Flatten and search the
        // concatenated literal portion.
        const joined = (body['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : '')).join('');
        if (joined.includes(needle)) return true;
      }
    }
    return false;
  }

  test('dashboard references ABCA/Cedar-HITL namespace for the new metrics', () => {
    const { template } = createStack();
    expect(dashboardBodyContains(template, 'ABCA/Cedar-HITL')).toBe(true);
  });

  test('dashboard includes ApprovalTimeoutClipRate widget (MathExpression with IF guard)', () => {
    const { template } = createStack();
    expect(dashboardBodyContains(template, 'Approval Timeout Clip Rate')).toBe(true);
    // The IF(requested > 0, ...) guard is critical to avoid divide-by-zero
    // NaN renders (silent gap). Assert the expression ships in the widget.
    expect(dashboardBodyContains(template, 'IF(requested > 0')).toBe(true);
    // The 3 reason dimensions each get their own MathExpression line.
    expect(dashboardBodyContains(template, 'rule_annotation')).toBe(true);
    expect(dashboardBodyContains(template, 'maxLifetime_ceiling')).toBe(true);
    expect(dashboardBodyContains(template, 'runtime_jwt_ceiling')).toBe(true);
  });

  test('dashboard references ClippedApprovalCount and ApprovalRequestCount metrics', () => {
    const { template } = createStack();
    expect(dashboardBodyContains(template, 'ClippedApprovalCount')).toBe(true);
    expect(dashboardBodyContains(template, 'ApprovalRequestCount')).toBe(true);
  });

  test('dashboard includes ApprovalTimeoutBreakdown widget with p50/p90/p99 on TimedOutEffectiveTimeout', () => {
    const { template } = createStack();
    expect(dashboardBodyContains(template, 'Approval Timeout Breakdown')).toBe(true);
    expect(dashboardBodyContains(template, 'TimedOutEffectiveTimeout')).toBe(true);
    // All three percentiles required by §11.3.
    expect(dashboardBodyContains(template, 'p50')).toBe(true);
    expect(dashboardBodyContains(template, 'p90')).toBe(true);
    expect(dashboardBodyContains(template, 'p99')).toBe(true);
  });

  test('dashboard includes ApprovalDecisionLatency widget with outcome dims', () => {
    const { template } = createStack();
    expect(dashboardBodyContains(template, 'Approval Decision Latency')).toBe(true);
    expect(dashboardBodyContains(template, 'ApprovalDecisionLatencyMs')).toBe(true);
    // Three outcome dim values — one series set per outcome per percentile.
    expect(dashboardBodyContains(template, 'approved')).toBe(true);
    expect(dashboardBodyContains(template, 'denied')).toBe(true);
    expect(dashboardBodyContains(template, 'timed_out')).toBe(true);
  });

  describe('build and lint pass rates', () => {
    let template: Template;
    beforeAll(() => {
      template = createStack().template;
    });

    /** The Logs Insights commands of one log widget, in order. */
    function widgetQuery(title: string): string[] {
      const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
      const parts = dashboard.Properties.DashboardBody['Fn::Join'][1] as unknown[];
      const body = JSON.parse(parts.map((p) => (typeof p === 'string' ? p : 'TOKEN')).join(''));
      const widget = body.widgets.find((w: { properties: { title?: string } }) => w.properties.title === title);
      return (widget.properties.query as string).split('\n| ');
    }

    // A METRICS_REPORT line as the agent writes it (Python json.dumps). Both
    // verdicts are null when nothing ran: a task without a repository, a
    // crashed task, a build command that could not run.
    const metricsLine = (verdict: boolean | null): string =>
      `{"event": "METRICS_REPORT", "status": "${verdict === null ? 'error' : 'success'}", "agent_status": "success", `
      + `"pr_url": null, "build_passed": ${verdict}, "lint_passed": ${verdict}, "cost_usd": 6.2, "turns": 60, "duration_s": 2400.0}`;

    test.each([
      ['Build Pass Rate (24h)', 'bp_raw'],
      ['Lint Pass Rate (24h)', 'lp_raw'],
    ])('%s counts a task without a verdict neither as passed nor as failed', (title, field) => {
      const [, parse, filter, stats] = widgetQuery(title);
      // What the query does with the parsed field: keep the events that have
      // it, then divide those that read "true" by all that are left.
      expect(filter).toBe(`filter ispresent(${field})`);
      expect(stats).toContain(`stats sum(${field} = "true") / count(*) * 100 as`);
      const pattern = new RegExp(parse.slice(parse.indexOf('/') + 1, parse.lastIndexOf('/')));
      const passRate = (lines: string[]): number => {
        const parsed = lines.map((line) => pattern.exec(line)?.groups?.[field]).filter((value) => value !== undefined);
        return (parsed.filter((value) => value === 'true').length / parsed.length) * 100;
      };

      const ninePassed = Array<string>(9).fill(metricsLine(true));
      const threeWithoutVerdict = Array<string>(3).fill(metricsLine(null));
      expect(passRate([...ninePassed, ...threeWithoutVerdict])).toBe(100);
      expect(passRate([...ninePassed, metricsLine(false), ...threeWithoutVerdict])).toBe(90);
    });
  });
});
