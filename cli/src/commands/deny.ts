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

import * as fs from 'node:fs';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { ApiError, CliError, mapApiError } from '../errors';
import { formatJson } from '../format';
import { DENY_REASON_MAX_LENGTH } from '../types';

/**
 * `bgagent deny <task-id> <request-id> [--reason ... | --reason-file ...]`
 * — deny a pending Cedar HITL gate (design §8.1).
 *
 * Reason is optional; when supplied the server sanitizes + truncates
 * to `DENY_REASON_MAX_LENGTH` chars before persisting. `--reason-file`
 * is useful for multi-line reasons that would otherwise need careful
 * shell quoting.
 */
export function makeDenyCommand(): Command {
  return new Command('deny')
    .description('Deny a pending Cedar HITL approval gate')
    .argument('<task-id>', 'Task ID that is awaiting approval')
    .argument('<request-id>', 'Approval request ID')
    .option('--reason <text>', 'Reason for denial (sanitized + truncated server-side)')
    .option('--reason-file <path>', 'Read the reason from a file (mutually exclusive with --reason)')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .addHelpText(
      'after',
      '\nExamples:\n'
      + '  $ bgagent deny 01K... 01R...\n'
      + '  $ bgagent deny 01K... 01R... --reason "run the migration dry-run first"\n'
      + '  $ bgagent deny 01K... 01R... --reason-file deny.txt\n',
    )
    .action(async (taskId: string, requestId: string, opts) => {
      if (opts.reason && opts.reasonFile) {
        throw new CliError('Use either --reason or --reason-file, not both.');
      }
      let reason: string | undefined;
      if (opts.reasonFile) {
        try {
          reason = fs.readFileSync(opts.reasonFile, 'utf-8').trim();
        } catch (err) {
          throw new CliError(
            `Cannot read --reason-file "${opts.reasonFile}": `
            + (err instanceof Error ? err.message : String(err)),
          );
        }
      } else if (opts.reason) {
        reason = String(opts.reason).trim();
      }

      // Client-side cap — server will also truncate, but a fast fail
      // here saves a round-trip when the reason is obviously too long.
      if (reason && reason.length > DENY_REASON_MAX_LENGTH) {
        throw new CliError(
          `Reason exceeds ${DENY_REASON_MAX_LENGTH} characters (got ${reason.length}). `
          + 'Shorten it locally — the server will truncate, but fail-fast is easier to debug.',
        );
      }

      const client = new ApiClient();
      try {
        const result = await client.denyTask(taskId, requestId, reason);
        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(
            `Denied ${result.request_id} on task ${result.task_id} at ${result.decided_at}.`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw mapDenyError(err);
        }
        throw err;
      }
    });
}

function mapDenyError(err: ApiError): CliError {
  return mapApiError(err, {
    400: (e) => `Denial rejected: ${e.message}`,
    404: (e) =>
      `Approval request not found or not owned by you (${e.errorCode}).\n`
      + 'Run `bgagent pending` to see active approvals.',
    409: (e) => `Denial cannot be recorded: ${e.message}`,
    429: (e) =>
      `Rate limit exceeded (${e.errorCode}). Slow down — approve/deny is limited per user per minute.`,
    503: (e) => `Approval service temporarily unavailable (${e.errorCode}): ${e.message}`,
  });
}
