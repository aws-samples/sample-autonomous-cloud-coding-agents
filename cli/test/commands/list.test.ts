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
import { makeListCommand } from '../../src/commands/list';

jest.mock('../../src/api-client');

describe('list command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockListTasks = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockListTasks.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: mockListTasks,
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      getTaskEvents: jest.fn(),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('lists tasks with default options', async () => {
    mockListTasks.mockResolvedValue({
      data: [{
        task_id: 'abc',
        status: 'RUNNING',
        repo: 'owner/repo',
        issue_number: 1,
        task_description: null,
        branch_name: 'bgagent/abc/fix',
        pr_url: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }],
      pagination: { next_token: null, has_more: false },
    });

    const cmd = makeListCommand();
    await cmd.parseAsync(['node', 'test']);

    expect(mockListTasks).toHaveBeenCalledWith({
      status: undefined,
      repo: undefined,
      limit: undefined,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  test('passes filter options', async () => {
    mockListTasks.mockResolvedValue({
      data: [],
      pagination: { next_token: null, has_more: false },
    });

    const cmd = makeListCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--status', 'RUNNING,SUBMITTED',
      '--repo', 'owner/repo',
      '--limit', '10',
    ]);

    expect(mockListTasks).toHaveBeenCalledWith({
      status: 'RUNNING,SUBMITTED',
      repo: 'owner/repo',
      limit: 10,
    });
  });

  test('shows pagination hint when has_more', async () => {
    mockListTasks.mockResolvedValue({
      data: [],
      pagination: { next_token: 'tok', has_more: true },
    });

    const cmd = makeListCommand();
    await cmd.parseAsync(['node', 'test']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('More results available'))).toBe(true);
  });
});
