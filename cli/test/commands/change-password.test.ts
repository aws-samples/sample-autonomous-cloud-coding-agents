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

import { changePassword } from '../../src/auth';
import { makeChangePasswordCommand, promptNewPasswordWithConfirmation } from '../../src/commands/change-password';
import { CliError } from '../../src/errors';
import { promptSecret } from '../../src/prompt-secret';

jest.mock('../../src/auth');
jest.mock('../../src/prompt-secret');

const mockChangePassword = changePassword as jest.MockedFunction<typeof changePassword>;
const mockPromptSecret = promptSecret as jest.MockedFunction<typeof promptSecret>;

/** Queue prompt answers in the order the command reads them. */
function queuePrompts(...answers: string[]): void {
  mockPromptSecret.mockReset();
  for (const a of answers) {
    mockPromptSecret.mockResolvedValueOnce(a);
  }
}

describe('change-password command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockChangePassword.mockReset();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  test('prompts current + new (twice), calls changePassword, and reports success', async () => {
    queuePrompts('OldPass1!', 'N3w$trongPass!', 'N3w$trongPass!');
    mockChangePassword.mockResolvedValue();

    await makeChangePasswordCommand().parseAsync(['node', 'change-password']);

    expect(mockChangePassword).toHaveBeenCalledWith('OldPass1!', 'N3w$trongPass!');
    expect(consoleSpy).toHaveBeenCalledWith('Password changed successfully.');
  });

  test('rejects when the two new-password entries do not match (no change attempted)', async () => {
    queuePrompts('OldPass1!', 'N3w$trongPass!', 'typo-mismatch');

    await expect(makeChangePasswordCommand().parseAsync(['node', 'change-password'])).rejects.toThrow(
      'Passwords do not match.',
    );
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  test('rejects an empty current password (no change attempted)', async () => {
    queuePrompts('');

    await expect(makeChangePasswordCommand().parseAsync(['node', 'change-password'])).rejects.toThrow(
      'Current password cannot be empty.',
    );
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  test('surfaces a weak-new-password policy error from the auth layer', async () => {
    queuePrompts('OldPass1!', 'weak', 'weak');
    mockChangePassword.mockRejectedValue(
      new CliError('New password rejected: Password did not conform with policy.'),
    );

    await expect(makeChangePasswordCommand().parseAsync(['node', 'change-password'])).rejects.toThrow(
      /New password rejected/,
    );
  });

  test('propagates a no-session error from the auth layer', async () => {
    queuePrompts('OldPass1!', 'N3w$trongPass!', 'N3w$trongPass!');
    mockChangePassword.mockRejectedValue(new CliError('Not authenticated. Run `bgagent login` first.'));

    await expect(makeChangePasswordCommand().parseAsync(['node', 'change-password'])).rejects.toThrow(
      'Not authenticated',
    );
  });
});

describe('promptNewPasswordWithConfirmation', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns the value when both entries match', async () => {
    queuePrompts('N3w$trongPass!', 'N3w$trongPass!');
    await expect(promptNewPasswordWithConfirmation()).resolves.toBe('N3w$trongPass!');
  });

  test('rejects an empty new password', async () => {
    queuePrompts('');
    await expect(promptNewPasswordWithConfirmation()).rejects.toThrow('New password cannot be empty.');
  });

  test('rejects on mismatch', async () => {
    queuePrompts('a-strong-one', 'a-different-one');
    await expect(promptNewPasswordWithConfirmation()).rejects.toThrow('Passwords do not match.');
  });
});
