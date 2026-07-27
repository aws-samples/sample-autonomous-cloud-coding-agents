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

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { makeRepoCommand } from '../../src/commands/repo';
import { CliError } from '../../src/errors';
import { listRepoConfigs, parseRepoConfigRow } from '../../src/repo-lookup';
import { offboardRepo, onboardRepo } from '../../src/repo-onboard';
import { getStackOutput } from '../../src/stack-outputs';

const ddbSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: ddbSend })),
    },
  };
});

jest.mock('../../src/stack-outputs', () => {
  const actual = jest.requireActual('../../src/stack-outputs');
  return { ...actual, getStackOutput: jest.fn() };
});
jest.mock('../../src/repo-onboard');

const getStackOutputMock = getStackOutput as jest.Mock;
const onboardRepoMock = onboardRepo as jest.Mock;
const offboardRepoMock = offboardRepo as jest.Mock;

describe('listRepoConfigs', () => {
  beforeEach(() => {
    ddbSend.mockReset();
  });

  test('returns sorted repo rows from RepoTable scan', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { repo: 'zebra/z', status: 'active' },
        { repo: 'acme/a', status: 'removed' },
      ],
    });

    const repos = await listRepoConfigs('us-east-1', 'RepoTable-dev');
    expect(repos.map((r) => r.repo)).toEqual(['acme/a', 'zebra/z']);
    const scanCmd = ddbSend.mock.calls[0][0] as ScanCommand;
    expect(scanCmd.input.TableName).toBe('RepoTable-dev');
  });

  test('paginates scan results', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Items: [{ repo: 'acme/a', status: 'active' }],
        LastEvaluatedKey: { repo: 'acme/a' },
      })
      .mockResolvedValueOnce({
        Items: [{ repo: 'acme/b', status: 'active' }],
      });

    const repos = await listRepoConfigs('us-east-1', 'RepoTable-dev');
    expect(repos).toHaveLength(2);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  test('rejects a scanned row with an unexpected status', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ repo: 'acme/a', status: 'disabled' }],
    });

    await expect(listRepoConfigs('us-east-1', 'RepoTable-dev')).rejects.toThrow(/unexpected status/);
  });
});

describe('repo command JSON output', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const RAW_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:acme-token-AbCdEf';

  beforeEach(() => {
    ddbSend.mockReset();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    getStackOutputMock.mockReset().mockResolvedValue('RepoTable-dev');
    onboardRepoMock.mockReset();
    offboardRepoMock.mockReset();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('repo list --output json renders rows and redacts the per-repo secret ARN', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ repo: 'acme/a', status: 'active', github_token_secret_arn: RAW_ARN }],
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'list', '--region', 'us-east-1', '--output', 'json']);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).not.toContain(RAW_ARN);
    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.repos[0].repo).toBe('acme/a');
    expect(payload.repos[0].github_token_secret_arn).toContain('****');
  });

  test('repo list text mode prints a header row and the repo', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ repo: 'acme/a', status: 'active', compute_type: 'agentcore' }],
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'list', '--region', 'us-east-1']);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('REPO');
    expect(out).toContain('acme/a');
    expect(out).toContain('agentcore');
  });

  test('repo show --output json redacts the secret ARN (via display object)', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: { repo: 'acme/a', status: 'active', github_token_secret_arn: RAW_ARN },
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync(['node', 'test', 'show', 'acme/a', '--region', 'us-east-1', '--output', 'json']);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).not.toContain(RAW_ARN);
    expect(out).toContain('****');
  });

  test('repo onboard --output json redacts the per-repo secret ARN', async () => {
    onboardRepoMock.mockResolvedValue({
      repo: 'acme/a',
      status: 'active',
      github_token_secret_arn: RAW_ARN,
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a',
      '--region', 'us-east-1', '--token-secret-arn', RAW_ARN, '--output', 'json',
    ]);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).not.toContain(RAW_ARN);
    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.repo.github_token_secret_arn).toContain('****');
  });

  test('onboard --compute-type ecs is REFUSED when the stack has no ECS substrate', async () => {
    // Per-key outputs: RepoTableName present, ComputeSubstrate=agentcore (deployed
    // without --context compute_type=ecs).
    getStackOutputMock.mockReset().mockImplementation((_r: string, _s: string, key: string) =>
      Promise.resolve(key === 'ComputeSubstrate' ? 'agentcore' : 'RepoTable-dev'));

    const cmd = makeRepoCommand();
    await expect(cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--compute-type', 'ecs',
    ])).rejects.toThrow(/without the ECS substrate|compute_type=ecs/i);
    // Must NOT write the repo row when it would be dead-on-arrival.
    expect(onboardRepoMock).not.toHaveBeenCalled();
  });

  test('onboard --compute-type ecs is ALLOWED when the stack provisioned ECS', async () => {
    getStackOutputMock.mockReset().mockImplementation((_r: string, _s: string, key: string) =>
      Promise.resolve(key === 'ComputeSubstrate' ? 'ecs' : 'RepoTable-dev'));
    onboardRepoMock.mockResolvedValue({ repo: 'acme/a', status: 'active', compute_type: 'ecs' });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--compute-type', 'ecs',
    ]);
    expect(onboardRepoMock).toHaveBeenCalledWith(
      'us-east-1', 'RepoTable-dev', 'acme/a', expect.objectContaining({ computeType: 'ecs' }));
  });

  test('onboard --compute-type ecs proceeds against an OLDER stack lacking ComputeSubstrate (null → unknown)', async () => {
    // Back-compat: pre-output stacks return null for ComputeSubstrate; don't hard-block
    // (the runtime error is the backstop there).
    getStackOutputMock.mockReset().mockImplementation((_r: string, _s: string, key: string) =>
      Promise.resolve(key === 'ComputeSubstrate' ? null : 'RepoTable-dev'));
    onboardRepoMock.mockResolvedValue({ repo: 'acme/a', status: 'active', compute_type: 'ecs' });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--compute-type', 'ecs',
    ]);
    expect(onboardRepoMock).toHaveBeenCalled();
  });

  test('onboard --compute-type agentcore is unaffected by ComputeSubstrate', async () => {
    getStackOutputMock.mockReset().mockImplementation((_r: string, _s: string, key: string) =>
      Promise.resolve(key === 'ComputeSubstrate' ? 'agentcore' : 'RepoTable-dev'));
    onboardRepoMock.mockResolvedValue({ repo: 'acme/a', status: 'active', compute_type: 'agentcore' });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'onboard', 'acme/a', '--region', 'us-east-1', '--compute-type', 'agentcore',
    ]);
    expect(onboardRepoMock).toHaveBeenCalled();
  });

  test('repo offboard --output json redacts the per-repo secret ARN', async () => {
    offboardRepoMock.mockResolvedValue({
      repo: 'acme/a',
      status: 'removed',
      github_token_secret_arn: RAW_ARN,
    });

    const cmd = makeRepoCommand();
    await cmd.parseAsync([
      'node', 'test', 'offboard', 'acme/a', '--region', 'us-east-1', '--output', 'json',
    ]);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).not.toContain(RAW_ARN);
    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.repo.github_token_secret_arn).toContain('****');
  });
});

describe('parseRepoConfigRow', () => {
  test('accepts a valid row', () => {
    const row = parseRepoConfigRow({ repo: 'acme/a', status: 'active', max_turns: 10 });
    expect(row.repo).toBe('acme/a');
    expect(row.status).toBe('active');
  });

  test('throws on a non-string repo', () => {
    expect(() => parseRepoConfigRow({ status: 'active' })).toThrow(CliError);
  });

  test('throws on an out-of-union status', () => {
    expect(() => parseRepoConfigRow({ repo: 'acme/a', status: 'paused' }))
      .toThrow(/unexpected status/);
  });
});
