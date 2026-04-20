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

  test('saves runtime_jwt_arn when --runtime-jwt-arn is supplied', async () => {
    const cmd = makeConfigureCommand();
    await cmd.parseAsync([
      'node', 'test',
      '--api-url', 'https://api.example.com',
      '--region', 'us-east-1',
      '--user-pool-id', 'us-east-1_xyz',
      '--client-id', 'client-123',
      '--runtime-jwt-arn', 'arn:aws:bedrock-agentcore:us-east-1:111:runtime/abca_agent_jwt-ABC',
    ]);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    expect(config.runtime_jwt_arn).toBe(
      'arn:aws:bedrock-agentcore:us-east-1:111:runtime/abca_agent_jwt-ABC',
    );
  });

  test('partial update: --runtime-jwt-arn alone merges onto existing config', async () => {
    // First: full configure without runtime_jwt_arn.
    const cmd1 = makeConfigureCommand();
    await cmd1.parseAsync([
      'node', 'test',
      '--api-url', 'https://api.example.com',
      '--region', 'us-east-1',
      '--user-pool-id', 'us-east-1_xyz',
      '--client-id', 'client-123',
    ]);

    // Second: only --runtime-jwt-arn, no other fields.
    const cmd2 = makeConfigureCommand();
    await cmd2.parseAsync([
      'node', 'test',
      '--runtime-jwt-arn',
      'arn:aws:bedrock-agentcore:us-east-1:222:runtime/abca_agent_jwt-DEF',
    ]);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    // Existing fields preserved.
    expect(config.api_url).toBe('https://api.example.com');
    expect(config.region).toBe('us-east-1');
    expect(config.user_pool_id).toBe('us-east-1_xyz');
    expect(config.client_id).toBe('client-123');
    // New field added.
    expect(config.runtime_jwt_arn).toBe(
      'arn:aws:bedrock-agentcore:us-east-1:222:runtime/abca_agent_jwt-DEF',
    );
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

  test('backward compatibility: existing config.json without runtime_jwt_arn loads cleanly', async () => {
    // Write a pre-existing config without runtime_jwt_arn (simulating an old install).
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        api_url: 'https://api.example.com',
        region: 'us-east-1',
        user_pool_id: 'us-east-1_legacy',
        client_id: 'client-legacy',
      }, null, 2),
    );

    const cmd = makeConfigureCommand();
    // Add runtime_jwt_arn only; should succeed and preserve everything else.
    await cmd.parseAsync([
      'node', 'test',
      '--runtime-jwt-arn',
      'arn:aws:bedrock-agentcore:us-east-1:333:runtime/abca_agent_jwt-GHI',
    ]);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    expect(config.user_pool_id).toBe('us-east-1_legacy');
    expect(config.runtime_jwt_arn).toBe(
      'arn:aws:bedrock-agentcore:us-east-1:333:runtime/abca_agent_jwt-GHI',
    );
  });
});
