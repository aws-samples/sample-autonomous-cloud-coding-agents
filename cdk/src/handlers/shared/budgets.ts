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
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import type { PersonalBudgetStatus } from './types';
import { makeClient, makeDocClient } from './ua';

export const BUDGET_CONFIG_PERIOD = 'CONFIG';
export const BUDGET_ROLLUP_PERIOD = 'ROLLUP';
export const BUDGET_USER_PREFIX = 'USER#';
export const BUDGET_TEAM_PREFIX = 'TEAM#';
export const BUDGET_TASK_PREFIX = 'TASK#';
export const BUDGET_WARNING_PERCENT = 80;
export const BUDGET_EXCEEDED_PERCENT = 100;

/** DynamoDB transactions allow 100 actions; reserve one for the task marker. */
export const MAX_BUDGET_SCOPES_PER_TASK = 99;

const BATCH_GET_LIMIT = 100;
const budgetTableName = process.env.BUDGET_TABLE_NAME;
const userPoolId = process.env.USER_POOL_ID;
const ddb = makeDocClient();
const cognito = budgetTableName && userPoolId
  ? makeClient(CognitoIdentityProviderClient)
  : undefined;

export type BudgetScopeType = 'user' | 'team';

export interface BudgetConfig {
  readonly scopeKey: string;
  readonly scopeType: BudgetScopeType;
  readonly scopeId: string;
  readonly monthlyLimitUsd: number;
  readonly hardStop: boolean;
  readonly updatedAt?: string;
}

export interface BudgetState extends BudgetConfig {
  readonly period: string;
  readonly spendUsd: number;
  readonly utilizationPercent: number;
}

export interface BudgetBlock {
  readonly scopeType: BudgetScopeType;
  readonly scopeId: string;
  readonly spendUsd: number;
  readonly monthlyLimitUsd: number;
}

export interface BudgetAdmissionResult {
  readonly teamIds: readonly string[];
  readonly period: string;
  readonly blocked: BudgetBlock | null;
}

export function budgetPeriod(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function budgetResetAt(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

export function userBudgetScopeKey(userId: string): string {
  return `${BUDGET_USER_PREFIX}${userId}`;
}

export function teamBudgetScopeKey(teamId: string): string {
  return `${BUDGET_TEAM_PREFIX}${teamId}`;
}

export function taskBudgetMarkerKey(taskId: string): string {
  return `${BUDGET_TASK_PREFIX}${taskId}`;
}

export function parseBudgetScopeKey(scopeKey: string): {
  scopeType: BudgetScopeType;
  scopeId: string;
} | null {
  if (scopeKey.startsWith(BUDGET_USER_PREFIX)) {
    return { scopeType: 'user', scopeId: scopeKey.slice(BUDGET_USER_PREFIX.length) };
  }
  if (scopeKey.startsWith(BUDGET_TEAM_PREFIX)) {
    return { scopeType: 'team', scopeId: scopeKey.slice(BUDGET_TEAM_PREFIX.length) };
  }
  return null;
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function resolveTeamIds(userId: string): Promise<string[]> {
  if (!userPoolId || !cognito) {
    throw new Error('Budget admission requires USER_POOL_ID when team IDs are not supplied by the caller.');
  }

  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: userId,
      NextToken: nextToken,
    }));
    for (const group of result.Groups ?? []) {
      if (group.GroupName) names.push(group.GroupName);
    }
    nextToken = result.NextToken;
  } while (nextToken);

  return [...new Set(names)].sort();
}

async function batchGetItems(keys: readonly Record<string, string>[]): Promise<Record<string, unknown>[]> {
  if (!budgetTableName || keys.length === 0) return [];

  const items: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += BATCH_GET_LIMIT) {
    let pendingKeys: Record<string, string>[] = keys.slice(offset, offset + BATCH_GET_LIMIT);
    do {
      const result = await ddb.send(new BatchGetCommand({
        RequestItems: {
          [budgetTableName]: {
            Keys: pendingKeys,
            ConsistentRead: true,
          },
        },
      }));
      items.push(...(result.Responses?.[budgetTableName] ?? []));
      pendingKeys = (result.UnprocessedKeys?.[budgetTableName]?.Keys ?? [])
        .map(key => ({
          scope_key: String(key.scope_key),
          period: String(key.period),
        }));
    } while (pendingKeys.length > 0);
  }
  return items;
}

/**
 * Load recurring configs and the named month's spend for each scope.
 * Missing config rows are omitted; spend defaults to zero.
 */
export async function loadBudgetStates(
  scopeKeys: readonly string[],
  period: string,
): Promise<BudgetState[]> {
  if (!budgetTableName || scopeKeys.length === 0) return [];

  const keys = scopeKeys.flatMap(scopeKey => [
    { scope_key: scopeKey, period: BUDGET_CONFIG_PERIOD },
    { scope_key: scopeKey, period },
  ]);
  const items = await batchGetItems(keys);
  const byKey = new Map(items.map(item => [
    `${String(item.scope_key)}\0${String(item.period)}`,
    item,
  ]));

  const states: BudgetState[] = [];
  for (const scopeKey of scopeKeys) {
    const parsedScope = parseBudgetScopeKey(scopeKey);
    if (!parsedScope) continue;
    const config = byKey.get(`${scopeKey}\0${BUDGET_CONFIG_PERIOD}`);
    if (!config) continue;

    const monthlyLimitUsd = numeric(config.monthly_limit_usd);
    if (monthlyLimitUsd <= 0) {
      throw new Error(`Budget config ${scopeKey} has invalid monthly_limit_usd.`);
    }
    const spend = byKey.get(`${scopeKey}\0${period}`);
    const spendUsd = Math.max(0, numeric(spend?.spend_usd));
    states.push({
      scopeKey,
      ...parsedScope,
      monthlyLimitUsd,
      hardStop: config.hard_stop === true,
      updatedAt: typeof config.updated_at === 'string' ? config.updated_at : undefined,
      period,
      spendUsd,
      utilizationPercent: (spendUsd / monthlyLimitUsd) * 100,
    });
  }
  return states;
}

/** Read the authenticated user's own monthly estimated-spend status. */
export async function loadPersonalBudgetStatus(
  userId: string,
  now: Date = new Date(),
): Promise<PersonalBudgetStatus> {
  const period = budgetPeriod(now);
  const scopeKey = userBudgetScopeKey(userId);
  const items = await batchGetItems([
    { scope_key: scopeKey, period: BUDGET_CONFIG_PERIOD },
    { scope_key: scopeKey, period },
  ]);
  const config = items.find(item => item.period === BUDGET_CONFIG_PERIOD);
  const spend = items.find(item => item.period === period);
  const spendUsd = Math.max(0, numeric(spend?.spend_usd));

  if (!config) {
    return {
      period,
      resets_at: budgetResetAt(now),
      configured: false,
      spend_usd: spendUsd,
      monthly_limit_usd: null,
      remaining_usd: null,
      utilization_percent: null,
      hard_stop: false,
      hard_stop_active: false,
    };
  }

  const monthlyLimitUsd = numeric(config.monthly_limit_usd);
  if (monthlyLimitUsd <= 0) {
    throw new Error(`Budget config ${scopeKey} has invalid monthly_limit_usd.`);
  }
  const utilizationPercent = (spendUsd / monthlyLimitUsd) * 100;
  const hardStop = config.hard_stop === true;
  return {
    period,
    resets_at: budgetResetAt(now),
    configured: true,
    spend_usd: spendUsd,
    monthly_limit_usd: monthlyLimitUsd,
    remaining_usd: Math.max(0, monthlyLimitUsd - spendUsd),
    utilization_percent: utilizationPercent,
    hard_stop: hardStop,
    hard_stop_active: hardStop && utilizationPercent >= BUDGET_EXCEEDED_PERCENT,
  };
}

/**
 * Resolve all team memberships and enforce configured hard-stop budgets.
 *
 * When the budget table is not wired (unit tests or an older deployment),
 * admission is unchanged and only caller-supplied team IDs are returned.
 */
export async function checkBudgetAdmission(
  userId: string,
  suppliedTeamIds?: readonly string[],
  now: Date = new Date(),
): Promise<BudgetAdmissionResult> {
  const teamIds = suppliedTeamIds === undefined
    ? (budgetTableName ? await resolveTeamIds(userId) : [])
    : [...new Set(suppliedTeamIds)].sort();
  const scopeKeys = [
    userBudgetScopeKey(userId),
    ...teamIds.map(teamBudgetScopeKey),
  ];
  if (scopeKeys.length > MAX_BUDGET_SCOPES_PER_TASK) {
    throw new Error(
      `User ${userId} belongs to ${teamIds.length} teams; budget rollup supports at most `
      + `${MAX_BUDGET_SCOPES_PER_TASK - 1}.`,
    );
  }

  const period = budgetPeriod(now);
  const states = await loadBudgetStates(scopeKeys, period);
  for (const state of states) {
    if (state.utilizationPercent >= BUDGET_WARNING_PERCENT) {
      logger.warn('Monthly budget is at or above the warning threshold', {
        scope_type: state.scopeType,
        scope_id: state.scopeId,
        period,
        spend_usd: state.spendUsd,
        monthly_limit_usd: state.monthlyLimitUsd,
        utilization_percent: state.utilizationPercent,
        hard_stop: state.hardStop,
      });
    }
  }

  const blocked = states.find(state =>
    state.hardStop && state.utilizationPercent >= BUDGET_EXCEEDED_PERCENT);

  return {
    teamIds,
    period,
    blocked: blocked
      ? {
        scopeType: blocked.scopeType,
        scopeId: blocked.scopeId,
        spendUsd: blocked.spendUsd,
        monthlyLimitUsd: blocked.monthlyLimitUsd,
      }
      : null,
  };
}
