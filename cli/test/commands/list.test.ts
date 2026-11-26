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

  const task = (id: string) => ({
    task_id: id,
    status: 'FAILED',
    repo: 'owner/repo',
    issue_number: 1,
    task_description: null,
    branch_name: `bgagent/${id}/fix`,
    pr_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });

  test('follows next_token when a page holds fewer tasks than asked for', async () => {
    // The API reads a bounded number of rows per request: with --repo or --status the
    // tasks that match can all lie behind them.
    mockListTasks
      .mockResolvedValueOnce({ data: [], pagination: { next_token: 'T1', has_more: true } })
      .mockResolvedValueOnce({ data: [task('task-0')], pagination: { next_token: null, has_more: false } });

    const cmd = makeListCommand();
    await cmd.parseAsync(['node', 'test', '--repo', 'owner/repo']);

    // The table and nothing else: not 'No tasks found.' followed by the hint.
    const printed = consoleSpy.mock.calls.map(c => c[0] as string);
    expect(printed).toEqual([expect.stringContaining('task-0')]);
    expect(mockListTasks).toHaveBeenCalledTimes(2);
    expect(mockListTasks).toHaveBeenLastCalledWith({ status: undefined, repo: 'owner/repo', limit: 20, nextToken: 'T1' });
  });

  test('lists more tasks than one page holds, asking each further page only for the tasks still missing', async () => {
    // The API returns at most 100 tasks per request.
    const page = (first: number, count: number, token: string) => ({
      data: Array.from({ length: count }, (_, i) => task(`task-${first + i}`)),
      pagination: { next_token: token, has_more: true },
    });
    mockListTasks
      .mockResolvedValueOnce(page(0, 100, 'T1'))
      .mockResolvedValueOnce(page(100, 100, 'T2'))
      .mockResolvedValueOnce(page(200, 50, 'T3'));

    const cmd = makeListCommand();
    await cmd.parseAsync(['node', 'test', '--status', 'FAILED', '--limit', '250', '--output', 'json']);

    expect(mockListTasks.mock.calls).toEqual([
      [{ status: 'FAILED', repo: undefined, limit: 250 }],
      [{ status: 'FAILED', repo: undefined, limit: 150, nextToken: 'T1' }],
      [{ status: 'FAILED', repo: undefined, limit: 50, nextToken: 'T2' }],
    ]);
    // No task is dropped, so the last token resumes right after the last one printed.
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({
      data: Array.from({ length: 250 }, (_, i) => task(`task-${i}`)),
      pagination: { next_token: 'T3', has_more: true },
    }, null, 2));
  });

  test('stops after 5 requests when every page is empty and promises more', async () => {
    mockListTasks.mockResolvedValue({ data: [], pagination: { next_token: 'tok', has_more: true } });

    const cmd = makeListCommand();
    await cmd.parseAsync(['node', 'test', '--status', 'FAILED']);

    expect(mockListTasks).toHaveBeenCalledTimes(5);
    const printed = consoleSpy.mock.calls.map(c => c[0] as string);
    expect(printed).toEqual(['No tasks found.', '\n(More results available)']);
  });

  test.each(['0', '-5', 'abc'])('takes --limit %s for none given', async (limit) => {
    mockListTasks
      .mockResolvedValueOnce({ data: [], pagination: { next_token: 'T1', has_more: true } })
      .mockResolvedValueOnce({ data: [task('task-0')], pagination: { next_token: null, has_more: false } });

    const cmd = makeListCommand();
    await cmd.parseAsync(['node', 'test', '--limit', limit]);

    // 20 are wanted, the page size the API defaults to.
    expect(mockListTasks).toHaveBeenLastCalledWith({ status: undefined, repo: undefined, limit: 20, nextToken: 'T1' });
  });
});
