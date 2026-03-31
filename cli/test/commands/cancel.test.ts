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

import { ApiClient } from '../../src/api-client';
import { makeCancelCommand } from '../../src/commands/cancel';

jest.mock('../../src/api-client');

describe('cancel command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockCancelTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockCancelTask.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: mockCancelTask,
      getTaskEvents: jest.fn(),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('cancels a task', async () => {
    mockCancelTask.mockResolvedValue({
      task_id: 'abc',
      status: 'CANCELLED',
      cancelled_at: '2026-01-01T00:00:00Z',
    });

    const cmd = makeCancelCommand();
    await cmd.parseAsync(['node', 'test', 'abc']);

    expect(mockCancelTask).toHaveBeenCalledWith('abc');
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('abc');
    expect(output).toContain('cancelled');
  });

  test('outputs JSON when --output json', async () => {
    const cancelData = { task_id: 'abc', status: 'CANCELLED', cancelled_at: '2026-01-01T00:00:00Z' };
    mockCancelTask.mockResolvedValue(cancelData);

    const cmd = makeCancelCommand();
    await cmd.parseAsync(['node', 'test', 'abc', '--output', 'json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(cancelData, null, 2));
  });
});
