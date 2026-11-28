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

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

const BASE_SET = 'SET #status = :active, #updated_at = :now, #onboarded_at = if_not_exists(#onboarded_at, :now)';
const BASE_NAMES = { '#status': 'status', '#updated_at': 'updated_at', '#onboarded_at': 'onboarded_at', '#ttl': 'ttl' };
const BASE_VALUES = { ':active': 'active', ':now': expect.any(String) };

/** DynamoDB refuses a placeholder that is used and not declared, and one that is declared and not used. */
function expectDeclaredPlaceholders(command: unknown): void {
  expect(command).toBeInstanceOf(UpdateCommand);
  const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } = (command as UpdateCommand).input;
  const used = (placeholder: RegExp) => [...new Set(UpdateExpression?.match(placeholder))].sort();
  expect(used(/#\w+/g)).toEqual(Object.keys(ExpressionAttributeNames ?? {}).sort());
  expect(used(/:\w+/g)).toEqual(Object.keys(ExpressionAttributeValues ?? {}).sort());
}

describe('repo onboard/offboard', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({ Attributes: { repo: 'acme/a', status: 'active' } });
  });

  afterEach(() => {
    for (const [command] of ddbSend.mock.calls) expectDeclaredPlaceholders(command);
  });

  test('onboardRepo writes active UpdateItem', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      set: { compute_type: 'agentcore', model_id: 'anthropic.claude-sonnet-4-6' },
    });

    expect(ddbSend).toHaveBeenCalledTimes(1);
    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.TableName).toBe('RepoTable');
    expect(update.input.Key).toEqual({ repo: 'acme/a' });
    expect(update.input.ExpressionAttributeValues?.[':active']).toBe('active');
    expect(update.input.ExpressionAttributeValues?.[':compute_type']).toBe('agentcore');
    expect(update.input.ReturnValues).toBe('ALL_NEW');
  });

  test('onboardRepo probes when an existing repo is switched to lambda-microvm', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockResolvedValueOnce({
      repo: 'acme/a',
      status: 'active',
      compute_type: 'agentcore',
    });
    const microvmSend = jest.fn().mockResolvedValue({ images: [] });

    await onboardRepo(
      'us-east-1',
      'RepoTable',
      'acme/a',
      { set: { compute_type: 'lambda-microvm' } },
      { lambdaMicrovmClientFactory: () => ({ send: microvmSend }) },
    );

    expect(microvmSend).toHaveBeenCalledTimes(1);
    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.ExpressionAttributeValues?.[':compute_type']).toBe('lambda-microvm');
  });

  test('onboardRepo probes when reactivating an existing lambda-microvm repo without a flag', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockResolvedValueOnce({
      repo: 'acme/a',
      status: 'removed',
      compute_type: 'lambda-microvm',
    });
    const microvmSend = jest.fn().mockResolvedValue({ images: [] });

    await onboardRepo(
      'us-east-1',
      'RepoTable',
      'acme/a',
      {},
      { lambdaMicrovmClientFactory: () => ({ send: microvmSend }) },
    );

    expect(microvmSend).toHaveBeenCalledTimes(1);
    // The stored pin stays because the write does not name it.
    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.ExpressionAttributeNames).not.toHaveProperty('#compute_type');
  });

  test('onboardRepo rejects lambda-microvm when its availability probe fails', async () => {
    const microvmSend = jest.fn().mockRejectedValue(
      Object.assign(new Error('unknown service'), { name: 'UnrecognizedClientException' }),
    );

    await expect(onboardRepo(
      'eu-central-1',
      'RepoTable',
      'acme/a',
      { set: { compute_type: 'lambda-microvm' } },
      { lambdaMicrovmClientFactory: () => ({ send: microvmSend }) },
    )).rejects.toThrow(
      'Launch regions: us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1. '
      + 'Use --compute-type agentcore or --compute-type ecs',
    );

    expect(ddbSend).not.toHaveBeenCalled();
  });

  test.each(['lambda-microvm', 'lambda-microvm,ecs'])('inherits %s and probes availability without persisting a default pin', async computeTypes => {
    const send = jest.fn().mockResolvedValue({ images: [] });
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      deployment: {
        stackName: 'test',
        computeTypes,
        computeSubstrate: computeTypes,
        computeDeploymentMode: computeTypes.includes(',') ? 'additive' : 'exclusive',
      },
    }, { lambdaMicrovmClientFactory: () => ({ send }) });
    expect(send).toHaveBeenCalledTimes(1);
    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.ExpressionAttributeNames).not.toHaveProperty('#compute_type');
  });

  test('rejects an AgentCore pin when the additive deployment omits AgentCore', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as { loadRepoConfig: jest.Mock };
    loadRepoConfig.mockResolvedValueOnce({ repo: 'acme/a', status: 'active', compute_type: 'agentcore' });
    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      deployment: {
        stackName: 'test',
        computeTypes: 'ecs,lambda-microvm',
        computeSubstrate: 'ecs,lambda-microvm',
        computeDeploymentMode: 'additive',
      },
    })).rejects.toThrow(/deploys only 'ecs, lambda-microvm'/);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('rejects stale stored overrides before a probe or write', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as { loadRepoConfig: jest.Mock };
    loadRepoConfig.mockResolvedValueOnce({ repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' });
    const send = jest.fn();
    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      deployment: { stackName: 'test', computeSubstrate: 'ecs', computeDeploymentMode: 'exclusive' },
    }, { lambdaMicrovmClientFactory: () => ({ send }) })).rejects.toThrow(/deploys only 'ecs'/);
    expect(send).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('does not check a stored compute type that the same command unsets', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as { loadRepoConfig: jest.Mock };
    loadRepoConfig.mockResolvedValueOnce({ repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' });
    const send = jest.fn();
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      deployment: { stackName: 'test', computeSubstrate: 'ecs', computeDeploymentMode: 'exclusive' },
      unset: ['compute_type'],
    }, { lambdaMicrovmClientFactory: () => ({ send }) });
    expect(send).not.toHaveBeenCalled();
    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.UpdateExpression).toBe(`${BASE_SET} REMOVE #ttl, #compute_type`);
  });

  test('refuses a runtime ARN for a repository on another backend', async () => {
    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      set: { compute_type: 'ecs', runtime_arn: 'arn:runtime' },
    })).rejects.toThrow('--runtime-arn applies only to the agentcore backend');
    expect(ddbSend).not.toHaveBeenCalled();
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

  test('onboardRepo with no option names only status, updated_at, onboarded_at and ttl', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a');

    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.UpdateExpression).toBe(`${BASE_SET} REMOVE #ttl`);
    expect(update.input.ExpressionAttributeNames).toEqual(BASE_NAMES);
    expect(update.input.ExpressionAttributeValues).toEqual(BASE_VALUES);
  });

  test('onboardRepo sets exactly the columns of set that have a value', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      set: { max_turns: 150, model_id: undefined, cedar_policies: ['policy'], poll_interval_ms: 0 },
    });

    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.UpdateExpression)
      .toBe(`${BASE_SET}, #max_turns = :max_turns, #cedar_policies = :cedar_policies, #poll_interval_ms = :poll_interval_ms REMOVE #ttl`);
    expect(update.input.ExpressionAttributeNames)
      .toEqual({ ...BASE_NAMES, '#max_turns': 'max_turns', '#cedar_policies': 'cedar_policies', '#poll_interval_ms': 'poll_interval_ms' });
    expect(update.input.ExpressionAttributeValues)
      .toEqual({ ...BASE_VALUES, ':max_turns': 150, ':cedar_policies': ['policy'], ':poll_interval_ms': 0 });
  });

  test('onboardRepo removes each column of unset once', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      set: { model_id: undefined },
      unset: ['model_id', 'mcp_servers', 'model_id'],
    });

    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.UpdateExpression).toBe(`${BASE_SET} REMOVE #ttl, #model_id, #mcp_servers`);
    expect(update.input.ExpressionAttributeNames)
      .toEqual({ ...BASE_NAMES, '#model_id': 'model_id', '#mcp_servers': 'mcp_servers' });
    expect(update.input.ExpressionAttributeValues).toEqual(BASE_VALUES);
  });

  test('onboardRepo refuses a column that is both set and unset before any send', async () => {
    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a', {
      set: { model_id: 'model' },
      unset: ['model_id'],
    })).rejects.toMatchObject({ name: 'CliError', message: "'model_id' cannot be set and unset in one command." });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('onboardRepo refuses unset for a repository without a row before any send', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as { loadRepoConfig: jest.Mock };
    loadRepoConfig.mockRejectedValueOnce(new RepoNotOnboardedError('acme/a'));

    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a', { unset: ['model_id'] }))
      .rejects.toBeInstanceOf(RepoNotOnboardedError);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('onboardRepo returns the row as stored after the write and the row it read before', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as { loadRepoConfig: jest.Mock };
    const stored = { repo: 'acme/a', status: 'removed', onboarded_at: '2025-01-01T00:00:00Z', build_command: 'make' };
    loadRepoConfig.mockResolvedValueOnce(stored);
    ddbSend.mockResolvedValue({ Attributes: { ...stored, status: 'active', max_turns: 150 } });

    const result = await onboardRepo('us-east-1', 'RepoTable', 'acme/a', { set: { max_turns: 150 } });

    expect(result.previous).toBe(stored);
    expect(result.config).toEqual({ ...stored, status: 'active', max_turns: 150 });
  });

  test('onboardRepo persists --poll-interval override', async () => {
    await onboardRepo('us-east-1', 'RepoTable', 'acme/a', { set: { poll_interval_ms: 12345 } });

    const update = ddbSend.mock.calls[0][0] as UpdateCommand;
    expect(update.input.ExpressionAttributeValues?.[':poll_interval_ms']).toBe(12345);
  });

  test('onboardRepo treats a missing row as a fresh onboard', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockRejectedValueOnce(new RepoNotOnboardedError('acme/a'));

    const { previous } = await onboardRepo('us-east-1', 'RepoTable', 'acme/a', { unset: [] });
    expect(previous).toBeUndefined();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('onboardRepo re-throws non-not-found load errors without writing', async () => {
    const { loadRepoConfig } = jest.requireMock('../../src/repo-lookup') as {
      loadRepoConfig: jest.Mock;
    };
    loadRepoConfig.mockRejectedValueOnce(
      Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
    );

    await expect(onboardRepo('us-east-1', 'RepoTable', 'acme/a')).rejects.toThrow('throttled');
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('offboardRepo rejects an invalid repo format before any write', async () => {
    await expect(offboardRepo('us-east-1', 'RepoTable', 'not-a-repo'))
      .rejects.toBeInstanceOf(CliError);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
