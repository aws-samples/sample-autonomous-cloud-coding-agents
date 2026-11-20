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
import { TaskStatus } from '../../src/constructs/task-status';
import {
  FACTORY_DIMENSIONS,
  FACTORY_METRIC_NAMESPACE,
  FACTORY_METRICS,
  FACTORY_WORK,
  taskFacts,
  taskMetricLine,
  type ScoreboardTask,
} from '../../src/handlers/shared/scoreboard';
import type { TaskOutcome } from '../../src/handlers/shared/types';
import { CODING_WORKFLOW_ID } from '../../src/handlers/shared/workflows';

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

/** A metric of a widget as the dashboard body holds it: `[namespace, name, dimension, value, ..., options]`, or `[expression]`. */
type MetricRow = readonly (string | Readonly<Record<string, unknown>>)[];

interface Widget {
  readonly type: string;
  readonly properties: {
    readonly title?: string;
    readonly markdown?: string;
    readonly query?: string;
    readonly metrics?: readonly MetricRow[];
    readonly [property: string]: unknown;
  };
}

/** The widgets of the dashboard, in the order it shows them. The body is a join around the region token. */
function widgetsOf(template: Template): Widget[] {
  const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
  const parts = dashboard.Properties.DashboardBody['Fn::Join'][1] as unknown[];
  return JSON.parse(parts.map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('')).widgets;
}

/** The widget with exactly this title. */
function widgetTitled(template: Template, title: string): Widget {
  const widget = widgetsOf(template).find((candidate) => candidate.properties.title === title);
  if (!widget) throw new Error(`The dashboard has no widget titled "${title}"`);
  return widget;
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
    // All three percentiles required by §11.3, read as the statistics of this widget:
    // other widgets of the dashboard have a p50 and a p90 of their own.
    const breakdown = widgetTitled(template, 'Approval Timeout Breakdown — effective timeout on timed-out approvals (s)');
    expect(breakdown.properties.metrics?.map((row) => [row[1], (row.at(-1) as { stat?: string }).stat])).toEqual([
      ['TimedOutEffectiveTimeout', 'p50'],
      ['TimedOutEffectiveTimeout', 'p90'],
      ['TimedOutEffectiveTimeout', 'p99'],
    ]);
  });

  test('dashboard includes ApprovalDecisionLatency widget with outcome dims', () => {
    const { template } = createStack();
    expect(dashboardBodyContains(template, 'Approval Decision Latency')).toBe(true);
    expect(dashboardBodyContains(template, 'ApprovalDecisionLatencyMs')).toBe(true);
    // Three outcome dim values — one series set per outcome per percentile. Read as
    // the dimension values of this widget: the factory scoreboard row has a
    // `timed_out` of its own.
    const latency = widgetTitled(template, 'Approval Decision Latency by outcome (ms, p50 / p90 / p99)');
    const outcomes = latency.properties.metrics?.map(([, , dimension, value]) => `${String(dimension)}=${String(value)}`);
    expect([...new Set(outcomes)]).toEqual(['outcome=approved', 'outcome=denied', 'outcome=timed_out']);
  });

  describe('build and lint pass rates', () => {
    let template: Template;
    beforeAll(() => {
      template = createStack().template;
    });

    /** The Logs Insights commands of one log widget, in order. */
    function widgetQuery(title: string): string[] {
      return (widgetTitled(template, title).properties.query as string).split('\n| ');
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

  describe('factory scoreboard row', () => {
    let template: Template;
    beforeAll(() => {
      template = createStack().template;
    });

    // The titles follow the labels of the console's Scoreboard page, in the order of the row.
    const NUMBER_TITLES = [
      'Time to verified pull request',
      'Verified pull request with no stop for a person',
      'Human touchpoints per verified pull request',
      'Spend per verified pull request',
      'Guardrail stops and blanket approvals',
    ];
    const GRAPH_TITLE = 'Tasks finished per day, by outcome';

    /** A statistic of one series, as `valuesShown` writes it: `Sum(ABCA/Factory TasksFinished{Outcome=verified_pr})`. */
    function reading(stat: string, metricName: string, dimensions: Record<string, string> = {}, namespace = FACTORY_METRIC_NAMESPACE): string {
      const pairs = Object.entries(dimensions).map(([dimension, value]) => `${dimension}=${value}`);
      return `${stat}(${namespace} ${metricName}${pairs.length > 0 ? `{${pairs.join(', ')}}` : ''})`;
    }

    /** The options of a metric row: its last cell. */
    const optionsOf = (row: MetricRow): Readonly<Record<string, unknown>> =>
      Object.assign({}, ...row.filter((cell) => typeof cell !== 'string'));

    /** The statistic a metric row takes of its series. A row that names none takes the average. */
    function seriesOf(row: MetricRow): string {
      const [namespace, metricName, ...cells] = row.filter((cell) => typeof cell === 'string');
      const dimensions: Record<string, string> = {};
      for (let i = 0; i < cells.length; i += 2) dimensions[cells[i]] = cells[i + 1];
      return reading(String(optionsOf(row).stat ?? 'Average'), metricName, dimensions, namespace);
    }

    /**
     * What a widget shows, by label and in the order it shows them: each value as a formula
     * over the statistics of the series it reads. The body lists such a series as a hidden
     * row under an id, and the value as an expression over the ids. Where the library puts
     * those rows, and that it names no statistic for an average, is how it renders the
     * widget, not what the widget shows.
     */
    function valuesShown(widget: Widget): Record<string, string> {
      const rows = widget.properties.metrics ?? [];
      const inputs = new Map(rows.filter((row) => 'id' in optionsOf(row)).map((row) => [optionsOf(row).id, seriesOf(row)]));
      return Object.fromEntries(rows.filter((row) => optionsOf(row).visible !== false).map((row) => {
        const { label, expression } = optionsOf(row);
        return [label, typeof expression === 'string' ? expression.replace(/[a-z]\w*/gi, (id) => inputs.get(id) ?? id) : seriesOf(row)];
      }));
    }

    const ofCodingTasks = { [FACTORY_DIMENSIONS.work]: FACTORY_WORK.coding };
    const verified = reading('Sum', FACTORY_METRICS.tasksFinished, { [FACTORY_DIMENSIONS.outcome]: 'verified_pr' });

    test('opens the dashboard, under a heading that names the row and its window', () => {
      const [heading, ...below] = widgetsOf(template);

      expect(heading.type).toBe('text');
      expect(heading.properties.markdown).toMatch(/^## Factory scoreboard\n/);
      // For its first 30 days the row holds less than its window says.
      expect(heading.properties.markdown).toContain(
        "Every user's tasks that finished in the last 30 days, or since the scoreboard was deployed if that is less.",
      );
      expect(heading.properties.markdown).toContain('whatever time range the dashboard shows');
      expect(below.slice(0, NUMBER_TITLES.length + 1).map((widget) => widget.properties.title)).toEqual([...NUMBER_TITLES, GRAPH_TITLE]);
    });

    test.each<[string, Record<string, string>]>([
      [
        NUMBER_TITLES[0],
        {
          'Median (minutes)': `${reading('p50', FACTORY_METRICS.timeToVerifiedPr)} / 60`,
          '9 in 10 within (minutes)': `${reading('p90', FACTORY_METRICS.timeToVerifiedPr)} / 60`,
        },
      ],
      [
        NUMBER_TITLES[1],
        // The metric is 0 or 1 on each task that asked for a new pull request: its average is the share.
        { '% of the tasks that asked for a new pull request': `100 * ${reading('Average', FACTORY_METRICS.untouchedVerifiedPrs)}` },
      ],
      [
        NUMBER_TITLES[2],
        { 'On coding tasks, failed ones too': `${reading('Sum', FACTORY_METRICS.humanTouchpoints, ofCodingTasks)} / ${verified}` },
      ],
      [
        NUMBER_TITLES[3],
        { 'USD on coding tasks, failed ones too': `${reading('Sum', FACTORY_METRICS.costUsd, ofCodingTasks)} / ${verified}` },
      ],
      [
        NUMBER_TITLES[4],
        {
          'Stopped by a guardrail': reading('Sum', FACTORY_METRICS.guardrailStops),
          'Started with blanket approval': reading('Sum', FACTORY_METRICS.blanketApprovals),
        },
      ],
    ])('%s: each value over the last 30 days as a whole', (title, values) => {
      const widget = widgetTitled(template, title);

      // The whole window is the period: neither the widget nor a metric names another one.
      expect(widget.properties).toMatchObject({ view: 'singleValue', setPeriodToTimeRange: true, start: '-P30D' });
      expect(widget.properties.period).toBeUndefined();
      expect((widget.properties.metrics ?? []).filter((row) => 'period' in optionsOf(row))).toEqual([]);
      expect(valuesShown(widget)).toEqual(values);
    });

    test(`${GRAPH_TITLE}: a stacked sum per day, one series for each outcome under its console name`, () => {
      const widget = widgetTitled(template, GRAPH_TITLE);
      const names: Record<TaskOutcome, string> = {
        verified_pr: 'Verified pull request',
        unverified_pr: 'Pull request without a passed build',
        no_new_pr: 'Finished, no new pull request',
        failed: 'Failed',
        cancelled: 'Cancelled',
        timed_out: 'Ran out of time',
      };
      const series = Object.entries(names).map(([outcome, label]) =>
        [label, reading('Sum', FACTORY_METRICS.tasksFinished, { [FACTORY_DIMENSIONS.outcome]: outcome })]);

      expect(widget.properties).toMatchObject({ view: 'timeSeries', stacked: true, period: 86400, start: '-P30D' });
      // The stack is built in this order, the verified pull requests at its foot.
      expect(Object.entries(valuesShown(widget))).toEqual(series);
    });

    describe('and the metric line', () => {
      /** `name {dimension: value}` of a metric, the way CloudWatch tells two series apart. */
      const series = (name: string, dimensions: Record<string, unknown>): string =>
        `${name} ${JSON.stringify(Object.entries(dimensions).sort())}`;

      /** Every series a widget of the row reads. */
      function seriesRead(): string[] {
        const rows = [...NUMBER_TITLES, GRAPH_TITLE].flatMap((title) => widgetTitled(template, title).properties.metrics ?? []);
        return rows
          .map((row) => row.filter((cell): cell is string => typeof cell === 'string'))
          .filter(([namespace]) => namespace === FACTORY_METRIC_NAMESPACE)
          .map(([, name, ...rest]) => {
            const dimensions: Record<string, string> = {};
            for (let i = 0; i < rest.length; i += 2) dimensions[rest[i]] = rest[i + 1];
            return series(name, dimensions);
          });
      }

      /** Every series the metric lines of these tasks write. */
      function seriesWritten(tasks: readonly ScoreboardTask[]): Set<string> {
        const written = new Set<string>();
        for (const task of tasks) {
          const line = JSON.parse(taskMetricLine(taskFacts(task)!, {}, 0));
          for (const directive of line._aws.CloudWatchMetrics as { Dimensions: string[][]; Metrics: { Name: string }[] }[]) {
            const dimensions = Object.fromEntries(directive.Dimensions[0].map((dimension) => [dimension, line[dimension]]));
            for (const metric of directive.Metrics) written.add(series(metric.Name, dimensions));
          }
        }
        return written;
      }

      /** New work that ended in a verified pull request, with a recorded cost. */
      const finished = (overrides: Partial<ScoreboardTask> = {}): ScoreboardTask => ({
        task_id: 'task-1',
        status: TaskStatus.COMPLETED,
        repo: 'Owner/Repo',
        resolved_workflow: { id: CODING_WORKFLOW_ID, version: '1.0.0' },
        created_at: '2026-11-18T10:00:00.000Z',
        completed_at: '2026-11-18T10:24:00Z',
        updated_at: '2026-11-18T10:24:00Z',
        pr_url: 'https://github.com/Owner/Repo/pull/12',
        build_passed: true,
        cost_usd: '3.87',
        ...overrides,
      });

      test('the row reads every metric of the line, and no other', () => {
        const names = seriesRead().map((read) => read.split(' ')[0]);

        expect([...new Set(names)].sort()).toEqual(Object.values(FACTORY_METRICS).sort());
      });

      test('the row reads each metric with dimensions the line writes it with', () => {
        // CloudWatch does not aggregate a custom metric across dimensions: a widget
        // gets data only for a combination of dimensions that was published.
        const written = seriesWritten([
          finished(),
          finished({ build_passed: false }),
          finished({ pr_url: undefined }),
          finished({ status: TaskStatus.FAILED }),
          finished({ status: TaskStatus.CANCELLED }),
          finished({ status: TaskStatus.TIMED_OUT }),
        ]);
        const read = seriesRead();

        expect(read).toContain(series(FACTORY_METRICS.tasksFinished, { [FACTORY_DIMENSIONS.outcome]: 'verified_pr' }));
        expect(read.filter((seriesOfRow) => !written.has(seriesOfRow))).toEqual([]);
      });
    });
  });
});
