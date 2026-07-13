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
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { loadConfig, loadCredentials, saveCredentials } from './config';
import { debug } from './debug';
import { CliError } from './errors';
import { Credentials } from './types';

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

/** Authenticate with username/password and cache tokens. */
export async function login(username: string, password: string): Promise<void> {
  const config = loadConfig();
  debug(`Cognito region: ${config.region}, client_id: ${config.client_id}, user_pool_id: ${config.user_pool_id}`);
  const client = new CognitoIdentityProviderClient({ region: config.region });

  const result = await client.send(new InitiateAuthCommand({
    AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
    ClientId: config.client_id,
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  }));

  const auth = result.AuthenticationResult;
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
  const client = new CognitoIdentityProviderClient({ region: config.region });

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
