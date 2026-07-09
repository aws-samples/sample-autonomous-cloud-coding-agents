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

  test('bumps durable cost high-water mark and evaluates against it', async () => {
    // No cumulative value on the event itself; the ceiling must be met from
    // the persisted high-water mark alone (the cross-restart case).
    mockSend
      .mockResolvedValueOnce({}) // high-water UpdateCommand
      .mockResolvedValueOnce({}) // idempotency claim
      .mockResolvedValueOnce({}) // Put policy_decision
      .mockResolvedValueOnce({}) // Update cancel
      .mockResolvedValueOnce({}); // Put task_cancelled
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    await mod.evaluateAsyncEventRules(
      {
        task_id: 't3',
        event_id: 'e3',
        event_type: 'agent_cost_update',
        metadata: { cost_usd: 5 }, // this session is cheap...
      },
      {
        task: {
          task_id: 't3',
          status: 'RUNNING',
          gov_cumulative_cost_usd: 40, // ...but a prior session already crossed
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
    // First send is the high-water UpdateCommand with a climb-only condition.
    const firstCall = mockSend.mock.calls[0][0];
    expect(firstCall._type).toBe('Update');
    expect(firstCall.input.ConditionExpression).toContain('gov_cumulative_cost_usd < :c');
    // The cancel fired — resolved aggregate (max(40, 5)=40) still ≥ 25.
    const cancelUpdate = mockSend.mock.calls.find(
      (c) => c[0]._type === 'Update' && String(c[0].input.UpdateExpression).includes('#status'),
    );
    expect(cancelUpdate).toBeDefined();
  });

  test('turn_count_gte rule fires on turn_count metadata', async () => {
    mockSend.mockResolvedValue({});
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    const result = await mod.evaluateAsyncEventRules(
      {
        task_id: 't4',
        event_id: 'e4',
        event_type: 'agent_turn',
        metadata: { turn_count: 35 },
      },
      {
        task: {
          task_id: 't4',
          status: 'RUNNING',
          event_rules: [
            {
              id: 'turns',
              on: 'agent_turn',
              when: { aggregate: { turn_count_gte: 30 } },
              action: 'escalate',
              mode: 'enforce',
              evaluation: 'async',
              notify_channels: ['slack'],
            },
          ],
        } as any,
      },
    );
    expect(result.notifyChannels).toContain('slack');
  });

  test('isRetryableInfraError classifies infra vs benign errors', async () => {
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    expect(mod.isRetryableInfraError({ $retryable: {} })).toBe(true);
    expect(mod.isRetryableInfraError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(mod.isRetryableInfraError({ name: 'ProvisionedThroughputExceededException' })).toBe(true);
    expect(mod.isRetryableInfraError({ name: 'ThrottlingException' })).toBe(true);
    // Benign / client errors and non-objects must not trigger a retry.
    expect(mod.isRetryableInfraError({ name: 'ValidationException' })).toBe(false);
    expect(mod.isRetryableInfraError({ $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(mod.isRetryableInfraError(new Error('plain'))).toBe(false);
    expect(mod.isRetryableInfraError('boom')).toBe(false);
    expect(mod.isRetryableInfraError(undefined)).toBe(false);
  });

  test('loadTaskForGovernance rethrows retryable infra errors', async () => {
    const throttle = Object.assign(new Error('rate exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
    mockSend.mockRejectedValueOnce(throttle);
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    await expect(mod.loadTaskForGovernance('t-retry')).rejects.toBe(throttle);
  });

  test('seeds cost mark from task.cost_usd on a non-cost event', async () => {
    // agent_milestone carries no cost metadata; the ceiling must still trip
    // from the authoritative task.cost_usd floor (may arrive as a string).
    mockSend.mockResolvedValue({});
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    const result = await mod.evaluateAsyncEventRules(
      {
        task_id: 't-seed',
        event_id: 'e-seed',
        event_type: 'agent_milestone',
        metadata: { milestone: 'pr_created' },
      },
      {
        task: {
          task_id: 't-seed',
          status: 'RUNNING',
          cost_usd: '30' as any, // doc-client string; floors the mark ≥ 25
          event_rules: [
            {
              id: 'cap',
              on: 'pr_created',
              when: { aggregate: { cost_usd_gte: 25 } },
              action: 'escalate',
              mode: 'enforce',
              evaluation: 'async',
            },
          ],
        } as any,
      },
    );
    // escalate with no notify_channels falls back to the default set.
    expect(result.notifyChannels).toEqual(expect.arrayContaining(['email', 'slack']));
  });

  test('rethrows retryable error from high-water update', async () => {
    const throttle = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    mockSend.mockRejectedValueOnce(throttle); // high-water UpdateCommand fails
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    await expect(
      mod.evaluateAsyncEventRules(
        {
          task_id: 't-hw',
          event_id: 'e-hw',
          event_type: 'agent_cost_update',
          metadata: { cumulative_cost_usd: 30 },
        },
        {
          task: {
            task_id: 't-hw',
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
      ),
    ).rejects.toBe(throttle);
  });

  test('executes cancel_task action in enforce mode', async () => {
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

