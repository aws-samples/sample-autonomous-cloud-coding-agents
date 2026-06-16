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

function aggregateMatch(
  when: EventRule['when'],
  metadata: Readonly<Record<string, unknown>>,
  aggregateState?: AggregateState,
): boolean {
  const agg = when?.aggregate;
  if (!agg) return true;
  if (agg.cost_usd_gte !== undefined) {
    let cumulative = aggregateState?.cumulative_cost_usd;
    if (cumulative === undefined) {
      const raw = metadata.cumulative_cost_usd;
      cumulative = typeof raw === 'number' ? raw : Number(raw);
    }
    if (!Number.isFinite(cumulative)) return false;
    if (cumulative < agg.cost_usd_gte) return false;
  }
  if (agg.turn_count_gte !== undefined) {
    let turns = aggregateState?.turn_count;
    if (turns === undefined) {
      const raw = metadata.turn_count;
      turns = typeof raw === 'number' ? raw : Number(raw);
    }
    if (!Number.isFinite(turns)) return false;
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
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.on !== 'string') continue;
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
