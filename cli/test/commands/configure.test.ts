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

  test('partial update: new field value merges onto existing config', async () => {
    const cmd1 = makeConfigureCommand();
    await cmd1.parseAsync([
      'node', 'test',
      '--api-url', 'https://api.example.com',
      '--region', 'us-east-1',
      '--user-pool-id', 'us-east-1_xyz',
      '--client-id', 'client-123',
    ]);

    // Update only --region; other fields should persist.
    const cmd2 = makeConfigureCommand();
    await cmd2.parseAsync(['node', 'test', '--region', 'us-west-1']);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    expect(config.api_url).toBe('https://api.example.com');
    expect(config.region).toBe('us-west-1');
    expect(config.user_pool_id).toBe('us-east-1_xyz');
    expect(config.client_id).toBe('client-123');
  });

  test('first-time configure without all required fields → CliError', async () => {
    const cmd = makeConfigureCommand();
    await expect(
      cmd.parseAsync([
        'node', 'test',
        '--api-url', 'https://api.example.com',
        // missing --region, --user-pool-id, --client-id
      ]),
    ).rejects.toThrow(/Missing required configuration/);
  });

  test('no flags with complete existing config → reports "No configuration changes" without re-saving', async () => {
    // Seed a complete config.
    const cmd1 = makeConfigureCommand();
    await cmd1.parseAsync([
      'node', 'test',
      '--api-url', 'https://api.example.com',
      '--region', 'us-east-1',
      '--user-pool-id', 'us-east-1_abc',
      '--client-id', 'client-123',
    ]);
    const initialMtime = fs.statSync(path.join(tmpDir, 'config.json')).mtimeMs;

    // Run configure again with no flags.
    const cmd2 = makeConfigureCommand();
    await cmd2.parseAsync(['node', 'test']);

    // File was not rewritten.
    expect(fs.statSync(path.join(tmpDir, 'config.json')).mtimeMs).toBe(initialMtime);
    // User-facing message is honest about the no-op.
    expect(consoleSpy).toHaveBeenCalledWith('No configuration changes — all flags were omitted.');
    expect(consoleSpy).not.toHaveBeenLastCalledWith('Configuration saved.');
  });
});
