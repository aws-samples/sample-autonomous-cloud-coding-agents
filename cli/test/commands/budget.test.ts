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
  currentBudgetPeriod,
  listBudgetStatus,
  setMonthlyBudget,
} from '../../src/budget-store';
import {
  cognitoClient,
  resolveCognitoAdminContext,
  resolveCognitoUsername,
} from '../../src/cognito-admin';
import { makeBudgetCommand } from '../../src/commands/budget';
import { getStackOutput } from '../../src/stack-outputs';

jest.mock('../../src/budget-store');
jest.mock('../../src/cognito-admin');
jest.mock('../../src/stack-outputs');
jest.mock('../../src/operator-context', () => ({
  DEFAULT_STACK_NAME: 'backgroundagent-dev',
  resolveOperatorContext: jest.fn(() => ({
    region: 'us-east-1',
    stackName: 'backgroundagent-dev',
  })),
}));

const listBudgetStatusMock = listBudgetStatus as jest.Mock;
const setMonthlyBudgetMock = setMonthlyBudget as jest.Mock;
const currentBudgetPeriodMock = currentBudgetPeriod as jest.Mock;
const getStackOutputMock = getStackOutput as jest.Mock;
const resolveCognitoAdminContextMock = resolveCognitoAdminContext as jest.Mock;
const resolveCognitoUsernameMock = resolveCognitoUsername as jest.Mock;
const cognitoClientMock = cognitoClient as jest.Mock;
const cognitoSend = jest.fn();

describe('budget command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    listBudgetStatusMock.mockReset();
    setMonthlyBudgetMock.mockReset();
    currentBudgetPeriodMock.mockReset();
    getStackOutputMock.mockReset();
    resolveCognitoAdminContextMock.mockReset();
    resolveCognitoUsernameMock.mockReset();
    cognitoClientMock.mockReset();
    cognitoSend.mockReset();

    getStackOutputMock.mockResolvedValue('BudgetTable');
    resolveCognitoAdminContextMock.mockResolvedValue({
      region: 'us-east-1',
      userPoolId: 'us-east-1_pool',
      configureBundle: null,
    });
    resolveCognitoUsernameMock.mockResolvedValue('user-sub');
    cognitoClientMock.mockReturnValue({ send: cognitoSend });
    cognitoSend.mockResolvedValue({
      UserAttributes: [{ Name: 'sub', Value: 'subject-123' }],
    });
    listBudgetStatusMock.mockResolvedValue([]);
    setMonthlyBudgetMock.mockResolvedValue(undefined);
    currentBudgetPeriodMock.mockReturnValue('2026-08');
  });

  afterEach(() => {
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  test('sets a hard-stop user budget after resolving email to Cognito ID', async () => {
    const command = makeBudgetCommand();
    await command.parseAsync([
      'node',
      'test',
      'set',
      '--user',
      'operator@example.com',
      '--monthly-usd',
      '125.50',
      '--hard-stop',
      '--region',
      'us-east-1',
    ]);

    expect(resolveCognitoUsernameMock).toHaveBeenCalledWith(
      expect.anything(),
      'us-east-1_pool',
      'operator@example.com',
    );
    expect(cognitoSend).toHaveBeenCalledWith(expect.objectContaining({
      input: {
        UserPoolId: 'us-east-1_pool',
        Username: 'user-sub',
      },
    }));
    expect(setMonthlyBudgetMock).toHaveBeenCalledWith(
      'us-east-1',
      'BudgetTable',
      { type: 'user', id: 'subject-123' },
      125.5,
      true,
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('$125.50'));
  });

  test('validates a Cognito team before setting its budget', async () => {
    const command = makeBudgetCommand();
    await command.parseAsync([
      'node',
      'test',
      'set',
      '--team',
      'Platform',
      '--monthly-usd',
      '500',
    ]);

    expect(cognitoSend).toHaveBeenCalledWith(expect.objectContaining({
      input: {
        UserPoolId: 'us-east-1_pool',
        GroupName: 'Platform',
      },
    }));
    expect(setMonthlyBudgetMock).toHaveBeenCalledWith(
      'us-east-1',
      'BudgetTable',
      { type: 'team', id: 'Platform' },
      500,
      false,
    );
  });

  test('rejects a Cognito user ID that does not exist', async () => {
    const notFound = Object.assign(new Error('missing'), {
      name: 'UserNotFoundException',
    });
    cognitoSend.mockRejectedValueOnce(notFound);
    const command = makeBudgetCommand();

    await expect(
      command.parseAsync([
        'node',
        'test',
        'set',
        '--user',
        'missing-user',
        '--monthly-usd',
        '10',
      ]),
    ).rejects.toThrow("Cognito user 'missing-user' was not found");
    expect(setMonthlyBudgetMock).not.toHaveBeenCalled();
  });

  test('rejects a Cognito user with no sub attribute', async () => {
    cognitoSend.mockResolvedValueOnce({ UserAttributes: [] });
    const command = makeBudgetCommand();

    await expect(
      command.parseAsync([
        'node',
        'test',
        'set',
        '--user',
        'missing-sub',
        '--monthly-usd',
        '10',
      ]),
    ).rejects.toThrow("Cognito user 'missing-sub' has no sub attribute");
    expect(setMonthlyBudgetMock).not.toHaveBeenCalled();
  });

  test('outputs the current period in JSON when no budgets are configured', async () => {
    const command = makeBudgetCommand();
    await command.parseAsync(['node', 'test', 'status', '--output', 'json']);

    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
      period: '2026-08',
      budgets: [],
    });
  });

  test('rejects invalid output before reading stack outputs', async () => {
    const command = makeBudgetCommand();
    await expect(
      command.parseAsync(['node', 'test', 'status', '--output', 'yaml']),
    ).rejects.toThrow('--output must be text or json');
    expect(getStackOutputMock).not.toHaveBeenCalled();
  });

  test('requires exactly one scope for set before reading stack outputs', async () => {
    const command = makeBudgetCommand();
    await expect(
      command.parseAsync([
        'node',
        'test',
        'set',
        '--user',
        'user-1',
        '--team',
        'Platform',
        '--monthly-usd',
        '10',
      ]),
    ).rejects.toThrow('Choose exactly one scope');
    expect(getStackOutputMock).not.toHaveBeenCalled();
  });

  test('rejects non-positive monthly limits', async () => {
    const command = makeBudgetCommand();
    await expect(
      command.parseAsync(['node', 'test', 'set', '--user', 'user-1', '--monthly-usd', '0']),
    ).rejects.toThrow('--monthly-usd must be at least 0.01');
    expect(setMonthlyBudgetMock).not.toHaveBeenCalled();
  });
});
