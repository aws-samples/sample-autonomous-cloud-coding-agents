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
import { makePendingCommand } from '../../src/commands/pending';
import { ApiError } from '../../src/errors';

jest.mock('../../src/api-client');

describe('pending command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockListPending = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockListPending.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      listPending: mockListPending,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('prints "(no pending approvals)" on empty response', async () => {
    mockListPending.mockResolvedValue({ pending: [] });
    await makePendingCommand().parseAsync(['node', 'test']);
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('no pending approvals');
  });

  test('renders each pending approval with approve/deny hints', async () => {
    mockListPending.mockResolvedValue({
      pending: [
        {
          task_id: 'T1',
          request_id: 'R1',
          tool_name: 'Bash',
          tool_input_preview: 'git push --force',
          severity: 'high',
          reason: 'force_push_any',
          created_at: '2026-05-07T00:00:00Z',
          timeout_s: 300,
          expires_at: '2026-05-07T00:05:00Z',
        },
      ],
    });

    await makePendingCommand().parseAsync(['node', 'test']);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('T1');
    expect(out).toContain('R1');
    expect(out).toContain('git push --force');
    expect(out).toContain('bgagent approve T1 R1');
    expect(out).toContain('bgagent deny T1 R1');
    expect(out).toContain('high');
  });

  test('outputs JSON when --output json', async () => {
    const payload = { pending: [] };
    mockListPending.mockResolvedValue(payload);
    await makePendingCommand().parseAsync(['node', 'test', '--output', 'json']);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual(payload);
  });

  test('401 → directs to bgagent login', async () => {
    mockListPending.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', '', ''));
    const cmd = makePendingCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('bgagent login'),
    });
  });

  test('429 → rate limit message', async () => {
    mockListPending.mockRejectedValue(new ApiError(429, 'RATE_LIMIT_EXCEEDED', '', ''));
    const cmd = makePendingCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('Rate limit'),
    });
  });
});
