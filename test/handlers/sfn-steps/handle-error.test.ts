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

const mockFailTask = jest.fn();
const mockLoadTask = jest.fn();

jest.mock('../../../src/handlers/shared/orchestrator', () => ({
  failTask: (...args: unknown[]) => mockFailTask(...args),
  loadTask: (...args: unknown[]) => mockLoadTask(...args),
}));

import { handler } from '../../../src/handlers/sfn-steps/handle-error';
import type { TaskRecord } from '../../../src/handlers/shared/types';

const TASK: TaskRecord = {
  task_id: 'task-1',
  user_id: 'user-1',
  status: 'HYDRATING',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'HYDRATING#2025-03-15T10:00:00Z',
  created_at: '2025-03-15T10:00:00Z',
  updated_at: '2025-03-15T10:00:00Z',
};

beforeEach(() => jest.resetAllMocks());

test('fails task when task object is provided (reloads from DDB)', async () => {
  mockLoadTask.mockResolvedValue({ ...TASK, status: 'RUNNING' });
  mockFailTask.mockResolvedValue(undefined);

  const result = await handler({
    Error: 'States.TaskFailed',
    Cause: 'Container exited with code 1',
    task: TASK,
  });

  expect(mockLoadTask).toHaveBeenCalledWith('task-1');
  expect(mockFailTask).toHaveBeenCalledWith(
    'task-1',
    'RUNNING',
    'States.TaskFailed: Container exited with code 1',
    'user-1',
    true, // concurrencyAcquired: RUNNING !== SUBMITTED
  );
  expect(result).toEqual({ status: 'failed', error: 'States.TaskFailed: Container exited with code 1' });
});

test('loads task when only task_id and user_id are provided', async () => {
  mockLoadTask.mockResolvedValue({ ...TASK, status: 'RUNNING' });
  mockFailTask.mockResolvedValue(undefined);

  const result = await handler({
    Error: 'States.Timeout',
    Cause: 'Timed out',
    task_id: 'task-1',
    user_id: 'user-1',
  });

  expect(mockLoadTask).toHaveBeenCalledWith('task-1');
  expect(mockFailTask).toHaveBeenCalledWith(
    'task-1',
    'RUNNING',
    'States.Timeout: Timed out',
    'user-1',
    true,
  );
  expect(result).toEqual({ status: 'failed', error: 'States.Timeout: Timed out' });
});

test('returns error without calling failTask when no task_id', async () => {
  const result = await handler({
    Error: 'States.Runtime',
    Cause: 'Unknown error',
  });

  expect(mockFailTask).not.toHaveBeenCalled();
  expect(mockLoadTask).not.toHaveBeenCalled();
  expect(result).toEqual({ status: 'failed', error: 'States.Runtime: Unknown error' });
});

test('handles loadTask failure gracefully', async () => {
  mockLoadTask.mockRejectedValue(new Error('Task not found'));

  const result = await handler({
    Error: 'States.TaskFailed',
    Cause: 'Container crashed',
    task_id: 'task-missing',
    user_id: 'user-1',
  });

  expect(mockFailTask).not.toHaveBeenCalled();
  expect(result).toEqual({ status: 'failed', error: 'States.TaskFailed: Container crashed' });
});

test('sets concurrencyAcquired=false when task is SUBMITTED', async () => {
  mockLoadTask.mockResolvedValue({ ...TASK, status: 'SUBMITTED' });
  mockFailTask.mockResolvedValue(undefined);

  await handler({
    Error: 'Error',
    Cause: 'Admission failed',
    task: { ...TASK, status: 'SUBMITTED' } as TaskRecord,
  });

  expect(mockLoadTask).toHaveBeenCalledWith('task-1');
  expect(mockFailTask).toHaveBeenCalledWith(
    'task-1',
    'SUBMITTED',
    'Error: Admission failed',
    'user-1',
    false, // concurrencyAcquired: SUBMITTED === SUBMITTED
  );
});

test('handles error nested under $.error (catch path)', async () => {
  mockLoadTask.mockResolvedValue({ ...TASK, status: 'RUNNING' });
  mockFailTask.mockResolvedValue(undefined);

  const result = await handler({
    error: { Error: 'States.TaskFailed', Cause: 'Container exited' },
    task: TASK,
  } as unknown as Parameters<typeof handler>[0]);

  expect(mockFailTask).toHaveBeenCalledWith(
    'task-1',
    'RUNNING',
    'States.TaskFailed: Container exited',
    'user-1',
    true,
  );
  expect(result.error).toContain('States.TaskFailed');
});
