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

const AGENT_MILESTONE_EVENT_TYPE = 'agent_milestone';

interface StreamEventView {
  readonly taskId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly milestone: string;
  readonly metadata: Record<string, unknown>;
}

type ParseOutcome =
  | { readonly kind: 'event'; readonly view: StreamEventView }
  | { readonly kind: 'skip'; readonly reason: ParseSkipReason; readonly taskId?: string; readonly eventId?: string };

/**
 * Reasons a stream record is skipped at parse time. The ``expected_*``
 * prefixed values MUST NOT emit ``MetricEmitSkipped``. The ``anomaly_*``
 * values DO emit.
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

export function parseApprovalRecordWithReason(record: DynamoDBRecord): ParseOutcome {
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

function emitEmf(spec: MetricSpec, timestampMs: number): void {
  process.stdout.write(buildEmfLine(spec, timestampMs) + '\n');
}

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

function publish(view: StreamEventView): { emitted: number; skipped: number } {
  const parsed: ParsedApprovalEvent = {
    milestone: view.milestone,
    eventTimestampIso: view.timestamp,
    metadata: view.metadata,
  };
  const timestampMs = Date.parse(view.timestamp);
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
 * Lambda entry point. Returns a ``DynamoDBBatchResponse`` so the
 * event-source-mapping's ``reportBatchItemFailures: true`` setting works.
 */
export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  let emittedMetrics = 0;
  let skippedBranches = 0;
  let parsedRecords = 0;
  let skippedRecords = 0;
  const parseReasonCounts: Record<string, number> = {};
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
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      logger.warn('approval_metrics record threw — flagging for partial-batch retry', {
        event: 'approval_metrics.record.failed',
        event_id: record.eventID,
        error: err instanceof Error ? err.message : String(err),
        error_name: err instanceof Error ? err.name : undefined,
      });
      if (sequenceNumber !== undefined) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    }
  }

  emitHeartbeat();

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
