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

const mockFinalizeTask = jest.fn();

jest.mock('../../../src/handlers/shared/orchestrator', () => ({
  finalizeTask: (...args: unknown[]) => mockFinalizeTask(...args),
}));

import { handler } from '../../../src/handlers/sfn-steps/finalize-task';
import type { TaskRecord } from '../../../src/handlers/shared/types';

const TASK: TaskRecord = {
  task_id: 'task-1',
  user_id: 'user-1',
  status: 'RUNNING',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'RUNNING#2025-03-15T10:00:00Z',
  created_at: '2025-03-15T10:00:00Z',
  updated_at: '2025-03-15T10:00:00Z',
};

beforeEach(() => jest.resetAllMocks());

test('finalizes task and returns status', async () => {
  mockFinalizeTask.mockResolvedValue(undefined);

  const result = await handler({ task: TASK });

  expect(mockFinalizeTask).toHaveBeenCalledWith('task-1', { attempts: 1 }, 'user-1');
  expect(result).toEqual({ status: 'finalized' });
});
