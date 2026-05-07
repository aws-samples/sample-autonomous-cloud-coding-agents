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
import { makeNudgeCommand } from '../../src/commands/nudge';
import { ApiError, CliError } from '../../src/errors';

jest.mock('../../src/api-client');

describe('nudge command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockNudgeTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockNudgeTask.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      nudgeTask: mockNudgeTask,
      getTaskEvents: jest.fn(),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('sends a nudge and prints confirmation on 202 success', async () => {
    mockNudgeTask.mockResolvedValue({
      task_id: 'TASK-123',
      nudge_id: 'NUDGE-abc',
      submitted_at: '2026-04-22T10:00:00Z',
    });

    const cmd = makeNudgeCommand();
    await cmd.parseAsync(['node', 'test', 'TASK-123', 'also update the README']);

    expect(mockNudgeTask).toHaveBeenCalledWith('TASK-123', 'also update the README');
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('NUDGE-abc');
    expect(output).toContain('TASK-123');
    expect(output).toContain('2026-04-22T10:00:00Z');
  });

  test('trims whitespace from the message before sending', async () => {
    mockNudgeTask.mockResolvedValue({
      task_id: 'TASK-123',
      nudge_id: 'NUDGE-abc',
      submitted_at: '2026-04-22T10:00:00Z',
    });

    const cmd = makeNudgeCommand();
    await cmd.parseAsync(['node', 'test', 'TASK-123', '   focus on auth   ']);

    expect(mockNudgeTask).toHaveBeenCalledWith('TASK-123', 'focus on auth');
  });

  test('outputs JSON when --output json', async () => {
    const nudgeData = {
      task_id: 'TASK-123',
      nudge_id: 'NUDGE-abc',
      submitted_at: '2026-04-22T10:00:00Z',
    };
    mockNudgeTask.mockResolvedValue(nudgeData);

    const cmd = makeNudgeCommand();
    await cmd.parseAsync(['node', 'test', 'TASK-123', 'hello', '--output', 'json']);

    const output = consoleSpy.mock.calls[0][0] as string;
    // Should be valid JSON matching the payload.
    expect(JSON.parse(output)).toEqual(nudgeData);
  });

  test('refuses empty message client-side without hitting the server', async () => {
    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', '   ']),
    ).rejects.toThrow(CliError);
    expect(mockNudgeTask).not.toHaveBeenCalled();
  });

  test('401 unauthenticated → points user to `bgagent login`', async () => {
    mockNudgeTask.mockRejectedValue(
      new ApiError(401, 'UNAUTHORIZED', 'Missing token', 'req-1'),
    );

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', 'hello']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('bgagent login'),
    });
  });

  test('400 guardrail blocked → shows reason verbatim', async () => {
    mockNudgeTask.mockRejectedValue(
      new ApiError(
        400,
        'GUARDRAIL_BLOCKED',
        'Nudge blocked by guardrail: policy-violation (GUARDRAIL_BLOCKED)',
        'req-2',
      ),
    );

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', 'bad message']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('policy-violation'),
    });
  });

  test('429 rate limit → tells user to slow down', async () => {
    mockNudgeTask.mockRejectedValue(
      new ApiError(429, 'RATE_LIMITED', 'Too many nudges', 'req-3'),
    );

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', 'hello']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringMatching(/rate limit|slow down/i),
    });
  });

  test('404 not found → clear "task not found" message', async () => {
    mockNudgeTask.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', 'Task does not exist', 'req-4'),
    );

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-missing', 'hello']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringMatching(/task not found/i),
    });
  });

  test('403 forbidden → "not your task" message', async () => {
    mockNudgeTask.mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', 'Access denied', 'req-5'),
    );

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', 'hello']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringMatching(/another user|not your/i),
    });
  });

  test('503 service unavailable → retry hint, no API call retry loop', async () => {
    mockNudgeTask.mockRejectedValue(
      new ApiError(503, 'SERVICE_UNAVAILABLE', 'Content screening is temporarily unavailable.', 'req-6'),
    );

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', 'hello']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringMatching(/unavailable|retry/i),
    });
    expect(mockNudgeTask).toHaveBeenCalledTimes(1);
  });

  test('over-limit message rejected client-side without API call', async () => {
    const oversized = 'x'.repeat(2001);

    const cmd = makeNudgeCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'TASK-123', oversized]),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringMatching(/maximum length|2000/i),
    });
    expect(mockNudgeTask).not.toHaveBeenCalled();
  });
});
