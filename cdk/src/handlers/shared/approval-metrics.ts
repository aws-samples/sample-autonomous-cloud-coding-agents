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
 * Chunk 8b — pure EMF (Embedded Metric Format) builder for Cedar-HITL
 * approval metrics. Consumed by ``metrics-publisher-task-events.ts`` at
 * runtime; unit-tested in isolation without a Lambda harness.
 *
 * EMF spec reference:
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 *
 * Why hand-rolled instead of ``@aws-lambda-powertools/metrics``:
 *   - This is the first Cedar-HITL-bearing Lambda in the stack; adding
 *     the project's first Powertools dependency for a 3-metric surface
 *     is disproportionate. Powertools' lifecycle machinery (explicit
 *     ``addMetric`` / ``publishStoredMetrics`` / per-handler flush)
 *     earns its keep when a Lambda emits 10+ metrics or needs the
 *     decorator pattern; at this scale a pure ``buildEmfLine`` +
 *     ``process.stdout.write`` is simpler, fully testable, and keeps
 *     the dependency footprint tight.
 *   - The shape-correctness risk (malformed EMF silently drops the
 *     metric at CloudWatch extraction time — see Chunk 8 silent-failure
 *     adversarial finding H3) is addressed by the dedicated
 *     ``approval-metrics.test.ts`` schema tests below.
 *   - Revisit if Chunk 10 PR review pushes back or if a second
 *     EMF-emitting Lambda joins the stack.
 */

export const METRIC_NAMESPACE = 'ABCA/Cedar-HITL';

/**
 * Allowlist of milestone names the publisher will emit metrics for.
 * Filtering at the handler layer (NOT via the event-source-mapping
 * filter pattern alone) keeps the behavior observable — an unknown
 * milestone reaches the handler and can be explicitly counted as a
 * skip rather than silently dropped at the service layer.
 */
export const APPROVAL_METRIC_MILESTONES = new Set<string>([
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'approval_timed_out',
  'approval_timeout_capped',
  // Chunk 10 (full-branch review M1 + B2): safety-critical milestones
  // added to the metric allowlist after deploy-gate review revealed
  // they produced zero dashboard signal. ``approval_cap_exceeded`` +
  // ``approval_rate_limit_exceeded`` fire on the §12.9 caps the
  // system exists to enforce; ``approval_stranded`` is the reconciler
  // signal that an AWAITING_APPROVAL task was evicted before decision.
  // Without these, the most operationally-interesting failure modes
  // were invisible to §11.3 widgets.
  'approval_cap_exceeded',
  'approval_rate_limit_exceeded',
  'approval_stranded',
]);

/**
 * Valid values for the ``reason`` dimension on
 * ``ClippedApprovalCount`` per §11.3. Additional values are collapsed
 * to ``unknown`` so a future agent-side change that introduces a new
 * reason value can't silently inflate metric cardinality — an
 * observable ``unknown`` bucket forces the operator to notice.
 */
export const CLIP_REASON_VALUES = new Set<string>([
  'rule_annotation',
  'maxLifetime_ceiling',
  'runtime_jwt_ceiling',
]);

/**
 * ``rule_id`` dimension cardinality cap (adversarial finding H4):
 * ``matching_rule_ids`` is user-defined via blueprint rules. Emitting
 * every distinct rule id creates an unbounded custom-metric count at
 * ~$0.30/month per metric. The normalizer keeps the first
 * ``RULE_ID_ALLOWLIST`` matching value as-is and collapses every other
 * rule id to ``other``. Operators who need finer granularity extend
 * the allowlist explicitly — the cardinality growth becomes a deploy-
 * reviewed decision instead of a silent bill.
 *
 * Empty list collapses to ``none`` for the same observability reason
 * — ``approval_timed_out`` without any matching rule is a real case
 * (e.g. on a ``force_push_any`` match, the rule may have fired without
 * populating ``matching_rule_ids`` — historical shape pre-Chunk-8a).
 */
export const RULE_ID_ALLOWLIST = new Set<string>([
  'force_push_any',
  'write_credentials',
  'delete_branch',
  'rewrite_history',
  // Extend this allowlist carefully — each entry is a permanent custom
  // metric dimension value with ongoing CloudWatch cost. Grow when
  // operators need per-rule visibility; collapse to ``other`` otherwise.
]);

export function normalizeRuleId(ruleIds: readonly string[] | undefined): string {
  if (!ruleIds || ruleIds.length === 0) return 'none';
  for (const id of ruleIds) {
    if (RULE_ID_ALLOWLIST.has(id)) return id;
  }
  return 'other';
}

export function normalizeClipReason(reason: string | undefined): string {
  if (reason && CLIP_REASON_VALUES.has(reason)) return reason;
  return 'unknown';
}

/**
 * Normalize the ``outcome`` dimension for ``ApprovalDecisionLatencyMs``.
 * Source milestone → outcome dim value.
 */
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

/**
 * EMF metric definition — a single metric to include in the EMF
 * payload. One EMF log line can carry multiple metrics sharing the
 * same dimension set (which is why ``Metrics`` is a list in the EMF
 * spec), but for clarity + test friendliness the publisher emits one
 * EMF line per metric.
 */
export interface MetricSpec {
  readonly name: string;
  readonly unit: 'Count' | 'Seconds' | 'Milliseconds';
  readonly value: number;
  /**
   * Dimensions applied to the metric. Map of dimension name → value.
   * Empty map produces a namespace-level metric (no dimensions).
   */
  readonly dimensions: Readonly<Record<string, string>>;
}

/**
 * Build a single EMF log line for one metric. The caller is expected
 * to ``process.stdout.write(line + '\n')`` or ``console.log(line)``
 * (either works; CloudWatch parses each log line independently).
 *
 * Timestamp is milliseconds since epoch per the EMF spec. Passing the
 * event's original DDB ``timestamp`` (parsed to ms) gives
 * metrics-over-time that align with the real event clock rather than
 * Lambda invocation time — important when a batch of 100 records
 * spans a few seconds of stream lag.
 */
export function buildEmfLine(spec: MetricSpec, timestampMs: number): string {
  const dimensionNames = Object.keys(spec.dimensions);
  const emf: Record<string, unknown> = {
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: dimensionNames.length > 0 ? [dimensionNames] : [],
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
 * The result of classifying a parsed approval milestone into the set
 * of EMF metric lines the handler should emit.
 *
 * ``specs`` is the list of metrics to emit for this event.
 * ``skipped`` is populated when the event is recognized but one or
 * more metric branches had to skip due to missing schema fields — the
 * handler translates these into ``MetricEmitSkipped`` emits with a
 * ``reason`` dimension so the dashboard's gap becomes observable
 * rather than a silent zero.
 */
export interface ClassificationResult {
  readonly specs: readonly MetricSpec[];
  readonly skipped: readonly { metric: string; reason: string }[];
}

/**
 * Parsed approval-milestone event shape as seen by the publisher.
 * Only the fields this module cares about are typed; everything else
 * is passed through untouched.
 */
export interface ParsedApprovalEvent {
  readonly milestone: string;
  readonly eventTimestampIso: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Pure classifier: given a parsed approval-milestone event, return
 * the list of EMF metric specs to emit + a list of per-metric skip
 * reasons for branches whose input is missing.
 *
 * Hand-rolled instead of a dispatch-table because each milestone has
 * metric-specific field-resolution logic (latency computation for
 * granted/denied/timed_out uses ``created_at`` + ``decided_at`` / event
 * timestamp; ``timed_out`` additionally emits the breakdown
 * histogram). Keeping the branching explicit makes the "which metric
 * depends on which field" coupling visible at review time.
 *
 * Handler path: skip-and-log on missing schema fields (fallback-to-0
 * would poison percentile widgets; never do that here — see
 * ``MetricEmitSkipped`` per Chunk 8 silent-failure adversarial
 * finding B1).
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
      // outcome is non-null here per the switch arms.
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
      // §12.9 per-task cap hit — emit a simple counter so operators
      // can alarm on sustained cap pressure (suspicious retry loop
      // or mis-sized ``approval_gate_cap``). No dimensions: the cap
      // value is task-scoped and varies per blueprint; a dimension
      // on ``cap`` would shred cardinality without analytical value
      // (the dashboard question is "how often does any task hit?",
      // not "which cap value is hit most").
      specs.push({
        name: 'ApprovalCapExceededCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_rate_limit_exceeded':
      // §12.9 per-user per-minute rate limit hit. Separate metric
      // from cap-exceeded so operators can tell "one user spamming"
      // from "task sized too small for approval load." No
      // dimensions for the same cardinality reason — the
      // ``request_id`` in the event carries the per-user
      // correlation for ad-hoc log-insights investigation.
      specs.push({
        name: 'ApprovalRateLimitExceededCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_stranded':
      // Reconciler-emitted signal that an AWAITING_APPROVAL task
      // was evicted before the user decided. High operational
      // interest: a 100 % eviction spike under container churn
      // would otherwise look identical to "no approval traffic"
      // on the dashboard (B2 full-branch finding). Counter only —
      // the event metadata carries ``age_s`` + ``reason`` for
      // post-hoc log-insights analysis.
      specs.push({
        name: 'ApprovalStrandedCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      });
      break;

    case 'approval_timed_out': {
      // Latency uses created_at + the event's own timestamp as the
      // "decided at" — the agent-side timer fired at the event's DDB
      // write moment. This is the same equivalence the dashboard
      // documents (§11.3): "decided_at − created_at" where
      // decided_at for timed_out is the timer-fire moment.
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
      }
      break;
    }

    default:
      // Not in APPROVAL_METRIC_MILESTONES — handler filters upstream
      // so this branch is defensive only. An unexpected milestone is
      // a classification miss; counter emitted by the handler.
      break;
  }

  return { specs, skipped };
}

/**
 * Compute milliseconds between two ISO-8601 timestamps. Returns null
 * on any parse failure (missing field, malformed string, negative
 * delta — the last because a negative latency is a clock-skew
 * problem the dashboard shouldn't silently paper over).
 */
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
  // Filter to strings — defensively coerce in case an upstream bug
  // smuggled a non-string (shouldn't happen with DDB Streams NEW_IMAGE
  // since every attribute is typed, but cost is trivial).
  return v.filter((x): x is string => typeof x === 'string');
}
