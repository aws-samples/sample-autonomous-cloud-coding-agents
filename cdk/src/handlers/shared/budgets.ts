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
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { coerceNumericOrNull } from './numeric';
import type { PersonalBudgetStatus } from './types';
import { makeClient, makeDocClient } from './ua';
import sharedConstants from '../../../../contracts/constants.json';

const budgetContract = sharedConstants.monthly_budgets;
export const BUDGET_CONFIG_PERIOD = budgetContract.config_period;
export const BUDGET_ROLLUP_PERIOD = budgetContract.rollup_period;
export const BUDGET_USER_PREFIX = budgetContract.user_prefix;
export const BUDGET_TEAM_PREFIX = budgetContract.team_prefix;
export const BUDGET_TASK_PREFIX = budgetContract.task_prefix;
export const BUDGET_WARNING_PERCENT = budgetContract.warning_percent;
export const BUDGET_EXCEEDED_PERCENT = budgetContract.exceeded_percent;
export const BUDGET_CONFIG_INDEX_NAME = budgetContract.config_index_name;
export const BUDGET_ROLLUP_RETENTION_DAYS = budgetContract.rollup_retention_days;
export const BUDGET_WARNING_ALERT_MARKER = budgetContract.warning_alert_marker;
export const BUDGET_EXCEEDED_ALERT_MARKER = budgetContract.exceeded_alert_marker;

/** DynamoDB transactions allow 100 actions; reserve one for the task marker. */
export const MAX_BUDGET_SCOPES_PER_TASK = 99;

const BATCH_GET_LIMIT = 100;
const BUDGET_METRIC_NAMESPACE = 'ABCA/Budgets';
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
  readonly warningAlerted: boolean;
  readonly exceededAlerted: boolean;
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

export class BudgetScopeLimitError extends Error {
  override readonly name = 'BudgetScopeLimitError';
}

function assertSupportedScopeCount(userId: string, teamIds: readonly string[]): void {
  if (teamIds.length + 1 > MAX_BUDGET_SCOPES_PER_TASK) {
    throw new BudgetScopeLimitError(
      `User ${userId} belongs to ${teamIds.length} teams; budget rollup supports at most `
      + `${MAX_BUDGET_SCOPES_PER_TASK - 1}.`,
    );
  }
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

function budgetNumber(
  value: unknown,
  field: string,
  scopeKey: string,
  absentValue?: number,
): number {
  if (value === undefined || value === null) {
    if (absentValue !== undefined) return absentValue;
    throw new Error(`Budget row ${scopeKey} has invalid ${field}.`);
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    logger.warn('[numeric] unsupported budget value', {
      event: 'numeric.coercion_failed',
      field,
      scope_key: scopeKey,
      raw: String(value),
    });
    throw new Error(`Budget row ${scopeKey} has invalid ${field}.`);
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`Budget row ${scopeKey} has invalid ${field}.`);
  }
  const numeric = coerceNumericOrNull(value, { field }, logger);
  if (numeric === null) {
    throw new Error(`Budget row ${scopeKey} has invalid ${field}.`);
  }
  return numeric;
}

function budgetSpend(value: unknown, scopeKey: string): number {
  const spendUsd = budgetNumber(value, 'spend_usd', scopeKey, 0);
  if (spendUsd < 0) {
    throw new Error(`Budget row ${scopeKey} has invalid spend_usd.`);
  }
  return spendUsd;
}

function errorName(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('name' in err)) return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function emitMissingTeamMembershipMetric(userId: string): void {
  process.stdout.write(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: BUDGET_METRIC_NAMESPACE,
        Dimensions: [],
        Metrics: [{ Name: 'BudgetTeamMembershipUnresolved', Unit: 'Count' }],
      }],
    },
    BudgetTeamMembershipUnresolved: 1,
    user_id: userId,
  }) + '\n');
}

async function resolveTeamIds(userId: string): Promise<string[]> {
  if (!userPoolId || !cognito) {
    const error = new Error(
      'Budget admission requires USER_POOL_ID when team IDs are not supplied by the caller.',
    );
    logger.error('Failed to resolve budget team membership', {
      user_id: userId,
      error: error.message,
      metric_type: 'budget_team_membership_resolution_failure',
    });
    throw error;
  }

  try {
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
  } catch (err) {
    const name = errorName(err);
    if (name === 'UserNotFoundException') {
      // A deleted or externally federated Cognito identity can remain in a
      // headless integration mapping. User-scope admission still applies, but
      // there is no resolvable user-pool membership to attribute to teams.
      emitMissingTeamMembershipMetric(userId);
      logger.warn('Budget team membership user was not found; continuing without teams', {
        user_id: userId,
        error: err instanceof Error ? err.message : String(err),
        error_name: name,
        metric_type: 'budget_team_membership_user_missing',
      });
      return []; // nosemgrep: ts-silent-success-masking -- user budgets remain enforced; an alarm pages on skipped team enforcement
    }
    logger.error('Failed to resolve budget team membership', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
      error_name: name || undefined,
      metric_type: 'budget_team_membership_resolution_failure',
    });
    throw err;
  }
}

async function hasConfiguredTeamBudgets(): Promise<boolean> {
  if (!budgetTableName) return false;
  const result = await ddb.send(new QueryCommand({
    TableName: budgetTableName,
    IndexName: BUDGET_CONFIG_INDEX_NAME,
    KeyConditionExpression: 'record_type = :config AND begins_with(scope_key, :team)',
    ExpressionAttributeValues: {
      ':config': BUDGET_CONFIG_PERIOD,
      ':team': BUDGET_TEAM_PREFIX,
    },
    ProjectionExpression: 'scope_key',
    Limit: 1,
  }));
  return (result.Items?.length ?? 0) > 0;
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

    const monthlyLimitUsd = budgetNumber(config.monthly_limit_usd, 'monthly_limit_usd', scopeKey);
    if (monthlyLimitUsd <= 0) {
      throw new Error(`Budget config ${scopeKey} has invalid monthly_limit_usd.`);
    }
    const spend = byKey.get(`${scopeKey}\0${period}`);
    const spendUsd = budgetSpend(spend?.spend_usd, scopeKey);
    states.push({
      scopeKey,
      ...parsedScope,
      monthlyLimitUsd,
      hardStop: config.hard_stop === true,
      updatedAt: typeof config.updated_at === 'string' ? config.updated_at : undefined,
      period,
      spendUsd,
      utilizationPercent: (spendUsd / monthlyLimitUsd) * 100,
      warningAlerted: spend !== undefined && Object.hasOwn(spend, BUDGET_WARNING_ALERT_MARKER),
      exceededAlerted: spend !== undefined && Object.hasOwn(spend, BUDGET_EXCEEDED_ALERT_MARKER),
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
  const spendUsd = budgetSpend(spend?.spend_usd, scopeKey);

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

  const monthlyLimitUsd = budgetNumber(config.monthly_limit_usd, 'monthly_limit_usd', scopeKey);
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
 * Resolve relevant team memberships and enforce configured hard-stop budgets.
 *
 * When the budget table is not wired (unit tests or an older deployment),
 * admission is unchanged and only caller-supplied team IDs are returned.
 * Headless callers query for an existing team config before calling Cognito,
 * keeping the feature inert when operators have configured no team budgets.
 */
export async function checkBudgetAdmission(
  userId: string,
  suppliedTeamIds?: readonly string[],
  now: Date = new Date(),
): Promise<BudgetAdmissionResult> {
  const period = budgetPeriod(now);
  const userScopeKey = userBudgetScopeKey(userId);
  let teamIds: string[];
  let states: BudgetState[];

  if (suppliedTeamIds === undefined) {
    const userStates = await loadBudgetStates([userScopeKey], period);
    const userBlocked = userStates.find(state =>
      state.hardStop && state.utilizationPercent >= BUDGET_EXCEEDED_PERCENT);
    if (userBlocked) {
      return {
        teamIds: [],
        period,
        blocked: {
          scopeType: userBlocked.scopeType,
          scopeId: userBlocked.scopeId,
          spendUsd: userBlocked.spendUsd,
          monthlyLimitUsd: userBlocked.monthlyLimitUsd,
        },
      };
    }

    teamIds = budgetTableName && await hasConfiguredTeamBudgets()
      ? await resolveTeamIds(userId)
      : [];
    assertSupportedScopeCount(userId, teamIds);
    states = [
      ...userStates,
      ...(await loadBudgetStates(teamIds.map(teamBudgetScopeKey), period)),
    ];
  } else {
    teamIds = [...new Set(suppliedTeamIds)].sort();
    assertSupportedScopeCount(userId, teamIds);
    states = await loadBudgetStates([
      userScopeKey,
      ...teamIds.map(teamBudgetScopeKey),
    ], period);
  }

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
