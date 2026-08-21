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
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';
import {
  BUDGET_EXCEEDED_PERCENT,
  BUDGET_ROLLUP_PERIOD,
  BUDGET_WARNING_PERCENT,
  budgetPeriod,
  loadBudgetStates,
  MAX_BUDGET_SCOPES_PER_TASK,
  taskBudgetMarkerKey,
  teamBudgetScopeKey,
  userBudgetScopeKey,
} from './shared/budgets';
import { logger } from './shared/logger';
import { makeDocClient } from './shared/ua';
import { TERMINAL_STATUSES, type TaskStatusType } from '../constructs/task-status';

const BUDGET_TABLE_NAME = process.env.BUDGET_TABLE_NAME;
const BUDGET_METRIC_NAMESPACE = 'ABCA/Budgets';
const ROLLUP_RETENTION_DAYS = 400;
const SECONDS_PER_DAY = 24 * 60 * 60;
const TERMINAL = new Set<TaskStatusType>(TERMINAL_STATUSES);
const ddb = makeDocClient();

interface TaskCostEvent {
  readonly taskId: string;
  readonly userId: string;
  readonly teamIds: readonly string[];
  readonly period: string;
  readonly costUsd: number;
}

function numberAttribute(record: DynamoDBRecord, field: string): number | null {
  const attr = record.dynamodb?.NewImage?.[field];
  const value = attr?.N ?? attr?.S;
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTaskCostEvent(record: DynamoDBRecord): TaskCostEvent | null {
  if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') return null;
  const image = record.dynamodb?.NewImage;
  if (!image) return null;

  const status = image.status?.S as TaskStatusType | undefined;
  const taskId = image.task_id?.S;
  const userId = image.user_id?.S;
  const costUsd = numberAttribute(record, 'cost_usd');
  if (!status || !TERMINAL.has(status) || !taskId || !userId || costUsd === null || costUsd <= 0) {
    return null;
  }

  const teamIds = (image.team_ids?.L ?? [])
    .map(value => value.S)
    .filter((value): value is string => Boolean(value));
  const completedAt = image.completed_at?.S ?? image.updated_at?.S;
  const completedDate = completedAt ? new Date(completedAt) : new Date();
  const period = Number.isNaN(completedDate.getTime())
    ? budgetPeriod()
    : budgetPeriod(completedDate);

  return {
    taskId,
    userId,
    teamIds: [...new Set(teamIds)].sort(),
    period,
    costUsd,
  };
}

function ttlEpoch(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + (ROLLUP_RETENTION_DAYS * SECONDS_PER_DAY);
}

function isTransactionCanceled(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'TransactionCanceledException';
}

function isConditionalCheckFailed(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

async function markerExists(taskId: string): Promise<boolean> {
  if (!BUDGET_TABLE_NAME) return false;
  const result = await ddb.send(new GetCommand({
    TableName: BUDGET_TABLE_NAME,
    Key: {
      scope_key: taskBudgetMarkerKey(taskId),
      period: BUDGET_ROLLUP_PERIOD,
    },
    ConsistentRead: true,
  }));
  return result.Item !== undefined;
}

async function writeRollup(evt: TaskCostEvent): Promise<boolean> {
  if (!BUDGET_TABLE_NAME) return false;
  const scopeKeys = [
    userBudgetScopeKey(evt.userId),
    ...evt.teamIds.map(teamBudgetScopeKey),
  ];
  if (scopeKeys.length > MAX_BUDGET_SCOPES_PER_TASK) {
    throw new Error(
      `Task ${evt.taskId} has ${scopeKeys.length} budget scopes; maximum is `
      + `${MAX_BUDGET_SCOPES_PER_TASK}.`,
    );
  }

  const now = new Date().toISOString();
  const ttl = ttlEpoch();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: BUDGET_TABLE_NAME,
            Item: {
              scope_key: taskBudgetMarkerKey(evt.taskId),
              period: BUDGET_ROLLUP_PERIOD,
              task_id: evt.taskId,
              rolled_up_period: evt.period,
              cost_usd: evt.costUsd,
              created_at: now,
              ttl,
            },
            ConditionExpression: 'attribute_not_exists(scope_key)',
          },
        },
        ...scopeKeys.map(scopeKey => ({
          Update: {
            TableName: BUDGET_TABLE_NAME,
            Key: { scope_key: scopeKey, period: evt.period },
            UpdateExpression:
              'SET updated_at = :now, #ttl = :ttl '
              + 'ADD spend_usd :cost, task_count :one',
            ExpressionAttributeNames: {
              '#ttl': 'ttl',
            },
            ExpressionAttributeValues: {
              ':now': now,
              ':ttl': ttl,
              ':cost': evt.costUsd,
              ':one': 1,
            },
          },
        })),
      ],
    }));
    return true;
  } catch (err) {
    if (isTransactionCanceled(err) && await markerExists(evt.taskId)) {
      logger.info('Budget rollup already applied', { task_id: evt.taskId });
      return false;
    }
    throw err;
  }
}

function emitThresholdMetric(
  threshold: number,
  state: Awaited<ReturnType<typeof loadBudgetStates>>[number],
): void {
  process.stdout.write(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: BUDGET_METRIC_NAMESPACE,
        Dimensions: [['Threshold']],
        Metrics: [{ Name: 'BudgetThresholdCrossed', Unit: 'Count' }],
      }],
    },
    Threshold: String(threshold),
    BudgetThresholdCrossed: 1,
    scope_type: state.scopeType,
    scope_id: state.scopeId,
    period: state.period,
    spend_usd: state.spendUsd,
    monthly_limit_usd: state.monthlyLimitUsd,
    utilization_percent: state.utilizationPercent,
    hard_stop: state.hardStop,
  }) + '\n');
}

async function claimAndEmitAlert(
  threshold: typeof BUDGET_WARNING_PERCENT | typeof BUDGET_EXCEEDED_PERCENT,
  state: Awaited<ReturnType<typeof loadBudgetStates>>[number],
): Promise<void> {
  if (!BUDGET_TABLE_NAME || state.utilizationPercent < threshold) return;
  const suffix = String(threshold);
  try {
    await ddb.send(new UpdateCommand({
      TableName: BUDGET_TABLE_NAME,
      Key: { scope_key: state.scopeKey, period: state.period },
      UpdateExpression:
        `SET alerted_${suffix}_at = :now, `
        + `alerted_${suffix}_spend_usd = :spend, `
        + `alerted_${suffix}_limit_usd = :limit`,
      ConditionExpression: `attribute_not_exists(alerted_${suffix}_at)`,
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':spend': state.spendUsd,
        ':limit': state.monthlyLimitUsd,
      },
    }));
    emitThresholdMetric(threshold, state);
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

/** Apply one terminal TaskTable stream record to monthly budget rollups. */
export async function rollupTaskCost(record: DynamoDBRecord): Promise<boolean> {
  if (!BUDGET_TABLE_NAME) return false;
  const evt = parseTaskCostEvent(record);
  if (!evt) return false;
  const wrote = await writeRollup(evt);

  const scopeKeys = [
    userBudgetScopeKey(evt.userId),
    ...evt.teamIds.map(teamBudgetScopeKey),
  ];
  const states = await loadBudgetStates(scopeKeys, evt.period);
  for (const state of states) {
    await claimAndEmitAlert(BUDGET_WARNING_PERCENT, state);
    await claimAndEmitAlert(BUDGET_EXCEEDED_PERCENT, state);
  }
  return wrote;
}
