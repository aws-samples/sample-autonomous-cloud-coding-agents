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

import type { TaskStatusType } from '../../constructs/task-status';
import { failTask, loadTask } from '../shared/orchestrator';
import type { TaskRecord } from '../shared/types';

interface CatchError {
  readonly Error: string;
  readonly Cause: string;
}

interface HandleErrorInput {
  readonly Error?: string;
  readonly Cause?: string;
  readonly error?: CatchError;
  readonly task_id?: string;
  readonly user_id?: string;
  readonly task?: TaskRecord;
  readonly concurrencyAcquired?: boolean;
}

interface HandleErrorOutput {
  readonly status: string;
  readonly error: string;
}

export async function handler(event: HandleErrorInput): Promise<HandleErrorOutput> {
  // Error/Cause may be at top level (direct invoke) or nested under $.error (catch path)
  const errorObj = event.error ?? event;
  const errorMessage = `${errorObj.Error ?? 'Unknown'}: ${errorObj.Cause ?? 'Unknown'}`;
  const taskId = event.task_id ?? event.task?.task_id;
  const userId = event.user_id ?? event.task?.user_id;

  if (taskId && userId) {
    // Always reload from DynamoDB to get the actual current status
    let currentStatus: TaskStatusType | undefined;
    try {
      const loaded = await loadTask(taskId);
      currentStatus = loaded.status;
    } catch {
      // Task may not exist or may have been deleted
    }
    if (currentStatus) {
      const concurrencyAcquired = event.concurrencyAcquired ?? currentStatus !== 'SUBMITTED';
      await failTask(taskId, currentStatus, errorMessage, userId, concurrencyAcquired);
    }
  }

  return { status: 'failed', error: errorMessage };
}
