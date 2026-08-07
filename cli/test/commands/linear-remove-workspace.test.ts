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
    });

    await runRemove(['acme', '--yes']);

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith('acme', { purge: false });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('revoked');
  });

  test('--purge forwards purge=true to the API', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'purged',
      secret_deleted: true,
    });

    await runRemove(['acme', '--yes', '--purge']);

    expect(mockRemove).toHaveBeenCalledWith('acme', { purge: true });
  });

  test('rejects an invalid slug without hitting the API', async () => {
    await expect(runRemove(['a', '--yes'])).rejects.toBeInstanceOf(CliError);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test('surfaces the API error (does not swallow)', async () => {
    mockRemove.mockRejectedValue(new CliError('Workspace not found.'));
    await expect(runRemove(['ghost', '--yes'])).rejects.toThrow('Workspace not found.');
  });

  test('does not claim any project-mapping cleanup in the success output', async () => {
    // Mapping cleanup was dropped (rows carry no workspace id); the command
    // must not report a mapping count or a checkmark implying it ran.
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret_deleted: true,
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('mapping(s) removed');
    expect(out).toContain('mappings left in place');
  });

  test('reports when the OAuth secret was already absent (secret_deleted: false)', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret_deleted: false,
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('already absent');
  });

  // ─── Confirmation prompt (the destructive-command safety rail) ──────────
  // Without --yes the command reads a slug via promptLine and must abort on
  // mismatch. Under Jest, promptLine takes the non-TTY readline branch.
  function mockPromptLine(returned: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline') as typeof import('readline');
    const rlMock = {
      once: (event: string, cb: (line: string) => void) => {
        if (event === 'line') cb(returned);
      },
      close: jest.fn(),
    };
    return jest.spyOn(readline, 'createInterface')
      .mockReturnValue(rlMock as unknown as ReturnType<typeof readline.createInterface>);
  }

  test('aborts without calling the API when the typed confirmation does not match the slug', async () => {
    const rlSpy = mockPromptLine('wrong-slug');
    try {
      await runRemove(['acme']);
      expect(mockRemove).not.toHaveBeenCalled();
      const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('Aborted');
    } finally {
      rlSpy.mockRestore();
    }
  });

  test('proceeds when the typed confirmation matches the slug', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret_deleted: true,
    });
    const rlSpy = mockPromptLine('acme');
    try {
      await runRemove(['acme']);
      expect(mockRemove).toHaveBeenCalledWith('acme', { purge: false });
    } finally {
      rlSpy.mockRestore();
    }
  });
});
