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
  AdminGetUserCommand,
  GetGroupCommand,
  type AdminGetUserCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { Command } from 'commander';
import {
  type BudgetScope,
  type BudgetStatus,
  currentBudgetPeriod,
  listBudgetStatus,
  setMonthlyBudget,
} from '../budget-store';
import {
  cognitoClient,
  resolveCognitoAdminContext,
  resolveCognitoUsername,
} from '../cognito-admin';
import { CliError } from '../errors';
import { DEFAULT_STACK_NAME, resolveOperatorContext } from '../operator-context';
import { getStackOutput } from '../stack-outputs';

const SCOPE_TYPE_WIDTH = 8;
const SCOPE_ID_WIDTH = 36;
const MONEY_WIDTH = 12;
const PERCENT_WIDTH = 9;
const MIN_MONTHLY_BUDGET_USD = 0.01;
const OUTPUT_FORMATS = new Set(['text', 'json']);

interface ScopeOptions {
  readonly user?: string;
  readonly team?: string;
}

function requestedScope(opts: ScopeOptions): BudgetScope | null {
  if (opts.user && opts.team) {
    throw new CliError('Choose exactly one scope: --user or --team.');
  }
  if (opts.user) return { type: 'user', id: opts.user };
  if (opts.team) return { type: 'team', id: opts.team };
  return null;
}

async function resolveScope(
  opts: ScopeOptions & { region?: string; stackName?: string },
  required: boolean,
): Promise<BudgetScope | undefined> {
  const scope = requestedScope(opts);
  if (!scope) {
    if (required) throw new CliError('One scope is required: --user <email-or-id> or --team <group>.');
    return undefined;
  }

  const cognito = await resolveCognitoAdminContext(opts);
  const client = cognitoClient(cognito.region);
  if (scope.type === 'user') {
    const username = await resolveCognitoUsername(client, cognito.userPoolId, scope.id);
    let user: AdminGetUserCommandOutput;
    try {
      user = await client.send(new AdminGetUserCommand({
        UserPoolId: cognito.userPoolId,
        Username: username,
      }));
    } catch (err) {
      if (err instanceof Error && err.name === 'UserNotFoundException') {
        throw new CliError(`Cognito user '${scope.id}' was not found in pool ${cognito.userPoolId}.`);
      }
      throw err;
    }
    const subject = user.UserAttributes?.find(attribute => attribute.Name === 'sub')?.Value;
    if (!subject) {
      throw new CliError(
        `Cognito user '${scope.id}' has no sub attribute in pool ${cognito.userPoolId}.`,
      );
    }
    return { type: 'user', id: subject };
  }
  try {
    await client.send(new GetGroupCommand({
      UserPoolId: cognito.userPoolId,
      GroupName: scope.id,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      throw new CliError(`Cognito team/group '${scope.id}' was not found in pool ${cognito.userPoolId}.`);
    }
    throw err;
  }
  return scope;
}

async function budgetContext(opts: {
  region?: string;
  stackName?: string;
}): Promise<{ region: string; stackName: string; tableName: string }> {
  const { region, stackName } = resolveOperatorContext(opts);
  const tableName = await getStackOutput(region, stackName, 'BudgetTableName');
  if (!tableName) {
    throw new CliError(
      `Stack '${stackName}' is missing output 'BudgetTableName'. Re-deploy the CDK stack.`,
    );
  }
  return { region, stackName, tableName };
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function printStatus(rows: readonly BudgetStatus[]): void {
  if (rows.length === 0) {
    console.log('No monthly budgets configured for this scope.');
    return;
  }
  console.log(
    `${'TYPE'.padEnd(SCOPE_TYPE_WIDTH)} `
    + `${'SCOPE'.padEnd(SCOPE_ID_WIDTH)} `
    + `${'SPEND'.padEnd(MONEY_WIDTH)} `
    + `${'LIMIT'.padEnd(MONEY_WIDTH)} `
    + `${'USED'.padEnd(PERCENT_WIDTH)} HARD STOP`,
  );
  for (const row of rows) {
    const hardStop = row.hard_stop
      ? (row.hard_stop_active ? 'ACTIVE' : 'enabled')
      : 'disabled';
    console.log(
      `${row.scope_type.padEnd(SCOPE_TYPE_WIDTH)} `
      + `${row.scope_id.padEnd(SCOPE_ID_WIDTH)} `
      + `${dollars(row.spend_usd).padEnd(MONEY_WIDTH)} `
      + `${dollars(row.monthly_limit_usd).padEnd(MONEY_WIDTH)} `
      + `${`${row.utilization_percent.toFixed(1)}%`.padEnd(PERCENT_WIDTH)} ${hardStop}`,
    );
  }
}

function assertOutputFormat(format: string): void {
  if (!OUTPUT_FORMATS.has(format)) {
    throw new CliError('--output must be text or json.');
  }
}

function addOperatorOptions(command: Command): Command {
  return command
    .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
    .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME);
}

function addScopeOptions(command: Command): Command {
  return command
    .option('--user <email-or-id>', 'Cognito user email or username/sub')
    .option('--team <group>', 'Cognito group name used as the team ID');
}

export function makeBudgetCommand(): Command {
  const budget = new Command('budget')
    .description('Monthly user/team spend budgets (operator AWS credentials)');

  budget.addCommand(
    addOperatorOptions(addScopeOptions(
      new Command('status')
        .description('Show current UTC-month spend and limits')
        .option('--output <format>', 'Output format: text or json', 'text')
        .action(async (opts) => {
          requestedScope(opts);
          assertOutputFormat(opts.output);
          const ctx = await budgetContext(opts);
          const scope = await resolveScope(opts, false);
          const rows = await listBudgetStatus(ctx.region, ctx.tableName, scope);
          if (opts.output === 'json') {
            console.log(JSON.stringify({
              period: rows[0]?.period ?? currentBudgetPeriod(),
              budgets: rows,
            }, null, 2));
            return;
          }
          printStatus(rows);
        }),
    )),
  );

  budget.addCommand(
    addOperatorOptions(addScopeOptions(
      new Command('set')
        .description('Set a recurring monthly USD limit')
        .requiredOption('--monthly-usd <amount>', 'Monthly limit in USD', parseFloat)
        .option('--hard-stop', 'Reject new tasks at 100% utilization', false)
        .action(async (opts) => {
          requestedScope(opts);
          if (!Number.isFinite(opts.monthlyUsd) || opts.monthlyUsd < MIN_MONTHLY_BUDGET_USD) {
            throw new CliError(`--monthly-usd must be at least ${MIN_MONTHLY_BUDGET_USD}.`);
          }
          const ctx = await budgetContext(opts);
          const scope = await resolveScope(opts, true);
          if (!scope) {
            throw new CliError('One scope is required: --user <email-or-id> or --team <group>.');
          }
          await setMonthlyBudget(
            ctx.region,
            ctx.tableName,
            scope,
            opts.monthlyUsd,
            opts.hardStop === true,
          );
          const rows = await listBudgetStatus(ctx.region, ctx.tableName, scope);
          console.log(
            `Set ${scope.type} '${scope.id}' monthly budget to ${dollars(opts.monthlyUsd)} `
            + `(${opts.hardStop ? 'hard stop at 100%' : 'alerts only'}).`,
          );
          printStatus(rows);
        }),
    )),
  );

  return budget;
}
