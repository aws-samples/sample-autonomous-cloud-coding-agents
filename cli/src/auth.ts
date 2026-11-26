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
  AuthFlowType,
  ChallengeNameType,
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { loadConfig, loadCredentials, saveCredentials } from './config';
import { debug } from './debug';
import { CliError } from './errors';
import { Credentials } from './types';
import { makeClient } from './ua';

const TOKEN_REFRESH_BUFFER_MINUTES = 5;
const TOKEN_REFRESH_BUFFER_MS = TOKEN_REFRESH_BUFFER_MINUTES * 60 * 1000;

let inFlightRefresh: Promise<void> | null = null;

/**
 * Prompt callback invoked when Cognito returns the ``NEW_PASSWORD_REQUIRED``
 * challenge on first login. Resolves to the new password.
 */
export type NewPasswordPrompt = () => Promise<string>;

/**
 * Authenticate with username/password and cache tokens.
 *
 * First-login rotation: admins invite users with a *temporary* password, so
 * the initial ``InitiateAuth`` returns a ``NEW_PASSWORD_REQUIRED`` challenge
 * instead of tokens. When ``promptNewPassword`` is supplied, we prompt for a
 * replacement, answer the challenge via ``RespondToAuthChallenge``, and persist
 * the resulting tokens. Without a prompt (e.g. ``--password`` passed
 * non-interactively) we surface a clear error rather than hanging.
 */
export async function login(
  username: string,
  password: string,
  promptNewPassword?: NewPasswordPrompt,
): Promise<void> {
  const config = loadConfig();
  debug(`Cognito region: ${config.region}, client_id: ${config.client_id}, user_pool_id: ${config.user_pool_id}`);
  const client = makeClient(CognitoIdentityProviderClient, { region: config.region });

  let result;
  try {
    result = await client.send(new InitiateAuthCommand({
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId: config.client_id,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'NotAuthorizedException') {
      throw new CliError(
        'Login failed: incorrect password, or your temporary password expired. '
        + 'Temporary passwords lapse after a few days — ask your admin to run '
        + '`bgagent admin reset-password <email>` for a fresh one.',
      );
    }
    throw err;
  }

  if (result.ChallengeName === ChallengeNameType.NEW_PASSWORD_REQUIRED) {
    const auth = await respondToNewPasswordChallenge(
      client,
      config.client_id,
      username,
      result.Session,
      promptNewPassword,
    );
    persistAuthResult(auth);
    return;
  }

  persistAuthResult(result.AuthenticationResult);
}

async function respondToNewPasswordChallenge(
  client: CognitoIdentityProviderClient,
  clientId: string,
  username: string,
  session: string | undefined,
  promptNewPassword?: NewPasswordPrompt,
): Promise<AuthResult> {
  if (!promptNewPassword) {
    throw new CliError(
      'This account requires a new password on first login. '
      + 'Run `bgagent login --username <email>` interactively (omit --password) '
      + 'so the CLI can prompt you to set one.',
    );
  }

  const newPassword = await promptNewPassword();
  try {
    const challengeResult = await client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: ChallengeNameType.NEW_PASSWORD_REQUIRED,
      Session: session,
      ChallengeResponses: {
        USERNAME: username,
        NEW_PASSWORD: newPassword,
      },
    }));
    return challengeResult.AuthenticationResult;
  } catch (err) {
    if (err instanceof Error && err.name === 'InvalidPasswordException') {
      throw new CliError(`New password rejected: ${err.message}`);
    }
    throw err;
  }
}

type AuthResult = {
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
} | undefined;

function persistAuthResult(auth: AuthResult): void {
  if (!auth?.IdToken || !auth.RefreshToken || !auth.ExpiresIn) {
    throw new CliError('Unexpected authentication response from Cognito.');
  }
  const expiry = new Date(Date.now() + auth.ExpiresIn * 1000).toISOString();
  saveCredentials({
    id_token: auth.IdToken,
    refresh_token: auth.RefreshToken,
    token_expiry: expiry,
  });
}

/** Get a valid auth token, refreshing automatically if needed.
 *
 * The REST API Gateway's Cognito authorizer validates **ID tokens**.
 */
export async function getAuthToken(): Promise<string> {
  const creds = await ensureFreshCredentials();
  return creds.id_token;
}

async function ensureFreshCredentials(): Promise<Credentials> {
  const creds = loadCredentials();
  if (!creds) {
    throw new CliError('Not authenticated. Run `bgagent login` first.');
  }
  if (!isExpired(creds)) {
    debug('Using cached tokens (not expired)');
    return creds;
  }
  debug('Tokens expired or near expiry, refreshing...');
  if (!inFlightRefresh) {
    inFlightRefresh = refreshToken(creds).finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;
  const fresh = loadCredentials();
  if (!fresh) {
    throw new CliError('Credentials vanished after refresh. Run `bgagent login`.');
  }
  return fresh;
}

function isExpired(creds: Credentials): boolean {
  const expiryMs = new Date(creds.token_expiry).getTime();
  if (!Number.isFinite(expiryMs)) {
    return true;
  }
  return Date.now() >= expiryMs - TOKEN_REFRESH_BUFFER_MS;
}

async function refreshToken(creds: Credentials): Promise<void> {
  const config = loadConfig();
  const client = makeClient(CognitoIdentityProviderClient, { region: config.region });

  try {
    const result = await client.send(new InitiateAuthCommand({
      AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
      ClientId: config.client_id,
      AuthParameters: {
        REFRESH_TOKEN: creds.refresh_token,
      },
    }));
    // A refresh renews the ID token only: the cached refresh token stays.
    persistAuthResult({ ...result.AuthenticationResult, RefreshToken: creds.refresh_token });
  } catch (err) {
    if (err instanceof CliError) throw err;
    const name = (err as Error)?.name;
    if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
      throw new CliError('Session expired. Run `bgagent login` to re-authenticate.');
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Token refresh failed (${detail}). Retry, or run \`bgagent login\` if it persists.`);
  }
}

/**
 * Rotate the current user's Cognito password.
 *
 * ``ChangePassword`` requires a Cognito **access token**, which the CLI does
 * not persist, so this re-authenticates with the supplied *current* password:
 * a wrong one fails with a "current password is incorrect" message before any
 * change is attempted. Cognito enforces the password policy on the new value
 * server-side.
 *
 * Requires an existing ``bgagent login`` session — the username is read from
 * the cached ID token.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const config = loadConfig();
  const username = usernameFromSession();
  const client = makeClient(CognitoIdentityProviderClient, { region: config.region });

  const accessToken = await accessTokenFor(client, config.client_id, username, currentPassword);

  try {
    await client.send(new ChangePasswordCommand({
      AccessToken: accessToken,
      PreviousPassword: currentPassword,
      ProposedPassword: newPassword,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'InvalidPasswordException') {
      throw new CliError(`New password rejected: ${err.message}`);
    }
    if (err instanceof Error && err.name === 'LimitExceededException') {
      throw new CliError('Too many password-change attempts. Wait a few minutes and try again.');
    }
    throw err;
  }
}

function sessionClaims(): { 'sub'?: string; 'email'?: string; 'cognito:username'?: string } {
  const creds = loadCredentials();
  if (!creds?.id_token) {
    throw new CliError('Not authenticated. Run `bgagent login` first.');
  }
  const JWT_SEGMENTS = 3;
  const parts = String(creds.id_token).split('.');
  if (parts.length !== JWT_SEGMENTS) {
    throw new CliError('Credentials file is corrupt. Run `bgagent login` to re-authenticate.');
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) ?? {};
  } catch {
    throw new CliError('Credentials file is corrupt. Run `bgagent login` to re-authenticate.');
  }
}

function usernameFromSession(): string {
  const claims = sessionClaims();
  const username = claims.email ?? claims['cognito:username'];
  if (!username) {
    throw new CliError('Could not read your account identity. Run `bgagent login` to re-authenticate.');
  }
  return username;
}

/**
 * Read the signed-in user's Cognito ``sub``, the platform user id, from the
 * cached ID token.
 */
export function cognitoSubFromSession(): string {
  const { sub } = sessionClaims();
  if (!sub) {
    throw new CliError('Could not read your account identity. Run `bgagent login` to re-authenticate.');
  }
  return sub;
}

async function accessTokenFor(
  client: CognitoIdentityProviderClient,
  clientId: string,
  username: string,
  currentPassword: string,
): Promise<string> {
  let result;
  try {
    result = await client.send(new InitiateAuthCommand({
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId: clientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: currentPassword,
      },
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'NotAuthorizedException') {
      throw new CliError('Current password is incorrect.');
    }
    throw err;
  }

  const accessToken = result.AuthenticationResult?.AccessToken;
  if (!accessToken) {
    throw new CliError(
      'Could not verify your current password. If this is your first login, '
      + 'run `bgagent login` to set a permanent password instead.',
    );
  }
  return accessToken;
}
