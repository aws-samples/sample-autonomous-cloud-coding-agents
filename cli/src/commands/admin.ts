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

import * as crypto from 'crypto';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { Command } from 'commander';
import { loadConfig } from '../config';
import { CliError } from '../errors';
import { CliConfig } from '../types';

/**
 * Generate a strong temporary password meeting Cognito's default policy:
 * min 12 chars, with at least one upper, lower, digit, and symbol.
 *
 * Uses node crypto for cryptographic randomness; the symbol set excludes
 * `'` `"` `\` `` ` `` to keep the password copy-pasteable across shells
 * without escaping pain.
 */
export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // ambiguous chars (I/O) removed
  const lower = 'abcdefghijkmnpqrstuvwxyz'; // (l/o) removed
  const digit = '23456789'; // (0/1) removed
  const symbol = '!@#$%^&*()-_=+[]{}<>?';
  const all = upper + lower + digit + symbol;

  const pickFrom = (set: string): string => set[crypto.randomInt(set.length)];

  // One required char from each class, then 14 more random chars (>= 12 total).
  const chars: string[] = [pickFrom(upper), pickFrom(lower), pickFrom(digit), pickFrom(symbol)];
  for (let i = 0; i < 14; i += 1) {
    chars.push(pickFrom(all));
  }

  // Fisher-Yates shuffle so the required chars don't land at predictable indices
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Encode the four configure-fields as a single base64 bundle Alice can paste
 * into `bgagent configure --from-bundle`. Bundle is Cognito-only — Linear /
 * Slack onboarding is per-deployment, not per-user.
 */
export function encodeBundle(config: CliConfig): string {
  const json = JSON.stringify({
    api_url: config.api_url,
    region: config.region,
    user_pool_id: config.user_pool_id,
    client_id: config.client_id,
  });
  return Buffer.from(json, 'utf-8').toString('base64');
}

/**
 * Decode a base64 bundle back to a CliConfig. Throws CliError on malformed
 * input. Validates all four required fields are present and non-empty so a
 * truncated paste fails fast instead of writing a half-broken config.json.
 */
export function decodeBundle(bundle: string): CliConfig {
  let json: string;
  try {
    json = Buffer.from(bundle.trim(), 'base64').toString('utf-8');
  } catch {
    throw new CliError('Invalid bundle: not valid base64.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CliError('Invalid bundle: decoded payload is not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CliError('Invalid bundle: decoded payload is not an object.');
  }
  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of ['api_url', 'region', 'user_pool_id', 'client_id']) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new CliError(`Invalid bundle: missing or empty fields ${missing.join(', ')}.`);
  }
  return {
    api_url: obj.api_url as string,
    region: obj.region as string,
    user_pool_id: obj.user_pool_id as string,
    client_id: obj.client_id as string,
  };
}

/**
 * `bgagent admin invite-user <email>` — wraps Cognito admin-create-user +
 * admin-set-user-password and prints a shareable bundle. Requires the caller
 * to have AWS credentials with cognito-idp:AdminCreateUser permission on the
 * configured user pool (i.e. they're a stack admin / IAM principal, not just
 * a Cognito-authenticated end-user).
 *
 * Bundle distribution is intentionally manual — Slack/1Password/email is
 * usually fine, and adding SES introduces verified-identity gates and PII
 * handling that aren't worth the polish for a self-hosted tool.
 */
export function makeAdminCommand(): Command {
  const admin = new Command('admin').description('Admin commands for managing the deployment');

  admin.addCommand(
    new Command('invite-user')
      .description('Create a Cognito user and print a shareable config bundle')
      .argument('<email>', 'Email address of the new user')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option(
        '--temp-password <pwd>',
        'Temporary password (default: auto-generated, must meet Cognito policy)',
      )
      .action(async (email: string, opts) => {
        const config = loadConfig();
        const region = opts.region ?? config.region;

        if (!isLikelyEmail(email)) {
          throw new CliError(
            `'${email}' does not look like a valid email. The Cognito pool requires email as the username.`,
          );
        }

        const tempPassword = opts.tempPassword ?? generateTempPassword();

        const cognito = new CognitoIdentityProviderClient({ region });
        try {
          await cognito.send(new AdminCreateUserCommand({
            UserPoolId: config.user_pool_id,
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
            ],
            TemporaryPassword: tempPassword,
            MessageAction: 'SUPPRESS',
          }));
        } catch (err) {
          if (err instanceof Error && err.name === 'UsernameExistsException') {
            throw new CliError(
              `User ${email} already exists. Re-run with a different email, or delete the user first via the AWS console.`,
            );
          }
          throw err;
        }

        // The user has been created at this point. If `AdminSetUserPassword`
        // fails (stricter password policy than the generator, partial IAM
        // grant on the Set verb, throttling, etc.) the user is left in
        // `FORCE_CHANGE_PASSWORD` state — they exist in the pool but
        // can't actually log in. Surface a clear diagnostic so the
        // admin knows to either retry the password set manually or
        // delete the half-created user before re-running.
        try {
          await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: config.user_pool_id,
            Username: email,
            Password: tempPassword,
            Permanent: true,
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorName = err instanceof Error ? err.name : 'Error';
          throw new CliError(
            `User ${email} was created but the password could not be set `
            + `(${errorName}: ${message}). The user is now stuck in FORCE_CHANGE_PASSWORD `
            + 'state and cannot log in. Either:\n'
            + `  1. Delete the user and re-run: aws cognito-idp admin-delete-user --user-pool-id ${config.user_pool_id} --username ${email}\n`
            + '  2. Or set the password manually via the AWS console once the underlying issue is fixed.',
          );
        }

        const bundle = encodeBundle(config);
        printInviteSummary(email, tempPassword, bundle);
      }),
  );

  return admin;
}

/** Permissive email-shape check — Cognito does the real validation. */
function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function printInviteSummary(email: string, tempPassword: string, bundle: string): void {
  const bar = '─'.repeat(64);
  console.log();
  console.log(`✓ Created Cognito user ${email}`);
  console.log('✓ Set permanent password (no first-login change required)');
  console.log();
  console.log('Share with the new teammate:');
  console.log(bar);
  console.log(`  email:    ${email}`);
  console.log(`  password: ${tempPassword}`);
  console.log(`  bundle:   ${bundle}`);
  console.log(bar);
  console.log();
  console.log('They run:');
  console.log(`  bgagent configure --from-bundle ${bundle}`);
  console.log(`  bgagent login --username ${email}`);
}
