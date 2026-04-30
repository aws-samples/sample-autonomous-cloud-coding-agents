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
import { formatJson, formatStatusSnapshot, formatTaskDetail } from '../format';
import { exitCodeForStatus, waitForTask } from '../wait';

export function makeStatusCommand(): Command {
  return new Command('status')
    .description('Get a deterministic status snapshot of a task')
    .argument('<task-id>', 'Task ID')
    .option('--wait', 'Wait for task to reach terminal status')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (taskId: string, opts) => {
      const client = new ApiClient();

      if (opts.wait) {
        // ``--wait`` blocks until terminal and prints the full task-detail
        // view. The snapshot template is recency-biased and less useful
        // once the task has landed; reuse ``formatTaskDetail`` for that case.
        const task = await waitForTask(client, taskId);
        process.stderr.write('\n');
        console.log(opts.output === 'json' ? formatJson(task) : formatTaskDetail(task));
        process.exitCode = exitCodeForStatus(task.status);
        return;
      }

      if (opts.output === 'json') {
        // JSON consumers keep the existing ``TaskDetail`` contract.
        const task = await client.getTask(taskId);
        console.log(formatJson(task));
        return;
      }

      const { task, recentEvents } = await client.getStatusSnapshot(taskId);
      console.log(formatStatusSnapshot(task, recentEvents));
    });
}
