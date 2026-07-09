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
 * Declarative event rule matching — parity with agent/src/event_governance/evaluator.py.
 */

import type { EventRule, EventRuleEvaluation, PolicyDecisionMetadata } from './event-governance-types';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';

export interface EvaluableEvent {
  readonly event_type: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly event_id?: string;
}

export interface AggregateState {
  readonly cumulative_cost_usd?: number;
  readonly turn_count?: number;
}

function eventName(event: EvaluableEvent): string {
  if (event.event_type === 'agent_milestone') {
    const milestone = event.metadata.milestone;
    if (typeof milestone === 'string') return milestone;
  }
  const checkpoint = event.metadata.checkpoint;
  if (typeof checkpoint === 'string') return checkpoint;
  return event.event_type;
}

function fieldsMatch(when: EventRule['when'], metadata: Readonly<Record<string, unknown>>): boolean {
  const expected = when?.fields;
  if (!expected) return true;
  for (const [key, want] of Object.entries(expected)) {
    if (metadata[key] !== want) return false;
  }
  return true;
}

/**
 * Canonical metadata field names for aggregate values, each with its accepted
 * aliases (base field a producer emits ↔ cumulative field the rule reads). The
 * evaluator normalizes here so producers emit ONE name and rules match without
 * every producer having to echo a duplicate alias. See #230.
 */
const AGGREGATE_FIELDS = {
  cost: ['cumulative_cost_usd', 'cost_usd'],
  turns: ['turn_count', 'turn'],
} as const;

/** First finite value among the metadata aliases, coerced from string/number. */
function readAggregate(
  metadata: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
): number | null {
  for (const key of aliases) {
    const n = coerceNumericOrNull(metadata[key] as number | string | null | undefined, { field: key }, logger);
    if (n !== null) return n;
  }
  return null;
}

function aggregateMatch(
  when: EventRule['when'],
  metadata: Readonly<Record<string, unknown>>,
  aggregateState?: AggregateState,
): boolean {
  const agg = when?.aggregate;
  if (!agg) return true;
  if (agg.cost_usd_gte !== undefined) {
    const cumulative = aggregateState?.cumulative_cost_usd ?? readAggregate(metadata, AGGREGATE_FIELDS.cost);
    if (cumulative === null || cumulative === undefined) return false;
    if (cumulative < agg.cost_usd_gte) return false;
  }
  if (agg.turn_count_gte !== undefined) {
    const turns = aggregateState?.turn_count ?? readAggregate(metadata, AGGREGATE_FIELDS.turns);
    if (turns === null || turns === undefined) return false;
    if (turns < agg.turn_count_gte) return false;
  }
  return true;
}

export function matchEventRules(
  rules: readonly EventRule[],
  event: EvaluableEvent,
  options?: {
    readonly evaluation?: EventRuleEvaluation;
    readonly aggregateState?: AggregateState;
  },
): EventRule[] {
  const name = eventName(event);
  return rules.filter((rule) => {
    if (rule.on !== name) return false;
    if (options?.evaluation !== undefined && rule.evaluation !== options.evaluation) return false;
    if (!fieldsMatch(rule.when, event.metadata)) return false;
    if (!aggregateMatch(rule.when, event.metadata, options?.aggregateState)) return false;
    return true;
  });
}

export function buildPolicyDecisionMetadata(
  rule: EventRule,
  event: EvaluableEvent,
  enforce: boolean,
  correlationIdOverride?: string,
): PolicyDecisionMetadata {
  const triggerMilestone = event.event_type === 'agent_milestone'
    ? String(event.metadata.milestone ?? '')
    : undefined;
  const checkpoint = typeof event.metadata.checkpoint === 'string'
    ? event.metadata.checkpoint
    : undefined;
  const wouldBlock = rule.action === 'require_approval' && rule.mode === 'enforce';
  let decision: PolicyDecisionMetadata['decision'] = 'observe';
  if (rule.action === 'require_approval') decision = 'require_approval';
  return {
    decision,
    source: 'event_rule',
    enforcement_mode: enforce ? 'enforce' : 'observe_only',
    rule_id: rule.id,
    rule_pack_id: rule.rule_pack_id,
    trigger_event_type: event.event_type,
    trigger_milestone: triggerMilestone,
    checkpoint,
    correlation_id: correlationIdOverride
      ?? `${event.event_type}:${rule.id}:${event.event_id ?? Date.now()}`,
    matching_rule_ids: [rule.id],
    reason: rule.reason ?? `Event rule ${rule.id} matched on ${rule.on}`,
    severity: rule.severity,
    timeout_s: rule.timeout_s,
    action: rule.action,
    would_block: wouldBlock,
  };
}

export function parseEventRules(raw: unknown): EventRule[] {
  if (!Array.isArray(raw)) return [];
  const out: EventRule[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      logger.warn('[event-governance] dropped malformed rule — not an object', { index });
      continue;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.on !== 'string') {
      // Fail loud: a dropped ceiling/approval rule means zero enforcement with no
      // other signal. Mirror the fail-loud stance the pack resolver takes (#230).
      logger.warn('[event-governance] dropped malformed rule — missing id/on', {
        index,
        id: typeof r.id === 'string' ? r.id : undefined,
      });
      continue;
    }
    out.push({
      id: r.id,
      on: r.on,
      when: r.when as EventRule['when'],
      action: (r.action as EventRule['action']) ?? 'observe_only',
      mode: (r.mode as EventRule['mode']) ?? 'observe_only',
      evaluation: (r.evaluation as EventRule['evaluation']) ?? 'sync',
      reason: typeof r.reason === 'string' ? r.reason : undefined,
      severity: r.severity as EventRule['severity'],
      timeout_s: typeof r.timeout_s === 'number' ? r.timeout_s : undefined,
      notify_channels: Array.isArray(r.notify_channels)
        ? r.notify_channels as EventRule['notify_channels']
        : undefined,
      rule_pack_id: typeof r.rule_pack_id === 'string' ? r.rule_pack_id : undefined,
    });
  }
  return out;
}
