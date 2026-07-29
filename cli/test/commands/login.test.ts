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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeLoginCommand } from '../../src/commands/login';
import { saveConfig } from '../../src/config';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InitiateAuthCommand: jest.fn().mockImplementation((params) => ({ __command: 'InitiateAuth', ...params })),
  RespondToAuthChallengeCommand: jest.fn().mockImplementation((params) => ({ __command: 'RespondToAuthChallenge', ...params })),
  ChangePasswordCommand: jest.fn().mockImplementation((params) => ({ __command: 'ChangePassword', ...params })),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH', REFRESH_TOKEN_AUTH: 'REFRESH_TOKEN_AUTH' },
  ChallengeNameType: { NEW_PASSWORD_REQUIRED: 'NEW_PASSWORD_REQUIRED' },
}));

// Stub the confirmed-password prompt so the interactive first-login path can be
// exercised without a real TTY.
const mockPromptNewPassword = jest.fn();
jest.mock('../../src/commands/change-password', () => ({
  promptNewPasswordWithConfirmation: () => mockPromptNewPassword(),
}));

// Controllable readline so the non-TTY `promptPassword` path (piped stdin) can
// be driven deterministically — including the resolve-before-close ordering.
type RlHandlers = { line?: (line: string) => void; close?: () => void };
const rlHandlers: RlHandlers = {};
let rlCloseEmitsSynchronously = false;
jest.mock('readline', () => ({
  createInterface: jest.fn().mockImplementation(() => ({
    once: (event: string, handler: (...a: unknown[]) => void) => {
      if (event === 'line') rlHandlers.line = handler as (line: string) => void;
      if (event === 'close') rlHandlers.close = handler as () => void;
    },
    close: () => {
      // Mirror readline: 'close' fires synchronously from close().
      if (rlCloseEmitsSynchronously) rlHandlers.close?.();
    },
  })),
}));

describe('login command', () => {
  let tmpDir: string;
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
    saveConfig({
      api_url: 'https://api.example.com',
      region: 'us-east-1',
      user_pool_id: 'pool-id',
      client_id: 'client-id',
    });
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockSend.mockReset();
    mockPromptNewPassword.mockReset();
    rlHandlers.line = undefined;
    rlHandlers.close = undefined;
    rlCloseEmitsSynchronously = true;
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
  });

  test('logs in with username and password', async () => {
    mockSend.mockResolvedValue({
      AuthenticationResult: {
        IdToken: 'id-tok',
        AccessToken: 'access-tok',
        RefreshToken: 'ref-tok',
        ExpiresIn: 3600,
      },
    });

    const cmd = makeLoginCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--username', 'user@example.com',
      '--password', 'secret',
    ]);

    const creds = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'credentials.json'), 'utf-8'),
    );
    expect(creds.id_token).toBe('id-tok');
    expect(creds.access_token).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith('Login successful. Credentials saved.');
  });

  test('piped password (non-TTY, no --password): resolves before close so the race does not reject', async () => {
    // The regression: promptPassword closed the readline *before* resolving, and
    // 'close' fires synchronously and rejects "No password provided." — so a
    // successfully-read line was lost. With resolve-before-close a piped
    // password logs in cleanly.
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mockSend.mockResolvedValue({
      AuthenticationResult: { IdToken: 'piped-id', RefreshToken: 'piped-ref', ExpiresIn: 3600 },
    });

    try {
      const cmd = makeLoginCommand();
      const done = cmd.parseAsync(['node', 'test', '--username', 'user@example.com']);
      // Deliver the piped line; promptPassword then calls rl.close() (which our
      // mock fires synchronously) — resolve must have already won.
      rlHandlers.line?.('PipedPass1!');
      await done;

      const creds = JSON.parse(fs.readFileSync(path.join(tmpDir, 'credentials.json'), 'utf-8'));
      expect(creds.id_token).toBe('piped-id');
      const initiate = mockSend.mock.calls
        .map((c) => c[0])
        .find((c: { __command: string }) => c.__command === 'InitiateAuth');
      expect(initiate.AuthParameters.PASSWORD).toBe('PipedPass1!');
    } finally {
      if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor);
      else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    }
  });

  test('piped stdin closes with no line: rejects "No password provided."', async () => {
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const cmd = makeLoginCommand();
      const done = cmd.parseAsync(['node', 'test', '--username', 'user@example.com']);
      rlHandlers.close?.();
      await expect(done).rejects.toThrow('No password provided.');
    } finally {
      if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor);
      else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    }
  });

  // Command-layer seam test crossing login.ts → auth.ts. The auth-layer
  // "no callback" case tests a shape the CLI must actually produce; this proves
  // the command does not hand `login` a prompt when the account challenges for
  // a new password on a non-interactive invocation (`--password`), so the guard
  // in `login` fires with a clear error instead of hanging on stdin. This is
  // the seam that regressed when the callback was passed unconditionally.
  test('first-login challenge + non-interactive (--password) throws the guard error and never reads stdin', async () => {
    mockSend.mockResolvedValue({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-abc' });
    // If the command wrongly reached a stdin prompt this would hang the test;
    // spy so any read attempt is an assertable failure rather than a timeout.
    const stdinOn = jest.spyOn(process.stdin, 'on');
    const stdinResume = jest.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);

    const cmd = makeLoginCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--username', 'user@example.com',
        '--password', 'ExpiredTemp1!',
      ]),
    ).rejects.toThrow(/requires a new password on first login/);

    // The callback console line must not have been emitted, and no stdin
    // 'data' listener should have been attached to answer a prompt.
    expect(consoleSpy).not.toHaveBeenCalledWith('This account requires a new password on first login.');
    expect(stdinResume).not.toHaveBeenCalled();
    expect(stdinOn.mock.calls.some((c) => c[0] === 'data')).toBe(false);

    stdinOn.mockRestore();
    stdinResume.mockRestore();
  });

  test('interactive first-login (TTY, no --password) prompts for a new password and answers the challenge', async () => {
    mockSend.mockImplementation((cmd: { __command: string }) => {
      if (cmd.__command === 'InitiateAuth') {
        return Promise.resolve({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-abc' });
      }
      if (cmd.__command === 'RespondToAuthChallenge') {
        return Promise.resolve({
          AuthenticationResult: { IdToken: 'rotated-id', RefreshToken: 'rotated-ref', ExpiresIn: 3600 },
        });
      }
      throw new Error(`unexpected command ${cmd.__command}`);
    });
    mockPromptNewPassword.mockResolvedValue('N3w$trongPass!');

    // Force the interactive branch: TTY present, --password absent — this is the
    // only path that supplies the new-password callback to `login`. The initial
    // masked `promptPassword` reads from raw-mode stdin, so fake a TTY stdin and
    // feed the temp password through the 'data' handler it registers. Assigning
    // the methods directly (rather than jest.spyOn) is required because a piped
    // test stdin has no `setRawMode` to spy on.
    const original: Record<string, unknown> = {};
    const patch = (key: string, value: unknown): void => {
      original[key] = (process.stdin as unknown as Record<string, unknown>)[key];
      Object.defineProperty(process.stdin, key, { value, configurable: true });
    };
    const restore = (): void => {
      for (const [key, value] of Object.entries(original)) {
        Object.defineProperty(process.stdin, key, { value, configurable: true });
      }
    };
    patch('isTTY', true);
    patch('setRawMode', () => process.stdin);
    patch('resume', () => process.stdin);
    patch('pause', () => process.stdin);
    patch('removeListener', () => process.stdin);
    patch('on', (event: string, handler: (chunk: Buffer) => void) => {
      if (event === 'data') {
        // Deliver the temp password + Enter so promptPassword resolves.
        setImmediate(() => handler(Buffer.from('TempPass1!\n')));
      }
      return process.stdin;
    });

    try {
      const cmd = makeLoginCommand();
      await cmd.parseAsync(['node', 'test', '--username', 'user@example.com']);

      expect(mockPromptNewPassword).toHaveBeenCalledTimes(1);
      const challengeCall = mockSend.mock.calls
        .map((c) => c[0])
        .find((c: { __command: string }) => c.__command === 'RespondToAuthChallenge');
      expect(challengeCall).toMatchObject({
        ChallengeResponses: { USERNAME: 'user@example.com', NEW_PASSWORD: 'N3w$trongPass!' },
      });
      const creds = JSON.parse(fs.readFileSync(path.join(tmpDir, 'credentials.json'), 'utf-8'));
      expect(creds.id_token).toBe('rotated-id');
    } finally {
      restore();
    }
  });
});
