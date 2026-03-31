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
import { makeConfigureCommand } from '../../src/commands/configure';

describe('configure command', () => {
  let tmpDir: string;
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
  });

  test('saves configuration', async () => {
    const cmd = makeConfigureCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--api-url', 'https://api.example.com',
      '--region', 'us-west-2',
      '--user-pool-id', 'us-west-2_abc',
      '--client-id', 'client-xyz',
    ]);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    expect(config.api_url).toBe('https://api.example.com');
    expect(config.region).toBe('us-west-2');
    expect(config.user_pool_id).toBe('us-west-2_abc');
    expect(config.client_id).toBe('client-xyz');
    expect(consoleSpy).toHaveBeenCalledWith('Configuration saved.');
  });
});
