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
import { makeApproveCommand } from '../../src/commands/approve';
import { ApiError, CliError } from '../../src/errors';

jest.mock('../../src/api-client');

describe('approve command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockApproveTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockApproveTask.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      approveTask: mockApproveTask,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('sends approval with default scope this_call', async () => {
    mockApproveTask.mockResolvedValue({
      task_id: 'T1',
      request_id: 'R1',
      status: 'APPROVED',
      scope: 'this_call',
      decided_at: '2026-05-07T00:00:00Z',
    });

    await makeApproveCommand().parseAsync(['node', 'test', 'T1', 'R1']);

    expect(mockApproveTask).toHaveBeenCalledWith('T1', 'R1', 'this_call');
    expect(consoleSpy.mock.calls[0][0]).toContain('Approved R1');
    expect(consoleSpy.mock.calls[0][0]).toContain('scope="this_call"');
  });

  test('propagates custom scope', async () => {
    mockApproveTask.mockResolvedValue({
      task_id: 'T1',
      request_id: 'R1',
      status: 'APPROVED',
      scope: 'tool_type:Bash',
      decided_at: '2026-05-07T00:00:00Z',
    });
    await makeApproveCommand().parseAsync([
      'node', 'test', 'T1', 'R1', '--scope', 'tool_type:Bash',
    ]);
    expect(mockApproveTask).toHaveBeenCalledWith('T1', 'R1', 'tool_type:Bash');
  });

  test('refuses all_session without --yes', async () => {
    const cmd = makeApproveCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'T1', 'R1', '--scope', 'all_session']),
    ).rejects.toThrow(CliError);
    expect(mockApproveTask).not.toHaveBeenCalled();
  });

  test('accepts all_session with --yes', async () => {
    mockApproveTask.mockResolvedValue({
      task_id: 'T1',
      request_id: 'R1',
      status: 'APPROVED',
      scope: 'all_session',
      decided_at: '2026-05-07T00:00:00Z',
    });
    await makeApproveCommand().parseAsync([
      'node', 'test', 'T1', 'R1', '--scope', 'all_session', '--yes',
    ]);
    expect(mockApproveTask).toHaveBeenCalledWith('T1', 'R1', 'all_session');
  });

  test('outputs JSON when --output json', async () => {
    const data = { task_id: 'T', request_id: 'R', status: 'APPROVED', scope: 'this_call', decided_at: 't' };
    mockApproveTask.mockResolvedValue(data);
    await makeApproveCommand().parseAsync(['node', 'test', 'T', 'R', '--output', 'json']);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual(data);
  });

  test('404 → points to bgagent pending', async () => {
    mockApproveTask.mockRejectedValue(new ApiError(404, 'REQUEST_NOT_FOUND', 'nope', 'r'));
    const cmd = makeApproveCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'T', 'R'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('bgagent pending'),
    });
  });

  test('409 task-state → helpful message', async () => {
    mockApproveTask.mockRejectedValue(
      new ApiError(409, 'TASK_NOT_AWAITING_APPROVAL', 'cancelled', 'r'),
    );
    const cmd = makeApproveCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'T', 'R'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('cancelled'),
    });
  });

  test('401 → directs to bgagent login', async () => {
    mockApproveTask.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', '', ''));
    const cmd = makeApproveCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'T', 'R'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('bgagent login'),
    });
  });

  test('429 → rate limit message', async () => {
    mockApproveTask.mockRejectedValue(new ApiError(429, 'RATE_LIMIT_EXCEEDED', '', ''));
    const cmd = makeApproveCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'T', 'R'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('Rate limit'),
    });
  });
});
