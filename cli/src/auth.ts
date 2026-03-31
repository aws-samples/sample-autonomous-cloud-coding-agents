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

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

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

/** Get a valid auth token, refreshing automatically if needed. */
export async function getAuthToken(): Promise<string> {
  const creds = loadCredentials();
  if (!creds) {
    throw new CliError('Not authenticated. Run `bgagent login` first.');
  }

  if (!isExpired(creds)) {
    debug('Using cached token (not expired)');
    return creds.id_token;
  }

  debug('Token expired or near expiry, refreshing...');
  return refreshToken(creds);
}

function isExpired(creds: Credentials): boolean {
  const expiryMs = new Date(creds.token_expiry).getTime();
  return Date.now() >= expiryMs - TOKEN_REFRESH_BUFFER_MS;
}

async function refreshToken(creds: Credentials): Promise<string> {
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

    return auth.IdToken;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('Session expired. Run `bgagent login` to re-authenticate.');
  }
}
