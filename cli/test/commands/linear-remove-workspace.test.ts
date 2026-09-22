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
    // Mapping cleanup was dropped (rows carry no workspace id); the command
    // must not report a mapping count or a checkmark implying it ran.
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
    // `absent` means teardown IS finished — no vault follow-up must appear.
    expect(out).not.toContain('delete-oauth2-credential-provider');
  });

  // ─── Vault-managed teardown is incomplete (the B1 bug) ──────────────────
  // `secret: 'absent'` and `secret: 'not_applicable'` both mean "no secret was
  // deleted", but only the first means the workspace is fully torn down. When a
  // provider name comes back, an AgentCore credential provider outside
  // CloudFormation still holds the Linear client secret and a live refresh
  // grant, and the operator has to delete it by hand. Collapsing the two into
  // one boolean is what hid that.
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
    // The provider name is minted at onboarding and the response is the only
    // authority on it — a CLI that rebuilt `<prefix><slug>` would print a
    // command that silently no-ops if the convention ever changes.
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
    // A vault row can also have had its own secret deleted; the follow-up is
    // driven by `provider_name`, not by the secret outcome.
    expect(out).toContain('✓ OAuth secret deleted');
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
});
