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

import * as fs from 'fs';
import * as path from 'path';
import {
  BUDGET_CONFIG_INDEX_NAME,
  BUDGET_CONFIG_PERIOD,
  BUDGET_CONFIG_RECORD_TYPE,
  BUDGET_EXCEEDED_ALERT_MARKER,
  BUDGET_EXCEEDED_PERCENT,
  BUDGET_ROLLUP_PERIOD,
  BUDGET_ROLLUP_RETENTION_DAYS,
  BUDGET_TASK_PREFIX,
  BUDGET_TEAM_PREFIX,
  BUDGET_USER_PREFIX,
  BUDGET_WARNING_ALERT_MARKER,
  BUDGET_WARNING_PERCENT,
} from '../src/budget-store';
import {
  FORGE_WEBTRIGGER_SUFFIX,
  JIRA_APP_ACTOR_MIN_SECRET_LENGTH,
} from '../src/jira-app-actor';
import { LINEAR_OAUTH_SCOPES } from '../src/linear-oauth';
import { LINEAR_VAULT_CUSTOM_PARAMS_FOR_TEST } from '../src/linear-vault';
import {
  APPROVAL_TIMEOUT_S_DEFAULT,
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  MAX_BUDGET_USD_MAX,
  MAX_BUDGET_USD_MIN,
} from '../src/types';

/**
 * The CLI hard-codes these bounds as literals in ``src/types.ts`` rather than
 * importing ``contracts/constants.json`` directly: the contract file lives
 * outside the package's published ``files: ["lib"]`` whitelist, so a compiled
 * ``require('../../contracts/constants.json')`` from ``lib/`` would not be
 * packaged and would fail at runtime when the CLI is installed standalone.
 *
 * This test converts the resulting silent-drift risk into a CI failure: if the
 * single source of truth (the CDK side reads the same file via
 * ``resolveJsonModule``) changes, the CLI literals must be updated to match or
 * this test goes red.
 */
describe('CLI constants parity with contracts/constants.json', () => {
  const contracts = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'contracts', 'constants.json'),
      'utf-8',
    ),
  ) as {
    approval_timeout_s: { min: number; max: number; default: number };
    max_budget_usd: { min: number; max: number };
    monthly_budgets: {
      config_period: string;
      config_record_type: string;
      config_index_name: string;
      user_prefix: string;
      team_prefix: string;
      task_prefix: string;
      rollup_period: string;
      rollup_retention_days: number;
      warning_percent: number;
      exceeded_percent: number;
      warning_alert_marker: string;
      exceeded_alert_marker: string;
    };
    jira_app_actor: { min_secret_length: number; forge_webtrigger_suffix: string };
  };

  test('approval_timeout_s bounds match the contract', () => {
    expect(APPROVAL_TIMEOUT_S_MIN).toBe(contracts.approval_timeout_s.min);
    expect(APPROVAL_TIMEOUT_S_MAX).toBe(contracts.approval_timeout_s.max);
    expect(APPROVAL_TIMEOUT_S_DEFAULT).toBe(contracts.approval_timeout_s.default);
  });

  test('max_budget_usd bounds match the contract', () => {
    expect(MAX_BUDGET_USD_MIN).toBe(contracts.max_budget_usd.min);
    expect(MAX_BUDGET_USD_MAX).toBe(contracts.max_budget_usd.max);
  });

  test('monthly budget storage and alert constants match the contract', () => {
    expect({
      config_period: BUDGET_CONFIG_PERIOD,
      config_record_type: BUDGET_CONFIG_RECORD_TYPE,
      config_index_name: BUDGET_CONFIG_INDEX_NAME,
      user_prefix: BUDGET_USER_PREFIX,
      team_prefix: BUDGET_TEAM_PREFIX,
      task_prefix: BUDGET_TASK_PREFIX,
      rollup_period: BUDGET_ROLLUP_PERIOD,
      rollup_retention_days: BUDGET_ROLLUP_RETENTION_DAYS,
      warning_percent: BUDGET_WARNING_PERCENT,
      exceeded_percent: BUDGET_EXCEEDED_PERCENT,
      warning_alert_marker: BUDGET_WARNING_ALERT_MARKER,
      exceeded_alert_marker: BUDGET_EXCEEDED_ALERT_MARKER,
    }).toEqual(contracts.monthly_budgets);
  });

  test('Jira app-actor constraints match the contract', () => {
    expect(JIRA_APP_ACTOR_MIN_SECRET_LENGTH).toBe(
      contracts.jira_app_actor.min_secret_length,
    );
    expect(FORGE_WEBTRIGGER_SUFFIX).toBe(
      contracts.jira_app_actor.forge_webtrigger_suffix,
    );
  });
});

describe('linear_vault cache-key parity', () => {
  // AgentCore keys a cached grant by the WHOLE token request, customParameters included,
  // so consent time and every resolve must send an identical set. Four copies exist —
  // this file's, the Lambda resolver's, the CLI vault helper's and the agent's — and a
  // one-token divergence makes every resolve a cache miss, which since #812 is reported
  // as consent-required and can latch a healthy workspace `revoked`. The agent side is
  // enforced differently: `check:constants-sync` forbids it re-declaring these literals
  // at all.
  const contract = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'constants.json'), 'utf8'),
  ).linear_vault as { scopes: string[]; custom_parameters: Record<string, string> };

  test('the CLI OAuth scopes match the contract', () => {
    expect([...LINEAR_OAUTH_SCOPES]).toEqual(contract.scopes);
  });

  test('the consent-time customParameters match the contract', () => {
    expect(LINEAR_VAULT_CUSTOM_PARAMS_FOR_TEST).toEqual(contract.custom_parameters);
  });
});
