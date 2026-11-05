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

const ddbSend = jest.fn();
const cognitoSend = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();

async function loadBudgets(options: { enabled?: boolean } = {}) {
  jest.resetModules();
  ddbSend.mockReset();
  cognitoSend.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
  if (options.enabled === false) {
    delete process.env.BUDGET_TABLE_NAME;
    delete process.env.USER_POOL_ID;
  } else {
    process.env.BUDGET_TABLE_NAME = 'Budgets';
    process.env.USER_POOL_ID = 'us-east-1_pool';
  }
  jest.doMock('../../../src/handlers/shared/ua', () => ({
    makeDocClient: () => ({ send: ddbSend }),
    makeClient: () => ({ send: cognitoSend }),
  }));
  jest.doMock('../../../src/handlers/shared/logger', () => ({
    logger: {
      info: jest.fn(),
      warn: loggerWarn,
      error: loggerError,
      child: jest.fn(),
    },
  }));
  return import('../../../src/handlers/shared/budgets');
}

afterEach(() => {
  jest.dontMock('../../../src/handlers/shared/ua');
  jest.dontMock('../../../src/handlers/shared/logger');
  jest.restoreAllMocks();
  delete process.env.BUDGET_TABLE_NAME;
  delete process.env.USER_POOL_ID;
});

describe('budget admission', () => {
  test('resolves Cognito groups and blocks an exhausted hard-stop team', async () => {
    const budgets = await loadBudgets();
    cognitoSend.mockResolvedValue({
      Groups: [{ GroupName: 'Developers' }, { GroupName: 'Platform' }],
    });
    ddbSend
      .mockResolvedValueOnce({ Responses: { Budgets: [] } })
      .mockResolvedValueOnce({ Items: [{ scope_key: 'TEAM#Platform' }] })
      .mockResolvedValueOnce({
        Responses: {
          Budgets: [
            {
              scope_key: 'TEAM#Platform',
              period: 'CONFIG',
              monthly_limit_usd: 100,
              hard_stop: true,
            },
            {
              scope_key: 'TEAM#Platform',
              period: '2026-08',
              spend_usd: 101.25,
            },
          ],
        },
      });

    const result = await budgets.checkBudgetAdmission(
      'user-1',
      undefined,
      new Date('2026-08-18T12:00:00Z'),
    );

    expect(result.teamIds).toEqual(['Developers', 'Platform']);
    expect(result.blocked).toEqual({
      scopeType: 'team',
      scopeId: 'Platform',
      spendUsd: 101.25,
      monthlyLimitUsd: 100,
    });
    expect(ddbSend.mock.calls[0][0].input.RequestItems.Budgets.ConsistentRead).toBe(true);
    expect(ddbSend.mock.calls[1][0].input).toEqual(expect.objectContaining({
      IndexName: budgets.BUDGET_CONFIG_INDEX_NAME,
      KeyConditionExpression: 'record_type = :config AND begins_with(scope_key, :team)',
      Limit: 1,
    }));
  });

  test('paginates Cognito groups before loading applicable team budgets', async () => {
    const budgets = await loadBudgets();
    cognitoSend
      .mockResolvedValueOnce({
        Groups: [{ GroupName: 'Platform' }],
        NextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        Groups: [{ GroupName: 'Developers' }, { GroupName: 'Platform' }],
      });
    ddbSend
      .mockResolvedValueOnce({ Responses: { Budgets: [] } })
      .mockResolvedValueOnce({ Items: [{ scope_key: 'TEAM#Platform' }] })
      .mockResolvedValueOnce({ Responses: { Budgets: [] } });

    const result = await budgets.checkBudgetAdmission(
      'user-1',
      undefined,
      new Date('2026-08-18T12:00:00Z'),
    );

    expect(result.teamIds).toEqual(['Developers', 'Platform']);
    expect(cognitoSend).toHaveBeenCalledTimes(2);
    expect(cognitoSend.mock.calls[1][0].input.NextToken).toBe('page-2');
  });

  test('does not call Cognito when no team budget is configured', async () => {
    const budgets = await loadBudgets();
    ddbSend
      .mockResolvedValueOnce({ Responses: { Budgets: [] } })
      .mockResolvedValueOnce({ Items: [] });

    const result = await budgets.checkBudgetAdmission(
      'user-1',
      undefined,
      new Date('2026-08-18T12:00:00Z'),
    );

    expect(result).toEqual({
      teamIds: [],
      period: '2026-08',
      blocked: null,
    });
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  test('continues without team scopes when Cognito no longer has the mapped user', async () => {
    const budgets = await loadBudgets();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    ddbSend
      .mockResolvedValueOnce({ Responses: { Budgets: [] } })
      .mockResolvedValueOnce({ Items: [{ scope_key: 'TEAM#Platform' }] });
    cognitoSend.mockRejectedValueOnce(Object.assign(new Error('User does not exist'), {
      name: 'UserNotFoundException',
    }));

    await expect(budgets.checkBudgetAdmission('deleted-user')).resolves.toEqual({
      teamIds: [],
      period: expect.stringMatching(/^\d{4}-\d{2}$/),
      blocked: null,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      'Budget team membership user was not found; continuing without teams',
      expect.objectContaining({
        user_id: 'deleted-user',
        metric_type: 'budget_team_membership_user_missing',
      }),
    );
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(
      '"BudgetTeamMembershipUnresolved":1',
    ));
  });

  test('fails closed with a distinct metric on transient Cognito errors', async () => {
    const budgets = await loadBudgets();
    ddbSend
      .mockResolvedValueOnce({ Responses: { Budgets: [] } })
      .mockResolvedValueOnce({ Items: [{ scope_key: 'TEAM#Platform' }] });
    cognitoSend.mockRejectedValueOnce(new Error('Cognito throttled'));

    await expect(budgets.checkBudgetAdmission('user-1'))
      .rejects.toThrow('Cognito throttled');
    expect(loggerError).toHaveBeenCalledWith(
      'Failed to resolve budget team membership',
      expect.objectContaining({
        user_id: 'user-1',
        metric_type: 'budget_team_membership_resolution_failure',
      }),
    );
  });

  test('blocks an exhausted user without querying team configs or Cognito', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValueOnce({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: 'CONFIG',
            monthly_limit_usd: 10,
            hard_stop: true,
          },
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            spend_usd: 12,
          },
        ],
      },
    });

    const result = await budgets.checkBudgetAdmission(
      'user-1',
      undefined,
      new Date('2026-08-18T12:00:00Z'),
    );

    expect(result.blocked).toEqual(expect.objectContaining({
      scopeType: 'user',
      scopeId: 'user-1',
    }));
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  test('allows a soft budget above 100 percent', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValue({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: 'CONFIG',
            monthly_limit_usd: 10,
            hard_stop: false,
          },
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            spend_usd: 12,
          },
        ],
      },
    });

    const result = await budgets.checkBudgetAdmission(
      'user-1',
      [],
      new Date('2026-08-18T12:00:00Z'),
    );

    expect(cognitoSend).not.toHaveBeenCalled();
    expect(result.blocked).toBeNull();
  });

  test('blocks a hard-stop budget at exactly 100 percent', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValue({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: 'CONFIG',
            monthly_limit_usd: 10,
            hard_stop: true,
          },
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            spend_usd: 10,
          },
        ],
      },
    });

    await expect(budgets.checkBudgetAdmission(
      'user-1',
      [],
      new Date('2026-08-18T12:00:00Z'),
    )).resolves.toEqual({
      teamIds: [],
      period: '2026-08',
      blocked: {
        scopeType: 'user',
        scopeId: 'user-1',
        spendUsd: 10,
        monthlyLimitUsd: 10,
      },
    });
  });

  test('admits against a materialized monthly row whose spend counter is absent', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValue({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: 'CONFIG',
            monthly_limit_usd: 10,
            hard_stop: true,
          },
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            updated_at: '2026-08-18T12:00:00Z',
          },
        ],
      },
    });

    await expect(budgets.checkBudgetAdmission(
      'user-1',
      [],
      new Date('2026-08-18T12:00:00Z'),
    )).resolves.toEqual({
      teamIds: [],
      period: '2026-08',
      blocked: null,
    });
  });

  test('preserves caller-supplied groups when the feature is not wired', async () => {
    const budgets = await loadBudgets({ enabled: false });
    const result = await budgets.checkBudgetAdmission('user-1', ['TeamB', 'TeamA', 'TeamA']);
    expect(result.teamIds).toEqual(['TeamA', 'TeamB']);
    expect(result.blocked).toBeNull();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('rejects more team scopes than one DynamoDB rollup transaction supports', async () => {
    const budgets = await loadBudgets();
    const teamIds = Array.from({ length: 99 }, (_, index) => `Team-${index}`);

    await expect(budgets.checkBudgetAdmission('user-1', teamIds))
      .rejects.toThrow('belongs to 99 teams; budget rollup supports at most 98');
    expect(ddbSend).not.toHaveBeenCalled();
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  test('uses UTC calendar months', async () => {
    const budgets = await loadBudgets({ enabled: false });
    expect(budgets.budgetPeriod(new Date('2026-08-31T23:59:59Z'))).toBe('2026-08');
    expect(budgets.budgetPeriod(new Date('2026-09-01T00:00:00Z'))).toBe('2026-09');
    expect(budgets.budgetResetAt(new Date('2026-12-31T23:59:59Z')))
      .toBe('2027-01-01T00:00:00.000Z');
  });

  test('returns the authenticated user personal budget status', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValue({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: 'CONFIG',
            monthly_limit_usd: 100,
            hard_stop: true,
          },
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            spend_usd: 82.5,
          },
        ],
      },
    });

    await expect(budgets.loadPersonalBudgetStatus(
      'user-1',
      new Date('2026-08-21T12:00:00Z'),
    )).resolves.toEqual({
      period: '2026-08',
      resets_at: '2026-09-01T00:00:00.000Z',
      configured: true,
      spend_usd: 82.5,
      monthly_limit_usd: 100,
      remaining_usd: 17.5,
      utilization_percent: 82.5,
      hard_stop: true,
      hard_stop_active: false,
    });
  });

  test('treats a materialized monthly row without spend as zero', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValue({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: 'CONFIG',
            monthly_limit_usd: 100,
            hard_stop: true,
          },
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            updated_at: '2026-08-21T12:00:00Z',
          },
        ],
      },
    });

    await expect(budgets.loadPersonalBudgetStatus(
      'user-1',
      new Date('2026-08-21T12:00:00Z'),
    )).resolves.toEqual(expect.objectContaining({
      configured: true,
      spend_usd: 0,
      remaining_usd: 100,
      utilization_percent: 0,
      hard_stop_active: false,
    }));
  });

  test('shows spend without inventing a personal limit when none is configured', async () => {
    const budgets = await loadBudgets();
    ddbSend.mockResolvedValue({
      Responses: {
        Budgets: [
          {
            scope_key: 'USER#user-1',
            period: '2026-08',
            spend_usd: 12.25,
          },
        ],
      },
    });

    await expect(budgets.loadPersonalBudgetStatus(
      'user-1',
      new Date('2026-08-21T12:00:00Z'),
    )).resolves.toEqual({
      period: '2026-08',
      resets_at: '2026-09-01T00:00:00.000Z',
      configured: false,
      spend_usd: 12.25,
      monthly_limit_usd: null,
      remaining_usd: null,
      utilization_percent: null,
      hard_stop: false,
      hard_stop_active: false,
    });
  });

  test.each(['not-a-number', '', '   ', -1])(
    'fails closed when persisted spend is corrupt (%p)',
    async corruptSpend => {
      const budgets = await loadBudgets();
      ddbSend.mockResolvedValue({
        Responses: {
          Budgets: [
            {
              scope_key: 'USER#user-1',
              period: 'CONFIG',
              monthly_limit_usd: 100,
            },
            {
              scope_key: 'USER#user-1',
              period: '2026-08',
              spend_usd: corruptSpend,
            },
          ],
        },
      });

      await expect(budgets.loadPersonalBudgetStatus(
        'user-1',
        new Date('2026-08-21T12:00:00Z'),
      )).rejects.toThrow('Budget row USER#user-1 has invalid spend_usd');
    },
  );
});
