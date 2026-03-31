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
import { TaskDetail, TERMINAL_STATUSES } from './types';

const POLL_INTERVAL_MS = 5_000;

/**
 * Poll a task until it reaches a terminal status.
 * Prints status updates to stderr. Returns the final task detail.
 */
export async function waitForTask(client: ApiClient, taskId: string): Promise<TaskDetail> {
  const startTime = Date.now();
  let task: TaskDetail;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    task = await client.getTask(taskId);

    if (isTerminal(task.status)) {
      return task;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stderr.write(`\rWaiting... Status: ${task.status} (${elapsed}s)`);

    await sleep(POLL_INTERVAL_MS);
  }
}

/** Returns the process exit code for a terminal task status. */
export function exitCodeForStatus(status: string): number {
  return status === 'COMPLETED' ? 0 : 1;
}

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
