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
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { makeDocClient } from './ua';

const CONFIG_PERIOD = 'CONFIG';
const CONFIG_RECORD_TYPE = 'CONFIG';
const CONFIG_INDEX_NAME = 'record_type-scope_key-index';
const USER_PREFIX = 'USER#';
const TEAM_PREFIX = 'TEAM#';
const BATCH_GET_LIMIT = 100;
const ROLLUP_RETENTION_DAYS = 400;
const SECONDS_PER_DAY = 24 * 60 * 60;

export type BudgetScopeType = 'user' | 'team';

export interface BudgetScope {
  readonly type: BudgetScopeType;
  readonly id: string;
}

export interface BudgetStatus {
  readonly scope_type: BudgetScopeType;
  readonly scope_id: string;
  readonly period: string;
  readonly monthly_limit_usd: number;
  readonly spend_usd: number;
  readonly remaining_usd: number;
  readonly utilization_percent: number;
  readonly hard_stop: boolean;
  readonly hard_stop_active: boolean;
  readonly updated_at: string | null;
}

export function currentBudgetPeriod(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function budgetScopeKey(scope: BudgetScope): string {
  return `${scope.type === 'user' ? USER_PREFIX : TEAM_PREFIX}${scope.id}`;
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function ttlEpoch(now: Date): number {
  return Math.floor(now.getTime() / 1000) + (ROLLUP_RETENTION_DAYS * SECONDS_PER_DAY);
}

function toStatus(
  config: Record<string, unknown>,
  spend: Record<string, unknown> | undefined,
  period: string,
): BudgetStatus {
  const monthlyLimitUsd = numeric(config.monthly_limit_usd);
  const spendUsd = Math.max(0, numeric(spend?.spend_usd));
  const utilizationPercent = monthlyLimitUsd > 0
    ? (spendUsd / monthlyLimitUsd) * 100
    : 0;
  const hardStop = config.hard_stop === true;
  return {
    scope_type: config.scope_type === 'team' ? 'team' : 'user',
    scope_id: String(config.scope_id),
    period,
    monthly_limit_usd: monthlyLimitUsd,
    spend_usd: spendUsd,
    remaining_usd: Math.max(0, monthlyLimitUsd - spendUsd),
    utilization_percent: utilizationPercent,
    hard_stop: hardStop,
    hard_stop_active: hardStop && utilizationPercent >= 100,
    updated_at: typeof config.updated_at === 'string' ? config.updated_at : null,
  };
}

export async function setMonthlyBudget(
  region: string,
  tableName: string,
  scope: BudgetScope,
  monthlyLimitUsd: number,
  hardStop: boolean,
  now: Date = new Date(),
): Promise<void> {
  const ddb = makeDocClient({ region });
  const scopeKey = budgetScopeKey(scope);
  const period = currentBudgetPeriod(now);
  const updatedAt = now.toISOString();
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            scope_key: scopeKey,
            period: CONFIG_PERIOD,
            record_type: CONFIG_RECORD_TYPE,
            scope_type: scope.type,
            scope_id: scope.id,
            monthly_limit_usd: monthlyLimitUsd,
            hard_stop: hardStop,
            updated_at: updatedAt,
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { scope_key: scopeKey, period },
          UpdateExpression:
            'SET scope_type = :scopeType, scope_id = :scopeId, updated_at = :updatedAt, ttl = :ttl '
            + 'REMOVE alerted_80_at, alerted_80_spend_usd, alerted_80_limit_usd, '
            + 'alerted_100_at, alerted_100_spend_usd, alerted_100_limit_usd',
          ExpressionAttributeValues: {
            ':scopeType': scope.type,
            ':scopeId': scope.id,
            ':updatedAt': updatedAt,
            ':ttl': ttlEpoch(now),
          },
        },
      },
    ],
  }));
}

async function loadConfigs(
  region: string,
  tableName: string,
  scope?: BudgetScope,
): Promise<Record<string, unknown>[]> {
  const ddb = makeDocClient({ region });
  if (scope) {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: {
        scope_key: budgetScopeKey(scope),
        period: CONFIG_PERIOD,
      },
      ConsistentRead: true,
    }));
    return result.Item ? [result.Item] : [];
  }

  const rows: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: CONFIG_INDEX_NAME,
      KeyConditionExpression: 'record_type = :config',
      ExpressionAttributeValues: { ':config': CONFIG_RECORD_TYPE },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    rows.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

async function batchGetSpend(
  region: string,
  tableName: string,
  scopeKeys: readonly string[],
  period: string,
): Promise<Map<string, Record<string, unknown>>> {
  const ddb = makeDocClient({ region });
  const rows = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < scopeKeys.length; offset += BATCH_GET_LIMIT) {
    let pendingKeys = scopeKeys
      .slice(offset, offset + BATCH_GET_LIMIT)
      .map(scopeKey => ({ scope_key: scopeKey, period }));
    do {
      const result = await ddb.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: pendingKeys,
            ConsistentRead: true,
          },
        },
      }));
      for (const item of result.Responses?.[tableName] ?? []) {
        rows.set(String(item.scope_key), item);
      }
      pendingKeys = (result.UnprocessedKeys?.[tableName]?.Keys ?? [])
        .map(key => ({
          scope_key: String(key.scope_key),
          period: String(key.period),
        }));
    } while (pendingKeys.length > 0);
  }
  return rows;
}

export async function listBudgetStatus(
  region: string,
  tableName: string,
  scope?: BudgetScope,
  now: Date = new Date(),
): Promise<BudgetStatus[]> {
  const period = currentBudgetPeriod(now);
  const configs = await loadConfigs(region, tableName, scope);
  const spendByScope = await batchGetSpend(
    region,
    tableName,
    configs.map(config => String(config.scope_key)),
    period,
  );
  return configs
    .map(config => toStatus(config, spendByScope.get(String(config.scope_key)), period))
    .sort((a, b) =>
      a.scope_type.localeCompare(b.scope_type) || a.scope_id.localeCompare(b.scope_id));
}
