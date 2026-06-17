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

// Companion to jira.test.ts: covers the Linear adapter's CLI helper twins
// (openBrowser / upsertOauthSecret / command surface). These mirror the Jira
// helpers and were previously untested at the unit level.
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager';
import {
  makeLinearCommand,
  openBrowser,
  upsertOauthSecret,
} from '../../src/commands/linear';
import * as configMod from '../../src/config';
import type { StoredLinearOauthToken } from '../../src/linear-oauth';

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const linearLinkMock = jest.fn();
jest.mock('../../src/api-client', () => ({
  ApiClient: jest.fn(() => ({ linearLink: linearLinkMock })),
}));

// SecretsManagerClient — `list-projects` enumerates OAuth-install secrets.
const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  };
});

// CloudFormation — `getStackOutput` resolves stack outputs at setup time.
const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
  };
});

function sampleToken(overrides: Partial<StoredLinearOauthToken> = {}): StoredLinearOauthToken {
  return {
    access_token: 'access-xyz',
    refresh_token: 'refresh-xyz',
    expires_at: '2026-06-17T01:00:00.000Z',
    scope: 'read write',
    client_id: 'client-id',
    client_secret: 'client-secret',
    workspace_id: 'org-uuid',
    workspace_slug: 'acme',
    installed_at: '2026-06-17T00:00:00.000Z',
    updated_at: '2026-06-17T00:00:00.000Z',
    installed_by_platform_user_id: 'sub-abc',
    ...overrides,
  };
}

describe('linear openBrowser', () => {
  beforeEach(() => execFileMock.mockReset());

  test('resolves true when the OS opener succeeds', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    await expect(openBrowser('https://example.test')).resolves.toBe(true);
  });

  test('resolves false when the OS opener errors', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(new Error('no opener')));
    await expect(openBrowser('https://example.test')).resolves.toBe(false);
  });

  test.each([
    ['darwin', 'open'],
    ['win32', 'cmd'],
    ['linux', 'xdg-open'],
  ] as const)('invokes %s on %s', async (platform, expectedCmd) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    try {
      await openBrowser('https://example.test');
      expect(execFileMock.mock.calls[0]?.[0]).toBe(expectedCmd);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('linear upsertOauthSecret', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof upsertOauthSecret>[0];

  beforeEach(() => mockSend.mockReset());

  test('creates the secret and returns its ARN on first install', async () => {
    mockSend.mockResolvedValueOnce({ ARN: 'arn:new' });
    const arn = await upsertOauthSecret(mockClient, 'bgagent-linear-oauth-acme', sampleToken(), 'acme');
    expect(arn).toBe('arn:new');
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateSecretCommand);
  });

  test('falls back to PutSecretValue when the secret already exists', async () => {
    mockSend
      .mockRejectedValueOnce(new ResourceExistsException({ message: 'exists', $metadata: {} }))
      .mockResolvedValueOnce({ ARN: 'arn:existing' });
    const arn = await upsertOauthSecret(mockClient, 'bgagent-linear-oauth-acme', sampleToken(), 'acme');
    expect(arn).toBe('arn:existing');
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(PutSecretValueCommand);
  });

  test('rethrows non-ResourceExists errors', async () => {
    const err = new Error('kms denied');
    err.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(err);
    await expect(
      upsertOauthSecret(mockClient, 'bgagent-linear-oauth-acme', sampleToken(), 'acme'),
    ).rejects.toThrow('kms denied');
  });
});

describe('makeLinearCommand', () => {
  test('registers the expected subcommands', () => {
    const cmd = makeLinearCommand();
    expect(cmd.name()).toBe('linear');
    const names = cmd.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['app-template', 'setup', 'link']));
  });

  test('link --output json links and prints the result, skipping the preview', async () => {
    linearLinkMock.mockReset().mockResolvedValueOnce({ linked_at: '2026-06-17T03:00:00.000Z' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    try {
      const program = makeLinearCommand();
      await program.parseAsync(['node', 'bgagent', 'link', 'link-abc', '--output', 'json']);
      expect(linearLinkMock).toHaveBeenCalledTimes(1);
      expect(linearLinkMock).toHaveBeenCalledWith('link-abc');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('2026-06-17T03:00:00.000Z'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('link text mode previews via dry-run, prompts, then links on confirm', async () => {
    linearLinkMock
      .mockReset()
      .mockResolvedValueOnce({
        linear_user_name: 'Maya K',
        linear_user_email: 'maya@example.test',
        linear_workspace_slug: 'acme',
      })
      .mockResolvedValueOnce({ linked_at: '2026-06-17T04:00:00.000Z' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline') as typeof import('readline');
    // Linear's promptLine uses the non-TTY branch (rl.once('line', …)) under Jest.
    const rlMock = {
      once: (event: string, cb: (line: string) => void) => {
        if (event === 'line') cb('y');
      },
      close: jest.fn(),
    };
    const rlSpy = jest.spyOn(readline, 'createInterface').mockReturnValue(rlMock as unknown as ReturnType<typeof readline.createInterface>);
    try {
      const program = makeLinearCommand();
      await program.parseAsync(['node', 'bgagent', 'link', 'link-abc']);
      expect(linearLinkMock).toHaveBeenCalledWith('link-abc', { dryRun: true });
      expect(linearLinkMock).toHaveBeenCalledWith('link-abc');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Linear account linked'))).toBe(true);
    } finally {
      logSpy.mockRestore();
      rlSpy.mockRestore();
    }
  });

  test('setup aborts with a clear error when stack outputs are missing (covers getStackOutput)', async () => {
    cfnSend.mockReset().mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    try {
      const program = makeLinearCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'setup', 'acme']),
      ).rejects.toThrow(/missing outputs/);
    } finally {
      cfgSpy.mockRestore();
    }
  });

  test('list-projects exits when there are no OAuth installs in the registry', async () => {
    smSend.mockReset().mockResolvedValue({ SecretList: [], NextToken: undefined });
    const cfgSpy = jest.spyOn(configMod, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof configMod.loadConfig>);
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    try {
      const program = makeLinearCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'list-projects']),
      ).rejects.toThrow('process.exit:1');
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('No Linear OAuth installs'))).toBe(true);
    } finally {
      cfgSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('app-template rejects a --bot-name without the [bot] suffix', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    try {
      const program = makeLinearCommand();
      await expect(
        program.parseAsync(['node', 'bgagent', 'app-template', '--bot-name', 'notabot']),
      ).rejects.toThrow('process.exit:1');
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[bot]'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
