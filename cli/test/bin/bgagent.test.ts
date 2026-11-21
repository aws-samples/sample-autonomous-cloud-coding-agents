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
import { run } from '../../src/bin/bgagent';
import { isVerbose, setVerbose } from '../../src/debug';
import { CliError } from '../../src/errors';
import { waitForTask } from '../../src/wait';

jest.mock('../../src/api-client');
jest.mock('../../src/wait', () => ({
  ...jest.requireActual('../../src/wait'),
  waitForTask: jest.fn(),
}));

const waitForTaskMock = waitForTask as jest.Mock;

describe('bgagent entry point', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  const mockGetTask = jest.fn();
  const mockListWebhooks = jest.fn();
  const mockGetScoreboard = jest.fn();

  beforeEach(() => {
    // The entry point sets process.exitCode; a value left behind becomes the
    // exit code of the Jest worker.
    process.exitCode = undefined;
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    waitForTaskMock.mockReset();
    mockGetTask.mockReset().mockResolvedValue({ task_id: 't-1', status: 'RUNNING' });
    mockListWebhooks.mockReset().mockResolvedValue({ data: [], pagination: { next_token: null, has_more: false } });
    // With its `current`: the command takes an answer without one for that of an older stack.
    mockGetScoreboard.mockReset().mockResolvedValue({ range: '7d', current: {} });
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      getTask: mockGetTask,
      listWebhooks: mockListWebhooks,
      getScoreboard: mockGetScoreboard,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    process.exitCode = undefined;
    setVerbose(false);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('--verbose', () => {
    test('leaves debug output off without the flag', async () => {
      await run(['node', 'bgagent', 'webhook', 'list']);

      expect(isVerbose()).toBe(false);
      expect(mockListWebhooks).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['a top-level command', ['--verbose', 'status', 't-1', '--output', 'json']],
      ['a subcommand of a group', ['--verbose', 'webhook', 'list']],
      ['a subcommand of a group, flag last', ['webhook', 'list', '--verbose']],
    ])('turns debug output on for %s', async (_name, args) => {
      await run(['node', 'bgagent', ...args]);

      expect(isVerbose()).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });
  });

  test('has the stats command', async () => {
    await run(['node', 'bgagent', 'stats', '--output', 'json']);

    expect(mockGetScoreboard).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  describe('exit code', () => {
    test('is the code a CliError carries: 2 when --wait gives up', async () => {
      waitForTaskMock.mockRejectedValue(new CliError('Gave up waiting for task t-1', 2));

      await run(['node', 'bgagent', 'status', 't-1', '--wait']);

      expect(errorSpy).toHaveBeenCalledWith('Error: Gave up waiting for task t-1');
      expect(process.exitCode).toBe(2);
    });

    test('is 1 for an error that carries no code', async () => {
      mockGetTask.mockRejectedValue(new Error('socket hang up'));

      await run(['node', 'bgagent', 'status', 't-1', '--output', 'json']);

      expect(errorSpy).toHaveBeenCalledWith('Error: socket hang up');
      expect(process.exitCode).toBe(1);
    });
  });
});
