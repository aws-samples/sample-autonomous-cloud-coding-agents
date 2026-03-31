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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.REPO_TABLE_NAME = 'RepoConfig';

import { checkRepoOnboarded, loadRepoConfig } from '../../../src/handlers/shared/repo-config';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkRepoOnboarded', () => {
  test('returns true for active repos', async () => {
    mockSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    const result = await checkRepoOnboarded('org/repo');
    expect(result.onboarded).toBe(true);
  });

  test('returns false for missing repos', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await checkRepoOnboarded('org/missing');
    expect(result.onboarded).toBe(false);
  });

  test('returns false for removed repos', async () => {
    mockSend.mockResolvedValueOnce({ Item: { status: 'removed' } });
    const result = await checkRepoOnboarded('org/removed');
    expect(result.onboarded).toBe(false);
  });

  test('returns true when REPO_TABLE_NAME is not set', async () => {
    const original = process.env.REPO_TABLE_NAME;
    delete process.env.REPO_TABLE_NAME;
    try {
      const result = await checkRepoOnboarded('org/any');
      expect(result.onboarded).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      process.env.REPO_TABLE_NAME = original;
    }
  });

  test('throws on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB throttle'));
    await expect(checkRepoOnboarded('org/repo')).rejects.toThrow(
      "Unable to verify onboarding status for 'org/repo'",
    );
  });
});

describe('loadRepoConfig', () => {
  test('returns full config for existing repos', async () => {
    const config = {
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      compute_type: 'agentcore',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
      model_id: 'anthropic.claude-sonnet-4-6',
      max_turns: 50,
      poll_interval_ms: 15000,
    };
    mockSend.mockResolvedValueOnce({ Item: config });

    const result = await loadRepoConfig('org/repo');
    expect(result).toEqual(config);
  });

  test('returns null for missing repos', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await loadRepoConfig('org/missing');
    expect(result).toBeNull();
  });

  test('returns null for removed repos', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        repo: 'org/removed',
        status: 'removed',
        onboarded_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-06-01T00:00:00Z',
      },
    });
    const result = await loadRepoConfig('org/removed');
    expect(result).toBeNull();
  });

  test('returns null when REPO_TABLE_NAME is not set', async () => {
    const original = process.env.REPO_TABLE_NAME;
    delete process.env.REPO_TABLE_NAME;
    try {
      const result = await loadRepoConfig('org/any');
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      process.env.REPO_TABLE_NAME = original;
    }
  });

  test('throws on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));
    await expect(loadRepoConfig('org/repo')).rejects.toThrow(
      "Unable to load repo config for 'org/repo'",
    );
  });
});
