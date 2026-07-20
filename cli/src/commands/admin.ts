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
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  adminDeleteUser,
  adminInviteUser,
  adminResetPassword,
  assertLikelyEmail,
  listCognitoUsers,
  resolveCognitoAdminContext,
} from '../cognito-admin';
import { getConfigDir, SECRET_FILE_MODE } from '../config';
import { CliError } from '../errors';
import { DEFAULT_STACK_NAME } from '../operator-context';
import { CliConfig } from '../types';

/**
 * Generate a strong password meeting Cognito's default policy:
 * min 12 chars, with at least one upper, lower, digit, and symbol.
 */
export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%^&*()-_=+[]{}<>?';
  const all = upper + lower + digit + symbol;

  const pickFrom = (set: string): string => set[crypto.randomInt(set.length)];

  const RANDOM_FILL_CHARS = 14;
  const chars: string[] = [pickFrom(upper), pickFrom(lower), pickFrom(digit), pickFrom(symbol)];
  for (let i = 0; i < RANDOM_FILL_CHARS; i += 1) {
    chars.push(pickFrom(all));
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Encode configure fields as a base64 bundle for `bgagent configure --from-bundle`. */
export function encodeBundle(config: CliConfig): string {
  const json = JSON.stringify({
    api_url: config.api_url,
    region: config.region,
    user_pool_id: config.user_pool_id,
    client_id: config.client_id,
  });
  return Buffer.from(json, 'utf-8').toString('base64');
}

/** Decode a base64 configure bundle. */
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

const ADMIN_OPTS = {
  region: '--region <region>',
  stackName: '--stack-name <name>',
} as const;

function addAdminContextOptions(cmd: Command): Command {
  return cmd
    .option(ADMIN_OPTS.region, 'AWS region (defaults to configured region or AWS_REGION)')
    .option(ADMIN_OPTS.stackName, 'CloudFormation stack name', DEFAULT_STACK_NAME);
}

const ADMIN_EMAIL_COLUMN_WIDTH = 36;
const ADMIN_USERNAME_COLUMN_WIDTH = 36;
const ADMIN_STATUS_COLUMN_WIDTH = 22;
const ADMIN_ENABLED_COLUMN_WIDTH = 8;

/** Cognito user-pool administration for stack admins (operator IAM credentials). */
export function makeAdminCommand(): Command {
  const admin = new Command('admin')
    .description('Cognito user-pool administration (operator AWS credentials)');

  admin.addCommand(
    addAdminContextOptions(
      new Command('invite-user')
        .description('Create a Cognito user with a permanent password and optional configure bundle')
        .argument('<email>', 'Email address of the new user (Cognito username)')
        .option('--password <pwd>', 'Permanent password (default: auto-generated)')
        .option('--temp-password <pwd>', 'Alias for --password')
        .action(async (email: string, opts) => {
          assertLikelyEmail(email);
          const ctx = await resolveCognitoAdminContext(opts);
          const password = opts.password ?? opts.tempPassword ?? generateTempPassword();
          await adminInviteUser(ctx, email, password);

          const bundle = ctx.configureBundle ? encodeBundle(ctx.configureBundle) : null;
          printInviteSummary(email, password, bundle);
        }),
    ),
  );

  admin.addCommand(
    addAdminContextOptions(
      new Command('list-users')
        .description('List Cognito users in the deployment user pool')
        .option('--output <format>', 'Output format: text or json', 'text')
        .action(async (opts) => {
          const ctx = await resolveCognitoAdminContext(opts);
          const users = await listCognitoUsers(ctx);

          if (opts.output === 'json') {
            console.log(JSON.stringify({ user_pool_id: ctx.userPoolId, users }, null, 2));
            return;
          }

          if (users.length === 0) {
            console.log(`No users in pool ${ctx.userPoolId}.`);
            return;
          }

          console.log(`User pool: ${ctx.userPoolId}`);
          console.log(
            `${'EMAIL'.padEnd(ADMIN_EMAIL_COLUMN_WIDTH)} `
            + `${'USERNAME'.padEnd(ADMIN_USERNAME_COLUMN_WIDTH)} `
            + `${'STATUS'.padEnd(ADMIN_STATUS_COLUMN_WIDTH)} `
            + `${'ENABLED'.padEnd(ADMIN_ENABLED_COLUMN_WIDTH)} CREATED`,
          );
          for (const user of users) {
            console.log(
              `${(user.email ?? '-').padEnd(ADMIN_EMAIL_COLUMN_WIDTH)} `
              + `${user.username.padEnd(ADMIN_USERNAME_COLUMN_WIDTH)} `
              + `${user.status.padEnd(ADMIN_STATUS_COLUMN_WIDTH)} `
              + `${String(user.enabled).padEnd(ADMIN_ENABLED_COLUMN_WIDTH)} `
              + `${user.created_at ?? '-'}`,
            );
          }
        }),
    ),
  );

  admin.addCommand(
    addAdminContextOptions(
      new Command('delete-user')
        .description('Delete a Cognito user from the user pool')
        .argument('<email>', 'Email / username of the user to delete')
        .action(async (email: string, opts) => {
          assertLikelyEmail(email);
          const ctx = await resolveCognitoAdminContext(opts);
          await adminDeleteUser(ctx, email);
          console.log(`✓ Deleted Cognito user ${email}`);
        }),
    ),
  );

  admin.addCommand(
    addAdminContextOptions(
      new Command('reset-password')
        .description('Set a new permanent password for an existing Cognito user')
        .argument('<email>', 'Email / username of the user')
        .option('--password <pwd>', 'New permanent password (default: auto-generated)')
        .action(async (email: string, opts) => {
          assertLikelyEmail(email);
          const ctx = await resolveCognitoAdminContext(opts);
          const password = opts.password ?? generateTempPassword();
          await adminResetPassword(ctx, email, password);
          const invitePath = writeCredentialsFile(email, password, null, 'password-reset');
          console.log();
          console.log(`✓ Reset password for ${email}`);
          console.log(`  New password written to: ${invitePath}`);
        }),
    ),
  );

  return admin;
}

function printInviteSummary(email: string, password: string, bundle: string | null): void {
  const invitePath = writeCredentialsFile(email, password, bundle, 'invite');

  const SUMMARY_BAR_WIDTH = 64;
  const bar = '─'.repeat(SUMMARY_BAR_WIDTH);
  console.log();
  console.log(`✓ Created Cognito user ${email}`);
  console.log('✓ Set permanent password (no first-login change required)');
  if (bundle) {
    console.log('✓ Included configure bundle for `bgagent configure --from-bundle`');
  } else {
    console.log('  (Configure bundle unavailable — run `bgagent platform outputs` then `bgagent configure`.)');
  }
  console.log();
  console.log('Credentials written to (owner-readable only):');
  console.log(bar);
  console.log(`  ${invitePath}`);
  console.log(bar);
  console.log();
  if (bundle) {
    console.log('Next steps for this user:');
    console.log('  bgagent configure --from-bundle <bundle from file>');
    console.log(`  bgagent login --username ${email}`);
    console.log();
  }
  console.log('Share the file over a secure channel for teammates, then delete it:');
  console.log(`  rm ${invitePath}`);
}

function credentialsFilePath(email: string): string {
  const inviteDir = path.join(getConfigDir(), 'invites');
  return path.join(inviteDir, `${email.replace(/[^a-zA-Z0-9.@_-]/g, '_')}.txt`);
}

function writeCredentialsFile(
  email: string,
  password: string,
  bundle: string | null,
  kind: 'invite' | 'password-reset',
): string {
  const inviteDir = path.join(getConfigDir(), 'invites');
  fs.mkdirSync(inviteDir, { recursive: true, mode: 0o700 });
  const invitePath = credentialsFilePath(email);
  const lines = [
    `email:    ${email}`,
    `password: ${password}`,
  ];
  if (bundle) {
    lines.push(`bundle:   ${bundle}`, '');
    lines.push('Run:');
    lines.push(`  bgagent configure --from-bundle ${bundle}`);
    lines.push(`  bgagent login --username ${email}`);
  } else if (kind === 'password-reset') {
    lines.push('', 'Run:', `  bgagent login --username ${email}`);
  }
  lines.push('');
  fs.writeFileSync(invitePath, lines.join('\n'), { mode: SECRET_FILE_MODE });
  fs.chmodSync(invitePath, SECRET_FILE_MODE);
  return invitePath;
}
