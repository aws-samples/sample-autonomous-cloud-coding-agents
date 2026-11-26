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
import { getStackOutput, getStackOutputs } from '../../src/stack-outputs';

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
    (getStackOutputs as jest.Mock).mockImplementation(async (region: string, stack: string, keys: readonly string[]) => {
      const outputs: Record<string, string | null> = {};
      for (const key of keys) outputs[key] = await getStackOutput(region, stack, key);
      return outputs;
    });
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: { repo: 'acme/a', status: 'active' },
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
      config: {
        repo: 'acme/a',
        status: 'active',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
      },
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

  test('repo onboard does not warn when the stored runtime and token are the platform outputs', async () => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: {
        repo: 'acme/a',
        status: 'active',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:platform',
      },
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--output', 'json']);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect((payload.notes as string[]).join('\n')).not.toContain('WARNING');
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

  test.each([
    [undefined, 'onboarded'],
    ['active', 'updated'],
    ['removed', 're-activated'],
  ])('repo onboard reports a row whose status was %s as %s', async (status, change) => {
    (onboardRepo as jest.Mock).mockResolvedValue({
      config: { repo: 'acme/a', status: 'active' },
      previous: status && { repo: 'acme/a', status },
    });

    await makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1']);
    expect(consoleSpy.mock.calls[0][0]).toBe(`Repository 'acme/a' ${change} (status: active).`);

    consoleSpy.mockClear();
    await makeRepoCommand().parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--output', 'json']);
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string).change).toBe(change);
  });

  test('repo onboard rejects invalid compute type', async () => {
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--compute-type', 'lambda',
    ])).rejects.toThrow("compute-type must be 'agentcore', 'ecs', or 'lambda-microvm'");
  });

  test('repo onboard accepts lambda-microvm compute type', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1',
      '--compute-type', 'lambda-microvm',
    ]);

    expect((onboardRepo as jest.Mock).mock.calls[0][3]).toEqual(
      expect.objectContaining({ set: expect.objectContaining({ compute_type: 'lambda-microvm' }) }),
    );
  });

  test('repo onboard passes the deployment, and each flag as its RepoTable column', async () => {
    await makeRepoCommand().parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--compute-type', 'agentcore',
      '--runtime-arn', 'arn:runtime',
      '--model', ' global.anthropic.claude-opus-5-5 ',
      '--token-secret-arn', 'arn:secret',
      '--max-turns', '50',
      '--poll-interval', '1000',
    ]);

    expect((onboardRepo as jest.Mock).mock.calls[0][3]).toEqual({
      deployment: { stackName: 'backgroundagent-dev', computeSubstrate: null, computeDeploymentMode: null, computeTypes: null },
      set: {
        compute_type: 'agentcore',
        runtime_arn: 'arn:runtime',
        model_id: 'global.anthropic.claude-opus-5-5',
        github_token_secret_arn: 'arn:secret',
        max_turns: 50,
        poll_interval_ms: 1000,
      },
    });
  });

  test('repo onboard passes no value for a flag that is empty or not given', async () => {
    await makeRepoCommand().parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--runtime-arn', '', '--model', ' ', '--token-secret-arn', '',
    ]);

    const { set } = (onboardRepo as jest.Mock).mock.calls[0][3];
    expect(Object.values(set).filter((value) => value !== undefined)).toEqual([]);
  });

  test('reads BedrockGeoRegion and BedrockModelIds by their exact output names', async () => {
    // Both new checks read stack outputs by literal name, and a typo in either makes
    // them silent no-ops with the suite still green: `getStackOutput` returns null for
    // an unknown key, and null means "stack does not export this — skip". So a
    // misspelling degrades the guard to nothing rather than failing loudly.
    //
    // Asserted on the KEYS requested, which is the only place the literal appears.
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1']);

    const keys = (getStackOutput as jest.Mock).mock.calls.map((c) => c[2]);
    expect(keys).toContain('BedrockGeoRegion');
    expect(keys).toContain('BedrockModelIds');
  });

  test('rejects a --model whose geography the stack does not grant', async () => {
    // End-to-end through the command, not just the guard in isolation: proves the
    // output value actually reaches assertModelIdUsable and that a rejection aborts
    // before onboardRepo writes anything.
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'BedrockGeoRegion') return 'global';
      return null;
    });
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--model', 'us.anthropic.claude-opus-5',
    ])).rejects.toThrow(/grants 'global' profiles/);
    expect(onboardRepo).not.toHaveBeenCalled();
  });

  test('rejects a --model outside the set the stack grants', async () => {
    // Without the granted set the check is skipped, as on a stack that does not export the set.
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'BedrockGeoRegion') return 'global';
      if (key === 'BedrockModelIds') return 'anthropic.claude-haiku-5-5';
      return null;
    });
    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1',
      '--model', 'global.anthropic.claude-opus-5-5',
    ])).rejects.toThrow(/is not granted by stack/);
    expect(onboardRepo).not.toHaveBeenCalled();
  });

  test('repo offboard invokes offboardRepo', async () => {
    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'offboard', 'acme/a', '--region', 'us-east-1']);

    expect(offboardRepo).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('offboarded');
  });
});
