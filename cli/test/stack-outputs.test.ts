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

import { CliError } from '../src/errors';
import {
  fetchConfigureBundleFromStack,
  getStackOutput,
  resolveConfigureBundleFromStack,
  resolveOperatorRegion,
} from '../src/stack-outputs';

const cfSend = jest.fn();

jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfSend })),
  };
});

function mockStackWithOutputs(outputs: Record<string, string>): void {
  cfSend.mockResolvedValueOnce({
    Stacks: [{
      Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    }],
  });
}

describe('resolveConfigureBundleFromStack', () => {
  beforeEach(() => {
    cfSend.mockReset();
  });

  test('maps ApiUrl, UserPoolId, and AppClientId to configure fields', async () => {
    mockStackWithOutputs({
      ApiUrl: 'https://api.example/v1/',
      UserPoolId: 'us-east-1_pool',
      AppClientId: 'client123',
    });

    await expect(resolveConfigureBundleFromStack('us-east-1', 'dev'))
      .resolves.toEqual({
        api_url: 'https://api.example/v1/',
        region: 'us-east-1',
        user_pool_id: 'us-east-1_pool',
        client_id: 'client123',
      });
  });

  test('returns null when a required output is missing', async () => {
    mockStackWithOutputs({
      ApiUrl: 'https://api.example/v1/',
      UserPoolId: 'us-east-1_pool',
    });

    await expect(resolveConfigureBundleFromStack('us-east-1', 'dev'))
      .resolves.toBeNull();
  });
});

describe('fetchConfigureBundleFromStack', () => {
  beforeEach(() => {
    cfSend.mockReset();
  });

  test('returns configure bundle when outputs are complete', async () => {
    mockStackWithOutputs({
      ApiUrl: 'https://api.example/v1/',
      UserPoolId: 'us-east-1_pool',
      AppClientId: 'client123',
    });

    await expect(fetchConfigureBundleFromStack('us-east-1', 'dev'))
      .resolves.toEqual({
        api_url: 'https://api.example/v1/',
        region: 'us-east-1',
        user_pool_id: 'us-east-1_pool',
        client_id: 'client123',
      });
  });

  test('throws when configure outputs are incomplete', async () => {
    mockStackWithOutputs({
      UserPoolId: 'us-east-1_pool',
    });

    await expect(fetchConfigureBundleFromStack('us-east-1', 'dev'))
      .rejects.toThrow(CliError);
  });
});

describe('resolveOperatorRegion', () => {
  const originalRegion = process.env.AWS_REGION;
  const originalDefaultRegion = process.env.AWS_DEFAULT_REGION;

  afterEach(() => {
    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
    if (originalDefaultRegion === undefined) {
      delete process.env.AWS_DEFAULT_REGION;
    } else {
      process.env.AWS_DEFAULT_REGION = originalDefaultRegion;
    }
  });

  test('prefers explicit flag over configured region', () => {
    expect(resolveOperatorRegion({ region: 'eu-west-1' }, 'us-east-1')).toBe('eu-west-1');
  });

  test('throws when region cannot be resolved', () => {
    // Both AWS_REGION and AWS_DEFAULT_REGION feed the fallback chain.
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(() => resolveOperatorRegion({}, undefined)).toThrow(CliError);
  });
});

describe('getStackOutput', () => {
  beforeEach(() => {
    cfSend.mockReset();
  });

  test('returns a single output value by key', async () => {
    mockStackWithOutputs({ ApiUrl: 'https://api.example/v1/' });
    await expect(getStackOutput('us-east-1', 'dev', 'ApiUrl'))
      .resolves.toBe('https://api.example/v1/');
  });

  test('returns null when the output key is absent', async () => {
    mockStackWithOutputs({ ApiUrl: 'https://api.example/v1/' });
    await expect(getStackOutput('us-east-1', 'dev', 'MissingKey'))
      .resolves.toBeNull();
  });

  test('throws when the stack does not exist', async () => {
    cfSend.mockResolvedValueOnce({ Stacks: [] });
    await expect(getStackOutput('us-east-1', 'missing', 'ApiUrl'))
      .rejects.toThrow(/not found/);
  });

  test('wraps a raw SDK error into an actionable CliError', async () => {
    cfSend.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }),
    );
    await expect(getStackOutput('us-east-1', 'dev', 'ApiUrl'))
      .rejects.toThrow(/Could not describe stack 'dev' in us-east-1/);
  });
});
