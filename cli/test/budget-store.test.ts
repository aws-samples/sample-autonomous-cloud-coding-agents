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
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  currentBudgetPeriod,
  listBudgetStatus,
  setMonthlyBudget,
} from '../src/budget-store';
import { makeDocClient } from '../src/ua';

jest.mock('../src/ua', () => ({
  makeDocClient: jest.fn(),
}));

const makeDocClientMock = makeDocClient as jest.Mock;
const sendMock = jest.fn();

describe('budget store', () => {
  beforeEach(() => {
    sendMock.mockReset();
    makeDocClientMock.mockReset();
    makeDocClientMock.mockReturnValue({ send: sendMock });
  });

  test('uses UTC calendar months', () => {
    expect(currentBudgetPeriod(new Date('2026-08-31T23:59:59Z'))).toBe('2026-08');
    expect(currentBudgetPeriod(new Date('2026-09-01T00:00:00Z'))).toBe('2026-09');
  });

  test('writes the recurring config and resets current-month alert claims', async () => {
    sendMock.mockResolvedValue({});

    await setMonthlyBudget(
      'us-east-1',
      'Budgets',
      { type: 'team', id: 'Platform' },
      250,
      true,
      new Date('2026-08-18T12:00:00Z'),
    );

    const command = sendMock.mock.calls[0][0] as TransactWriteCommand;
    expect(command.input.TransactItems).toHaveLength(2);
    expect(command.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      scope_key: 'TEAM#Platform',
      period: 'CONFIG',
      record_type: 'CONFIG',
      monthly_limit_usd: 250,
      hard_stop: true,
    });
    expect(command.input.TransactItems?.[1]?.Update).toMatchObject({
      Key: { scope_key: 'TEAM#Platform', period: '2026-08' },
      ExpressionAttributeNames: { '#ttl': 'ttl' },
    });
    expect(command.input.TransactItems?.[1]?.Update?.UpdateExpression)
      .toContain('#ttl = :ttl');
    expect(command.input.TransactItems?.[1]?.Update?.UpdateExpression)
      .toContain('REMOVE alerted_80_at');
  });

  test('queries the config index and joins current spend', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{
          scope_key: 'USER#user-1',
          scope_type: 'user',
          scope_id: 'user-1',
          monthly_limit_usd: 100,
          hard_stop: true,
          updated_at: '2026-08-01T00:00:00Z',
        }],
      })
      .mockResolvedValueOnce({
        Responses: {
          Budgets: [{
            scope_key: 'USER#user-1',
            period: '2026-08',
            spend_usd: 85,
          }],
        },
      });

    const rows = await listBudgetStatus(
      'us-east-1',
      'Budgets',
      undefined,
      new Date('2026-08-18T12:00:00Z'),
    );

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect((sendMock.mock.calls[0][0] as QueryCommand).input.IndexName)
      .toBe('record_type-scope_key-index');
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(BatchGetCommand);
    expect((sendMock.mock.calls[1][0] as BatchGetCommand)
      .input.RequestItems?.Budgets?.ConsistentRead).toBe(true);
    expect(rows).toEqual([expect.objectContaining({
      scope_type: 'user',
      scope_id: 'user-1',
      spend_usd: 85,
      remaining_usd: 15,
      utilization_percent: 85,
      hard_stop_active: false,
    })]);
  });

  test('uses a consistent direct read for a scoped status request', async () => {
    sendMock
      .mockResolvedValueOnce({
        Item: {
          scope_key: 'TEAM#Platform',
          scope_type: 'team',
          scope_id: 'Platform',
          monthly_limit_usd: 10,
          hard_stop: true,
        },
      })
      .mockResolvedValueOnce({
        Responses: {
          Budgets: [{
            scope_key: 'TEAM#Platform',
            period: '2026-08',
            spend_usd: 12,
          }],
        },
      });

    const rows = await listBudgetStatus(
      'us-east-1',
      'Budgets',
      { type: 'team', id: 'Platform' },
      new Date('2026-08-18T12:00:00Z'),
    );

    const command = sendMock.mock.calls[0][0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toMatchObject({
      Key: { scope_key: 'TEAM#Platform', period: 'CONFIG' },
      ConsistentRead: true,
    });
    expect(rows[0]).toMatchObject({
      utilization_percent: 120,
      remaining_usd: 0,
      hard_stop_active: true,
    });
  });
});
