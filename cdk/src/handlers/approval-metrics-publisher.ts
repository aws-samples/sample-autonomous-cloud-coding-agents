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

/**
 * ApprovalMetricsPublisher Lambda — Chunk 8b (design §11.3, IMPL-28).
 *
 * DynamoDB Streams on ``TaskEventsTable`` deliver NEW_IMAGE records to
 * this Lambda as consumer #2 alongside ``FanOutConsumer`` (consumer #1,
 * Slack/GitHub/email dispatch). We filter to Cedar-HITL approval
 * milestones (``approval_requested`` / ``approval_granted`` /
 * ``approval_denied`` / ``approval_timed_out`` /
 * ``approval_timeout_capped``) and emit EMF log lines from which
 * CloudWatch auto-extracts custom metrics in namespace
 * ``ABCA/Cedar-HITL``.
 *
 * Why this Lambda exists (not a producer-side dual-write):
 *   - Single source of truth stays ``TaskEventsTable`` (DDB).
 *   - Metric schema lives here, not in the agent — future dashboard
 *     changes don't force an agent redeploy.
 *   - Native CloudWatch metrics are alarm-ready for §11.5 once a
 *     notification channel lands.
 *   - §11.3 literal wording is "CloudWatch custom metric" — EMF is the
 *     cheapest path to that posture without a custom metric-put API.
 *
 * Observability-of-observability (Chunk 8 silent-failure adversarial):
 *   - Every invocation that passes the event-source-mapping filter
 *     emits ``MetricsPublisherHeartbeat`` = 1 before returning.
 *     **Semantics** (full-branch review B1): the heartbeat is
 *     "present when active," not "pipeline alive always" — the ESM
 *     filter blocks invocation when no ``agent_milestone`` records
 *     are in the poll window, so a quiet period produces the same
 *     widget gap as a broken pipeline. Operators should alarm on
 *     the COMBINATION: heartbeat-absent AND recent agent_milestone
 *     writes in TaskEventsTable (or alternatively run a scheduled
 *     canary that emits a synthetic approval record — deferred
 *     §11.5 work). A dedicated heartbeat-is-alive signal needs a
 *     scheduled EventBridge rule, not a record-driven counter.
 *   - On a schema-mismatch (outcome event missing ``created_at`` / old
 *     container still running post-Chunk-8a deploy), the handler emits
 *     ``MetricEmitSkipped`` with a ``reason`` dimension + structured
 *     log. The dashboard sees an explicit skip counter rather than a
 *     silently-missing bar.
 *   - Per-record try/catch with ``reportBatchItemFailures`` mirrors
 *     ``fanout-task-events.ts`` poison-pill isolation (one record's
 *     throw does not stall the batch or strand the stream cursor).
 */

import type {
  DynamoDBBatchItemFailure,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import {
  APPROVAL_METRIC_MILESTONES,
  METRIC_NAMESPACE,
  type MetricSpec,
  type ParsedApprovalEvent,
  RULE_ID_ALLOWLIST,
  buildEmfLine,
  classifyApprovalEvent,
} from './shared/approval-metrics';
import { logger } from './shared/logger';

/**
 * Milestone event type written by ``progress_writer.py``. Chunk 8a's
 * approval outcome events all share ``event_type = agent_milestone``
 * with the specific milestone name in ``metadata.milestone``. The
 * event-source-mapping filter pattern (see
 * ``approval-metrics-publisher-consumer.ts``) rejects non-
 * ``agent_milestone`` records at the service layer so this Lambda
 * only sees relevant traffic.
 */
const AGENT_MILESTONE_EVENT_TYPE = 'agent_milestone';

/**
 * Flattened approval-milestone event parsed from a DDB Stream record.
 * ``milestone`` is the already-unwrapped ``metadata.milestone`` value;
 * ``metadata`` is the remaining metadata without the milestone key
 * (so classifier code doesn't have to defensively ignore it).
 */
interface StreamEventView {
  readonly taskId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly milestone: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Parse a DDB Stream record into the approval-event view. Returns
 * ``null`` for records that are not approval milestones (deletes,
 * non-``agent_milestone`` event types, unknown milestone names). The
 * caller counts ``null`` as a skip; this is how we count Lambda
 * invocations vs. emitted metrics downstream.
 *
 * NOTE: DDB Streams NEW_IMAGE shape encodes attribute types as
 * ``{"S": "..."}`` / ``{"N": "..."}`` / ``{"M": {...}}`` / ``{"L":
 * [...]}`` / ``{"BOOL": ...}`` / ``{"NULL": true}``. We flatten only
 * the attributes the classifier reads. ``metadata.matching_rule_ids``
 * is a List<String> on the write side (``progress_writer.py``), so
 * the L→string[] flatten is load-bearing for the ``rule_id``
 * dimension on ``TimedOutEffectiveTimeout``.
 */
/**
 * Outcome of parsing a stream record. Carries the concrete null-return
 * reason so the handler can distinguish expected skips (REMOVE,
 * non-milestone event types) from anomalies (missing keys, unknown
 * milestone) that should be surfaced via ``MetricEmitSkipped`` — single
 * aggregate counter would hide the signal operators actually need
 * (silent-failure adversarial H1).
 */
type ParseOutcome =
  | { readonly kind: 'event'; readonly view: StreamEventView }
  | { readonly kind: 'skip'; readonly reason: ParseSkipReason; readonly taskId?: string; readonly eventId?: string };

/**
 * Reasons a stream record is skipped at parse time. The ``expected_*``
 * prefixed values are high-volume (every non-approval event lands
 * here) and MUST NOT emit ``MetricEmitSkipped`` — that would dwarf
 * real signal. The ``anomaly_*`` values are rare and DO emit.
 */
export type ParseSkipReason =
  | 'expected_non_insert_modify'
  | 'expected_missing_new_image'
  | 'expected_non_milestone_event_type'
  | 'expected_milestone_not_tracked'
  | 'anomaly_missing_required_keys'
  | 'anomaly_missing_metadata_map'
  | 'anomaly_missing_milestone_name';

const ANOMALY_PARSE_REASONS: ReadonlySet<ParseSkipReason> = new Set([
  'anomaly_missing_required_keys',
  'anomaly_missing_metadata_map',
  'anomaly_missing_milestone_name',
]);

export function parseApprovalRecord(record: DynamoDBRecord): StreamEventView | null {
  const outcome = parseApprovalRecordWithReason(record);
  return outcome.kind === 'event' ? outcome.view : null;
}

/**
 * Parse with full reason reporting. Used by the handler to drive
 * per-reason skip metrics; the legacy ``parseApprovalRecord`` is a
 * thin wrapper that discards the reason for callers that only need
 * the happy-path view (tests + any future caller).
 */
export function parseApprovalRecordWithReason(record: DynamoDBRecord): ParseOutcome {
  // INSERT-only per the event-source-mapping filter (see
  // ``approval-metrics-publisher-consumer.ts``). Keeping the handler
  // strictly aligned with the filter avoids the full-branch H2
  // finding: if a future chunk starts MODIFY-ing TaskEventsTable
  // items, the publisher will silently stop seeing them (filter
  // drops) and the mismatch will be detectable only by staring at
  // stream stats — hard to diagnose. A single source of truth on
  // ``eventName == INSERT`` keeps the layers honest.
  if (record.eventName !== 'INSERT') {
    return { kind: 'skip', reason: 'expected_non_insert_modify' };
  }
  const img = record.dynamodb?.NewImage;
  if (!img) {
    return { kind: 'skip', reason: 'expected_missing_new_image' };
  }

  const eventType = img.event_type?.S;
  if (eventType !== AGENT_MILESTONE_EVENT_TYPE) {
    return { kind: 'skip', reason: 'expected_non_milestone_event_type' };
  }

  const taskId = img.task_id?.S;
  const eventId = img.event_id?.S;
  const timestamp = img.timestamp?.S;
  if (!taskId || !eventId || !timestamp) {
    return {
      kind: 'skip',
      reason: 'anomaly_missing_required_keys',
      taskId,
      eventId,
    };
  }

  const metaImg = img.metadata?.M;
  if (!metaImg) {
    return {
      kind: 'skip',
      reason: 'anomaly_missing_metadata_map',
      taskId,
      eventId,
    };
  }

  const milestoneRaw = metaImg.milestone?.S;
  if (!milestoneRaw) {
    return {
      kind: 'skip',
      reason: 'anomaly_missing_milestone_name',
      taskId,
      eventId,
    };
  }
  if (!APPROVAL_METRIC_MILESTONES.has(milestoneRaw)) {
    return {
      kind: 'skip',
      reason: 'expected_milestone_not_tracked',
      taskId,
      eventId,
    };
  }

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metaImg)) {
    if (k === 'milestone') continue;
    if (v.S !== undefined) {
      metadata[k] = v.S;
    } else if (v.N !== undefined) {
      const n = Number(v.N);
      if (Number.isFinite(n)) {
        metadata[k] = n;
      } else {
        // Malformed N value from DDB (theoretical — DDB wouldn't
        // normally store non-numeric strings in an N attribute, but
        // a future schema migration or hand-edited row could). The
        // classifier's skip-branch covers the downstream metric
        // case, but without a log here the parse-time drop is
        // invisible. Emit a structured warn so silent-failure
        // adversarial H2 is addressed: operators can alarm on a
        // sustained non-zero rate of ``numeric_coerce_failed``.
        logger.warn('approval_metrics numeric attribute coerce failed', {
          event: 'approval_metrics.numeric_coerce_failed',
          task_id: taskId,
          event_id: eventId,
          milestone: milestoneRaw,
          field: k,
          raw_value: v.N,
        });
      }
    } else if (v.BOOL !== undefined) {
      metadata[k] = v.BOOL;
    } else if (v.L !== undefined) {
      // List<String> only — matching_rule_ids is the only L-typed
      // attribute the classifier currently reads. Defensively cap
      // to string values so a mistyped future field can't smuggle
      // non-string cardinality into the ``rule_id`` dimension.
      metadata[k] = v.L
        .map((entry) => entry.S)
        .filter((entry): entry is string => typeof entry === 'string');
    } else if (v.NULL !== undefined) {
      metadata[k] = null;
    }
  }

  return {
    kind: 'event',
    view: {
      taskId,
      eventId,
      timestamp,
      milestone: milestoneRaw,
      metadata,
    },
  };
}

/**
 * Emit a single EMF line to stdout. CloudWatch picks up each log
 * event independently — one metric per line keeps the extraction
 * trivially-auditable in CloudWatch Logs Insights and keeps any
 * single malformed line from swallowing its siblings.
 *
 * Uses ``process.stdout.write`` (not ``console.log``) to match the
 * shared logger style — ``console.log`` is lint-banned in this
 * codebase outside the CLI package.
 */
function emitEmf(spec: MetricSpec, timestampMs: number): void {
  process.stdout.write(buildEmfLine(spec, timestampMs) + '\n');
}

/**
 * Emit the per-batch heartbeat metric. Fires on every invocation
 * that passes the event-source-mapping filter. **Important caveat
 * (B1)**: the filter blocks invocation when no ``agent_milestone``
 * records exist in the poll window, so a widget gap can mean either
 * "no approval traffic this period" OR "pipeline broken." This
 * metric alone cannot distinguish the two; operators should alarm
 * on the combination (heartbeat-absent + recent TaskEventsTable
 * activity) or wire a scheduled canary. See the module docstring
 * for the full semantics rationale.
 */
function emitHeartbeat(): void {
  emitEmf(
    {
      name: 'MetricsPublisherHeartbeat',
      unit: 'Count',
      value: 1,
      dimensions: {},
    },
    Date.now(),
  );
}

/**
 * Emit a skip metric with a ``reason`` dimension. Triggered on a
 * schema-mismatch on one of the metric branches (missing
 * ``created_at``, missing ``effective_timeout_s``, etc.). Operators
 * can alarm on a sustained non-zero rate to detect:
 *   - stale agent containers post-Chunk-8a rollout (will self-resolve
 *     once all containers cycle)
 *   - agent-side regression that drops a required field
 *   - an unexpected milestone reaching the classifier default branch
 *     (classification_miss)
 */
function emitSkip(reason: string, timestampMs: number): void {
  emitEmf(
    {
      name: 'MetricEmitSkipped',
      unit: 'Count',
      value: 1,
      dimensions: { reason },
    },
    timestampMs,
  );
}

/**
 * Publish metrics for a single parsed approval event. Any thrown
 * error is the caller's poison-pill responsibility — we do not swallow
 * here so the handler's per-record try/catch can flag the record for
 * Lambda's partial-batch retry cursor.
 */
function publish(view: StreamEventView): { emitted: number; skipped: number } {
  const parsed: ParsedApprovalEvent = {
    milestone: view.milestone,
    eventTimestampIso: view.timestamp,
    metadata: view.metadata,
  };
  const timestampMs = Date.parse(view.timestamp);
  // Guard against a malformed timestamp — fall back to Date.now so
  // the metric still emits (better than a NaN EMF line that
  // CloudWatch silently drops at extraction). The event_id is in
  // the structured log for post-hoc correlation.
  const safeTimestampMs = Number.isFinite(timestampMs) ? timestampMs : Date.now();

  if (!Number.isFinite(timestampMs)) {
    logger.warn('approval event has unparseable timestamp — using Date.now() for EMF', {
      event: 'approval_metrics.timestamp_parse_failed',
      task_id: view.taskId,
      event_id: view.eventId,
      milestone: view.milestone,
      raw_timestamp: view.timestamp,
    });
    emitSkip('timestamp_parse_failed', safeTimestampMs);
  }

  const { specs, skipped } = classifyApprovalEvent(parsed);
  for (const spec of specs) {
    emitEmf(spec, safeTimestampMs);
  }
  for (const s of skipped) {
    logger.warn('approval metric branch skipped — schema mismatch', {
      event: 'approval_metrics.schema_mismatch',
      task_id: view.taskId,
      event_id: view.eventId,
      milestone: view.milestone,
      metric: s.metric,
      reason: s.reason,
    });
    emitSkip(s.reason, safeTimestampMs);
  }

  return { emitted: specs.length, skipped: skipped.length };
}

/**
 * Lambda entry point. Matches the shape of ``fanout-task-events.ts``:
 * returns a ``DynamoDBBatchResponse`` so the event-source-mapping's
 * ``reportBatchItemFailures: true`` setting works.
 */
export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  let emittedMetrics = 0;
  let skippedBranches = 0;
  let parsedRecords = 0;
  let skippedRecords = 0;
  // Per-parse-reason counts drive the structured ``batch.complete`` log
  // at end-of-handler. Rare anomaly reasons additionally emit a
  // ``MetricEmitSkipped`` so the dashboard surfaces the gap; expected
  // high-volume reasons (``expected_non_insert_modify``, etc.) only
  // bump the counter to avoid drowning real signal.
  const parseReasonCounts: Record<string, number> = {};
  // Track distinct unknown rule ids observed this batch so operators
  // can discover "why is `other` growing?" (silent-failure adversarial
  // M2). Bounded by batch size; summary emitted once per batch.
  const unknownRuleIds = new Set<string>();

  for (const record of event.Records) {
    try {
      const outcome = parseApprovalRecordWithReason(record);
      if (outcome.kind === 'skip') {
        skippedRecords++;
        parseReasonCounts[outcome.reason] = (parseReasonCounts[outcome.reason] ?? 0) + 1;
        if (ANOMALY_PARSE_REASONS.has(outcome.reason)) {
          emitSkip(outcome.reason, Date.now());
          logger.warn('approval_metrics parse anomaly — record dropped', {
            event: 'approval_metrics.parse_anomaly',
            reason: outcome.reason,
            task_id: outcome.taskId,
            event_id: outcome.eventId,
          });
        }
        continue;
      }
      parsedRecords++;
      // Track unknown rule ids before publishing so the per-batch
      // summary reflects what the classifier would have collapsed.
      const ruleIds = outcome.view.metadata.matching_rule_ids;
      if (Array.isArray(ruleIds)) {
        for (const rid of ruleIds) {
          if (typeof rid === 'string' && !RULE_ID_ALLOWLIST.has(rid)) {
            unknownRuleIds.add(rid);
          }
        }
      }
      const result = publish(outcome.view);
      emittedMetrics += result.emitted;
      skippedBranches += result.skipped;
    } catch (err) {
      // Poison-pill isolation. Lambda retries this specific record via
      // the reportBatchItemFailures cursor; after retryAttempts it
      // lands in the DLQ (see ApprovalMetricsPublisherConsumer).
      const eventID = record.eventID;
      logger.warn('approval_metrics record threw — flagging for partial-batch retry', {
        event: 'approval_metrics.record.failed',
        event_id: eventID,
        error: err instanceof Error ? err.message : String(err),
        error_name: err instanceof Error ? err.name : undefined,
      });
      if (eventID !== undefined) {
        batchItemFailures.push({ itemIdentifier: eventID });
      }
    }
  }

  // Heartbeat fires unconditionally on every invocation reaching the
  // end of the loop — even a fully-skipped batch (all non-approval
  // records) still produces the heartbeat signal. The only way to
  // lose the heartbeat is an invocation that never starts or throws
  // before the loop; both are separately observable via Lambda's
  // own Invocations / Errors metrics in AWS/Lambda.
  emitHeartbeat();

  // Summarize any unknown rule ids the classifier collapsed to
  // ``other`` this batch. Emitted at INFO (not WARN) because the
  // collapse is intentional cardinality cap behavior; the goal is
  // discoverability — an operator investigating a growing ``other``
  // bucket on the dashboard should find the actual rule id strings
  // in CloudWatch Logs Insights via this log line.
  if (unknownRuleIds.size > 0) {
    logger.info('approval_metrics unknown rule_ids collapsed to "other"', {
      event: 'approval_metrics.rule_id_collapsed',
      count: unknownRuleIds.size,
      rule_ids: Array.from(unknownRuleIds).sort(),
    });
  }

  logger.info('approval_metrics batch complete', {
    event: 'approval_metrics.batch.complete',
    records: event.Records.length,
    parsed: parsedRecords,
    skipped_records: skippedRecords,
    parse_reasons: parseReasonCounts,
    emitted_metrics: emittedMetrics,
    skipped_branches: skippedBranches,
    failed: batchItemFailures.length,
    namespace: METRIC_NAMESPACE,
  });

  return { batchItemFailures };
};
