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

import { Command } from 'commander';
import {
  buildCognitoEmailByUsername,
  resolveCognitoAdminContext,
  resolveUserEmailForDisplay,
} from '../cognito-admin';
import { CliError } from '../errors';
import { DEFAULT_STACK_NAME, resolveOperatorContext } from '../operator-context';
import {
  buildConcurrencyReport,
  DEFAULT_APPROVAL_STRANDED_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONCURRENT_TASKS_PER_USER,
  DEFAULT_STRANDED_TIMEOUT_SECONDS,
  findStuckTasks,
} from '../ops-queries';
import { getStackOutput } from '../stack-outputs';

const TASK_ID_WIDTH = 28;
const EMAIL_COLUMN_WIDTH = 36;
const USERNAME_COLUMN_WIDTH = 36;
const COUNT_COLUMN_WIDTH = 8;
const STATUS_WIDTH = 20;
const AGE_WIDTH = 10;

export function makeOpsCommand(): Command {
  const ops = new Command('ops')
    .description('Operational shortcuts (operator AWS credentials)');

  ops.addCommand(
    new Command('stuck-tasks')
      .description('List tasks stuck in SUBMITTED, HYDRATING, or AWAITING_APPROVAL beyond reconciler thresholds')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--stranded-timeout <seconds>', 'SUBMITTED/HYDRATING threshold (default: 1200)', parseInt)
      .option('--approval-timeout <seconds>', 'AWAITING_APPROVAL threshold (default: 7200)', parseInt)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const { region, stackName } = resolveOperatorContext(opts);
        const taskTableName = await getStackOutput(region, stackName, 'TaskTableName');
        if (!taskTableName) {
          throw new CliError(
            `Stack '${stackName}' is missing output 'TaskTableName'. Re-deploy the CDK stack.`,
          );
        }

        const tasks = await findStuckTasks(region, taskTableName, {
          strandedTimeoutSeconds: opts.strandedTimeout ?? DEFAULT_STRANDED_TIMEOUT_SECONDS,
          approvalTimeoutSeconds: opts.approvalTimeout ?? DEFAULT_APPROVAL_STRANDED_TIMEOUT_SECONDS,
        });
        const emailByUsername = await loadUserEmailLookup(opts);

        if (opts.output === 'json') {
          console.log(JSON.stringify({
            tasks: tasks.map((t) => ({
              ...t,
              user_email: resolveUserEmailForDisplay(t.user_id, emailByUsername),
            })),
          }, null, 2));
          return;
        }

        if (tasks.length === 0) {
          console.log('No stuck tasks found.');
          return;
        }

        console.log(
          `${'TASK_ID'.padEnd(TASK_ID_WIDTH)} `
          + `${'EMAIL'.padEnd(EMAIL_COLUMN_WIDTH)} `
          + `${'USERNAME'.padEnd(USERNAME_COLUMN_WIDTH)} `
          + `${'STATUS'.padEnd(STATUS_WIDTH)} ${'AGE(s)'.padEnd(AGE_WIDTH)} REPO`,
        );
        for (const t of tasks) {
          console.log(
            `${t.task_id.padEnd(TASK_ID_WIDTH)} `
            + `${resolveUserEmailForDisplay(t.user_id, emailByUsername).padEnd(EMAIL_COLUMN_WIDTH)} `
            + `${t.user_id.padEnd(USERNAME_COLUMN_WIDTH)} `
            + `${t.status.padEnd(STATUS_WIDTH)} `
            + `${String(t.age_seconds).padEnd(AGE_WIDTH)} `
            + `${t.repo ?? '-'}`,
          );
        }
        console.log(`\n${tasks.length} stuck task(s). Thresholds: SUBMITTED/HYDRATING `
          + `${opts.strandedTimeout ?? DEFAULT_STRANDED_TIMEOUT_SECONDS}s, `
          + `AWAITING_APPROVAL ${opts.approvalTimeout ?? DEFAULT_APPROVAL_STRANDED_TIMEOUT_SECONDS}s.`);
      }),
  );

  ops.addCommand(
    new Command('concurrency')
      .description('Show per-user active task counts vs admission limit (UserConcurrencyTable)')
      .option('--region <region>', 'AWS region (defaults to configured region or AWS_REGION)')
      .option('--stack-name <name>', 'CloudFormation stack name', DEFAULT_STACK_NAME)
      .option('--limit <n>', 'Per-user concurrency limit (default: 3)', parseInt)
      .option('--output <format>', 'Output format: text or json', 'text')
      .action(async (opts) => {
        const { region, stackName } = resolveOperatorContext(opts);
        const [taskTableName, concurrencyTableName] = await Promise.all([
          getStackOutput(region, stackName, 'TaskTableName'),
          getStackOutput(region, stackName, 'UserConcurrencyTableName'),
        ]);
        if (!taskTableName || !concurrencyTableName) {
          throw new CliError(
            `Stack '${stackName}' is missing TaskTableName and/or UserConcurrencyTableName outputs.`,
          );
        }

        const limit = opts.limit ?? DEFAULT_MAX_CONCURRENT_TASKS_PER_USER;
        const rows = await buildConcurrencyReport(
          region,
          taskTableName,
          concurrencyTableName,
          limit,
        );
        const emailByUsername = await loadUserEmailLookup(opts);

        if (opts.output === 'json') {
          console.log(JSON.stringify({
            concurrency: rows.map((row) => ({
              ...row,
              user_email: resolveUserEmailForDisplay(row.user_id, emailByUsername),
            })),
            limit_per_user: limit,
          }, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log('No users in UserConcurrencyTable.');
          return;
        }

        console.log(
          `${'EMAIL'.padEnd(EMAIL_COLUMN_WIDTH)} `
          + `${'USERNAME'.padEnd(USERNAME_COLUMN_WIDTH)} `
          + `${'STORED'.padEnd(COUNT_COLUMN_WIDTH)} `
          + `${'ACTUAL'.padEnd(COUNT_COLUMN_WIDTH)} ${'LIMIT'.padEnd(COUNT_COLUMN_WIDTH)} DRIFT`,
        );
        for (const row of rows) {
          let driftLabel: string;
          if (row.drift === null) {
            driftLabel = `error: ${row.error ?? 'unknown'}`;
          } else if (row.drift === 0) {
            driftLabel = '0';
          } else {
            driftLabel = `${row.drift > 0 ? '+' : ''}${row.drift}`;
          }
          const actualLabel = row.actual_count === null ? '?' : String(row.actual_count);
          console.log(
            `${resolveUserEmailForDisplay(row.user_id, emailByUsername).padEnd(EMAIL_COLUMN_WIDTH)} `
            + `${row.user_id.padEnd(USERNAME_COLUMN_WIDTH)} `
            + `${String(row.stored_count).padEnd(COUNT_COLUMN_WIDTH)} `
            + `${actualLabel.padEnd(COUNT_COLUMN_WIDTH)} `
            + `${String(row.limit).padEnd(COUNT_COLUMN_WIDTH)} `
            + driftLabel,
          );
        }
        console.log('\nACTUAL counts SUBMITTED/HYDRATING/RUNNING/FINALIZING/AWAITING_APPROVAL tasks. '
          + 'Non-zero DRIFT may clear on the next concurrency reconciler run.');
      }),
  );

  return ops;
}

async function loadUserEmailLookup(opts: {
  region?: string;
  stackName?: string;
}): Promise<Map<string, string>> {
  const ctx = await resolveCognitoAdminContext(opts);
  return buildCognitoEmailByUsername(ctx);
}
