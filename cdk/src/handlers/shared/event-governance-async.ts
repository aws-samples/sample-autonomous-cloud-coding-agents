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
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { createAsyncEventApproval } from './event-governance-approval';
import {
  buildPolicyDecisionMetadata,
  matchEventRules,
  parseEventRules,
  type EvaluableEvent,
} from './event-rule-evaluator';
import { logger } from './logger';
import type { EventRule, TaskRecord } from './types';
import { NUDGE_MAX_MESSAGE_LENGTH } from './types';
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

export async function loadTaskForGovernance(taskId: string): Promise<TaskRecord | undefined> {
  if (!TASK_TABLE) return undefined;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
    }));
    return result.Item as TaskRecord | undefined;
  } catch (err) {
    logger.warn('[event-governance] task load failed', {
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
    logger.warn('[event-governance] cancel_task skipped', {
      task_id: taskId,
      rule_id: rule.id,
      error: err instanceof Error ? err.message : String(err),
    });
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
    logger.warn('[event-governance] inject_nudge skipped', {
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
    if (name === 'ConditionalCheckFailedException') return false;
    logger.warn('[event-governance] idempotency claim failed — proceeding', {
      task_id: taskId,
      rule_id: ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

function escalateChannels(rule: EventRule): string[] {
  const base = rule.notify_channels ?? [];
  if (base.length > 0) return [...base];
  return ['email', 'slack'];
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

  const matched = matchEventRules(rules, event, {
    evaluation: 'async',
    aggregateState: ctx.aggregateState,
  });
  const notifyChannels: string[] = [];
  let forceFanOut = false;

  for (const rule of matched) {
    const corr = correlationId(event, rule);
    const claimed = await claimIdempotency(event.task_id, rule.id, corr);
    if (!claimed) continue;

    const enforce = rule.mode === 'enforce';
    const meta = buildPolicyDecisionMetadata(rule, event, enforce, corr);
    await emitPolicyDecision(event.task_id, { ...meta, correlation_id: corr });

    if (rule.action === 'observe_only' || (rule.action === 'require_approval' && !enforce)) {
      continue;
    }

    if (rule.action === 'notify' && rule.notify_channels) {
      notifyChannels.push(...rule.notify_channels);
      forceFanOut = true;
    }

    if (rule.action === 'escalate') {
      notifyChannels.push(...escalateChannels(rule));
      forceFanOut = true;
    }

    if (rule.action === 'inject_nudge' && enforce && task) {
      await injectNudgeByRule(task, rule, event.metadata);
    }

    if (rule.action === 'require_approval' && enforce && task) {
      await createAsyncEventApproval({
        task,
        rule,
        eventType: event.event_type,
        metadata: event.metadata,
      });
      forceFanOut = true;
    }

    if (rule.action === 'cancel_task' && enforce && task) {
      if (!TERMINAL_STATUSES.includes(task.status)) {
        await cancelTaskByRule(
          event.task_id,
          rule,
          rule.reason ?? `Event rule ${rule.id} triggered cancel_task`,
        );
      }
    }
  }

  return { notifyChannels: [...new Set(notifyChannels)], forceFanOut };
}

/** Test helper — retained for module tests (no-op; idempotency is durable). */
export function _resetGovernanceIdempotencyCache(): void {
  // no-op — durable idempotency uses TaskEventsTable markers
}
