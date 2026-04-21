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
import { fetchInitialSnapshot, makeFormatter, runSse } from './watch';
import { loadConfig } from '../config';
import { debug, isVerbose } from '../debug';
import { CliError } from '../errors';
import { CreateTaskRequest, TERMINAL_STATUSES } from '../types';
import { exitCodeForStatus } from '../wait';
import { DEFAULT_STREAM_TIMEOUT_SECONDS, validateStreamTimeout } from './_stream';

/** Log an INFO-level message to stderr. Matches `watch.ts`'s signature so
 *  the two commands can share helpers in the future. Stdout stays free of
 *  info text regardless of output mode. */
function logInfo(_isJson: boolean, message: string): void {
  process.stderr.write(`${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
}

/**
 * `bgagent run` — direct-submit interactive path (rev 5, §9.13).
 *
 * Composes `createTask({execution_mode: 'interactive'})` + `runSse` so the
 * pipeline executes same-process with the SSE stream on Runtime-JWT. The
 * Lambda writes the TaskTable record but SKIPS the orchestrator invoke;
 * server.py on Runtime-JWT spawns the pipeline when the SSE stream opens.
 *
 * @returns Configured commander `Command` instance to attach to the bin.
 */
export function makeRunCommand(): Command {
  return new Command('run')
    .description('Submit a task and stream live progress in one command (real-time SSE)')
    .requiredOption('--repo <owner/repo>', 'GitHub repository (owner/repo)')
    .option('--issue <number>', 'GitHub issue number', parseInt)
    .option('--task <description>', 'Task description')
    .option('--max-turns <number>', 'Maximum agent turns (1-500)', parseInt)
    .option('--max-budget <dollars>', 'Maximum budget in USD (0.01-100)', parseFloat)
    .option('--pr <number>', 'PR number to iterate on (sets task_type to pr_iteration)', parseInt)
    .option('--review-pr <number>', 'PR number to review (sets task_type to pr_review)', parseInt)
    .option('--idempotency-key <key>', 'Idempotency key for deduplication')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .option(
      '--stream-timeout-seconds <n>',
      'SSE stream proactive-restart timeout in seconds (max 3500 = 58 min)',
      String(DEFAULT_STREAM_TIMEOUT_SECONDS),
    )
    .action(async (opts) => {
      // -------- Flag validation (mirrors submit.ts) --------------------------
      if (opts.pr !== undefined && isNaN(opts.pr)) {
        throw new CliError('--pr must be a valid number.');
      }
      if (opts.reviewPr !== undefined && isNaN(opts.reviewPr)) {
        throw new CliError('--review-pr must be a valid number.');
      }
      if (opts.pr !== undefined && opts.reviewPr !== undefined) {
        throw new CliError('--pr and --review-pr cannot be used together.');
      }
      if (
        opts.pr === undefined
        && opts.reviewPr === undefined
        && opts.issue === undefined
        && !opts.task
      ) {
        throw new CliError('At least one of --issue, --task, --pr, or --review-pr is required.');
      }
      if (opts.issue !== undefined && isNaN(opts.issue)) {
        throw new CliError('--issue must be a valid number.');
      }
      if (opts.maxTurns !== undefined) {
        if (
          isNaN(opts.maxTurns)
          || !Number.isInteger(opts.maxTurns)
          || opts.maxTurns < 1
          || opts.maxTurns > 500
        ) {
          throw new CliError('--max-turns must be an integer between 1 and 500.');
        }
      }
      if (opts.maxBudget !== undefined) {
        if (isNaN(opts.maxBudget) || opts.maxBudget < 0.01 || opts.maxBudget > 100) {
          throw new CliError('--max-budget must be a number between 0.01 and 100.');
        }
      }

      const streamTimeoutSeconds = validateStreamTimeout(opts.streamTimeoutSeconds);
      const isJson = opts.output === 'json';

      // -------- Config: runtime_jwt_arn is required ------------------------
      const config = loadConfig();
      if (!config.runtime_jwt_arn) {
        logError(
          '`bgagent run` requires `runtime_jwt_arn` in config. '
          + 'Run `bgagent configure --runtime-jwt-arn <arn>` and retry.',
        );
        throw new CliError('`runtime_jwt_arn` not configured.');
      }

      const apiClient = new ApiClient();

      // -------- Create task in interactive mode ----------------------------
      const body: CreateTaskRequest = {
        repo: opts.repo,
        execution_mode: 'interactive',
        ...(opts.issue !== undefined && { issue_number: opts.issue }),
        ...(opts.task && { task_description: opts.task }),
        ...(opts.maxTurns !== undefined && { max_turns: opts.maxTurns }),
        ...(opts.maxBudget !== undefined && { max_budget_usd: opts.maxBudget }),
        ...(opts.pr !== undefined && { task_type: 'pr_iteration' as const, pr_number: opts.pr }),
        ...(opts.reviewPr !== undefined && { task_type: 'pr_review' as const, pr_number: opts.reviewPr }),
      };

      debug(`[run] creating task (execution_mode=interactive) repo=${opts.repo}`);
      const task = await apiClient.createTask(body, opts.idempotencyKey);
      debug(`[run] task=${task.task_id} status=${task.status}`);

      if (!isJson) {
        logInfo(isJson, `Task: ${task.task_id}`);
        if (isVerbose()) {
          logInfo(isJson, `Verbose mode: on`);
        }
      }

      // -------- Snapshot: seed cursor (brand-new task — rarely has events)
      const snapshot = await fetchInitialSnapshot(apiClient, task.task_id);
      const seedCursor = snapshot.latestEventId ?? '';

      const formatter = makeFormatter(isJson);
      for (const ev of snapshot.events) {
        formatter.emitSemantic(ev);
      }

      // Edge case: task already terminal (admission rejected with immediate
      // FAILED, or idempotent replay of a completed task).
      if ((TERMINAL_STATUSES as readonly string[]).includes(snapshot.taskStatus)) {
        debug(`[run] task already terminal status=${snapshot.taskStatus}`);
        if (!isJson) logInfo(isJson, `Task ${snapshot.taskStatus.toLowerCase()}.`);
        process.exitCode = exitCodeForStatus(snapshot.taskStatus);
        return;
      }

      if (!isJson) {
        logInfo(isJson, `Streaming task ${task.task_id}... (Ctrl+C to stop)`);
      }

      // -------- SIGINT/SIGTERM → abort --------------------------------------
      const abortController = new AbortController();
      const onSignal = (): void => {
        debug('[run] SIGINT/SIGTERM received, aborting');
        abortController.abort();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      try {
        try {
          await runSse({
            apiClient,
            taskId: task.task_id,
            seedCursor,
            runtimeJwtArn: config.runtime_jwt_arn,
            region: config.region,
            streamTimeoutSeconds,
            formatter,
            abortController,
            isJson,
          });
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          debug(`[run] runSse threw: ${e.name}: ${e.message}`);

          // Rev-5 design: interactive tasks run same-process with the SSE
          // stream. If SSE fatally fails before or during the pipeline,
          // the orchestrator was skipped — nothing else will run this
          // task. Cancel it so the user isn't left with a task stranded
          // in SUBMITTED / HYDRATING.
          //
          // Best-effort: cancel failure is logged but doesn't change the
          // exit path; the user still needs to know the original error.
          try {
            await apiClient.cancelTask(task.task_id);
            debug(`[run] cancelled stranded task ${task.task_id}`);
          } catch (cancelErr) {
            const ce = cancelErr instanceof Error ? cancelErr : new Error(String(cancelErr));
            debug(`[run] cancel after SSE failure also failed: ${ce.message}`);
          }

          logError(`SSE stream failed: ${e.message}`);
          logError(`Task ${task.task_id} was cancelled. To re-run, try: bgagent run ...`);
          logError(`If you believe the task should have succeeded, check status with:`);
          logError(`  bgagent status ${task.task_id}`);
          throw new CliError(`run failed: ${e.message}`);
        }

        // runSse sets process.exitCode internally from the authoritative
        // REST status (watch.ts's post-terminal getTask), so no outer
        // final-status call is needed here.
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    });
}
