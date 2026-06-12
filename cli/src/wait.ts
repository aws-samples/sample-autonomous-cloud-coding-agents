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

import { ApiClient } from './api-client';
import { CliError } from './errors';
import { abortableSleep, isTransientError, transientRetryDelayMs } from './retry';
import { TaskDetail, TERMINAL_STATUSES } from './types';

const POLL_INTERVAL_MS = 5_000;

/** Maximum consecutive transient (5xx / network) failures tolerated before
 *  giving up. A single blip must not abort a long ``--wait``; a sustained
 *  outage eventually surfaces an error. Reset to 0 after any successful poll. */
const MAX_TRANSIENT_FAILURES = 5;

/** Generous default wall-clock ceiling so a stuck task can never pin the CLI
 *  forever. ``submit --wait`` / ``status --wait`` expose no ``--timeout`` flag
 *  today, so this is the only bound. 24h comfortably exceeds any legitimate
 *  task while still guaranteeing eventual termination. */
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1_000;

/**
 * Poll a task until it reaches a terminal status.
 * Prints status updates to stderr. Returns the final task detail.
 *
 * Resilience added per the L2 audit:
 *   - Transient errors (5xx / network) are tolerated: up to
 *     ``MAX_TRANSIENT_FAILURES`` consecutive failures are retried with
 *     jittered backoff before the wait gives up. 4xx errors are
 *     deterministic and propagate immediately.
 *   - A ``maxWaitMs`` ceiling (default 24h) bounds the total wait so a
 *     wedged task cannot block the CLI indefinitely.
 */
export async function waitForTask(
  client: ApiClient,
  taskId: string,
  opts: { maxWaitMs?: number } = {},
): Promise<TaskDetail> {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startTime = Date.now();
  let consecutiveTransientFailures = 0;

  while (true) {
    let task: TaskDetail;
    try {
      task = await client.getTask(taskId);
      consecutiveTransientFailures = 0;
    } catch (err) {
      if (!isTransientError(err)) {
        throw err;
      }
      consecutiveTransientFailures += 1;
      if (consecutiveTransientFailures > MAX_TRANSIENT_FAILURES) {
        const e = err instanceof Error ? err : new Error(String(err));
        throw new CliError(
          `Gave up waiting for task ${taskId} after ${MAX_TRANSIENT_FAILURES} `
          + `consecutive transient failures: ${e.message}. `
          + `Re-run \`bgagent status ${taskId} --wait\` to resume.`,
        );
      }
      await abortableSleep(transientRetryDelayMs(consecutiveTransientFailures));
      continue;
    }

    if (isTerminal(task.status)) {
      return task;
    }

    if (Date.now() - startTime >= maxWaitMs) {
      throw new CliError(
        `Timed out waiting for task ${taskId} to reach a terminal status `
        + `after ${Math.round(maxWaitMs / 1_000)}s (last status: ${task.status}). `
        + `Re-run \`bgagent status ${taskId} --wait\` to keep waiting.`,
      );
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stderr.write(`\rWaiting... Status: ${task.status} (${elapsed}s)`);

    await abortableSleep(POLL_INTERVAL_MS);
  }
}

/** Returns the process exit code for a terminal task status. */
export function exitCodeForStatus(status: string): number {
  return status === 'COMPLETED' ? 0 : 1;
}

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
