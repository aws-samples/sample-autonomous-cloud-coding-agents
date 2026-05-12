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
import type { PendingApprovalSummary } from '../types';

/**
 * `bgagent pending [--output text|json]` — list all pending approvals
 * owned by the caller across every active task (design §8.1, §7.7).
 */
export function makePendingCommand(): Command {
  return new Command('pending')
    .description('List all pending Cedar HITL approvals across your active tasks')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      const client = new ApiClient();
      try {
        const result = await client.listPending();
        if (opts.output === 'json') {
          console.log(formatJson(result));
          return;
        }
        renderText(result.pending);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw mapPendingError(err);
        }
        throw err;
      }
    });
}

function renderText(pending: readonly PendingApprovalSummary[]): void {
  if (pending.length === 0) {
    console.log('(no pending approvals)');
    return;
  }
  console.log(`${pending.length} pending approval(s):\n`);
  for (const p of pending) {
    console.log(`  task_id:    ${p.task_id}`);
    console.log(`  request_id: ${p.request_id}`);
    console.log(`  tool:       ${p.tool_name}    severity: ${p.severity}`);
    console.log(`  reason:     ${p.reason}`);
    if (p.matching_rule_ids !== undefined && p.matching_rule_ids.length > 0) {
      console.log(`  rules:      ${p.matching_rule_ids.join(', ')}`);
    }
    console.log(`  preview:    ${p.tool_input_preview}`);
    console.log(`  created:    ${p.created_at}`);
    console.log(`  expires:    ${p.expires_at} (timeout_s=${p.timeout_s})`);
    console.log(
      `  approve:    bgagent approve ${p.task_id} ${p.request_id}`,
    );
    console.log(
      `  deny:       bgagent deny ${p.task_id} ${p.request_id} --reason "..."`,
    );
    console.log();
  }
}

function mapPendingError(err: ApiError): CliError {
  switch (err.statusCode) {
    case 401:
      return new CliError(
        `Not authenticated (${err.errorCode}). Run \`bgagent login\` to re-authenticate.`,
      );
    case 429:
      return new CliError(
        `Rate limit exceeded (${err.errorCode}). \`bgagent pending\` is rate-limited; slow down \`watch\` polls.`,
      );
    case 503:
      return new CliError(
        `Service temporarily unavailable (${err.errorCode}): ${err.message}`,
      );
    default:
      return new CliError(err.message);
  }
}
