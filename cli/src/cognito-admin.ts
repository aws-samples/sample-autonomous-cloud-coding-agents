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

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { tryLoadConfig } from './config';
import { CliError } from './errors';
import { DEFAULT_STACK_NAME, resolveOperatorContext } from './operator-context';
import { getStackOutput, resolveConfigureBundleFromStack } from './stack-outputs';
import { CliConfig } from './types';

export interface CognitoAdminContext {
  readonly region: string;
  readonly userPoolId: string;
  /** Present when all four configure fields are known (config file or stack outputs). */
  readonly configureBundle: CliConfig | null;
}

export interface CognitoUserSummary {
  readonly username: string;
  readonly status: string;
  readonly enabled: boolean;
  readonly created_at?: string;
  readonly email?: string;
}

/** Resolve user pool + optional configure bundle from config or stack outputs. */
export async function resolveCognitoAdminContext(opts: {
  region?: string;
  stackName?: string;
}): Promise<CognitoAdminContext> {
  const { region, stackName } = resolveOperatorContext({
    region: opts.region,
    stackName: opts.stackName,
  });

  const configured = tryLoadConfig();
  let userPoolId = configured?.user_pool_id;

  if (!userPoolId) {
    userPoolId = await getStackOutput(region, stackName, 'UserPoolId') ?? undefined;
  }

  if (!userPoolId) {
    throw new CliError(
      'Cognito user pool ID is required. Run `bgagent configure --user-pool-id …` '
      + 'or pass `--stack-name` so the CLI can read `UserPoolId` from CloudFormation outputs.',
    );
  }

  const configureBundle = await resolveConfigureBundle(region, stackName, configured, userPoolId);

  return { region, userPoolId, configureBundle };
}

async function resolveConfigureBundle(
  region: string,
  stackName: string,
  configured: CliConfig | null,
  userPoolId: string,
): Promise<CliConfig | null> {
  if (configured?.api_url && configured.client_id && configured.user_pool_id) {
    return configured;
  }

  const fromStack = await resolveConfigureBundleFromStack(region, stackName);
  if (fromStack) {
    return {
      ...fromStack,
      user_pool_id: fromStack.user_pool_id ?? userPoolId,
    };
  }

  return null;
}

export function cognitoClient(region: string): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region });
}

/** Permissive email-shape check — Cognito does the real validation. */
export function assertLikelyEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CliError(
      `'${email}' does not look like a valid email. The Cognito pool requires email as the username.`,
    );
  }
}

/** Create a Cognito user with verified email and suppressed welcome email. */
export async function adminCreateUser(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
  temporaryPassword: string,
): Promise<void> {
  try {
    await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      TemporaryPassword: temporaryPassword,
      MessageAction: 'SUPPRESS',
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'UsernameExistsException') {
      throw new CliError(
        `User ${email} already exists. Use a different email, or run `
        + `\`bgagent admin delete-user ${email}\` and try again.`,
      );
    }
    throw err;
  }
}

/** Set a permanent password (skips FORCE_CHANGE_PASSWORD on first login). */
export async function adminSetPermanentPassword(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  emailOrUsername: string,
  password: string,
): Promise<void> {
  const username = await resolveCognitoUsername(client, userPoolId, emailOrUsername);
  await client.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: username,
    Password: password,
    Permanent: true,
  }));
}

/** Create user + set permanent password; surfaces half-failure diagnostics. */
export async function adminInviteUser(
  ctx: CognitoAdminContext,
  email: string,
  password: string,
): Promise<void> {
  const client = cognitoClient(ctx.region);
  await adminCreateUser(client, ctx.userPoolId, email, password);
  try {
    await adminSetPermanentPassword(client, ctx.userPoolId, email, password);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : 'Error';
    throw new CliError(
      `User ${email} was created but the password could not be set `
      + `(${errorName}: ${message}). The user is now stuck in FORCE_CHANGE_PASSWORD `
      + 'state and cannot log in. Either:\n'
      + `  1. Delete and re-run: bgagent admin delete-user ${email} --stack-name ${DEFAULT_STACK_NAME}\n`
      + '  2. Or reset the password: bgagent admin reset-password '
      + `${email} --stack-name ${DEFAULT_STACK_NAME}`,
    );
  }
}

export async function adminDeleteUser(
  ctx: CognitoAdminContext,
  emailOrUsername: string,
): Promise<void> {
  const client = cognitoClient(ctx.region);
  const username = await resolveCognitoUsername(client, ctx.userPoolId, emailOrUsername);

  try {
    await client.send(new AdminDeleteUserCommand({
      UserPoolId: ctx.userPoolId,
      Username: username,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'UserNotFoundException') {
      throw new CliError(`User ${emailOrUsername} was not found in pool ${ctx.userPoolId}.`);
    }
    throw err;
  }
}

export async function adminResetPassword(
  ctx: CognitoAdminContext,
  email: string,
  password: string,
): Promise<void> {
  const client = cognitoClient(ctx.region);
  try {
    await adminSetPermanentPassword(client, ctx.userPoolId, email, password);
  } catch (err) {
    if (err instanceof Error && err.name === 'UserNotFoundException') {
      throw new CliError(`User ${email} was not found in pool ${ctx.userPoolId}.`);
    }
    throw err;
  }
}

export async function listCognitoUsers(ctx: CognitoAdminContext): Promise<CognitoUserSummary[]> {
  const client = cognitoClient(ctx.region);
  const users: CognitoUserSummary[] = [];
  let paginationToken: string | undefined;

  do {
    const result = await client.send(new ListUsersCommand({
      UserPoolId: ctx.userPoolId,
      PaginationToken: paginationToken,
    }));
    for (const user of result.Users ?? []) {
      users.push(mapCognitoUser(user));
    }
    paginationToken = result.PaginationToken;
  } while (paginationToken);

  return users.sort((a, b) =>
    displayUserIdentity(a).localeCompare(displayUserIdentity(b), undefined, { sensitivity: 'base' }),
  );
}

export function mapCognitoUser(user: UserType): CognitoUserSummary {
  const emailAttr = user.Attributes?.find((a) => a.Name === 'email')?.Value;
  return {
    username: user.Username ?? '(unknown)',
    status: user.UserStatus ?? 'UNKNOWN',
    enabled: user.Enabled ?? false,
    created_at: user.UserCreateDate?.toISOString(),
    email: emailAttr,
  };
}

/** Sign-in identity for operators (email attribute, or Cognito Username when email is unset). */
export function displayUserIdentity(user: CognitoUserSummary): string {
  return user.email ?? user.username;
}

/** Map Cognito Username (often the task `user_id` / sub UUID) to email for operator display. */
export async function buildCognitoEmailByUsername(
  ctx: CognitoAdminContext,
): Promise<Map<string, string>> {
  const users = await listCognitoUsers(ctx);
  const byUsername = new Map<string, string>();
  for (const user of users) {
    if (user.email) {
      byUsername.set(user.username, user.email);
    }
  }
  return byUsername;
}

/** Resolve a task/concurrency `user_id` to an operator-friendly email label. */
export function resolveUserEmailForDisplay(
  userId: string,
  emailByUsername: ReadonlyMap<string, string>,
): string {
  if (userId.includes('@')) {
    return userId;
  }
  return emailByUsername.get(userId) ?? '-';
}

/**
 * Resolve the Cognito `Username` for admin API calls.
 * Email-alias pools store a UUID in `Username` while the email lives in attributes.
 */
export async function resolveCognitoUsername(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  emailOrUsername: string,
): Promise<string> {
  if (!emailOrUsername.includes('@')) {
    return emailOrUsername;
  }

  const result = await client.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `email = "${emailOrUsername}"`,
    Limit: 1,
  }));

  const username = result.Users?.[0]?.Username;
  if (!username) {
    throw new CliError(`User ${emailOrUsername} was not found in pool ${userPoolId}.`);
  }

  return username;
}
