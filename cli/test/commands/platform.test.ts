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

import * as githubToken from '../../src/github-token';
import { redactSecretArn } from '../../src/operator-context';
import { doctorChecksPassed, runPlatformDoctor } from '../../src/platform-doctor';
import * as repoLookup from '../../src/repo-lookup';
import * as stackOutputs from '../../src/stack-outputs';

const cognitoSend = jest.fn();
const bedrockSend = jest.fn();
const microvmSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const actual = jest.requireActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: jest.fn(() => ({ send: cognitoSend })),
  };
});

jest.mock('@aws-sdk/client-bedrock', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock');
  return {
    ...actual,
    BedrockClient: jest.fn(() => ({ send: bedrockSend })),
  };
});

jest.mock('@aws-sdk/client-lambda-microvms', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda-microvms');
  return {
    ...actual,
    LambdaMicrovmsClient: jest.fn(() => ({ send: microvmSend })),
  };
});

jest.mock('../../src/github-token', () => {
  const actual = jest.requireActual('../../src/github-token');
  return {
    ...actual,
    isGithubTokenConfigured: jest.fn(),
  };
});

jest.mock('../../src/repo-lookup', () => {
  const actual = jest.requireActual('../../src/repo-lookup');
  return {
    ...actual,
    listRepoConfigs: jest.fn(),
  };
});

const getStackOutputSpy = jest.spyOn(stackOutputs, 'getStackOutput');
const isGithubTokenConfiguredMock = githubToken.isGithubTokenConfigured as jest.Mock;
const listRepoConfigsMock = repoLookup.listRepoConfigs as jest.Mock;
const originalFetch = global.fetch;

function mockStackOutputs(): void {
  getStackOutputSpy.mockImplementation(async (_region, _stack, key) => {
    const outputs: Record<string, string> = {
      ApiUrl: 'https://api.example/v1/',
      UserPoolId: 'us-east-1_pool',
      AppClientId: 'client123',
      GitHubTokenSecretArn: 'arn:token',
      RepoTableName: 'RepoTable',
    };
    return outputs[key] ?? null;
  });
}

describe('runPlatformDoctor', () => {
  beforeEach(() => {
    getStackOutputSpy.mockReset();
    isGithubTokenConfiguredMock.mockReset();
    listRepoConfigsMock.mockReset();
    cognitoSend.mockReset().mockResolvedValue({});
    bedrockSend.mockReset().mockResolvedValue({});
    microvmSend.mockReset().mockResolvedValue({ images: [] });
    global.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns pass when all checks succeed', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([
      { repo: 'acme/a', status: 'active' },
      { repo: 'acme/b', status: 'active' },
    ]);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    expect(doctorChecksPassed(results)).toBe(true);
    expect(results.find((r) => r.id === 'api_reachable')?.status).toBe('pass');
    expect(results.find((r) => r.id === 'github_token')?.status).toBe('pass');
    expect(results.find((r) => r.id === 'active_repos')?.status).toBe('pass');
    expect(cognitoSend).toHaveBeenCalledTimes(2);
    expect(bedrockSend).toHaveBeenCalledTimes(1);
  });

  test('fails when github token is not configured', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(false);
    listRepoConfigsMock.mockResolvedValue([{ repo: 'acme/a', status: 'active' }]);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    expect(doctorChecksPassed(results)).toBe(false);
    expect(results.find((r) => r.id === 'github_token')?.status).toBe('fail');
  });

  test('warns when API returns an unexpected status code', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([{ repo: 'acme/a', status: 'active' }]);
    (global.fetch as jest.Mock).mockResolvedValue({ status: 500, ok: false });

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    expect(results.find((r) => r.id === 'api_reachable')?.status).toBe('warn');
    expect(doctorChecksPassed(results)).toBe(true);
  });

  test('fails the active-repo check when the repo table output is missing', async () => {
    mockStackOutputs();
    getStackOutputSpy.mockImplementation(async (_region, _stack, key) =>
      key === 'RepoTableName' ? null : ({
        ApiUrl: 'https://api.example/v1/',
        UserPoolId: 'us-east-1_pool',
        AppClientId: 'client123',
        GitHubTokenSecretArn: 'arn:token',
      }[key] ?? null));
    isGithubTokenConfiguredMock.mockResolvedValue(true);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });

    expect(results.find((r) => r.id === 'active_repos')).toEqual(expect.objectContaining({
      status: 'fail',
      detail: 'Stack output RepoTableName is missing.',
    }));
    expect(listRepoConfigsMock).not.toHaveBeenCalled();
  });

  test('fails the active-repo check when the repo table has no active rows', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([{ repo: 'acme/removed', status: 'removed' }]);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });

    expect(results.find((r) => r.id === 'active_repos')).toEqual(expect.objectContaining({
      status: 'fail',
      detail: 'No active repos in RepoTable. Register a Blueprint and redeploy.',
    }));
  });

  test('reports a non-Error repo lookup failure', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockRejectedValue('DynamoDB unavailable');

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });

    expect(results.find((r) => r.id === 'active_repos')).toEqual(expect.objectContaining({
      status: 'fail',
      detail: 'DynamoDB unavailable',
    }));
  });

  test('probes Lambda MicroVMs only when an active blueprint uses it', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([
      { repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' },
      { repo: 'acme/removed', status: 'removed', compute_type: 'lambda-microvm' },
    ]);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });

    expect(results.find((r) => r.id === 'lambda_microvm_availability')?.status).toBe('pass');
    expect(microvmSend).toHaveBeenCalledTimes(1);
  });

  test('omits Lambda MicroVM check when no active blueprint uses it', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([
      { repo: 'acme/a', status: 'active', compute_type: 'agentcore' },
      { repo: 'acme/removed', status: 'removed', compute_type: 'lambda-microvm' },
    ]);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });

    expect(results.some((r) => r.id === 'lambda_microvm_availability')).toBe(false);
    expect(microvmSend).not.toHaveBeenCalled();
  });

  test('reports Lambda MicroVM probe failure with remedy', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([
      { repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' },
    ]);
    microvmSend.mockRejectedValue(new Error('endpoint not found'));

    const results = await runPlatformDoctor({ region: 'eu-central-1', stackName: 'dev' });
    const check = results.find((r) => r.id === 'lambda_microvm_availability');

    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('Launch regions: us-east-1');
    expect(check?.detail).toContain('--compute-type agentcore');
  });

  test('warns when IAM prevents the Lambda MicroVM availability check', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([
      { repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' },
    ]);
    microvmSend.mockRejectedValue(Object.assign(
      new Error('User is not authorized to perform lambda-microvms:ListManagedMicrovmImages'),
      { name: 'AccessDeniedException' },
    ));

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    const check = results.find((r) => r.id === 'lambda_microvm_availability');

    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('Cannot verify Lambda MicroVM availability');
    expect(check?.detail).toContain('lambda-microvms List* actions');
    expect(doctorChecksPassed(results)).toBe(true);
  });

  test('formats a non-Error Lambda MicroVM probe failure', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    listRepoConfigsMock.mockResolvedValue([
      { repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' },
    ]);
    microvmSend.mockRejectedValue('service unavailable');

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    const check = results.find((r) => r.id === 'lambda_microvm_availability');

    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('service unavailable');
  });
});

describe('doctorChecksPassed', () => {
  test('treats warnings as acceptable', () => {
    expect(doctorChecksPassed([
      { id: 'a', label: 'A', status: 'pass', detail: '' },
      { id: 'b', label: 'B', status: 'warn', detail: '' },
    ])).toBe(true);
  });

  test('fails when any check fails', () => {
    expect(doctorChecksPassed([
      { id: 'a', label: 'A', status: 'pass', detail: '' },
      { id: 'b', label: 'B', status: 'fail', detail: '' },
    ])).toBe(false);
  });
});

describe('redactSecretArn', () => {
  test('redacts secret name but keeps suffix', () => {
    expect(redactSecretArn('arn:aws:secretsmanager:us-east-1:123456789012:secret:GitHubTokenSecret-AbCdEf'))
      .toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:****-AbCdEf');
  });
});
