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
import {
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  ApprovalScope,
  CreateTaskRequest,
  INITIAL_APPROVALS_MAX_ENTRIES,
  INITIAL_APPROVALS_MAX_ENTRY_LENGTH,
} from '../types';
import { exitCodeForStatus, waitForTask } from '../wait';

/** Scope prefixes the server accepts (see ``parseApprovalScope`` on the
 *  CDK side). Special short forms without ``:`` are also valid. */
const SCOPE_PREFIXES = [
  'tool_type:',
  'tool_group:',
  'bash_pattern:',
  'write_path:',
  'rule:',
] as const;
const SCOPE_SHORT_FORMS = new Set([
  'this_call',
  'tool_type_session',
  'tool_group_session',
  'all_session',
]);

function collect<T>(value: T, previous: readonly T[]): readonly T[] {
  return [...previous, value];
}

export function makeSubmitCommand(): Command {
  return new Command('submit')
    .description('Submit a new task')
    .requiredOption('--repo <owner/repo>', 'GitHub repository (owner/repo)')
    .option('--issue <number>', 'GitHub issue number', parseInt)
    .option('--task <description>', 'Task description')
    .option('--max-turns <number>', 'Maximum agent turns (1-500)', parseInt)
    .option('--max-budget <dollars>', 'Maximum budget in USD (0.01-100)', parseFloat)
    .option('--pr <number>', 'PR number to iterate on (sets task_type to pr_iteration)', parseInt)
    .option('--review-pr <number>', 'PR number to review (sets task_type to pr_review)', parseInt)
    .option('--idempotency-key <key>', 'Idempotency key for deduplication')
    .option('--trace', 'Capture 4 KB debug previews (design §10.1). Opt-in per task; not routine observability.')
    .option(
      '--approval-timeout <seconds>',
      `Cedar HITL per-task default approval timeout (${APPROVAL_TIMEOUT_S_MIN}-${APPROVAL_TIMEOUT_S_MAX}s). `
        + 'Overrides the platform default of 300s. Per-rule @approval_timeout_s still min-wins at gate-firing.',
      parseInt,
    )
    .option(
      '--pre-approve <scope>',
      'Cedar HITL pre-approval scope to seed at task start (repeatable). '
        + 'Valid forms: this_call, tool_type_session, tool_group_session, all_session, '
        + 'tool_type:<name>, tool_group:<name>, bash_pattern:<glob>, write_path:<glob>, rule:<id>.',
      collect<string>,
      [] as readonly string[],
    )
    .option('--wait', 'Wait for task to complete')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      if (opts.pr !== undefined && isNaN(opts.pr)) {
        throw new CliError('--pr must be a valid number.');
      }
      if (opts.reviewPr !== undefined && isNaN(opts.reviewPr)) {
        throw new CliError('--review-pr must be a valid number.');
      }
      if (opts.pr !== undefined && opts.reviewPr !== undefined) {
        throw new CliError('--pr and --review-pr cannot be used together.');
      }
      if (opts.pr === undefined && opts.reviewPr === undefined && opts.issue === undefined && !opts.task) {
        throw new CliError('At least one of --issue, --task, --pr, or --review-pr is required.');
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
      if (opts.approvalTimeout !== undefined) {
        if (
          isNaN(opts.approvalTimeout)
          || !Number.isInteger(opts.approvalTimeout)
          || opts.approvalTimeout < APPROVAL_TIMEOUT_S_MIN
          || opts.approvalTimeout > APPROVAL_TIMEOUT_S_MAX
        ) {
          throw new CliError(
            `--approval-timeout must be an integer between ${APPROVAL_TIMEOUT_S_MIN} `
              + `and ${APPROVAL_TIMEOUT_S_MAX} seconds.`,
          );
        }
      }
      const preApproveRaw = (opts.preApprove ?? []) as readonly string[];
      let initialApprovals: readonly ApprovalScope[] | undefined;
      if (preApproveRaw.length > 0) {
        if (preApproveRaw.length > INITIAL_APPROVALS_MAX_ENTRIES) {
          throw new CliError(
            `--pre-approve exceeds ${INITIAL_APPROVALS_MAX_ENTRIES} entries.`,
          );
        }
        for (const scope of preApproveRaw) {
          if (scope.length > INITIAL_APPROVALS_MAX_ENTRY_LENGTH) {
            throw new CliError(
              `--pre-approve "${scope}" exceeds ${INITIAL_APPROVALS_MAX_ENTRY_LENGTH} characters.`,
            );
          }
          if (
            !SCOPE_SHORT_FORMS.has(scope)
            && !SCOPE_PREFIXES.some((p) => scope.startsWith(p) && scope.length > p.length)
          ) {
            throw new CliError(
              `--pre-approve "${scope}" has an invalid scope. Use one of: `
                + 'this_call, tool_type_session, tool_group_session, all_session, '
                + 'or a prefix: tool_type:, tool_group:, bash_pattern:, write_path:, rule:.',
            );
          }
        }
        initialApprovals = preApproveRaw as readonly ApprovalScope[];
      }

      const client = new ApiClient();
      const body: CreateTaskRequest = {
        repo: opts.repo,
        ...(opts.issue !== undefined && { issue_number: opts.issue }),
        ...(opts.task && { task_description: opts.task }),
        ...(opts.maxTurns !== undefined && { max_turns: opts.maxTurns }),
        ...(opts.maxBudget !== undefined && { max_budget_usd: opts.maxBudget }),
        // Note: --pr and --review-pr are mutually exclusive (validated above).
        ...(opts.pr !== undefined && { task_type: 'pr_iteration' as const, pr_number: opts.pr }),
        ...(opts.reviewPr !== undefined && { task_type: 'pr_review' as const, pr_number: opts.reviewPr }),
        ...(opts.trace && { trace: true }),
        ...(opts.approvalTimeout !== undefined && { approval_timeout_s: opts.approvalTimeout }),
        ...(initialApprovals !== undefined && { initial_approvals: initialApprovals }),
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
