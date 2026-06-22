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

import {
  adminCreateUser,
  adminDeleteUser,
  adminInviteUser,
  adminResetPassword,
  assertLikelyEmail,
  buildCognitoEmailByUsername,
  displayUserIdentity,
  listCognitoUsers,
  mapCognitoUser,
  resolveCognitoAdminContext,
  resolveCognitoUsername,
  resolveUserEmailForDisplay,
} from '../../src/cognito-admin';
import * as config from '../../src/config';
import { CliError } from '../../src/errors';
import * as stackOutputs from '../../src/stack-outputs';

const cognitoSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const actual = jest.requireActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: jest.fn(() => ({ send: cognitoSend })),
  };
});

jest.mock('../../src/config', () => ({
  tryLoadConfig: jest.fn(),
}));

const getStackOutputSpy = jest.spyOn(stackOutputs, 'getStackOutput');
const resolveConfigureBundleFromStackSpy = jest.spyOn(stackOutputs, 'resolveConfigureBundleFromStack');
const tryLoadConfigMock = config.tryLoadConfig as jest.Mock;

describe('resolveCognitoAdminContext', () => {
  beforeEach(() => {
    getStackOutputSpy.mockReset();
    resolveConfigureBundleFromStackSpy.mockReset();
    tryLoadConfigMock.mockReset();
  });

  test('uses configured user pool when bgagent configure exists', async () => {
    tryLoadConfigMock.mockReturnValue({
      api_url: 'https://api/v1/',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_fromConfig',
      client_id: 'client123',
    });

    const ctx = await resolveCognitoAdminContext({ stackName: 'dev' });
    expect(ctx.userPoolId).toBe('us-east-1_fromConfig');
    expect(ctx.configureBundle?.api_url).toBe('https://api/v1/');
    expect(getStackOutputSpy).not.toHaveBeenCalled();
  });

  test('reads user pool and configure bundle from stack outputs when not configured', async () => {
    tryLoadConfigMock.mockReturnValue(null);
    getStackOutputSpy.mockResolvedValue('us-east-1_fromStack');
    resolveConfigureBundleFromStackSpy.mockResolvedValue({
      api_url: 'https://api/v1/',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_fromStack',
      client_id: 'client456',
    });

    const ctx = await resolveCognitoAdminContext({ region: 'us-east-1', stackName: 'dev' });
    expect(ctx.userPoolId).toBe('us-east-1_fromStack');
    expect(ctx.configureBundle).toEqual({
      api_url: 'https://api/v1/',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_fromStack',
      client_id: 'client456',
    });
  });

  test('throws when user pool cannot be resolved', async () => {
    tryLoadConfigMock.mockReturnValue(null);
    getStackOutputSpy.mockResolvedValue(null);

    await expect(resolveCognitoAdminContext({ region: 'us-east-1', stackName: 'dev' }))
      .rejects.toThrow(CliError);
  });

  test('builds configure bundle from stack when config is partial', async () => {
    tryLoadConfigMock.mockReturnValue({
      api_url: 'https://old/v1/',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_partial',
    });
    resolveConfigureBundleFromStackSpy.mockResolvedValue({
      api_url: 'https://api/v1/',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_fromStack',
      client_id: 'client789',
    });

    const ctx = await resolveCognitoAdminContext({ region: 'us-east-1', stackName: 'dev' });
    expect(ctx.configureBundle).toEqual({
      api_url: 'https://api/v1/',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_fromStack',
      client_id: 'client789',
    });
  });

  test('returns null configure bundle when stack outputs are incomplete', async () => {
    tryLoadConfigMock.mockReturnValue(null);
    getStackOutputSpy.mockResolvedValue('us-east-1_onlyPool');
    resolveConfigureBundleFromStackSpy.mockResolvedValue(null);

    const ctx = await resolveCognitoAdminContext({ region: 'us-east-1', stackName: 'dev' });
    expect(ctx.userPoolId).toBe('us-east-1_onlyPool');
    expect(ctx.configureBundle).toBeNull();
  });
});

describe('mapCognitoUser', () => {
  test('extracts username, status, and email', () => {
    const summary = mapCognitoUser({
      Username: 'alice@example.com',
      UserStatus: 'CONFIRMED',
      Enabled: true,
      UserCreateDate: new Date('2026-01-01T00:00:00.000Z'),
      Attributes: [{ Name: 'email', Value: 'alice@example.com' }],
    });
    expect(summary.email).toBe('alice@example.com');
  });

  test('preserves internal Cognito username when it differs from email', () => {
    const summary = mapCognitoUser({
      Username: 'e4c80468-8051-7062-032c-01689f5711d3',
      UserStatus: 'CONFIRMED',
      Enabled: true,
      Attributes: [{ Name: 'email', Value: 'you@example.com' }],
    });
    expect(summary.username).toBe('e4c80468-8051-7062-032c-01689f5711d3');
    expect(summary.email).toBe('you@example.com');
    expect(displayUserIdentity(summary)).toBe('you@example.com');
  });

  test('handles missing optional attributes', () => {
    const summary = mapCognitoUser({ Username: 'bob' });
    expect(summary.username).toBe('bob');
    expect(summary.status).toBe('UNKNOWN');
    expect(summary.enabled).toBe(false);
    expect(summary.email).toBeUndefined();
    expect(displayUserIdentity(summary)).toBe('bob');
  });
});

describe('resolveCognitoUsername', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('returns input unchanged when it is not an email', async () => {
    const client = { send: cognitoSend } as never;
    await expect(resolveCognitoUsername(client, 'pool', 'uuid-subject-id'))
      .resolves.toBe('uuid-subject-id');
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  test('looks up Cognito Username by email attribute', async () => {
    cognitoSend.mockResolvedValueOnce({
      Users: [{ Username: 'e4c80468-8051-7062-032c-01689f5711d3' }],
    });
    const client = { send: cognitoSend } as never;

    await expect(resolveCognitoUsername(client, 'pool', 'you@example.com'))
      .resolves.toBe('e4c80468-8051-7062-032c-01689f5711d3');
    expect(cognitoSend).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        Filter: 'email = "you@example.com"',
      }),
    }));
  });

  test('throws when email is not found', async () => {
    cognitoSend.mockResolvedValueOnce({ Users: [] });
    const client = { send: cognitoSend } as never;

    await expect(resolveCognitoUsername(client, 'pool', 'missing@example.com'))
      .rejects.toThrow(/not found/);
  });

  test('rejects emails containing a double-quote', async () => {
    const client = { send: cognitoSend } as never;

    await expect(resolveCognitoUsername(client, 'pool', 'bad"@example.com'))
      .rejects.toThrow(/quote or backslash/);
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  test('rejects emails containing a backslash', async () => {
    const client = { send: cognitoSend } as never;

    await expect(resolveCognitoUsername(client, 'pool', 'bad\\@example.com'))
      .rejects.toThrow(/quote or backslash/);
    expect(cognitoSend).not.toHaveBeenCalled();
  });
});

describe('assertLikelyEmail', () => {
  test('rejects non-email usernames', () => {
    expect(() => assertLikelyEmail('not-an-email')).toThrow(CliError);
  });
});

describe('listCognitoUsers', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('paginates ListUsers results and sorts by email', async () => {
    cognitoSend
      .mockResolvedValueOnce({
        Users: [{
          Username: 'uuid-b',
          UserStatus: 'CONFIRMED',
          Enabled: true,
          Attributes: [{ Name: 'email', Value: 'b@example.com' }],
        }],
        PaginationToken: 'next',
      })
      .mockResolvedValueOnce({
        Users: [{
          Username: 'uuid-a',
          UserStatus: 'CONFIRMED',
          Enabled: true,
          Attributes: [{ Name: 'email', Value: 'a@example.com' }],
        }],
      });

    const users = await listCognitoUsers({
      region: 'us-east-1',
      userPoolId: 'pool',
      configureBundle: null,
    });
    expect(users.map((u) => u.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(cognitoSend).toHaveBeenCalledTimes(2);
  });
});

describe('adminCreateUser', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('maps UsernameExistsException to CliError', async () => {
    const err = new Error('exists');
    err.name = 'UsernameExistsException';
    cognitoSend.mockRejectedValueOnce(err);
    const client = { send: cognitoSend } as never;

    await expect(adminCreateUser(client, 'pool', 'a@b.com', 'pwd'))
      .rejects.toThrow(/already exists/);
  });
});

describe('adminInviteUser', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('creates user then sets permanent password', async () => {
    cognitoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com' }] })
      .mockResolvedValueOnce({});
    await adminInviteUser(
      { region: 'us-east-1', userPoolId: 'pool', configureBundle: null },
      'a@b.com',
      'SecretPass123!',
    );
    expect(cognitoSend).toHaveBeenCalledTimes(3);
  });

  test('surfaces half-created user when password set fails', async () => {
    cognitoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com' }] })
      .mockRejectedValueOnce(Object.assign(new Error('policy'), { name: 'InvalidPasswordException' }));

    await expect(adminInviteUser(
      { region: 'us-east-1', userPoolId: 'pool', configureBundle: null },
      'a@b.com',
      'weak',
    )).rejects.toThrow(/FORCE_CHANGE_PASSWORD/);
  });
});

describe('adminDeleteUser', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('maps UserNotFoundException to CliError', async () => {
    cognitoSend
      .mockResolvedValueOnce({
        Users: [{ Username: 'uuid-gone' }],
      })
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'UserNotFoundException' }));

    await expect(adminDeleteUser(
      { region: 'us-east-1', userPoolId: 'pool', configureBundle: null },
      'gone@b.com',
    )).rejects.toThrow(/not found/);
  });

  test('deletes an existing user by email', async () => {
    cognitoSend
      .mockResolvedValueOnce({
        Users: [{ Username: 'uuid-gone' }],
      })
      .mockResolvedValueOnce({});

    await adminDeleteUser(
      { region: 'us-east-1', userPoolId: 'pool', configureBundle: null },
      'gone@b.com',
    );
    expect(cognitoSend).toHaveBeenCalledTimes(2);
    expect(cognitoSend.mock.calls[1][0].input).toEqual(expect.objectContaining({
      Username: 'uuid-gone',
    }));
  });
});

describe('adminResetPassword', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('sets permanent password for existing user by email', async () => {
    cognitoSend
      .mockResolvedValueOnce({
        Users: [{ Username: 'uuid-a' }],
      })
      .mockResolvedValueOnce({});

    await adminResetPassword(
      { region: 'us-east-1', userPoolId: 'pool', configureBundle: null },
      'a@b.com',
      'NewPass123!',
    );
    expect(cognitoSend).toHaveBeenCalledTimes(2);
    expect(cognitoSend.mock.calls[1][0].input).toEqual(expect.objectContaining({
      Username: 'uuid-a',
    }));
  });

  test('maps UserNotFoundException to CliError', async () => {
    cognitoSend
      .mockResolvedValueOnce({
        Users: [{ Username: 'uuid-missing' }],
      })
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'UserNotFoundException' }));

    await expect(adminResetPassword(
      { region: 'us-east-1', userPoolId: 'pool', configureBundle: null },
      'missing@b.com',
      'NewPass123!',
    )).rejects.toThrow(/not found/);
  });
});

describe('resolveUserEmailForDisplay', () => {
  const lookup = new Map([
    ['e4c80468-8051-7062-032c-01689f5711d3', 'ops@example.com'],
  ]);

  test('maps Cognito username UUID to email', () => {
    expect(resolveUserEmailForDisplay('e4c80468-8051-7062-032c-01689f5711d3', lookup))
      .toBe('ops@example.com');
  });

  test('returns email when user_id is already an email', () => {
    expect(resolveUserEmailForDisplay('you@example.com', lookup)).toBe('you@example.com');
  });

  test('returns dash when username is unknown', () => {
    expect(resolveUserEmailForDisplay('unknown-uuid', lookup)).toBe('-');
  });
});

describe('buildCognitoEmailByUsername', () => {
  beforeEach(() => {
    cognitoSend.mockReset();
  });

  test('indexes email by Cognito Username', async () => {
    cognitoSend.mockResolvedValueOnce({
      Users: [{
        Username: 'e4c80468-8051-7062-032c-01689f5711d3',
        Attributes: [{ Name: 'email', Value: 'ops@example.com' }],
      }],
    });

    const lookup = await buildCognitoEmailByUsername({
      region: 'us-east-1',
      userPoolId: 'pool',
      configureBundle: null,
    });

    expect(lookup.get('e4c80468-8051-7062-032c-01689f5711d3')).toBe('ops@example.com');
  });
});
