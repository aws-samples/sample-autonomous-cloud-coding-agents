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
 * Async event governance actions invoked from FanOutConsumer (issue #230).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { createAsyncEventApproval } from './event-governance-approval';
import {
  buildPolicyDecisionMetadata,
  matchEventRules,
  parseEventRules,
  type AggregateState,
  type EvaluableEvent,
} from './event-rule-evaluator';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';
import { isRetryableInfraError } from './retryable-error';
import { NUDGE_MAX_MESSAGE_LENGTH, type EventRule, type TaskRecord } from './types';
import { computeTtlEpoch } from './validation';
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TASK_TABLE = process.env.TASK_TABLE_NAME;
const EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME;
const NUDGES_TABLE = process.env.NUDGES_TABLE_NAME;
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const NUDGE_RETENTION_DAYS = 30;
const NUDGE_RETENTION_SECONDS = NUDGE_RETENTION_DAYS * 86400;

/** Test seam — disable async governance without mocking an extra DDB GetItem. */
let eventGovernanceEnabled = true;

export function _setEventGovernanceEnabled(enabled: boolean): void {
  eventGovernanceEnabled = enabled;
}

export function isEventGovernanceEnabled(): boolean {
  return eventGovernanceEnabled;
}

export interface AsyncGovernanceContext {
  readonly task?: TaskRecord;
  readonly aggregateState?: { cumulative_cost_usd?: number; turn_count?: number };
}

export interface AsyncGovernanceResult {
  readonly notifyChannels: string[];
  readonly forceFanOut: boolean;
}

// Re-exported so existing importers/tests keep resolving it from this module;
// the canonical definition lives in ./retryable-error so the approval path can
// consume it without a circular import back into this module.
export { isRetryableInfraError };

export async function loadTaskForGovernance(taskId: string): Promise<TaskRecord | undefined> {
  if (!TASK_TABLE) return undefined;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
    }));
    return result.Item as TaskRecord | undefined;
  } catch (err) {
    // A throttle/5xx here would silently disable every ``&& task`` enforce
    // action (cancel_task, require_approval). Rethrow infra errors so the
    // fanout flags the record for retry; swallow only benign failures. See #230.
    if (isRetryableInfraError(err)) throw err;
    logger.warn('[event-governance] task load failed (non-retryable) — continuing', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function emitPolicyDecision(
  taskId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!EVENTS_TABLE) return;
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE,
    Item: {
      task_id: taskId,
      event_id: ulid(),
      event_type: 'policy_decision',
      timestamp: now,
      ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
      metadata,
    },
  }));
}

async function cancelTaskByRule(taskId: string, rule: EventRule, reason: string): Promise<void> {
  if (!TASK_TABLE) return;
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #status = :cancelled, updated_at = :now, completed_at = :now, error_message = :reason, status_created_at = :sca',
      ConditionExpression: 'attribute_exists(task_id) AND NOT #status IN (:s1, :s2, :s3, :s4)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': TaskStatus.CANCELLED,
        ':now': now,
        ':reason': reason,
        ':sca': `${TaskStatus.CANCELLED}#${now}`,
        ':s1': TaskStatus.COMPLETED,
        ':s2': TaskStatus.FAILED,
        ':s3': TaskStatus.CANCELLED,
        ':s4': TaskStatus.TIMED_OUT,
      },
    }));
    if (EVENTS_TABLE) {
      await ddb.send(new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          task_id: taskId,
          event_id: ulid(),
          event_type: 'task_cancelled',
          timestamp: now,
          ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
          metadata: { source: 'event_rule', rule_id: rule.id, reason },
        },
      }));
    }
  } catch (err) {
    const name = (err as { name?: string })?.name;
    // Benign: the task raced to a terminal status between loadTaskForGovernance
    // and this Update, so the climb-only ConditionExpression rejected it. The
    // task is already done/cancelled — nothing to enforce. Swallow (mirrors the
    // approval path) rather than parking the record in batchItemFailures forever.
    if (name === 'ConditionalCheckFailedException') {
      logger.info('[event-governance] cancel_task skipped — task already terminal', {
        task_id: taskId,
        rule_id: rule.id,
      });
      return;
    }
    // cancel_task IS the enforcement action ("cancel if cost exceeds $25"). A
    // throttle/5xx here must retry the record, not silently let the task run on
    // past its ceiling.
    if (isRetryableInfraError(err)) throw err;
    logger.error('[event-governance] cancel_task failed (non-retryable) — enforcement gap', {
      task_id: taskId,
      rule_id: rule.id,
      error_id: 'EVENT_GOV_CANCEL_FAILED',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function injectNudgeByRule(
  task: TaskRecord,
  rule: EventRule,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!NUDGES_TABLE) return;
  const message = rule.reason
    ?? `Event rule ${rule.id} injected steering at ${rule.on}`;
  const nudgeId = ulid();
  const now = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(new PutCommand({
      TableName: NUDGES_TABLE,
      Item: {
        task_id: task.task_id,
        nudge_id: nudgeId,
        user_id: task.user_id,
        message: message.slice(0, NUDGE_MAX_MESSAGE_LENGTH),
        created_at: now,
        consumed: false,
        ttl: nowEpoch + NUDGE_RETENTION_SECONDS,
        source: 'event_rule',
        rule_id: rule.id,
        event_type: metadata.milestone ?? rule.on,
      },
      ConditionExpression: 'attribute_not_exists(nudge_id)',
    }));
  } catch (err) {
    // The nudge row is keyed by a fresh ULID, so the attribute_not_exists guard
    // only ever fires on a genuine ULID collision (never) — any CCF here is
    // effectively an infra fault. Rethrow retryable errors so steering isn't
    // silently dropped on a transient blip.
    if (isRetryableInfraError(err)) throw err;
    logger.warn('[event-governance] inject_nudge skipped (non-retryable)', {
      task_id: task.task_id,
      rule_id: rule.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function correlationId(event: EvaluableEvent & { event_id?: string }, rule: EventRule): string {
  const base = event.event_id ?? `${event.event_type}:${Date.now()}`;
  return `${base}:${rule.id}`;
}

/** First finite value among the metadata aliases, coerced from string/number. */
function readAggregate(meta: Readonly<Record<string, unknown>>, aliases: readonly string[]): number | undefined {
  for (const key of aliases) {
    const n = coerceNumericOrNull(meta[key] as number | string | null | undefined, { field: key }, logger);
    if (n !== null) return n;
  }
  return undefined;
}

/**
 * Extract the incoming cumulative cost/turn from an event's metadata (#230).
 * Cost is sourced from ``agent_cost_update`` (SDK session ``total_cost_usd``),
 * turns from ``agent_turn`` (the ``result.turns`` AssistantMessage counter).
 * Each aggregate has exactly ONE producing event so the two turn counters the
 * SDK exposes (``result.turns`` vs ``num_turns``) never mix into one mark.
 */
function incomingAggregate(event: EvaluableEvent): { cost?: number; turns?: number } {
  const meta = event.metadata;
  const out: { cost?: number; turns?: number } = {};
  if (event.event_type === 'agent_cost_update') {
    out.cost = readAggregate(meta, ['cumulative_cost_usd', 'cost_usd']);
  }
  if (event.event_type === 'agent_turn') {
    out.turns = readAggregate(meta, ['turn_count', 'turn']);
  }
  return out;
}

/**
 * Bump the durable high-water marks on the TaskRecord and return the effective
 * aggregate state for rule evaluation (#230).
 *
 * The mark is a monotonic MAX (``if_not_exists`` + a ``<`` ConditionExpression),
 * NOT a cross-session sum. Two reasons max is the correct semantic here:
 *   1. Idempotency. The source is a DynamoDB stream with at-least-once delivery
 *      and partial-batch retries; a SUM would double-count on every replay,
 *      whereas re-applying a max is a no-op. A ceiling rule must not fire early
 *      because a batch was retried.
 *   2. A normal task is single-session (one ClaudeSDKClient per run_agent), so
 *      the SDK ``total_cost_usd`` / ``result.turns`` are already the true task
 *      totals; max just makes them durable across a container restart, where
 *      the per-session counter resets to 0.
 * ponytail: on a restart whose *second* session out-costs the first only in
 * aggregate (each session individually cheaper than the first), max under-counts
 * the true lifetime sum. The upgrade is per-session delta accounting keyed by
 * session_id — deferred until multi-session tasks are common, because it trades
 * the stream's free idempotency for a dedup table.
 *
 * Cost also seeds from the authoritative ``TaskRecord.cost_usd`` (written by the
 * agent's task_state terminal path) so a cost event that arrives without cost
 * metadata, or the first evaluation of an already-costed task, still counts.
 * On any DDB error we fall back to the resolved value so evaluation proceeds.
 */
async function persistAndResolveAggregate(
  taskId: string,
  event: EvaluableEvent,
  task: TaskRecord | undefined,
): Promise<AggregateState | undefined> {
  const incoming = incomingAggregate(event);
  // Authoritative task cost (may be a string from the DDB doc-client) is a floor
  // for the cost mark — bridges the gap the removed inline fallback used to fill.
  const taskCost = coerceNumericOrNull(
    task?.cost_usd as number | string | null | undefined,
    { field: 'cost_usd', task_id: taskId },
    logger,
  );
  if (incoming.cost === undefined && incoming.turns === undefined) {
    // Not a cost/turn event — use whatever is already persisted, seeded by
    // task.cost_usd so a ceiling can still trip on a non-cost event.
    if (!task) return undefined;
    const cost = Math.max(task.gov_cumulative_cost_usd ?? 0, taskCost ?? 0) || undefined;
    return { cumulative_cost_usd: cost ?? task.gov_cumulative_cost_usd, turn_count: task.gov_cumulative_turn_count };
  }

  const priorCost = Math.max(task?.gov_cumulative_cost_usd ?? 0, taskCost ?? 0);
  const priorTurns = task?.gov_cumulative_turn_count ?? 0;
  const resolvedCost = incoming.cost !== undefined ? Math.max(priorCost, incoming.cost) : priorCost || task?.gov_cumulative_cost_usd;
  const resolved: AggregateState = {
    cumulative_cost_usd: resolvedCost,
    turn_count: incoming.turns !== undefined ? Math.max(priorTurns, incoming.turns) : task?.gov_cumulative_turn_count,
  };

  if (!TASK_TABLE) return resolved;

  const sets: string[] = [];
  const conds: string[] = [];
  const values: Record<string, unknown> = {};
  if (incoming.cost !== undefined) {
    // Persist the resolved value (max of prior mark, task.cost_usd seed, and the
    // incoming reading) so the seed is durable, not just used for this eval.
    sets.push('gov_cumulative_cost_usd = :c');
    conds.push('(attribute_not_exists(gov_cumulative_cost_usd) OR gov_cumulative_cost_usd < :c)');
    values[':c'] = resolvedCost ?? incoming.cost;
  }
  if (incoming.turns !== undefined) {
    sets.push('gov_cumulative_turn_count = :t');
    conds.push('(attribute_not_exists(gov_cumulative_turn_count) OR gov_cumulative_turn_count < :t)');
    values[':t'] = incoming.turns;
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      // Only write when at least one mark climbs; a no-op (retry with equal or
      // lower value) fails the condition and is silently skipped.
      ConditionExpression: `attribute_exists(task_id) AND (${conds.join(' OR ')})`,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name !== 'ConditionalCheckFailedException') {
      // Rethrow throttles/5xx so the record is retried — otherwise the mark
      // fails to advance and a cost ceiling under-counts with no signal.
      if (isRetryableInfraError(err)) throw err;
      logger.warn('[event-governance] aggregate high-water update failed', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return resolved;
}

function idempotencyEventId(taskId: string, ruleId: string, corr: string): string {
  return `gov-idem#${taskId}#${ruleId}#${corr}`;
}

/** Durable idempotency via TaskEventsTable marker row. */
async function claimIdempotency(taskId: string, ruleId: string, corr: string): Promise<boolean> {
  if (!EVENTS_TABLE) return true;
  const eventId = idempotencyEventId(taskId, ruleId, corr);
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        task_id: taskId,
        event_id: eventId,
        event_type: 'governance_idempotency',
        timestamp: new Date().toISOString(),
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: { rule_id: ruleId, correlation_id: corr },
      },
      ConditionExpression: 'attribute_not_exists(event_id)',
    }));
    return true;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    // Marker already exists — a genuine duplicate delivery. Skip the rule.
    if (name === 'ConditionalCheckFailedException') return false;
    // A throttle/5xx on the claim itself must retry the whole record rather than
    // proceed: proceeding on an unclaimed marker risks double-firing a notify /
    // escalate (which are not conditional-safe) on the eventual retry (#230).
    if (isRetryableInfraError(err)) throw err;
    logger.warn('[event-governance] idempotency claim failed (non-retryable) — proceeding', {
      task_id: taskId,
      rule_id: ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** Delete the idempotency marker so a rethrown (retried) record can re-claim
 *  and re-run the enforcement action. Best-effort: if this delete is itself
 *  throttled the marker survives and the retry is a no-op (the action is lost),
 *  but that is strictly better than double-firing, and the enforce actions
 *  (cancel/approval) are themselves conditional so re-running is safe. */
async function releaseIdempotency(taskId: string, ruleId: string, corr: string): Promise<void> {
  if (!EVENTS_TABLE) return;
  try {
    await ddb.send(new DeleteCommand({
      TableName: EVENTS_TABLE,
      Key: { task_id: taskId, event_id: idempotencyEventId(taskId, ruleId, corr) },
    }));
  } catch (err) {
    logger.warn('[event-governance] idempotency release failed', {
      task_id: taskId,
      rule_id: ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Channels for a notify/escalate rule; falls back to a default so a rule with
 *  no ``notify_channels`` still delivers rather than silently doing nothing. */
function resolveChannels(rule: EventRule, fallback: string[]): string[] {
  const base = rule.notify_channels ?? [];
  return base.length > 0 ? [...base] : fallback;
}

/**
 * Evaluate async event rules for one stream record.
 */
export async function evaluateAsyncEventRules(
  event: EvaluableEvent & { task_id: string; event_id: string },
  ctx: AsyncGovernanceContext,
): Promise<AsyncGovernanceResult> {
  const task = ctx.task;
  const rules = parseEventRules(task?.event_rules);
  if (rules.length === 0) return { notifyChannels: [], forceFanOut: false };

  // Resolve aggregates against the durable high-water mark so ceiling rules
  // survive the per-session SDK cost/turn reset (#230). ``ctx.aggregateState``
  // (the caller's live reading) is the fallback when no durable value applies.
  const aggregateState = await persistAndResolveAggregate(event.task_id, event, task)
    ?? ctx.aggregateState;

  const matched = matchEventRules(rules, event, {
    evaluation: 'async',
    aggregateState,
  });
  const notifyChannels: string[] = [];
  let forceFanOut = false;

  for (const rule of matched) {
    const corr = correlationId(event, rule);
    const claimed = await claimIdempotency(event.task_id, rule.id, corr);
    if (!claimed) continue;

    const enforce = rule.mode === 'enforce';
    const meta = buildPolicyDecisionMetadata(rule, event, enforce, corr);

    // The audit emit AND the enforce action share one release-guarded try: the
    // idempotency marker is already claimed, so if EITHER throws a retryable
    // error we must release the marker before the record retries — otherwise the
    // retry re-claims false and the rule is skipped entirely, silently dropping
    // the audit record (observe_only) or the enforcement action (#230).
    try {
      await emitPolicyDecision(event.task_id, { ...meta, correlation_id: corr });

      // observe_only records the policy_decision above but must NOT fire the
      // action — the "would have fired" contract (design §8).
      if (enforce) {
        if (rule.action === 'notify') {
          notifyChannels.push(...resolveChannels(rule, ['slack']));
          forceFanOut = true;
        }

        if (rule.action === 'escalate') {
          notifyChannels.push(...resolveChannels(rule, ['email', 'slack']));
          forceFanOut = true;
        }

        if (rule.action === 'inject_nudge' && task) {
          await injectNudgeByRule(task, rule, event.metadata);
        }

        if (rule.action === 'require_approval' && task) {
          await createAsyncEventApproval({
            task,
            rule,
            eventType: event.event_type,
            metadata: event.metadata,
          });
          forceFanOut = true;
        }

        if (rule.action === 'cancel_task' && task && !TERMINAL_STATUSES.includes(task.status)) {
          await cancelTaskByRule(
            event.task_id,
            rule,
            rule.reason ?? `Event rule ${rule.id} triggered cancel_task`,
          );
        }
      }
    } catch (err) {
      await releaseIdempotency(event.task_id, rule.id, corr);
      throw err;
    }
  }

  return { notifyChannels: [...new Set(notifyChannels)], forceFanOut };
}

/** Test helper — retained for module tests (no-op; idempotency is durable). */
export function _resetGovernanceIdempotencyCache(): void {
  // no-op — durable idempotency uses TaskEventsTable markers
}
