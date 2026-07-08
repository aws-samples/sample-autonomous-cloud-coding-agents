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

import { PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { CliError } from '../../src/errors';
import {
  isGithubTokenConfigured,
  putGithubToken,
  resolveGithubTokenSecretArn,
} from '../../src/github-token';
import * as repoLookup from '../../src/repo-lookup';
import * as stackOutputs from '../../src/stack-outputs';

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return {
    ...actual,
    SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  };
});

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: ddbSend })),
    },
  };
});

const smSend = jest.fn();
const ddbSend = jest.fn();
const getStackOutputSpy = jest.spyOn(stackOutputs, 'getStackOutput');

describe('resolveGithubTokenSecretArn', () => {
  beforeEach(() => {
    getStackOutputSpy.mockReset();
    ddbSend.mockReset();
  });

  test('returns platform default when no repo or secret-arn is given', async () => {
    getStackOutputSpy.mockResolvedValueOnce('arn:platform-token');

    const result = await resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
    });

    expect(result).toEqual({
      secretArn: 'arn:platform-token',
      source: 'platform',
    });
    expect(getStackOutputSpy).toHaveBeenCalledWith('us-east-1', 'backgroundagent-dev', 'GitHubTokenSecretArn');
  });

  test('returns explicit ARN when --secret-arn is provided', async () => {
    const result = await resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
      secretArn: 'arn:custom-secret',
    });

    expect(result).toEqual({
      secretArn: 'arn:custom-secret',
      source: 'explicit',
    });
    expect(getStackOutputSpy).not.toHaveBeenCalled();
  });

  test('rejects both --repo and --secret-arn', async () => {
    await expect(resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
      repo: 'acme/foo',
      secretArn: 'arn:custom-secret',
    })).rejects.toThrow(/either --repo or --secret-arn/);
  });

  test('uses blueprint per-repo secret when github_token_secret_arn is set', async () => {
    getStackOutputSpy
      .mockResolvedValueOnce('arn:platform-token')
      .mockResolvedValueOnce('RepoTable-dev');
    ddbSend.mockResolvedValueOnce({
      Item: {
        repo: 'acme/foo',
        status: 'active',
        github_token_secret_arn: 'arn:blueprint-token',
      },
    });

    const result = await resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
      repo: 'acme/foo',
    });

    expect(result).toEqual({
      secretArn: 'arn:blueprint-token',
      source: 'blueprint',
    });
  });

  test('falls back to platform default when blueprint has no per-repo secret', async () => {
    getStackOutputSpy
      .mockResolvedValueOnce('arn:platform-token')
      .mockResolvedValueOnce('RepoTable-dev');
    ddbSend.mockResolvedValueOnce({
      Item: { repo: 'acme/foo', status: 'active' },
    });

    const result = await resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
      repo: 'acme/foo',
    });

    expect(result).toEqual({
      secretArn: 'arn:platform-token',
      source: 'platform',
      repoUsesPlatformDefault: true,
    });
  });

  test('throws when platform GitHubTokenSecretArn output is missing', async () => {
    getStackOutputSpy.mockResolvedValueOnce(null);

    await expect(resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
    })).rejects.toThrow(/GitHubTokenSecretArn/);
  });

  test('throws when RepoTableName output is missing for --repo lookup', async () => {
    getStackOutputSpy
      .mockResolvedValueOnce('arn:platform-token')
      .mockResolvedValueOnce(null);

    await expect(resolveGithubTokenSecretArn({
      region: 'us-east-1',
      stackName: 'backgroundagent-dev',
      repo: 'acme/foo',
    })).rejects.toThrow(/RepoTableName/);
  });
});

describe('assertRepoFormat', () => {
  test('rejects invalid repo strings', () => {
    expect(() => repoLookup.assertRepoFormat('not-a-repo')).toThrow(CliError);
  });

  test('accepts owner/repo format', () => {
    expect(() => repoLookup.assertRepoFormat('acme/my-service')).not.toThrow();
  });
});

describe('loadActiveRepoConfig', () => {
  beforeEach(() => {
    ddbSend.mockReset();
  });

  test('returns active repo config from RepoTable', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: {
        repo: 'acme/foo',
        status: 'active',
        github_token_secret_arn: 'arn:blueprint-token',
      },
    });

    const config = await repoLookup.loadActiveRepoConfig('us-east-1', 'RepoTable-dev', 'acme/foo');
    expect(config.github_token_secret_arn).toBe('arn:blueprint-token');
    const getCmd = ddbSend.mock.calls[0][0] as GetCommand;
    expect(getCmd.input.TableName).toBe('RepoTable-dev');
    expect(getCmd.input.Key).toEqual({ repo: 'acme/foo' });
  });

  test('throws when repo is not onboarded', async () => {
    ddbSend.mockResolvedValueOnce({});
    await expect(
      repoLookup.loadActiveRepoConfig('us-east-1', 'RepoTable-dev', 'acme/missing'),
    ).rejects.toThrow(/not onboarded/);
  });

  test('throws when repo status is not active', async () => {
    ddbSend.mockResolvedValueOnce({
      Item: { repo: 'acme/foo', status: 'removed' },
    });
    await expect(
      repoLookup.loadActiveRepoConfig('us-east-1', 'RepoTable-dev', 'acme/foo'),
    ).rejects.toThrow(/status is 'removed'/);
  });
});

describe('isGithubTokenConfigured', () => {
  beforeEach(() => {
    smSend.mockReset();
  });

  test('returns true for a non-placeholder secret string', async () => {
    smSend.mockResolvedValueOnce({ SecretString: 'ghp_abc123' });
    await expect(isGithubTokenConfigured('us-east-1', 'arn:secret')).resolves.toBe(true);
  });

  test('returns false for empty or JSON placeholder secrets', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '{}' });
    await expect(isGithubTokenConfigured('us-east-1', 'arn:secret')).resolves.toBe(false);
  });

  test('returns false when secret is missing', async () => {
    const err = new Error('not found');
    (err as { name?: string }).name = 'ResourceNotFoundException';
    smSend.mockRejectedValueOnce(err);
    await expect(isGithubTokenConfigured('us-east-1', 'arn:secret')).resolves.toBe(false);
  });
});

describe('putGithubToken', () => {
  beforeEach(() => {
    smSend.mockReset();
  });

  test('writes token via PutSecretValue', async () => {
    smSend.mockResolvedValueOnce({});
    await putGithubToken('us-east-1', 'arn:secret', 'ghp_test');
    const putCmd = smSend.mock.calls[0][0] as PutSecretValueCommand;
    expect(putCmd.input.SecretId).toBe('arn:secret');
    expect(putCmd.input.SecretString).toBe('ghp_test');
  });
});
