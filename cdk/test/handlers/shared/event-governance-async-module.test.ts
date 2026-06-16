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

/**
 * Coverage-focused tests for event-governance-async helpers.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

describe('event-governance-async module', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSend.mockReset();
    process.env.TASK_TABLE_NAME = 'Tasks';
    process.env.TASK_EVENTS_TABLE_NAME = 'Events';
  });

  test('loadTaskForGovernance returns undefined on Get failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('boom'));
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    const got = await mod.loadTaskForGovernance('t1');
    expect(got).toBeUndefined();
  });

  test('evaluateAsyncEventRules emits notify channel', async () => {
    mockSend
      .mockResolvedValueOnce({}) // idempotency claim
      .mockResolvedValueOnce({}); // Put policy_decision
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    const result1 = await mod.evaluateAsyncEventRules(
      {
        task_id: 't1',
        event_id: 'e1',
        event_type: 'agent_milestone',
        metadata: { milestone: 'pr_created' },
      },
      {
        task: {
          task_id: 't1',
          event_rules: [
            {
              id: 'notify',
              on: 'pr_created',
              action: 'notify',
              mode: 'enforce',
              evaluation: 'async',
              notify_channels: ['slack'],
            },
          ],
        } as any,
      },
    );
    expect(result1.notifyChannels).toEqual(['slack']);
    expect(result1.forceFanOut).toBe(true);
  });

  test('evaluateAsyncEventRules executes cancel_task action in enforce mode', async () => {
    mockSend
      .mockResolvedValueOnce({}) // idempotency
      .mockResolvedValueOnce({}) // Put policy_decision
      .mockResolvedValueOnce({}) // Update task cancel
      .mockResolvedValueOnce({}); // Put task_cancelled event
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    await mod.evaluateAsyncEventRules(
      {
        task_id: 't2',
        event_id: 'e2',
        event_type: 'agent_cost_update',
        metadata: { cumulative_cost_usd: 30 },
      },
      {
        aggregateState: { cumulative_cost_usd: 30 },
        task: {
          task_id: 't2',
          status: 'RUNNING',
          event_rules: [
            {
              id: 'cap',
              on: 'agent_cost_update',
              when: { aggregate: { cost_usd_gte: 25 } },
              action: 'cancel_task',
              mode: 'enforce',
              evaluation: 'async',
            },
          ],
        } as any,
      },
    );
    expect(mockSend).toHaveBeenCalled();
  });
});

