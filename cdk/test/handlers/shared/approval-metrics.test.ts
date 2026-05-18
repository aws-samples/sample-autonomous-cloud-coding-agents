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

import {
  APPROVAL_METRIC_MILESTONES,
  METRIC_NAMESPACE,
  buildEmfLine,
  classifyApprovalEvent,
  normalizeClipReason,
  normalizeRuleId,
  outcomeFromMilestone,
} from '../../../src/handlers/shared/approval-metrics';

describe('approval-metrics: normalizeRuleId', () => {
  test('returns allowlisted rule id verbatim', () => {
    expect(normalizeRuleId(['force_push_any'])).toBe('force_push_any');
    expect(normalizeRuleId(['write_credentials'])).toBe('write_credentials');
  });

  test('collapses unknown rule ids to "other"', () => {
    expect(normalizeRuleId(['user_custom_rule_42'])).toBe('other');
  });

  test('takes the first allowlisted rule when multiple match', () => {
    // Deterministic cardinality cap — the first match wins so a rule's
    // dimension bucket doesn't flip based on Cedar evaluation order.
    expect(normalizeRuleId(['write_credentials', 'force_push_any'])).toBe('write_credentials');
  });

  test('returns "other" when no entry is allowlisted', () => {
    expect(normalizeRuleId(['user_custom_a', 'user_custom_b'])).toBe('other');
  });

  test('returns "none" for empty array', () => {
    expect(normalizeRuleId([])).toBe('none');
  });

  test('returns "none" for undefined', () => {
    expect(normalizeRuleId(undefined)).toBe('none');
  });
});

describe('approval-metrics: normalizeClipReason', () => {
  test('returns valid reason verbatim', () => {
    expect(normalizeClipReason('rule_annotation')).toBe('rule_annotation');
    expect(normalizeClipReason('maxLifetime_ceiling')).toBe('maxLifetime_ceiling');
    expect(normalizeClipReason('runtime_jwt_ceiling')).toBe('runtime_jwt_ceiling');
  });

  test('collapses unknown reason to "unknown"', () => {
    expect(normalizeClipReason('mystery')).toBe('unknown');
  });

  test('undefined reason yields "unknown"', () => {
    expect(normalizeClipReason(undefined)).toBe('unknown');
  });
});

describe('approval-metrics: outcomeFromMilestone', () => {
  test.each([
    ['approval_granted', 'approved'],
    ['approval_denied', 'denied'],
    ['approval_timed_out', 'timed_out'],
  ])('%s → %s', (milestone, expected) => {
    expect(outcomeFromMilestone(milestone)).toBe(expected);
  });

  test('returns null for non-outcome milestone', () => {
    expect(outcomeFromMilestone('approval_requested')).toBeNull();
    expect(outcomeFromMilestone('approval_timeout_capped')).toBeNull();
  });
});

describe('approval-metrics: APPROVAL_METRIC_MILESTONES allowlist', () => {
  test('contains all 8 supported milestones', () => {
    // Guard against accidental renames that would silently remove a
    // milestone from the dashboard. Chunk 10 full-branch review
    // expanded this allowlist with 3 safety-critical milestones
    // (cap / rate-limit / stranded) that had been producing zero
    // dashboard signal — keep the size assertion strict so a
    // future refactor dropping one is caught.
    expect(APPROVAL_METRIC_MILESTONES.has('approval_requested')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_granted')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_denied')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_timed_out')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_timeout_capped')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_cap_exceeded')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_rate_limit_exceeded')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.has('approval_stranded')).toBe(true);
    expect(APPROVAL_METRIC_MILESTONES.size).toBe(8);
  });
});

describe('approval-metrics: buildEmfLine', () => {
  test('emits a valid EMF JSON line with timestamp + namespace + metric value', () => {
    const line = buildEmfLine(
      {
        name: 'ApprovalRequestCount',
        unit: 'Count',
        value: 1,
        dimensions: {},
      },
      1_700_000_000_000,
    );

    const parsed = JSON.parse(line);
    expect(parsed._aws.Timestamp).toBe(1_700_000_000_000);
    expect(parsed._aws.CloudWatchMetrics).toHaveLength(1);
    const emf = parsed._aws.CloudWatchMetrics[0];
    expect(emf.Namespace).toBe(METRIC_NAMESPACE);
    expect(emf.Metrics).toEqual([{ Name: 'ApprovalRequestCount', Unit: 'Count' }]);
    expect(parsed.ApprovalRequestCount).toBe(1);
  });

  test('emits dimension list when dimensions are present', () => {
    const line = buildEmfLine(
      {
        name: 'ClippedApprovalCount',
        unit: 'Count',
        value: 1,
        dimensions: { reason: 'rule_annotation' },
      },
      1_700_000_000_000,
    );

    const parsed = JSON.parse(line);
    const emf = parsed._aws.CloudWatchMetrics[0];
    // Dimension names are grouped into one set per metric.
    expect(emf.Dimensions).toEqual([['reason']]);
    expect(parsed.reason).toBe('rule_annotation');
    expect(parsed.ClippedApprovalCount).toBe(1);
  });

  test('emits empty dimensions list when no dimensions', () => {
    const line = buildEmfLine(
      {
        name: 'MetricsPublisherHeartbeat',
        unit: 'Count',
        value: 1,
        dimensions: {},
      },
      1_700_000_000_000,
    );

    const parsed = JSON.parse(line);
    expect(parsed._aws.CloudWatchMetrics[0].Dimensions).toEqual([]);
  });
});

describe('approval-metrics: classifyApprovalEvent', () => {
  // Use a fixed time pair: request at T+0, decision at T+5s (5000ms)
  const CREATED_AT = '2026-05-08T12:00:00.000Z';
  const DECIDED_AT = '2026-05-08T12:00:05.000Z';

  test('approval_requested → ApprovalRequestCount=1 (no dims)', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_requested',
      eventTimestampIso: CREATED_AT,
      metadata: { request_id: 'r-1' },
    });
    expect(result.skipped).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].name).toBe('ApprovalRequestCount');
    expect(result.specs[0].value).toBe(1);
    expect(result.specs[0].unit).toBe('Count');
    expect(result.specs[0].dimensions).toEqual({});
  });

  test('approval_timeout_capped → ClippedApprovalCount with reason dim', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_timeout_capped',
      eventTimestampIso: CREATED_AT,
      metadata: { request_id: 'r-1', reason: 'rule_annotation' },
    });
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].name).toBe('ClippedApprovalCount');
    expect(result.specs[0].dimensions).toEqual({ reason: 'rule_annotation' });
  });

  test('approval_timeout_capped with unknown reason collapses to "unknown" dim', () => {
    // Keeps cardinality bounded when agent-side code adds a new reason
    // value the dashboard doesn't know about yet.
    const result = classifyApprovalEvent({
      milestone: 'approval_timeout_capped',
      eventTimestampIso: CREATED_AT,
      metadata: { request_id: 'r-1', reason: 'new_reason_value' },
    });
    expect(result.specs[0].dimensions).toEqual({ reason: 'unknown' });
  });

  test('approval_granted with both timestamps → ApprovalDecisionLatencyMs=5000 (ms), outcome=approved', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_granted',
      eventTimestampIso: DECIDED_AT,
      metadata: { request_id: 'r-1', created_at: CREATED_AT, decided_at: DECIDED_AT },
    });
    expect(result.skipped).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].name).toBe('ApprovalDecisionLatencyMs');
    expect(result.specs[0].value).toBe(5000);
    expect(result.specs[0].unit).toBe('Milliseconds');
    expect(result.specs[0].dimensions).toEqual({ outcome: 'approved' });
  });

  test('approval_denied with both timestamps → ApprovalDecisionLatencyMs, outcome=denied', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_denied',
      eventTimestampIso: DECIDED_AT,
      metadata: { request_id: 'r-1', created_at: CREATED_AT, decided_at: DECIDED_AT },
    });
    expect(result.specs[0].dimensions).toEqual({ outcome: 'denied' });
  });

  test('approval_granted missing created_at → skip, not emit value=0', () => {
    // Critical: a silently-emitted latency=0 would poison the p50/p90
    // percentile widgets. Chunk 8 silent-failure adversarial finding
    // B1 / H2 / M3 require explicit skip-and-log on schema mismatch.
    const result = classifyApprovalEvent({
      milestone: 'approval_granted',
      eventTimestampIso: DECIDED_AT,
      metadata: { request_id: 'r-1', decided_at: DECIDED_AT },
    });
    expect(result.specs).toHaveLength(0);
    expect(result.skipped).toEqual([
      { metric: 'ApprovalDecisionLatencyMs', reason: 'missing_created_at_or_decided_at' },
    ]);
  });

  test('approval_granted missing decided_at → skip', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_granted',
      eventTimestampIso: DECIDED_AT,
      metadata: { request_id: 'r-1', created_at: CREATED_AT },
    });
    expect(result.specs).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  test('approval_granted with negative latency (clock skew) → skip', () => {
    // decided_at BEFORE created_at is a clock-skew / replay bug; emit-0
    // would be wrong. Skip and log instead.
    const result = classifyApprovalEvent({
      milestone: 'approval_granted',
      eventTimestampIso: CREATED_AT,
      metadata: { request_id: 'r-1', created_at: DECIDED_AT, decided_at: CREATED_AT },
    });
    expect(result.specs).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  test('approval_timed_out with all fields → latency + breakdown', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_timed_out',
      eventTimestampIso: DECIDED_AT,
      metadata: {
        request_id: 'r-1',
        created_at: CREATED_AT,
        effective_timeout_s: 30,
        matching_rule_ids: ['force_push_any'],
      },
    });
    expect(result.skipped).toEqual([]);
    expect(result.specs).toHaveLength(2);
    const byName = new Map(result.specs.map((s) => [s.name, s]));
    expect(byName.get('ApprovalDecisionLatencyMs')?.value).toBe(5000);
    expect(byName.get('ApprovalDecisionLatencyMs')?.dimensions).toEqual({ outcome: 'timed_out' });
    expect(byName.get('TimedOutEffectiveTimeout')?.value).toBe(30);
    expect(byName.get('TimedOutEffectiveTimeout')?.unit).toBe('Seconds');
    expect(byName.get('TimedOutEffectiveTimeout')?.dimensions).toEqual({ rule_id: 'force_push_any' });
  });

  test('approval_timed_out with unknown rule_id collapses to "other"', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_timed_out',
      eventTimestampIso: DECIDED_AT,
      metadata: {
        request_id: 'r-1',
        created_at: CREATED_AT,
        effective_timeout_s: 30,
        matching_rule_ids: ['user_custom_rule'],
      },
    });
    const breakdown = result.specs.find((s) => s.name === 'TimedOutEffectiveTimeout');
    expect(breakdown?.dimensions).toEqual({ rule_id: 'other' });
  });

  test('approval_timed_out with empty matching_rule_ids → rule_id=none', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_timed_out',
      eventTimestampIso: DECIDED_AT,
      metadata: {
        request_id: 'r-1',
        created_at: CREATED_AT,
        effective_timeout_s: 30,
        matching_rule_ids: [],
      },
    });
    const breakdown = result.specs.find((s) => s.name === 'TimedOutEffectiveTimeout');
    expect(breakdown?.dimensions).toEqual({ rule_id: 'none' });
  });

  test('approval_timed_out missing effective_timeout_s → latency emits, breakdown skips', () => {
    // Partial-superset handling: one metric branch's input is
    // present, the other isn't. Emit what we can, skip what we can't.
    const result = classifyApprovalEvent({
      milestone: 'approval_timed_out',
      eventTimestampIso: DECIDED_AT,
      metadata: {
        request_id: 'r-1',
        created_at: CREATED_AT,
        matching_rule_ids: ['force_push_any'],
      },
    });
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].name).toBe('ApprovalDecisionLatencyMs');
    expect(result.skipped).toEqual([
      { metric: 'TimedOutEffectiveTimeout', reason: 'missing_effective_timeout_s' },
    ]);
  });

  test('approval_timed_out missing created_at → breakdown emits, latency skips', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_timed_out',
      eventTimestampIso: DECIDED_AT,
      metadata: {
        request_id: 'r-1',
        effective_timeout_s: 30,
        matching_rule_ids: ['force_push_any'],
      },
    });
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].name).toBe('TimedOutEffectiveTimeout');
    expect(result.skipped).toEqual([
      { metric: 'ApprovalDecisionLatencyMs', reason: 'missing_created_at' },
    ]);
  });

  test('approval_timed_out with effective_timeout_s=0 is valid (emits 0)', () => {
    // 0 is a legitimate effective timeout (degenerate rule annotation
    // clipping to 0). Number.isFinite check must not reject it.
    const result = classifyApprovalEvent({
      milestone: 'approval_timed_out',
      eventTimestampIso: DECIDED_AT,
      metadata: {
        request_id: 'r-1',
        created_at: CREATED_AT,
        effective_timeout_s: 0,
        matching_rule_ids: ['force_push_any'],
      },
    });
    const breakdown = result.specs.find((s) => s.name === 'TimedOutEffectiveTimeout');
    expect(breakdown?.value).toBe(0);
  });

  test('unknown milestone → empty result (classification miss)', () => {
    // Handler upstream filters to APPROVAL_METRIC_MILESTONES, but
    // the classifier must still cope with an unexpected milestone
    // without throwing. ``approval_late_win`` is not in the
    // allowlist (future work per full-branch review) so it reaches
    // the default branch even if handed to the classifier directly.
    const result = classifyApprovalEvent({
      milestone: 'approval_late_win',
      eventTimestampIso: DECIDED_AT,
      metadata: {},
    });
    expect(result.specs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  // --- Chunk 10: safety-critical milestones added after full-branch review

  test('approval_cap_exceeded → ApprovalCapExceededCount (no dims)', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_cap_exceeded',
      eventTimestampIso: CREATED_AT,
      metadata: { request_id: 'r-1', count: 51, cap: 50 },
    });
    expect(result.skipped).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].name).toBe('ApprovalCapExceededCount');
    expect(result.specs[0].value).toBe(1);
    expect(result.specs[0].dimensions).toEqual({});
  });

  test('approval_rate_limit_exceeded → ApprovalRateLimitExceededCount (no dims)', () => {
    const result = classifyApprovalEvent({
      milestone: 'approval_rate_limit_exceeded',
      eventTimestampIso: CREATED_AT,
      metadata: { request_id: 'r-1', rate: 11, limit: 10 },
    });
    expect(result.specs[0].name).toBe('ApprovalRateLimitExceededCount');
    expect(result.specs[0].value).toBe(1);
  });

  test('approval_stranded → ApprovalStrandedCount (no dims)', () => {
    // Reconciler-emitted: an AWAITING_APPROVAL task was evicted
    // before the user decided. Critical dashboard signal that was
    // invisible pre-Chunk-10 (B2 full-branch finding).
    const result = classifyApprovalEvent({
      milestone: 'approval_stranded',
      eventTimestampIso: CREATED_AT,
      metadata: { age_s: 7300, reason: 'STRANDED_NO_HEARTBEAT' },
    });
    expect(result.specs[0].name).toBe('ApprovalStrandedCount');
    expect(result.specs[0].value).toBe(1);
  });
});
