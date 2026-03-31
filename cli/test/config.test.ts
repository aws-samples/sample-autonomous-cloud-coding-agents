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
import { loadConfig, loadCredentials, saveConfig, saveCredentials } from '../src/config';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveConfig / loadConfig', () => {
    test('saves and loads config', () => {
      const config = {
        api_url: 'https://api.example.com/v1',
        region: 'us-east-1',
        user_pool_id: 'us-east-1_abc',
        client_id: 'client123',
      };
      saveConfig(config);
      expect(loadConfig()).toEqual(config);
    });

    test('throws when config does not exist', () => {
      expect(() => loadConfig()).toThrow('Not configured');
    });
  });

  describe('saveCredentials / loadCredentials', () => {
    test('saves and loads credentials', () => {
      const creds = {
        id_token: 'tok-id',
        refresh_token: 'tok-refresh',
        token_expiry: '2026-01-01T00:00:00.000Z',
      };
      saveCredentials(creds);
      expect(loadCredentials()).toEqual(creds);
    });

    test('returns null when credentials file does not exist', () => {
      expect(loadCredentials()).toBeNull();
    });

    test('credentials file has restricted permissions', () => {
      saveCredentials({
        id_token: 'tok',
        refresh_token: 'ref',
        token_expiry: '2026-01-01T00:00:00.000Z',
      });
      const stat = fs.statSync(path.join(tmpDir, 'credentials.json'));
      // 0o600 = owner read+write only (octal 600 = decimal 384)
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});
