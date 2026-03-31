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
import { getAuthToken, login } from '../src/auth';
import { saveConfig, saveCredentials } from '../src/config';

// Mock the Cognito SDK
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InitiateAuthCommand: jest.fn().mockImplementation((params) => params),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH', REFRESH_TOKEN_AUTH: 'REFRESH_TOKEN_AUTH' },
}));

describe('auth', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
    saveConfig({
      api_url: 'https://api.example.com',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_abc',
      client_id: 'client123',
    });
    mockSend.mockReset();
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('login', () => {
    test('saves credentials on successful login', async () => {
      mockSend.mockResolvedValue({
        AuthenticationResult: {
          IdToken: 'id-token-123',
          RefreshToken: 'refresh-token-123',
          ExpiresIn: 3600,
        },
      });

      await login('user@example.com', 'password123');

      const creds = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'credentials.json'), 'utf-8'),
      );
      expect(creds.id_token).toBe('id-token-123');
      expect(creds.refresh_token).toBe('refresh-token-123');
      expect(creds.token_expiry).toBeDefined();
    });

    test('throws on missing auth result', async () => {
      mockSend.mockResolvedValue({ AuthenticationResult: null });
      await expect(login('user@example.com', 'pass')).rejects.toThrow('Unexpected authentication response');
    });
  });

  describe('getAuthToken', () => {
    test('returns cached token when not expired', async () => {
      const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      saveCredentials({
        id_token: 'cached-token',
        refresh_token: 'refresh-token',
        token_expiry: futureExpiry,
      });

      const token = await getAuthToken();
      expect(token).toBe('cached-token');
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('refreshes expired token', async () => {
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      saveCredentials({
        id_token: 'old-token',
        refresh_token: 'refresh-token',
        token_expiry: pastExpiry,
      });

      mockSend.mockResolvedValue({
        AuthenticationResult: {
          IdToken: 'new-token',
          ExpiresIn: 3600,
        },
      });

      const token = await getAuthToken();
      expect(token).toBe('new-token');
    });

    test('throws when no credentials exist', async () => {
      await expect(getAuthToken()).rejects.toThrow('Not authenticated');
    });

    test('throws readable error when refresh fails', async () => {
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      saveCredentials({
        id_token: 'old-token',
        refresh_token: 'bad-refresh',
        token_expiry: pastExpiry,
      });

      mockSend.mockRejectedValue(new Error('Token expired'));

      await expect(getAuthToken()).rejects.toThrow('Session expired');
    });
  });
});
