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

import { ApiClient } from '../src/api-client';
import { ApiError, CliError } from '../src/errors';
import { TaskDetail } from '../src/types';
import { exitCodeForStatus, waitForTask } from '../src/wait';

jest.mock('../src/api-client');

function makeTask(status: string): TaskDetail {
  return { task_id: 'task-1', status } as unknown as TaskDetail;
}

/** Drive a fake-timer poll loop: flush microtasks, advance all timers, repeat,
 *  so each ``abortableSleep`` resolves and the next ``getTask`` runs. */
async function flushPolls(iterations: number): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
    await Promise.resolve();
    jest.runOnlyPendingTimers();
  }
}

describe('exitCodeForStatus', () => {
  test('COMPLETED maps to exit 0', () => {
    expect(exitCodeForStatus('COMPLETED')).toBe(0);
  });

  test.each(['FAILED', 'CANCELLED', 'TIMED_OUT', 'RUNNING'])(
    '%s maps to exit 1',
    (status) => {
      expect(exitCodeForStatus(status)).toBe(1);
    },
  );
});

describe('waitForTask', () => {
  let mockGetTask: jest.Mock;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetTask = jest.fn();
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(
      () => ({ getTask: mockGetTask }) as unknown as ApiClient,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    stderrSpy.mockRestore();
  });

  test('returns immediately when the task is already terminal', async () => {
    mockGetTask.mockResolvedValue(makeTask('COMPLETED'));
    const client = new ApiClient();
    const task = await waitForTask(client, 'task-1');
    expect(task.status).toBe('COMPLETED');
    expect(mockGetTask).toHaveBeenCalledTimes(1);
  });

  test('polls until terminal', async () => {
    mockGetTask
      .mockResolvedValueOnce(makeTask('RUNNING'))
      .mockResolvedValueOnce(makeTask('RUNNING'))
      .mockResolvedValueOnce(makeTask('COMPLETED'));
    const client = new ApiClient();

    const promise = waitForTask(client, 'task-1');
    await flushPolls(4);
    const task = await promise;

    expect(task.status).toBe('COMPLETED');
    expect(mockGetTask).toHaveBeenCalledTimes(3);
  });

  test('tolerates a single transient network failure', async () => {
    const networkErr = new TypeError('fetch failed');
    mockGetTask
      .mockResolvedValueOnce(makeTask('RUNNING'))
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(makeTask('COMPLETED'));
    const client = new ApiClient();

    const promise = waitForTask(client, 'task-1');
    await flushPolls(5);
    const task = await promise;

    expect(task.status).toBe('COMPLETED');
    expect(mockGetTask).toHaveBeenCalledTimes(3);
  });

  test('gives up after exceeding the transient-failure budget', async () => {
    const networkErr = new TypeError('fetch failed');
    mockGetTask.mockRejectedValue(networkErr);
    const client = new ApiClient();

    const promise = waitForTask(client, 'task-1');
    const assertion = expect(promise).rejects.toThrow(CliError);
    await flushPolls(12);
    await assertion;
    // 5 retries tolerated, the 6th consecutive failure trips the budget.
    expect(mockGetTask).toHaveBeenCalledTimes(6);
  });

  test('propagates a 4xx error immediately (deterministic)', async () => {
    const apiErr = new ApiError(404, 'NOT_FOUND', 'no such task', 'req-1');
    mockGetTask.mockRejectedValue(apiErr);
    const client = new ApiClient();

    await expect(waitForTask(client, 'task-1')).rejects.toThrow(apiErr);
    expect(mockGetTask).toHaveBeenCalledTimes(1);
  });

  test('enforces the max-wait ceiling on a stuck task', async () => {
    mockGetTask.mockResolvedValue(makeTask('RUNNING'));
    const client = new ApiClient();

    // Tiny ceiling so the second poll observes elapsed >= maxWaitMs.
    const promise = waitForTask(client, 'task-1', { maxWaitMs: 1 });
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting/);
    await flushPolls(3);
    await assertion;
  });
});
