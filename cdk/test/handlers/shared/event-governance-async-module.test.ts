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
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ _type: 'TransactWrite', input })),
}));

describe('event-governance-async module', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSend.mockReset();
    process.env.TASK_TABLE_NAME = 'Tasks';
    process.env.TASK_EVENTS_TABLE_NAME = 'Events';
    process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
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

  test('observe_only notify does NOT push channels or force fan-out', async () => {
    mockSend
      .mockResolvedValueOnce({}) // idempotency claim
      .mockResolvedValueOnce({}); // Put policy_decision (audit only)
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    const result = await mod.evaluateAsyncEventRules(
      {
        task_id: 't-obs',
        event_id: 'e-obs',
        event_type: 'agent_milestone',
        metadata: { milestone: 'pr_created' },
      },
      {
        task: {
          task_id: 't-obs',
          event_rules: [
            {
              id: 'notify-observe',
              on: 'pr_created',
              action: 'notify',
              mode: 'observe_only',
              evaluation: 'async',
              notify_channels: ['slack'],
            },
          ],
        } as any,
      },
    );
    // "Would have fired": audit record written, but no action.
    expect(result.notifyChannels).toEqual([]);
    expect(result.forceFanOut).toBe(false);
  });

  test('enforce require_approval creates an approval row and forces fan-out', async () => {
    mockSend
      .mockResolvedValueOnce({}) // idempotency claim
      .mockResolvedValueOnce({}) // Put policy_decision
      .mockResolvedValueOnce({}); // TransactWrite approval (RUNNING task)
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    const result = await mod.evaluateAsyncEventRules(
      {
        task_id: 't-appr',
        event_id: 'e-appr',
        event_type: 'agent_milestone',
        metadata: { milestone: 'pr_created', pr_url: 'https://github.com/o/r/pull/1' },
      },
      {
        task: {
          task_id: 't-appr',
          user_id: 'u1',
          status: 'RUNNING',
          event_rules: [
            {
              id: 'approve-pr',
              on: 'pr_created',
              action: 'require_approval',
              mode: 'enforce',
              evaluation: 'async',
            },
          ],
        } as any,
      },
    );
    expect(result.forceFanOut).toBe(true);
    const approvalCall = mockSend.mock.calls.find((c) => c[0]._type === 'TransactWrite');
    expect(approvalCall).toBeDefined();
  });

  test('observe_only require_approval does NOT create an approval row', async () => {
    mockSend
      .mockResolvedValueOnce({}) // idempotency claim
      .mockResolvedValueOnce({}); // Put policy_decision (audit only)
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    await mod.evaluateAsyncEventRules(
      {
        task_id: 't-appr-obs',
        event_id: 'e-appr-obs',
        event_type: 'agent_milestone',
        metadata: { milestone: 'pr_created' },
      },
      {
        task: {
          task_id: 't-appr-obs',
          user_id: 'u1',
          status: 'RUNNING',
          event_rules: [
            {
              id: 'approve-observe',
              on: 'pr_created',
              action: 'require_approval',
              mode: 'observe_only',
              evaluation: 'async',
            },
          ],
        } as any,
      },
    );
    expect(mockSend.mock.calls.some((c) => c[0]._type === 'TransactWrite')).toBe(false);
    expect(mockSend.mock.calls.some((c) => c[0]._type === 'Put')).toBe(true); // policy_decision only
  });

  test('enforce inject_nudge writes a nudge, truncated to the max length', async () => {
    process.env.NUDGES_TABLE_NAME = 'Nudges';
    mockSend
      .mockResolvedValueOnce({}) // idempotency claim
      .mockResolvedValueOnce({}) // Put policy_decision
      .mockResolvedValueOnce({}); // Put nudge
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    const longReason = 'x'.repeat(5000);
    await mod.evaluateAsyncEventRules(
      {
        task_id: 't-nudge',
        event_id: 'e-nudge',
        event_type: 'agent_milestone',
        metadata: { milestone: 'plan_ready' },
      },
      {
        task: {
          task_id: 't-nudge',
          user_id: 'u1',
          status: 'RUNNING',
          event_rules: [
            {
              id: 'nudge',
              on: 'plan_ready',
              action: 'inject_nudge',
              mode: 'enforce',
              evaluation: 'async',
              reason: longReason,
            },
          ],
        } as any,
      },
    );
    const nudgeCall = mockSend.mock.calls.find(
      (c) => c[0]._type === 'Put' && c[0].input?.Item?.source === 'event_rule' && c[0].input?.Item?.nudge_id,
    );
    expect(nudgeCall).toBeDefined();
    expect(nudgeCall![0].input.Item.message.length).toBeLessThanOrEqual(2000);
    delete process.env.NUDGES_TABLE_NAME;
  });

  test('idempotency dedup skips the action on a replayed record', async () => {
    // The idempotency claim (a conditional Put of a governance_idempotency row)
    // fails → the marker already exists → the cancel_task transition must be
    // suppressed. Route the CCF to the claim Put only, by command shape.
    const ccf = Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    mockSend.mockImplementation((cmd: any) =>
      cmd?._type === 'Put' && cmd.input?.Item?.event_type === 'governance_idempotency'
        ? Promise.reject(ccf)
        : Promise.resolve({}),
    );
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    await mod.evaluateAsyncEventRules(
      {
        task_id: 't-dup',
        event_id: 'e-dup',
        event_type: 'agent_cost_update',
        metadata: { cumulative_cost_usd: 30 },
      },
      {
        aggregateState: { cumulative_cost_usd: 30 },
        task: {
          task_id: 't-dup',
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
    // The high-water persist may run, but the cancel transition must NOT — the
    // replayed record was deduped by the failed idempotency claim.
    expect(mockSend.mock.calls.some(isCancelUpdate)).toBe(false);
  });

  // The cancel_task write is the only Update carrying a #status transition;
  // the high-water-mark persist is also an Update, so tests key on #status.
  const isCancelUpdate = (c: any) =>
    c[0]._type === 'Update' && String(c[0].input?.UpdateExpression ?? '').includes('#status');

  test('cancel_task is skipped when the task is already terminal', async () => {
    mockSend.mockResolvedValue({});
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    await mod.evaluateAsyncEventRules(
      {
        task_id: 't-term',
        event_id: 'e-term',
        event_type: 'agent_cost_update',
        metadata: { cumulative_cost_usd: 30 },
      },
      {
        aggregateState: { cumulative_cost_usd: 30 },
        task: {
          task_id: 't-term',
          status: 'COMPLETED',
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
    // No cancel transition issued against an already-terminal task.
    expect(mockSend.mock.calls.some(isCancelUpdate)).toBe(false);
  });

  test('retryable error in cancel_task releases idempotency and rethrows', async () => {
    const throttle = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    // Route by command shape so we don't depend on call ordering: only the
    // cancel transition throttles; everything else (high-water, claim, audit,
    // release) succeeds.
    mockSend.mockImplementation((cmd: any) =>
      isCancelUpdate([cmd]) ? Promise.reject(throttle) : Promise.resolve({}),
    );
    const mod = await import('../../../src/handlers/shared/event-governance-async');
    mod._resetGovernanceIdempotencyCache();
    await expect(
      mod.evaluateAsyncEventRules(
        {
          task_id: 't-throttle',
          event_id: 'e-throttle',
          event_type: 'agent_cost_update',
          metadata: { cumulative_cost_usd: 30 },
        },
        {
          aggregateState: { cumulative_cost_usd: 30 },
          task: {
            task_id: 't-throttle',
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
    // The idempotency marker was released (Delete) so the retried record re-runs.
    expect(mockSend.mock.calls.some((c) => c[0]._type === 'Delete')).toBe(true);
  });
});

