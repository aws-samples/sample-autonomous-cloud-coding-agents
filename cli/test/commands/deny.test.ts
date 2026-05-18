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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiClient } from '../../src/api-client';
import { makeDenyCommand } from '../../src/commands/deny';
import { ApiError, CliError } from '../../src/errors';

jest.mock('../../src/api-client');

describe('deny command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockDenyTask = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockDenyTask.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      denyTask: mockDenyTask,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('sends denial without reason', async () => {
    mockDenyTask.mockResolvedValue({
      task_id: 'T1', request_id: 'R1', status: 'DENIED', decided_at: 't',
    });
    await makeDenyCommand().parseAsync(['node', 'test', 'T1', 'R1']);
    expect(mockDenyTask).toHaveBeenCalledWith('T1', 'R1', undefined);
  });

  test('sends denial with --reason', async () => {
    mockDenyTask.mockResolvedValue({
      task_id: 'T', request_id: 'R', status: 'DENIED', decided_at: 't',
    });
    await makeDenyCommand().parseAsync([
      'node', 'test', 'T', 'R', '--reason', '  use force-with-lease  ',
    ]);
    expect(mockDenyTask).toHaveBeenCalledWith('T', 'R', 'use force-with-lease');
  });

  test('reads reason from --reason-file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-deny-'));
    const p = path.join(tmp, 'reason.txt');
    fs.writeFileSync(p, '\ntry the pre-receive hook first\n');
    try {
      mockDenyTask.mockResolvedValue({
        task_id: 'T', request_id: 'R', status: 'DENIED', decided_at: 't',
      });
      await makeDenyCommand().parseAsync([
        'node', 'test', 'T', 'R', '--reason-file', p,
      ]);
      expect(mockDenyTask).toHaveBeenCalledWith('T', 'R', 'try the pre-receive hook first');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects both --reason and --reason-file', async () => {
    const cmd = makeDenyCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync([
        'node', 'test', 'T', 'R',
        '--reason', 'a',
        '--reason-file', '/tmp/doesnotexist',
      ]),
    ).rejects.toThrow(CliError);
    expect(mockDenyTask).not.toHaveBeenCalled();
  });

  test('rejects reason over DENY_REASON_MAX_LENGTH locally', async () => {
    const cmd = makeDenyCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync([
        'node', 'test', 'T', 'R', '--reason', 'x'.repeat(2500),
      ]),
    ).rejects.toThrow(CliError);
    expect(mockDenyTask).not.toHaveBeenCalled();
  });

  test('404 → points to bgagent pending', async () => {
    mockDenyTask.mockRejectedValue(new ApiError(404, 'REQUEST_NOT_FOUND', 'nope', 'r'));
    const cmd = makeDenyCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'T', 'R'])).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('bgagent pending'),
    });
  });
});
