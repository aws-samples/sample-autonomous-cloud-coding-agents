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
import { makeLinearCommand } from '../../src/commands/linear';
import { CliError } from '../../src/errors';

jest.mock('../../src/api-client');

const mockRemove = jest.fn();

function installMockClient() {
  (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
    linearRemoveWorkspace: mockRemove,
  }) as unknown as ApiClient);
}

/** Run `bgagent linear remove-workspace ...`. */
async function runRemove(args: string[]): Promise<void> {
  const cmd = makeLinearCommand();
  await cmd.parseAsync(['node', 'test', 'remove-workspace', ...args]);
}

describe('linear remove-workspace command', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    mockRemove.mockReset();
    installMockClient();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('--yes skips the prompt and calls DELETE with default flags', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret_deleted: true,
      mappings_removed: 0,
    });

    await runRemove(['acme', '--yes']);

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith('acme', { purge: false, keepMappings: false });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('revoked');
  });

  test('--purge forwards purge=true to the API', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'purged',
      secret_deleted: true,
      mappings_removed: 0,
    });

    await runRemove(['acme', '--yes', '--purge']);

    expect(mockRemove).toHaveBeenCalledWith('acme', { purge: true, keepMappings: false });
  });

  test('--keep-mappings forwards keepMappings=true to the API', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret_deleted: true,
      mappings_removed: 0,
    });

    await runRemove(['acme', '--yes', '--keep-mappings']);

    expect(mockRemove).toHaveBeenCalledWith('acme', { purge: false, keepMappings: true });
  });

  test('rejects an invalid slug without hitting the API', async () => {
    await expect(runRemove(['a', '--yes'])).rejects.toBeInstanceOf(CliError);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test('surfaces the API error (does not swallow)', async () => {
    mockRemove.mockRejectedValue(new CliError('Workspace not found.'));
    await expect(runRemove(['ghost', '--yes'])).rejects.toThrow('Workspace not found.');
  });

  test('reports mapping removals in the success output', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret_deleted: true,
      mappings_removed: 4,
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('4');
  });
});
