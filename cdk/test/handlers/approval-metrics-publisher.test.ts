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
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { TaskDashboard } from '../../src/constructs/task-dashboard';
import { handler, parseApprovalRecord } from '../../src/handlers/approval-metrics-publisher';
import { METRIC_NAMESPACE } from '../../src/handlers/shared/approval-metrics';

// --- Helpers ----------------------------------------------------------------

interface RecordOpts {
  readonly eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  readonly taskId?: string;
  readonly eventId?: string;
  readonly timestamp?: string;
  readonly eventType?: string;
  readonly milestone?: string;
  readonly metadata?: Record<string, unknown>;
  readonly eventID?: string;
  readonly sequenceNumber?: string;
}

function streamRecord(opts: RecordOpts = {}): DynamoDBRecord {
  const {
    eventName = 'INSERT',
    taskId = 'task-1',
    eventId = 'evt-1',
    timestamp = '2026-05-08T12:00:05.000Z',
    eventType = 'agent_milestone',
    milestone = 'approval_requested',
    metadata = {},
    eventID,
    sequenceNumber = '1',
  } = opts;

  // Encode metadata into DDB Stream attribute shape. Matches what
  // `progress_writer.py::_put_event` would produce for typical
  // approval-milestone metadata (string, number, list of string).
  const metaAttr: Record<string, any> = { milestone: { S: milestone } };
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v === 'string') {metaAttr[k] = { S: v };} else if (typeof v === 'number') {metaAttr[k] = { N: String(v) };} else if (typeof v === 'boolean') {metaAttr[k] = { BOOL: v };} else if (Array.isArray(v)) {
      metaAttr[k] = { L: v.map((entry) => ({ S: String(entry) })) };
    } else if (v === null) {
      metaAttr[k] = { NULL: true };
    }
  }

  const record: DynamoDBRecord = {
    eventName,
    eventID: eventID ?? `record-${eventId}`,
    dynamodb: {
      NewImage: {
        task_id: { S: taskId },
        event_id: { S: eventId },
        event_type: { S: eventType },
        timestamp: { S: timestamp },
        metadata: { M: metaAttr },
      },
      SequenceNumber: sequenceNumber,
      SizeBytes: 100,
      StreamViewType: 'NEW_IMAGE',
    },
  };
  return record;
}

function streamEvent(records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

/**
 * Capture process.stdout writes during a handler invocation.
 * Returns the list of written lines (EMF JSON strings) parsed as
 * objects, so tests can assert on specific metric emissions.
 */
function captureEmfLines(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: string) => boolean) = (chunk: string): boolean => {
    // Handler emits '<json>\n' — split so a multi-line chunk would
    // still be parsed correctly. In practice each call is one line.
    // Filter to EMF lines (containing ``_aws``) — the shared logger
    // also writes JSON INFO/WARN lines to stdout, which we don't
    // want to count as metric emissions.
    for (const segment of String(chunk).split('\n')) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && '_aws' in parsed) {
          lines.push(parsed);
        }
      } catch {
        // Non-JSON stdout (e.g. jest's own output) is ignored —
        // handler-emitted EMF is always JSON.
      }
    }
    return true;
  };
  return {
    lines,
    restore: () => {
      process.stdout.write = originalWrite as typeof process.stdout.write;
    },
  };
}

/** Shape guard: narrows an EMF line to metric-name + value + dims. */
function metricOf(line: Record<string, unknown>): { name: string; value: number; dimensions: Record<string, string> } | null {
  const aws = line._aws as any;
  if (!aws?.CloudWatchMetrics?.[0]?.Metrics?.[0]) return null;
  const name = aws.CloudWatchMetrics[0].Metrics[0].Name as string;
  const value = line[name] as number;
  const dimNames: string[] = aws.CloudWatchMetrics[0].Dimensions?.[0] ?? [];
  const dimensions: Record<string, string> = {};
  for (const dn of dimNames) dimensions[dn] = String(line[dn]);
  return { name, value, dimensions };
}

// --- parseApprovalRecord ----------------------------------------------------

describe('parseApprovalRecord', () => {
  test('parses a valid approval_requested INSERT record', () => {
    const rec = streamRecord({ milestone: 'approval_requested' });
    const view = parseApprovalRecord(rec);
    expect(view).not.toBeNull();
    expect(view?.milestone).toBe('approval_requested');
    expect(view?.taskId).toBe('task-1');
  });

  test('rejects REMOVE records', () => {
    const rec = streamRecord({ eventName: 'REMOVE' });
    expect(parseApprovalRecord(rec)).toBeNull();
  });

  test('rejects non-agent_milestone event_type', () => {
    const rec = streamRecord({ eventType: 'task_created' });
    expect(parseApprovalRecord(rec)).toBeNull();
  });

  test('rejects unknown milestone name (service-layer filter passed but handler catches)', () => {
    // Defense-in-depth with the event-source filter-pattern — a new
    // agent_milestone kind that's not approval-related gets dropped
    // at the handler layer instead of polluting the publisher.
    const rec = streamRecord({ milestone: 'pr_created' });
    expect(parseApprovalRecord(rec)).toBeNull();
  });

  test('flattens List<String> matching_rule_ids', () => {
    const rec = streamRecord({
      milestone: 'approval_timed_out',
      metadata: {
        created_at: '2026-05-08T12:00:00.000Z',
        effective_timeout_s: 30,
        matching_rule_ids: ['force_push_any', 'write_credentials'],
      },
    });
    const view = parseApprovalRecord(rec);
    expect(view?.metadata.matching_rule_ids).toEqual(['force_push_any', 'write_credentials']);
  });

  test('drops NaN numeric attributes', () => {
    // A malformed ``N`` value in the stream record (theoretical — DDB
    // wouldn't let it happen for real) must not poison downstream
    // metrics. Parser omits the field; classifier's skip branch fires.
    const rec = streamRecord({
      milestone: 'approval_timed_out',
      metadata: { created_at: '2026-05-08T12:00:00.000Z' },
    });
    // Manually corrupt the effective_timeout_s to a non-numeric N value
    (rec.dynamodb!.NewImage!.metadata!.M as any).effective_timeout_s = { N: 'not-a-number' };
    const view = parseApprovalRecord(rec);
    expect(view?.metadata.effective_timeout_s).toBeUndefined();
  });
});

// --- handler ----------------------------------------------------------------

describe('approval-metrics-publisher handler', () => {
  afterEach(() => {
    // Safety net — each test restores its own capture, but a thrown
    // assertion between install and restore could leak. Guard.
    jest.restoreAllMocks();
  });

  test('happy path: approval_requested emits ApprovalRequestCount + heartbeat', async () => {
    const capture = captureEmfLines();
    try {
      await handler(streamEvent([streamRecord({ milestone: 'approval_requested' })]));
    } finally {
      capture.restore();
    }

    const metrics = capture.lines.map(metricOf).filter((m) => m !== null);
    const names = metrics.map((m) => m!.name).sort();
    expect(names).toEqual(['ApprovalRequestCount', 'MetricsPublisherHeartbeat']);
    // Namespace is set on every line.
    for (const line of capture.lines) {
      const ns = (line._aws as any).CloudWatchMetrics[0].Namespace;
      expect(ns).toBe(METRIC_NAMESPACE);
      // Neither metric has dimensions: one empty DimensionSet each. With no
      // set at all CloudWatch has no metric to create from the line.
      expect((line._aws as any).CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    }
  });

  test('happy path: approval_granted emits ApprovalDecisionLatencyMs with outcome dim', async () => {
    const capture = captureEmfLines();
    try {
      await handler(
        streamEvent([
          streamRecord({
            milestone: 'approval_granted',
            timestamp: '2026-05-08T12:00:05.000Z',
            metadata: {
              created_at: '2026-05-08T12:00:00.000Z',
              decided_at: '2026-05-08T12:00:05.000Z',
              scope: 'tool_type:Read',
            },
          }),
        ]),
      );
    } finally {
      capture.restore();
    }

    const latency = capture.lines.map(metricOf).find((m) => m?.name === 'ApprovalDecisionLatencyMs');
    expect(latency).toBeDefined();
    expect(latency!.value).toBe(5000);
    expect(latency!.dimensions).toEqual({ outcome: 'approved' });
  });

  test('approval_granted missing created_at → MetricEmitSkipped, no latency emit', async () => {
    // Critical silent-failure defense: a stale container (pre-Chunk-8a
    // shape) must not cause the publisher to emit latency=0 into
    // percentile widgets. Explicit skip counter instead.
    const capture = captureEmfLines();
    try {
      await handler(
        streamEvent([
          streamRecord({
            milestone: 'approval_granted',
            metadata: { decided_at: '2026-05-08T12:00:05.000Z', scope: 'tool_type:Read' },
          }),
        ]),
      );
    } finally {
      capture.restore();
    }

    const byName = new Map<string, ReturnType<typeof metricOf>>();
    for (const line of capture.lines) {
      const m = metricOf(line);
      if (m) byName.set(m.name, m);
    }
    expect(byName.has('ApprovalDecisionLatencyMs')).toBe(false);
    const skipped = byName.get('MetricEmitSkipped');
    expect(skipped).toBeDefined();
    expect(skipped!.dimensions).toEqual({ reason: 'missing_created_at_or_decided_at' });
    expect(byName.has('MetricsPublisherHeartbeat')).toBe(true);
  });

  test('approval_timed_out emits both latency + breakdown when all fields present', async () => {
    const capture = captureEmfLines();
    try {
      await handler(
        streamEvent([
          streamRecord({
            milestone: 'approval_timed_out',
            timestamp: '2026-05-08T12:00:30.000Z',
            metadata: {
              created_at: '2026-05-08T12:00:00.000Z',
              effective_timeout_s: 30,
              matching_rule_ids: ['force_push_any'],
            },
          }),
        ]),
      );
    } finally {
      capture.restore();
    }

    const byName = new Map<string, ReturnType<typeof metricOf>>();
    for (const line of capture.lines) {
      const m = metricOf(line);
      if (m) byName.set(m.name, m);
    }
    expect(byName.get('ApprovalDecisionLatencyMs')?.value).toBe(30_000);
    expect(byName.get('ApprovalDecisionLatencyMs')?.dimensions).toEqual({ outcome: 'timed_out' });
    // The breakdown is written twice: per rule, and without dimensions.
    const breakdown = capture.lines.map(metricOf).filter((m) => m?.name === 'TimedOutEffectiveTimeout');
    expect(breakdown.map((m) => m!.value)).toEqual([30, 30]);
    expect(breakdown.map((m) => m!.dimensions)).toEqual([{ rule_id: 'force_push_any' }, {}]);
  });

  test('heartbeat fires even on a batch of all-non-approval records', async () => {
    // Operator signal: heartbeat means the pipeline is live, even if
    // no approval traffic is hitting TaskEventsTable right now. Gap
    // on heartbeat = pipeline is broken.
    const capture = captureEmfLines();
    try {
      await handler(
        streamEvent([
          streamRecord({ eventType: 'task_created' }),
          streamRecord({ milestone: 'pr_created' }),
        ]),
      );
    } finally {
      capture.restore();
    }

    const names = capture.lines.map(metricOf).filter((m) => m !== null).map((m) => m!.name);
    expect(names).toContain('MetricsPublisherHeartbeat');
    // No approval-event metrics emitted.
    expect(names.filter((n) => n.startsWith('Approval') || n.startsWith('Clipped') || n.startsWith('TimedOut'))).toHaveLength(0);
  });

  test('poison pill: handler exception flags record for partial-batch retry', async () => {
    // Simulate a record that parseApprovalRecord tolerates but
    // classifyApprovalEvent throws on. We can't easily force the
    // pure classifier to throw; instead, corrupt the stream shape
    // in a way that slips past the parser. A malformed timestamp
    // is not a poison pill (we fall back to Date.now()). A thrown
    // ``metadata`` accessor — via a DDB NewImage missing ``M`` — IS
    // a poison pill because parseApprovalRecord returns null, which
    // is a skip, not a throw. So we mock the classifier indirectly
    // via a getter that throws on metadata access.
    const poison = streamRecord({ milestone: 'approval_requested', eventID: 'poison-1', sequenceNumber: '4901' });
    // Replace metadata M with a getter that throws on iteration.
    Object.defineProperty(poison.dynamodb!.NewImage!.metadata!, 'M', {
      get() {
        throw new Error('simulated parse poison');
      },
    });

    const capture = captureEmfLines();
    try {
      const result = await handler(streamEvent([
        poison,
        streamRecord({ milestone: 'approval_requested', eventID: 'good-1', sequenceNumber: '4902' }),
      ]));
      // The stream sequence number, which is what Lambda checkpoints on — not
      // the eventID ('poison-1'), which is no position in the shard.
      expect(result.batchItemFailures).toEqual([{ itemIdentifier: '4901' }]);
    } finally {
      capture.restore();
    }

    // Sibling record still emitted.
    const names = capture.lines.map(metricOf).filter((m) => m !== null).map((m) => m!.name);
    expect(names).toContain('ApprovalRequestCount');
    expect(names).toContain('MetricsPublisherHeartbeat');
  });

  test('returns empty batchItemFailures on happy-path batch', async () => {
    const capture = captureEmfLines();
    try {
      const result = await handler(
        streamEvent([
          streamRecord({ milestone: 'approval_requested' }),
          streamRecord({ milestone: 'approval_requested', eventId: 'evt-2' }),
        ]),
      );
      expect(result.batchItemFailures).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  test('heartbeat still emits even when every record in the batch is a poison pill', async () => {
    // Invariant guarded by this test: the ``MetricsPublisherHeartbeat``
    // emit lives AFTER the per-record for loop, so an all-poison batch
    // still produces the "pipeline is alive" signal. A future refactor
    // that moves the heartbeat INSIDE the try/catch (e.g. "only count
    // as alive if we parsed at least one record") would break the
    // operator's ability to distinguish "no approval traffic" from
    // "pipeline is broken" during a DLQ-driven replay of poison
    // records. Regression guard per Chunk 8 silent-failure M5.
    const poison1 = streamRecord({ milestone: 'approval_requested', eventID: 'poison-a', sequenceNumber: '4901' });
    const poison2 = streamRecord({ milestone: 'approval_requested', eventID: 'poison-b', sequenceNumber: '4902' });
    for (const rec of [poison1, poison2]) {
      Object.defineProperty(rec.dynamodb!.NewImage!.metadata!, 'M', {
        get() {
          throw new Error('simulated parse poison');
        },
      });
    }

    const capture = captureEmfLines();
    let result;
    try {
      result = await handler(streamEvent([poison1, poison2]));
    } finally {
      capture.restore();
    }

    // Both records flagged for partial-batch retry, by sequence number.
    expect(result!.batchItemFailures).toEqual([
      { itemIdentifier: '4901' },
      { itemIdentifier: '4902' },
    ]);
    // Heartbeat MUST fire despite 100% of records being poison.
    const names = capture.lines.map(metricOf).filter((m) => m !== null).map((m) => m!.name);
    expect(names).toContain('MetricsPublisherHeartbeat');
    // No approval-event metrics since nothing parsed successfully.
    expect(names.filter((n) => n.startsWith('ApprovalRequestCount'))).toHaveLength(0);
  });

  test('parse anomalies (missing required keys) emit MetricEmitSkipped + structured warn', async () => {
    // Silent-failure H1: parseApprovalRecord distinguishes "expected"
    // skips (non-approval records — high volume, silenced) from
    // "anomaly" skips (missing task_id / missing metadata.M /
    // missing milestone name — rare, surfaced). Anomalies MUST emit
    // a MetricEmitSkipped with a reason dimension so the dashboard's
    // absence-of-data becomes observable.
    const rec = streamRecord({ milestone: 'approval_requested' });
    // Force missing task_id to trigger ``anomaly_missing_required_keys``.
    delete (rec.dynamodb!.NewImage! as any).task_id;

    const capture = captureEmfLines();
    try {
      await handler(streamEvent([rec]));
    } finally {
      capture.restore();
    }

    const skipped = capture.lines.map(metricOf).find((m) => m?.name === 'MetricEmitSkipped');
    expect(skipped).toBeDefined();
    expect(skipped!.dimensions).toEqual({ reason: 'anomaly_missing_required_keys' });
  });

  test('expected skips (non-milestone event_type) do NOT emit MetricEmitSkipped', async () => {
    // The inverse: expected skip reasons (REMOVE records, non-
    // agent_milestone records, non-approval milestones) are high
    // volume and must NOT emit MetricEmitSkipped — that would drown
    // real anomaly signal. They only bump the per-reason counter
    // visible in the batch.complete log.
    const rec = streamRecord({ eventType: 'task_created' });

    const capture = captureEmfLines();
    try {
      await handler(streamEvent([rec]));
    } finally {
      capture.restore();
    }

    const skipped = capture.lines.map(metricOf).filter((m) => m?.name === 'MetricEmitSkipped');
    expect(skipped).toHaveLength(0);
    // Heartbeat still fires — pipeline is alive.
    const names = capture.lines.map(metricOf).filter((m) => m !== null).map((m) => m!.name);
    expect(names).toContain('MetricsPublisherHeartbeat');
  });

  test('unparseable event timestamp → skip counter + emission uses Date.now fallback', async () => {
    // Malformed ISO timestamp shouldn't drop the metric, but we
    // want an observability signal that the timestamp path failed.
    const capture = captureEmfLines();
    try {
      await handler(
        streamEvent([
          streamRecord({
            milestone: 'approval_requested',
            timestamp: 'not-an-iso-string',
          }),
        ]),
      );
    } finally {
      capture.restore();
    }

    const names = capture.lines.map(metricOf).filter((m) => m !== null).map((m) => m!.name);
    expect(names).toContain('ApprovalRequestCount');
    expect(names).toContain('MetricEmitSkipped');
    const skipped = capture.lines.map(metricOf).find((m) => m?.name === 'MetricEmitSkipped');
    expect(skipped?.dimensions).toEqual({ reason: 'timestamp_parse_failed' });
  });
});

// --- dashboard parity -------------------------------------------------------

describe('the dashboard and the publisher agree on metric dimensions', () => {
  const key = (name: string, dimensions: Record<string, string>): string =>
    `${name} ${JSON.stringify(Object.entries(dimensions).sort())}`;

  /** Every ABCA/Cedar-HITL metric a dashboard widget reads, with its dimensions. */
  function dashboardMetrics(): string[] {
    const stack = new Stack(new App(), 'TestStack');
    new TaskDashboard(stack, 'TaskDashboard', {
      applicationLogGroup: new logs.LogGroup(stack, 'AppLogGroup'),
      runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime',
    });
    const [dashboard] = Object.values(Template.fromStack(stack).findResources('AWS::CloudWatch::Dashboard'));
    const parts = dashboard.Properties.DashboardBody['Fn::Join'][1] as unknown[];
    const body = JSON.parse(parts.map((p) => (typeof p === 'string' ? p : 'TOKEN')).join(''));
    const read = new Set<string>();
    for (const widget of body.widgets as { properties: { metrics?: unknown[][] } }[]) {
      for (const row of widget.properties.metrics ?? []) {
        // A row is [namespace, name, dimension, value, ..., options].
        const [namespace, name, ...rest] = row.filter((cell): cell is string => typeof cell === 'string');
        if (namespace !== METRIC_NAMESPACE) continue;
        const dimensions: Record<string, string> = {};
        for (let i = 0; i < rest.length; i += 2) dimensions[rest[i]] = rest[i + 1];
        read.add(key(name, dimensions));
      }
    }
    return [...read].sort();
  }

  test('every Cedar-HITL metric a widget reads is written with exactly those dimensions', async () => {
    // CloudWatch does not aggregate a custom metric across dimensions: a widget
    // gets data only for a combination of dimensions that was published.
    const times = { created_at: '2026-05-08T12:00:00.000Z', decided_at: '2026-05-08T12:00:05.000Z' };
    const capture = captureEmfLines();
    try {
      await handler(streamEvent([
        streamRecord({ milestone: 'approval_requested' }),
        ...['rule_annotation', 'maxLifetime_ceiling', 'runtime_jwt_ceiling', 'a_reason_added_later'].map((reason) =>
          streamRecord({ milestone: 'approval_timeout_capped', metadata: { reason } })),
        streamRecord({ milestone: 'approval_granted', metadata: times }),
        streamRecord({ milestone: 'approval_denied', metadata: times }),
        streamRecord({
          milestone: 'approval_timed_out',
          metadata: { ...times, effective_timeout_s: 300, matching_rule_ids: ['force_push_any'] },
        }),
      ]));
    } finally {
      capture.restore();
    }
    const written = new Set(capture.lines.map(metricOf).map((m) => key(m!.name, m!.dimensions)));

    const read = dashboardMetrics();
    expect(read).toContain(key('ApprovalRequestCount', {}));
    expect(read.filter((metric) => !written.has(metric))).toEqual([]);
  });
});
