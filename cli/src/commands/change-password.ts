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

import { Command } from 'commander';
import { changePassword } from '../auth';
import { CliError } from '../errors';
import { promptSecret } from '../prompt-secret';

/**
 * Prompt for a new password twice and confirm the two entries match. Shared by
 * ``bgagent change-password`` and the first-login ``NEW_PASSWORD_REQUIRED``
 * challenge in ``bgagent login`` so both use the same masked, confirmed prompt.
 *
 * Cognito enforces the real password policy server-side; we only guard against
 * a typo (mismatch) and an empty entry here — leaking policy specifics client
 * side would drift from the pool config.
 */
export async function promptNewPasswordWithConfirmation(): Promise<string> {
  const next = await promptSecret('New password: ');
  if (!next) {
    throw new CliError('New password cannot be empty.');
  }
  const confirm = await promptSecret('Confirm new password: ');
  if (next !== confirm) {
    throw new CliError('Passwords do not match.');
  }
  return next;
}

/**
 * ``bgagent change-password`` — rotate the signed-in user's Cognito password.
 *
 * Interactive: prompts for the current password, then the new password twice.
 * Delegates to ``changePassword`` in the auth layer, which verifies the current
 * password and lets Cognito enforce the password policy on the new one.
 */
export function makeChangePasswordCommand(): Command {
  return new Command('change-password')
    .description('Change your Cognito password (requires an active `bgagent login` session)')
    .action(async () => {
      const currentPassword = await promptSecret('Current password: ');
      if (!currentPassword) {
        throw new CliError('Current password cannot be empty.');
      }
      const newPassword = await promptNewPasswordWithConfirmation();
      await changePassword(currentPassword, newPassword);
      console.log('Password changed successfully.');
    });
}
