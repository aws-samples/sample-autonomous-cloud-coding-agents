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
    countActiveRepos: jest.fn(),
  };
});

const getStackOutputSpy = jest.spyOn(stackOutputs, 'getStackOutput');
const isGithubTokenConfiguredMock = githubToken.isGithubTokenConfigured as jest.Mock;
const countActiveReposMock = repoLookup.countActiveRepos as jest.Mock;
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
    countActiveReposMock.mockReset();
    cognitoSend.mockReset().mockResolvedValue({});
    bedrockSend.mockReset().mockResolvedValue({});
    global.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns pass when all checks succeed', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    countActiveReposMock.mockResolvedValue(2);

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
    countActiveReposMock.mockResolvedValue(1);

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    expect(doctorChecksPassed(results)).toBe(false);
    expect(results.find((r) => r.id === 'github_token')?.status).toBe('fail');
  });

  test('warns when API returns an unexpected status code', async () => {
    mockStackOutputs();
    isGithubTokenConfiguredMock.mockResolvedValue(true);
    countActiveReposMock.mockResolvedValue(1);
    (global.fetch as jest.Mock).mockResolvedValue({ status: 500, ok: false });

    const results = await runPlatformDoctor({ region: 'us-east-1', stackName: 'dev' });
    expect(results.find((r) => r.id === 'api_reachable')?.status).toBe('warn');
    expect(doctorChecksPassed(results)).toBe(true);
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
