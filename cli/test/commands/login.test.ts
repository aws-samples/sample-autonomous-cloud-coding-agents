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
import { makeLoginCommand } from '../../src/commands/login';
import { saveConfig } from '../../src/config';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InitiateAuthCommand: jest.fn().mockImplementation((params) => params),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH', REFRESH_TOKEN_AUTH: 'REFRESH_TOKEN_AUTH' },
}));

describe('login command', () => {
  let tmpDir: string;
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
    saveConfig({
      api_url: 'https://api.example.com',
      region: 'us-east-1',
      user_pool_id: 'pool-id',
      client_id: 'client-id',
    });
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockSend.mockReset();
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
  });

  test('logs in with username and password', async () => {
    mockSend.mockResolvedValue({
      AuthenticationResult: {
        IdToken: 'id-tok',
        RefreshToken: 'ref-tok',
        ExpiresIn: 3600,
      },
    });

    const cmd = makeLoginCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--username', 'user@example.com',
      '--password', 'secret',
    ]);

    const creds = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'credentials.json'), 'utf-8'),
    );
    expect(creds.id_token).toBe('id-tok');
    expect(consoleSpy).toHaveBeenCalledWith('Login successful. Credentials saved.');
  });
});
