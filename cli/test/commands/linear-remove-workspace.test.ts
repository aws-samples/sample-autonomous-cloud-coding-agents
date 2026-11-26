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

import { PassThrough } from 'stream';
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

async function runRemove(args: string[]): Promise<void> {
  const cmd = makeLinearCommand();
  await cmd.parseAsync(['node', 'test', 'remove-workspace', ...args]);
}

describe('linear remove-workspace command', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mockRemove.mockReset();
    installMockClient();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    logSpy.mockRestore();
  });

  test('--yes skips the prompt and calls DELETE with default flags', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret: 'deleted',
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
      secret: 'deleted',
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
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret: 'deleted',
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('mapping(s) removed');
    expect(out).toContain('mappings left in place');
  });

  test("reports when the OAuth secret was already absent (secret: 'absent')", async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret: 'absent',
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('already absent');
    expect(out).not.toContain('delete-oauth2-credential-provider');
  });

  test('prints the AgentCore follow-up command for a vault-managed workspace', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret: 'not_applicable',
      provider_name: 'bgagent-linear-oauth-acme',
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('vault-managed');
    expect(out).toContain('Teardown is NOT complete');
    expect(out).toContain(
      'aws bedrock-agentcore-control delete-oauth2-credential-provider --name bgagent-linear-oauth-acme',
    );
  });

  test('echoes the returned provider name verbatim rather than deriving it from the slug', async () => {
    mockRemove.mockResolvedValue({
      workspace_slug: 'acme',
      linear_workspace_id: 'ws-uuid-1',
      status: 'revoked',
      secret: 'deleted',
      provider_name: 'legacy-linear-provider-acme-7f3a',
    });

    await runRemove(['acme', '--yes']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('--name legacy-linear-provider-acme-7f3a');
    expect(out).not.toContain('--name bgagent-linear-oauth-acme');
    expect(out).toContain('✓ OAuth secret deleted');
  });

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
      secret: 'deleted',
    });
    const rlSpy = mockPromptLine('acme');
    try {
      await runRemove(['acme']);
      expect(mockRemove).toHaveBeenCalledWith('acme', { purge: false });
    } finally {
      rlSpy.mockRestore();
    }
  });

  describe('with the confirmation read from a pipe, through the real readline', () => {
    let stdin: PassThrough;
    let restore: () => void;

    beforeEach(() => {
      stdin = new PassThrough();
      const original = Object.getOwnPropertyDescriptor(process, 'stdin');
      Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      restore = () => {
        stderrSpy.mockRestore();
        if (original) Object.defineProperty(process, 'stdin', original);
      };
    });

    afterEach(() => restore());

    test('removes the workspace when the line is the slug', async () => {
      mockRemove.mockResolvedValue({
        workspace_slug: 'acme',
        linear_workspace_id: 'ws-uuid-1',
        status: 'revoked',
        secret: 'deleted',
      });
      stdin.end('acme\n');

      await runRemove(['acme']);

      expect(mockRemove).toHaveBeenCalledWith('acme', { purge: false });
    });

    test('aborts when the line is not the slug', async () => {
      stdin.end('not-the-slug\n');

      await runRemove(['acme']);

      expect(mockRemove).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Aborted');
    });

    test('fails, and removes nothing, when the input ends before a line', async () => {
      stdin.end();

      await expect(runRemove(['acme'])).rejects.toThrow('No input provided.');
      expect(mockRemove).not.toHaveBeenCalled();
    });
  });
});
