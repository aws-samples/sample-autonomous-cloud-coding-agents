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
import { ApiError, CliError } from '../errors';
import { formatJson } from '../format';
import type { ApprovalScope } from '../types';

/**
 * `bgagent approve <task-id> <request-id> [--scope <scope>]` —
 * approve a pending Cedar HITL gate (design §8.1).
 *
 * Scope defaults to `this_call` server-side when omitted. `all_session`
 * is the only scope that normally requires interactive confirmation;
 * pass `--yes` to bypass.
 */
export function makeApproveCommand(): Command {
  return new Command('approve')
    .description('Approve a pending Cedar HITL approval gate')
    .argument('<task-id>', 'Task ID that is awaiting approval')
    .argument('<request-id>', 'Approval request ID (get it from `bgagent pending` or the notification)')
    .option('--scope <scope>', 'Approval scope (this_call, tool_type_session, tool_type:Bash, rule:<id>, bash_pattern:<glob>, write_path:<glob>, all_session)', 'this_call')
    .option('--yes', 'Skip the interactive confirmation for broad scopes (all_session)', false)
    .option('--output <format>', 'Output format (text or json)', 'text')
    .addHelpText(
      'after',
      '\nExamples:\n'
      + '  $ bgagent approve 01K... 01R...                    # one-shot\n'
      + '  $ bgagent approve 01K... 01R... --scope tool_type:Bash\n'
      + '  $ bgagent approve 01K... 01R... --scope rule:force_push_any\n'
      + '  $ bgagent approve 01K... 01R... --scope all_session --yes\n',
    )
    .action(async (taskId: string, requestId: string, opts) => {
      const scope = opts.scope as string;

      // all_session is the nuclear option — require --yes.
      if (scope === 'all_session' && !opts.yes) {
        throw new CliError(
          'Scope "all_session" grants the agent blanket approval for every subsequent gate.\n'
          + 'Re-run with `--yes` to confirm, or pick a narrower scope (e.g. `tool_type_session`).',
        );
      }

      const client = new ApiClient();
      try {
        const result = await client.approveTask(taskId, requestId, scope as ApprovalScope);
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(
            `Approved ${result.request_id} on task ${result.task_id} `
            + `with scope="${result.scope}" at ${result.decided_at}.`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw mapApproveError(err);
        }
        throw err;
      }
    });
}

/** Map approve-specific API errors to user-facing CLI messages. */
function mapApproveError(err: ApiError): CliError {
  switch (err.statusCode) {
    case 400:
      return new CliError(`Approval rejected: ${err.message}`);
    case 401:
      return new CliError(
        `Not authenticated (${err.errorCode}). Run \`bgagent login\` to re-authenticate.`,
      );
    case 404:
      return new CliError(
        `Approval request not found or not owned by you (${err.errorCode}).\n`
        + 'Run `bgagent pending` to see active approvals.',
      );
    case 409:
      return new CliError(
        `Approval cannot be recorded: ${err.message}\n`
        + '(The task may have been cancelled, the request already decided, '
        + 'or it is no longer in AWAITING_APPROVAL.)',
      );
    case 429:
      return new CliError(
        `Rate limit exceeded (${err.errorCode}). Slow down — approve/deny is limited per user per minute.`,
      );
    case 503:
      return new CliError(
        `Approval service temporarily unavailable (${err.errorCode}): ${err.message}`,
      );
    default:
      return new CliError(err.message);
  }
}
