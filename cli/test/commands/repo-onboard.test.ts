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

import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CliError } from '../../src/errors';
import { RepoNotOnboardedError } from '../../src/repo-lookup';
import { onboardRepo, offboardRepo, REMOVED_REPO_TTL_DAYS } from '../../src/repo-onboard';

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

jest.mock('../../src/repo-lookup', () => {
  const actual = jest.requireActual('../../src/repo-lookup');
  return {
    ...actual,
    loadRepoConfig: jest.fn(async () => ({
      repo: 'acme/a',
      status: 'active',
      onboarded_at: '2026-01-01T00:00:00Z',
    })),
  };
});

describe('repo onboard/offboard', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
  });

  test('onboardRepo writes active PutItem', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      computeType: 'agentcore',
      modelId: 'anthropic.claude-sonnet-4-6',
    });

    const put = ddbSend.mock.calls[0][0] as PutCommand;
    expect(put.input.TableName).toBe('RepoTable');
    expect(put.input.Item?.repo).toBe('acme/a');
    expect(put.input.Item?.status).toBe('active');
    expect(put.input.Item?.compute_type).toBe('agentcore');
  });

  test('offboardRepo sets removed status and TTL', async () => {
    await offboardRepo('us-east-1', 'RepoTable', 'acme/a');

    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.Key).toEqual({ repo: 'acme/a' });
    expect(update.input.ExpressionAttributeValues?.[':removed']).toBe('removed');
    const ttl = update.input.ExpressionAttributeValues?.[':ttl'] as number;
    expect(ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + REMOVED_REPO_TTL_DAYS * 86400 + 5);
  });

  test('onboardRepo preserves existing optional fields', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockResolvedValueOnce({
      repo: 'acme/a',
      status: 'removed',
      onboarded_at: '2025-01-01T00:00:00Z',
      compute_type: 'agentcore',
      runtime_arn: 'arn:runtime',
      model_id: 'model',
      max_turns: 50,
      github_token_secret_arn: 'arn:secret',
      poll_interval_ms: 1000,
      system_prompt_overrides: 'custom',
      egress_allowlist: ['example.com'],
      cedar_policies: ['policy'],
      approval_gate_cap: 10,
      max_budget_usd: 5,
    });

    await onboardRepo('us-east-1', 'RepoTable', 'acme/a');

    const put = ddbSend.mock.calls[0][0] as PutCommand;
    expect(put.input.Item?.onboarded_at).toBe('2025-01-01T00:00:00Z');
    expect(put.input.Item?.cedar_policies).toEqual(['policy']);
  });

  test('onboardRepo persists --poll-interval override', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', { pollIntervalMs: 12345 });

    const put = ddbSend.mock.calls[0][0] as PutCommand;
    expect(put.input.Item?.poll_interval_ms).toBe(12345);
  });

  test('onboardRepo treats a missing row as a fresh onboard', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockRejectedValueOnce(new RepoNotOnboardedError('acme/a'));

    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a')).resolves.toBeDefined();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('onboardRepo re-throws non-not-found load errors instead of wiping overrides', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockRejectedValueOnce(
      Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
    );

    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a')).rejects.toThrow('throttled');
    // Must NOT have written a defaults-only row over the existing config.
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('offboardRepo rejects an invalid repo format before any write', async () => {
    await expect(offboardRepo('us-east-1', 'RepoTable', 'not-a-repo'))
      .rejects.toBeInstanceOf(CliError);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
