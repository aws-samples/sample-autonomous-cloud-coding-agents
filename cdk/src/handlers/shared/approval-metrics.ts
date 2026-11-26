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

export const METRIC_NAMESPACE = 'ABCA/Cedar-HITL';

export const APPROVAL_METRIC_MILESTONES = new Set<string>([
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'approval_timed_out',
  'approval_timeout_capped',
  'approval_cap_exceeded',
  'approval_rate_limit_exceeded',
  'approval_stranded',
]);

const CLIP_REASON_VALUES = new Set<string>([
  'rule_annotation',
  'maxLifetime_ceiling',
  'runtime_jwt_ceiling',
]);

/**
 * Values of the ``rule_id`` dimension, in order of precedence: an event that
 * several of these rules matched counts under the one that stands first here.
 * Any other rule id counts as ``other``, an empty list as ``none``.
 *
 * CloudWatch bills every distinct dimension value as a custom metric of its own (~$0.30/month).
 */
export const RULE_ID_ALLOWLIST = new Set<string>([
  'force_push_main',
  'force_push_any',
  'push_to_protected_branch',
  'write_credentials',
  'write_env_files',
]);

export function normalizeRuleId(ruleIds: readonly string[] | undefined): string {
  if (!ruleIds || ruleIds.length === 0) return 'none';
  for (const id of RULE_ID_ALLOWLIST) {
    if (ruleIds.includes(id)) return id;
  }
  return 'other';
}

export function normalizeClipReason(reason: string | undefined): string {
  if (reason && CLIP_REASON_VALUES.has(reason)) return reason;
  return 'unknown';
}

export function outcomeFromMilestone(milestone: string): string | null {
  switch (milestone) {
    case 'approval_granted':
      return 'approved';
    case 'approval_denied':
      return 'denied';
    case 'approval_timed_out':
      return 'timed_out';
    default:
      return null;
  }
}

export interface MetricSpec {
  readonly name: string;
  readonly unit: 'Count' | 'Seconds' | 'Milliseconds';
  readonly value: number;
  /**
   * Dimension name → value. An empty map produces a metric without dimensions.
   */
  readonly dimensions: Readonly<Record<string, string>>;
}

/**
 * Build a single EMF log line for one metric. `timestampMs` is milliseconds since epoch.
 * EMF spec: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
export function buildEmfLine(spec: MetricSpec, timestampMs: number): string {
  const dimensionNames = Object.keys(spec.dimensions);
  const emf: Record<string, unknown> = {
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          // Always one DimensionSet, the empty one for a metric without
          // dimensions: `[]` would declare no metric.
          Dimensions: [dimensionNames],
          Metrics: [{ Name: spec.name, Unit: spec.unit }],
        },
      ],
    },
    [spec.name]: spec.value,
    ...spec.dimensions,
  };
  return JSON.stringify(emf);
}

/**
 * ``specs``: the metrics to emit for one approval milestone. ``skipped``: the
 * metrics that could not be built because a schema field was missing.
 */
export interface ClassificationResult {
  readonly specs: readonly MetricSpec[];
  readonly skipped: readonly { metric: string; reason: string }[];
}

export interface ParsedApprovalEvent {
  readonly milestone: string;
  readonly eventTimestampIso: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Pure classifier: given a parsed approval-milestone event, return
 * the list of EMF metric specs to emit + a list of per-metric skip
 * reasons for branches whose input is missing.
 */
export function classifyApprovalEvent(ev: ParsedApprovalEvent): ClassificationResult {
  const specs: MetricSpec[] = [];
  const skipped: { metric: string; reason: string }[] = [];
  const md = ev.metadata;

  switch (ev.milestone) {
    case 'approval_requested':
      specs.push({
        name: 'ApprovalRequestCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_timeout_capped':
      specs.push({
        name: 'ClippedApprovalCount',
        unit: 'Count',
        value: 1,
        dimensions: { reason: normalizeClipReason(asString(md.reason)) },
      });
      break;

    case 'approval_granted':
    case 'approval_denied': {
      const outcome = outcomeFromMilestone(ev.milestone);
      const latency = latencyMs(md.created_at, md.decided_at);
      if (latency === null) {
        skipped.push({
          metric: 'ApprovalDecisionLatencyMs',
          reason: 'missing_created_at_or_decided_at',
        });
      } else if (outcome !== null) {
        specs.push({
          name: 'ApprovalDecisionLatencyMs',
          unit: 'Milliseconds',
          value: latency,
          dimensions: { outcome },
        });
      }
      break;
    }

    case 'approval_cap_exceeded':
      specs.push({
        name: 'ApprovalCapExceededCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_rate_limit_exceeded':
      specs.push({
        name: 'ApprovalRateLimitExceededCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_stranded':
      specs.push({
        name: 'ApprovalStrandedCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_timed_out': {
      const latency = latencyMs(md.created_at, ev.eventTimestampIso);
      if (latency === null) {
        skipped.push({
          metric: 'ApprovalDecisionLatencyMs',
          reason: 'missing_created_at',
        });
      } else {
        specs.push({
          name: 'ApprovalDecisionLatencyMs',
          unit: 'Milliseconds',
          value: latency,
          dimensions: { outcome: 'timed_out' },
        });
      }

      const effective = asNumber(md.effective_timeout_s);
      if (effective === null) {
        skipped.push({
          metric: 'TimedOutEffectiveTimeout',
          reason: 'missing_effective_timeout_s',
        });
      } else {
        specs.push({
          name: 'TimedOutEffectiveTimeout',
          unit: 'Seconds',
          value: effective,
          dimensions: { rule_id: normalizeRuleId(asStringArray(md.matching_rule_ids)) },
        });
        // CloudWatch does not aggregate a custom metric across dimensions: the roll-up over all rules is a metric of its own.
        specs.push({
          name: 'TimedOutEffectiveTimeout',
          unit: 'Seconds',
          value: effective,
          dimensions: {},
        });
      }
      break;
    }

    default:
      break;
  }

  return { specs, skipped };
}

function latencyMs(startIso: unknown, endIso: unknown): number | null {
  if (typeof startIso !== 'string' || typeof endIso !== 'string') return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  const delta = endMs - startMs;
  if (delta < 0) return null;
  return delta;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}
