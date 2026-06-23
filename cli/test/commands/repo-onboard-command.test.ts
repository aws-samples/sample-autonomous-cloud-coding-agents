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

import { makeRepoCommand } from '../../src/commands/repo';
import { onboardRepo, offboardRepo } from '../../src/repo-onboard';
import { getStackOutput } from '../../src/stack-outputs';

jest.mock('../../src/repo-onboard');
jest.mock('../../src/stack-outputs');

describe('repo onboard/offboard commands', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const originalRegion = process.env.AWS_REGION;

  beforeEach(() => {
    process.env.AWS_REGION = 'us-east-1';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'RuntimeArn') return 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform';
      if (key === 'GitHubTokenSecretArn') return 'arn:aws:secretsmanager:us-east-1:123:secret:platform';
      return null;
    });
    (onboardRepo as jest.Mock).mockResolvedValue({
      repo: 'acme/a',
      status: 'active',
    });
    (offboardRepo as jest.Mock).mockResolvedValue({
      repo: 'acme/a',
      status: 'removed',
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
  });

  test('repo onboard invokes onboardRepo', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1']);

    expect(onboardRepo).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('onboarded');
    expect(output).toContain('RepoTable only');
    expect(output).toContain('CDK Blueprint');
  });

  test('repo onboard warns when custom runtime is stored', async () => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      repo: 'acme/a',
      status: 'active',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--runtime-arn', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
    ]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('additionalRuntimeArns');
  });

  test('repo onboard JSON output includes notes', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--output', 'json',
    ]);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.repo.repo).toBe('acme/a');
    expect(payload.notes.length).toBeGreaterThan(0);
  });

  test('repo onboard rejects invalid compute type', async () => {
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--compute-type', 'lambda',
    ])).rejects.toThrow("compute-type must be 'agentcore' or 'ecs'");
  });

  test('repo offboard invokes offboardRepo', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'offboard', 'acme/a', '--region', 'us-east-1']);

    expect(offboardRepo).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('offboarded');
  });
});
