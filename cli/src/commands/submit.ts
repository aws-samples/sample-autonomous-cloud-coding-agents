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
import { ApiClient } from '../api-client';
import { CliError } from '../errors';
import { formatJson, formatTaskDetail } from '../format';
import { CreateTaskRequest } from '../types';
import { exitCodeForStatus, waitForTask } from '../wait';

export function makeSubmitCommand(): Command {
  return new Command('submit')
    .description('Submit a new task')
    .requiredOption('--repo <owner/repo>', 'GitHub repository (owner/repo)')
    .option('--issue <number>', 'GitHub issue number', parseInt)
    .option('--task <description>', 'Task description')
    .option('--max-turns <number>', 'Maximum agent turns (1-500)', parseInt)
    .option('--max-budget <dollars>', 'Maximum budget in USD (0.01-100)', parseFloat)
    .option('--pr <number>', 'PR number to iterate on (sets task_type to pr_iteration)', parseInt)
    .option('--idempotency-key <key>', 'Idempotency key for deduplication')
    .option('--wait', 'Wait for task to complete')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      if (opts.pr !== undefined && isNaN(opts.pr)) {
        throw new CliError('--pr must be a valid number.');
      }
      if (opts.pr === undefined && opts.issue === undefined && !opts.task) {
        throw new CliError('At least one of --issue, --task, or --pr is required.');
      }
      if (opts.issue !== undefined && isNaN(opts.issue)) {
        throw new CliError('--issue must be a valid number.');
      }
      if (opts.maxTurns !== undefined) {
        if (isNaN(opts.maxTurns) || !Number.isInteger(opts.maxTurns) || opts.maxTurns < 1 || opts.maxTurns > 500) {
          throw new CliError('--max-turns must be an integer between 1 and 500.');
        }
      }
      if (opts.maxBudget !== undefined) {
        if (isNaN(opts.maxBudget) || opts.maxBudget < 0.01 || opts.maxBudget > 100) {
          throw new CliError('--max-budget must be a number between 0.01 and 100.');
        }
      }

      const client = new ApiClient();
      const body: CreateTaskRequest = {
        repo: opts.repo,
        ...(opts.issue !== undefined && { issue_number: opts.issue }),
        ...(opts.task && { task_description: opts.task }),
        ...(opts.maxTurns !== undefined && { max_turns: opts.maxTurns }),
        ...(opts.maxBudget !== undefined && { max_budget_usd: opts.maxBudget }),
        ...(opts.pr !== undefined && { task_type: 'pr_iteration' as const, pr_number: opts.pr }),
      };

      const task = await client.createTask(body, opts.idempotencyKey);

      if (opts.wait) {
        process.stderr.write('\n');
        const finalTask = await waitForTask(client, task.task_id);
        process.stderr.write('\n');
        console.log(opts.output === 'json' ? formatJson(finalTask) : formatTaskDetail(finalTask));
        process.exitCode = exitCodeForStatus(finalTask.status);
      } else {
        console.log(opts.output === 'json' ? formatJson(task) : formatTaskDetail(task));
      }
    });
}
