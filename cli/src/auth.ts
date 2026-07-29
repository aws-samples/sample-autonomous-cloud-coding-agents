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

/**
 * In-flight refresh promise, memoized at module scope. Concurrent callers
 * that all observe an expired token (e.g. several ``ApiClient`` requests
 * firing in parallel) would otherwise each send their own
 * ``REFRESH_TOKEN_AUTH`` and race to ``saveCredentials`` — clobbering each
 * other's freshly-written tokens. Sharing one refresh promise collapses
 * those into a single Cognito round-trip; the slot is cleared when the
 * refresh settles so the next genuine expiry re-refreshes.
 */
let inFlightRefresh: Promise<void> | null = null;

/**
 * Prompt callback invoked when Cognito returns the ``NEW_PASSWORD_REQUIRED``
 * challenge on first login. Returning the new password lets ``login`` respond
 * to the challenge without pulling TTY/readline concerns into the auth layer.
 * The command layer supplies the interactive implementation.
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
    // Invited users sit in FORCE_CHANGE_PASSWORD under Cognito's default 7-day
    // TemporaryPasswordValidityDays. Once that window lapses the temp password
    // is dead and Cognito answers with a bare NotAuthorizedException — the same
    // error a genuinely wrong password produces, with nothing to say the temp
    // one merely expired. Point the teammate at the fix (a fresh invite) rather
    // than letting them retype a password that can never work again. We do not
    // include the attempted password or any secret in the message.
    if (err instanceof Error && err.name === 'NotAuthorizedException') {
      throw new CliError(
        'Login failed: incorrect password, or your temporary password expired. '
        + 'Temporary passwords lapse after a few days — ask your admin to re-run '
        + '`bgagent admin invite-user` for a fresh one.',
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

/**
 * Answer the first-login ``NEW_PASSWORD_REQUIRED`` challenge: prompt for a new
 * password (via the caller-supplied prompt) and exchange it for tokens.
 * ``ChallengeResponses`` carries the same ``USERNAME`` Cognito challenged plus
 * the ``NEW_PASSWORD``; the ``Session`` echoes the value from ``InitiateAuth``.
 */
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
    // Cognito rejects a policy-violating new password with
    // InvalidPasswordException; surface the server's guidance verbatim rather
    // than leaking a raw SDK stack.
    if (err instanceof Error && err.name === 'InvalidPasswordException') {
      throw new CliError(`New password rejected: ${err.message}`);
    }
    throw err;
  }
}

/** Shared shape of the tokens both ``InitiateAuth`` and challenge responses return. */
type AuthResult = {
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
} | undefined;

/** Validate and persist a Cognito auth result to the credentials cache. */
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
 * The REST API Gateway's Cognito authorizer validates **ID tokens** (checks
 * the `aud` claim against the app client ID). All CLI calls go through the
 * REST path, so this is the only token we need.
 */
export async function getAuthToken(): Promise<string> {
  const creds = await ensureFreshCredentials();
  return creds.id_token;
}

/** Internal: return non-expired credentials, refreshing if needed. */
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
  // Share a single in-flight refresh across concurrent callers so we do not
  // fire multiple ``REFRESH_TOKEN_AUTH`` calls that clobber each other's
  // ``saveCredentials``. The slot is cleared in ``finally`` so a later
  // expiry triggers a fresh refresh.
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
  // A corrupt token_expiry parses to NaN, and every comparison against NaN
  // is false — the token would be classified as never-expiring and surface
  // as an opaque 401 instead of a refresh. Treat unparseable as expired.
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

    const auth = result.AuthenticationResult;
    if (!auth?.IdToken || !auth.ExpiresIn) {
      throw new CliError('Unexpected refresh response from Cognito.');
    }

    const expiry = new Date(Date.now() + auth.ExpiresIn * 1000).toISOString();
    saveCredentials({
      id_token: auth.IdToken,
      refresh_token: creds.refresh_token,
      token_expiry: expiry,
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    // Distinguish a genuinely rejected/expired refresh token from a
    // transient transport failure. Only Cognito's auth-rejection error
    // names mean the session is really over; telling a user to re-login
    // over a network blip is wrong advice — and with the shared in-flight
    // refresh, that one blip's message reaches every concurrent caller.
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
 * not persist (only the ID + refresh tokens the REST authorizer needs). Rather
 * than widen the on-disk credential surface, we re-authenticate with the
 * supplied *current* password to mint a short-lived access token in memory.
 * That re-auth doubles as verification of the current password: a wrong one
 * fails here with a clear "current password is incorrect" message before any
 * change is attempted. Cognito enforces the password policy on the new value
 * server-side; a policy violation surfaces as ``InvalidPasswordException``.
 *
 * Requires an existing ``bgagent login`` session — the username is read from
 * the cached ID token so the user does not re-type their email.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const config = loadConfig();
  const username = usernameFromSession();
  const client = new CognitoIdentityProviderClient({ region: config.region });

  const accessToken = await accessTokenFor(client, config.client_id, username, currentPassword);

  try {
    await client.send(new ChangePasswordCommand({
      AccessToken: accessToken,
      PreviousPassword: currentPassword,
      ProposedPassword: newPassword,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'InvalidPasswordException') {
      // Cognito's message already states which policy rule failed.
      throw new CliError(`New password rejected: ${err.message}`);
    }
    if (err instanceof Error && err.name === 'LimitExceededException') {
      throw new CliError('Too many password-change attempts. Wait a few minutes and try again.');
    }
    throw err;
  }
}

/**
 * Read the signed-in user's Cognito username from the cached ID token.
 *
 * Requires a ``bgagent login`` session. The username lives in the ``email``
 * claim (the pool's sign-in alias); older tokens may only carry
 * ``cognito:username``. Never logs the token or its claims.
 */
function usernameFromSession(): string {
  const creds = loadCredentials();
  if (!creds) {
    throw new CliError('Not authenticated. Run `bgagent login` first.');
  }
  const JWT_SEGMENTS = 3; // header.payload.signature
  const parts = creds.id_token.split('.');
  if (parts.length !== JWT_SEGMENTS) {
    throw new CliError('Credentials file is corrupt. Run `bgagent login` to re-authenticate.');
  }
  let payload: { 'email'?: string; 'cognito:username'?: string };
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    throw new CliError('Credentials file is corrupt. Run `bgagent login` to re-authenticate.');
  }
  const username = payload.email ?? payload['cognito:username'];
  if (!username) {
    throw new CliError('Could not read your account identity. Run `bgagent login` to re-authenticate.');
  }
  return username;
}

/**
 * Re-authenticate to obtain a fresh, in-memory access token for
 * ``ChangePassword``. A wrong current password fails here with
 * ``NotAuthorizedException`` — surfaced as an actionable message.
 */
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
    // A challenge (e.g. NEW_PASSWORD_REQUIRED) or an unexpected shape — the
    // account is not in a state where a self-service change applies.
    throw new CliError(
      'Could not verify your current password. If this is your first login, '
      + 'run `bgagent login` to set a permanent password instead.',
    );
  }
  return accessToken;
}
