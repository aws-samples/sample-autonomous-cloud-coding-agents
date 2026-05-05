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
import { NUDGE_MAX_MESSAGE_LENGTH } from '../types';

/**
 * `bgagent nudge <task-id> <message>` — send a steering message to a
 * running task (Phase 2). The message argument should be quoted in the
 * shell if it contains spaces, e.g.:
 *
 *     bgagent nudge TASK-123 "also update the README"
 */
export function makeNudgeCommand(): Command {
  return new Command('nudge')
    .description('Send a steering message to a running task')
    .argument('<task-id>', 'Task ID to nudge')
    .argument('<message>', 'Steering message (quote it if it contains spaces, e.g. "also update the README")')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .addHelpText(
      'after',
      '\nExamples:\n'
      + '  $ bgagent nudge TASK-123 "also update the README"\n'
      + '  $ bgagent nudge TASK-123 "focus on the auth module" --output json\n'
      + '\nNote: wrap the message in quotes so the shell passes it as a single argument.',
    )
    .action(async (taskId: string, message: string, opts) => {
      const trimmed = message.trim();
      if (trimmed.length === 0) {
        throw new CliError('Nudge message cannot be empty.');
      }
      if (trimmed.length > NUDGE_MAX_MESSAGE_LENGTH) {
        throw new CliError(
          `Nudge message exceeds maximum length of ${NUDGE_MAX_MESSAGE_LENGTH} characters (got ${trimmed.length}).`,
        );
      }

      const client = new ApiClient();
      try {
        const result = await client.nudgeTask(taskId, trimmed);

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(`Nudge ${result.nudge_id} submitted for task ${result.task_id} at ${result.submitted_at}.`);
        }
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw mapNudgeError(err);
        }
        throw err;
      }
    });
}

/** Map nudge-specific API error codes to friendlier CLI messages. */
function mapNudgeError(err: ApiError): CliError {
  switch (err.statusCode) {
    case 400:
      // Guardrail-blocked or validation error. Pass the server's message
      // through verbatim so guardrail reasons are visible to the user.
      return new CliError(`Nudge rejected: ${err.message}`);
    case 401:
      return new CliError(
        `Not authenticated (${err.errorCode}). Run \`bgagent login\` to re-authenticate.`,
      );
    case 403:
      return new CliError(
        `Forbidden (${err.errorCode}): this task belongs to another user.`,
      );
    case 404:
      return new CliError(`Task not found (${err.errorCode}).`);
    case 429:
      return new CliError(
        `Rate limit exceeded (${err.errorCode}). Slow down — nudges are limited per task; try again shortly.`,
      );
    case 503:
      return new CliError(
        `Nudge service temporarily unavailable (${err.errorCode}): ${err.message} Please retry in a moment.`,
      );
    default:
      return new CliError(err.message);
  }
}
