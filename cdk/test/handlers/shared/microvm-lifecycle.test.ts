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

const mockSend = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send: mockSend }) }));
process.env.TASK_TABLE_NAME = 'LifecycleTasks';
process.env.TASK_APPROVALS_TABLE_NAME = 'LifecycleApprovals';

import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { MicrovmObservedState } from '../../../src/handlers/shared/compute-strategy';
import {
  readMicrovmLifecycleSnapshot, saveMicrovmLifecycleIntent, type MicrovmLifecycleSnapshot,
  type MicrovmLifecycleIntent,
} from '../../../src/handlers/shared/microvm-lifecycle';
import { decideMicrovmLifecycle, type MicrovmLifecyclePolicyInput } from '../../../src/handlers/shared/microvm-lifecycle-policy';

const NOW = 1_800_000_000_000;
const CREATED = new Date(NOW - 45_000).toISOString();
const DEADLINE = NOW + 555_000;
const task = {
  task_id: 'task',
  user_id: 'user',
  status: 'AWAITING_APPROVAL',
  compute_type: 'lambda-microvm',
  session_id: 'vm',
  compute_metadata: { microvmId: 'vm', endpoint: 'https://vm.example' },
  awaiting_approval_request_id: 'gate',
};
const row = { task_id: 'task', user_id: 'user', request_id: 'gate', status: 'PENDING', created_at: CREATED, timeout_s: 600 };
const intent = (action: 'suspend' | 'resume' = 'suspend'): MicrovmLifecycleIntent => ({
  version: 1,
  generation: 'generation-one',
  microvm_id: 'vm',
  request_id: 'gate',
  action,
  requested_at_ms: NOW - 10_000,
  deadline_ms: DEADLINE,
});
const snapshot = (overrides: Partial<MicrovmLifecycleSnapshot> = {}): MicrovmLifecycleSnapshot => ({
  taskId: 'task',
  userId: 'user',
  status: 'AWAITING_APPROVAL',
  requestId: 'gate',
  handle: { strategyType: 'lambda-microvm', sessionId: 'vm', microvmId: 'vm', endpoint: 'https://vm.example' },
  approval: { kind: 'present', status: 'PENDING', created_at: CREATED, timeout_s: 600, createdAtMs: NOW - 45_000, deadlineMs: DEADLINE },
  ...overrides,
});
const policy = (state: MicrovmObservedState = 'RUNNING', change: Partial<MicrovmLifecyclePolicyInput> = {}) => decideMicrovmLifecycle({
  snapshot: snapshot(),
  substrate: { status: 'running', microvmState: state },
  nowMs: NOW,
  sessionDeadlineMs: NOW + 3_600_000,
  pollIntervalMs: 30_000,
  suspendEnabled: true,
  imageSupportsLifecycle: true,
  ...change,
});

beforeEach(() => {
  mockSend.mockReset();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

describe('MicroVM lifecycle policy', () => {
  test('long pending gate may suspend only after grace and explicit RUNNING', () => {
    expect(policy()).toEqual({ action: 'suspend', requestReady: true, reason: 'pending-long-gate', nextPollInMs: 5_000 });
    expect(mockSend).not.toHaveBeenCalled();
  });
  test.each(['PENDING', 'UNKNOWN'] as const)('%s is not proof of awake state', state => {
    expect(policy(state)).toMatchObject({ action: 'wait', nextPollInMs: 5_000 });
  });
  test('legacy coarse running without a service observation cannot trigger suspend', () => {
    expect(policy('RUNNING', { substrate: { status: 'running' } })).toMatchObject({ action: 'wait', reason: 'unconfirmed-state' });
  });
  test.each([{ suspendEnabled: false }, { imageSupportsLifecycle: false }])('requires both enable and compatible image: %j', change => {
    expect(policy('RUNNING', change)).toMatchObject({ action: 'wait', reason: 'suspend-disabled' });
  });
  test('long poll setting is clamped to the end of grace', () => {
    const gate = snapshot();
    expect(policy('RUNNING', { nowMs: NOW - 20_000, snapshot: gate, pollIntervalMs: 600_000 }))
      .toMatchObject({ action: 'wait', reason: 'suspend-grace', nextPollInMs: 5_000 });
  });
  test('too little useful sleep keeps the VM awake', () => {
    expect(policy('RUNNING', { nowMs: DEADLINE - 80_000 }))
      .toMatchObject({ action: 'wait', reason: 'short-window', nextPollInMs: 20_000 });
    expect(policy('RUNNING', { nowMs: DEADLINE - 90_000 })).toMatchObject({ action: 'suspend' });
  });
  test('intended sleep waits until wake margin even with an oversized poll interval', () => {
    expect(policy('SUSPENDED', { snapshot: snapshot({ intent: intent() }), pollIntervalMs: 900_000, suspendEnabled: false }))
      .toEqual({ action: 'wait', reason: 'intentionally-suspended', nextPollInMs: DEADLINE - NOW - 60_000 });
  });
  test.each(['APPROVED', 'DENIED', 'TIMED_OUT', 'STRANDED'] as const)('%s always preserves wake intent', status => {
    const pending = snapshot().approval;
    if (pending.kind !== 'present') throw new Error('fixture');
    for (const state of ['RUNNING', 'SUSPENDING', 'SUSPENDED'] as const) {
      expect(policy(state, { snapshot: snapshot({ approval: { ...pending, status }, intent: intent() }), suspendEnabled: false }))
        .toMatchObject({ action: 'resume', requestReady: state === 'SUSPENDED', reason: 'approval-terminal' });
    }
  });
  test.each([DEADLINE - 60_000, DEADLINE + 1000])('wakes at/past the original deadline margin (%s)', nowMs => {
    expect(policy('SUSPENDED', { nowMs, snapshot: snapshot({ intent: intent() }) }))
      .toMatchObject({ action: 'resume', requestReady: true, reason: 'wake-deadline' });
  });
  test('session lifetime also bounds the wake margin', () => {
    expect(policy('SUSPENDED', { sessionDeadlineMs: NOW + 30_000, snapshot: snapshot({ intent: intent() }) }))
      .toMatchObject({ action: 'resume', reason: 'wake-deadline' });
    expect(policy('SUSPENDED', { sessionDeadlineMs: NOW })).toMatchObject({ action: 'terminate', reason: 'session-deadline' });
  });
  test.each(['SUSPENDING', 'SUSPENDED'] as const)('unintended %s is repaired, but resume waits until SUSPENDED', state => {
    expect(policy(state)).toMatchObject({ action: 'resume', requestReady: state === 'SUSPENDED', reason: 'unintended-suspension' });
  });
  test('acknowledged wake remains sticky even when a delayed suspend finishes later', () => {
    const current = snapshot({ intent: intent('resume') });
    expect(policy('RUNNING', { snapshot: current })).toMatchObject({ action: 'wait', reason: 'wake-intent' });
    expect(policy('SUSPENDING', { snapshot: current })).toMatchObject({ action: 'resume', requestReady: false });
    expect(policy('SUSPENDED', { snapshot: current })).toMatchObject({ action: 'resume', requestReady: true });
  });
  test('another gate or changed deadline cannot inherit an old sleep intent', () => {
    expect(policy('RUNNING', { snapshot: snapshot({ intent: { ...intent(), request_id: 'old-gate' } }) }))
      .toMatchObject({ action: 'resume', reason: 'previous-gate-suspend' });
    expect(policy('SUSPENDED', { snapshot: snapshot({ intent: { ...intent(), deadline_ms: DEADLINE + 1 } }) }))
      .toMatchObject({ action: 'resume', reason: 'approval-deadline-changed' });
  });
  test.each(['missing', 'invalid', 'unavailable'] as const)('%s approval forbids sleep and wakes a sleeping VM', kind => {
    const current = snapshot({ approval: kind === 'unavailable' ? { kind, errorType: 'AccessDeniedException' } : { kind } });
    expect(policy('RUNNING', { snapshot: current })).toMatchObject({ action: 'wait' });
    expect(policy('SUSPENDED', { snapshot: current })).toMatchObject({ action: 'resume', requestReady: true });
    expect(policy('RUNNING', { snapshot: { ...current, intent: intent() } })).toMatchObject({ action: 'resume', requestReady: false });
  });
  test.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'FINALIZING'] as const)('%s tasks are never revived', status => {
    expect(policy('SUSPENDED', { snapshot: snapshot({ status }) })).toMatchObject({ action: 'terminate' });
  });
  test.each(['TERMINATING', 'TERMINATED', 'NOT_FOUND'] as const)('%s triggers task reconciliation', state => {
    expect(policy(state)).toMatchObject({ action: 'reconcile-terminal' });
    expect(policy(state, { snapshot: snapshot({ status: 'COMPLETED' }) })).toMatchObject({ action: 'wait' });
  });
  test('a working task is never suspended for lack of traffic; unexpected sleep recovers', () => {
    const current = snapshot({ status: 'RUNNING', requestId: null, approval: { kind: 'none' } });
    expect(policy('RUNNING', { snapshot: current })).toMatchObject({ action: 'wait', reason: 'working' });
    expect(policy('SUSPENDED', { snapshot: current })).toMatchObject({ action: 'resume', reason: 'suspended-outside-gate' });
  });
  test.each([0, -1, NaN, Infinity])('rejects invalid poll interval %s', pollIntervalMs => {
    expect(() => policy('RUNNING', { pollIntervalMs })).toThrow('positive poll interval');
  });
});

describe('MicroVM lifecycle store', () => {
  test('a cancelled task may retain its gate pointer and needs no approval read', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...task, status: 'CANCELLED' } });
    const closed = await readMicrovmLifecycleSnapshot('task', 'user');
    expect(closed).toMatchObject({ status: 'CANCELLED', requestId: 'gate', approval: { kind: 'none' } });
    expect(await saveMicrovmLifecycleIntent(closed!, 'resume', NOW)).toEqual({ status: 'ineligible' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  test('reads current task and only its current gate consistently with one bounded read budget', async () => {
    mockSend.mockResolvedValueOnce({ Item: task }).mockResolvedValueOnce({ Item: row });
    expect(await readMicrovmLifecycleSnapshot('task', 'user')).toEqual(snapshot());
    expect(mockSend.mock.calls.map(([command]) => command.input)).toEqual([
      { TableName: 'LifecycleTasks', Key: { task_id: 'task' }, ConsistentRead: true },
      { TableName: 'LifecycleApprovals', Key: { task_id: 'task', request_id: 'gate' }, ConsistentRead: true },
    ]);
    expect(mockSend.mock.calls[0][1].abortSignal).toBe(mockSend.mock.calls[1][1].abortSignal);
  });
  test.each([undefined, { ...task, compute_type: 'ecs' }])('missing/non-MicroVM task is inapplicable', async item => {
    mockSend.mockResolvedValueOnce({ Item: item });
    await expect(readMicrovmLifecycleSnapshot('task', 'user')).resolves.toBeUndefined();
  });
  test.each([
    { user_id: 'other' }, { session_id: 'other-vm' }, { compute_metadata: {} },
    { awaiting_approval_request_id: null }, { status: 'RUNNING' },
    { microvm_lifecycle: { ...intent(), version: 99 } },
  ])('invalid task/intent fails visibly: %j', async change => {
    mockSend.mockResolvedValueOnce({ Item: { ...task, ...change } });
    await expect(readMicrovmLifecycleSnapshot('task', 'user')).rejects.toThrow('MicroVM lifecycle');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  test.each([
    { user_id: 'other' }, { request_id: 'old-gate' }, { status: 'MADE_UP' },
    { created_at: '2026-02-30T00:00:00Z' }, { created_at: 'not-a-date' },
    { timeout_s: -1 }, { timeout_s: Number.MAX_SAFE_INTEGER },
  ])('bad approval data remains explicitly invalid: %j', async change => {
    mockSend.mockResolvedValueOnce({ Item: task }).mockResolvedValueOnce({ Item: { ...row, ...change } });
    expect((await readMicrovmLifecycleSnapshot('task', 'user'))?.approval).toEqual({ kind: 'invalid' });
  });
  test('missing approval and failed approval reads remain distinguishable', async () => {
    mockSend.mockResolvedValueOnce({ Item: task }).mockResolvedValueOnce({});
    expect((await readMicrovmLifecycleSnapshot('task', 'user'))?.approval).toEqual({ kind: 'missing' });
    mockSend.mockResolvedValueOnce({ Item: task }).mockRejectedValueOnce(Object.assign(new Error('private data'), { name: 'AccessDeniedException' }));
    expect((await readMicrovmLifecycleSnapshot('task', 'user'))?.approval).toEqual({ kind: 'unavailable', errorType: 'AccessDeniedException' });
  });
  test('suspend records intent with an atomic exact-gate condition', async () => {
    mockSend.mockResolvedValueOnce({});
    const saved = await saveMicrovmLifecycleIntent(snapshot(), 'suspend', NOW);
    expect(saved).toMatchObject({ status: 'saved', intent: { action: 'suspend', request_id: 'gate', deadline_ms: DEADLINE } });
    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(2);
    expect(command.input.TransactItems[1].ConditionCheck.ExpressionAttributeValues)
      .toEqual({ ':pending': 'PENDING', ':user': 'user', ':created': CREATED, ':timeout': 600 });
    expect(command.input.TransactItems[0].Update.UpdateExpression).toBe('SET microvm_lifecycle = :intent');
  });
  test('resume preserves its generation and original recovery age when replayed', async () => {
    mockSend.mockResolvedValue({});
    const previous = intent('resume');
    expect(await saveMicrovmLifecycleIntent(snapshot({ intent: previous }), 'resume', NOW)).toEqual({ status: 'saved', intent: previous });
    const command = mockSend.mock.calls[0][0];
    expect(command.input.TransactItems).toHaveLength(1);
    expect(command.input.ClientRequestToken).not.toBe(previous.generation);
    expect(command.input.TransactItems[0].Update.ExpressionAttributeValues[':generation']).toBe(previous.generation);
  });
  test('a wake cannot become sleep again within the same gate', async () => {
    expect(await saveMicrovmLifecycleIntent(snapshot({ intent: intent('resume') }), 'suspend', NOW)).toEqual({ status: 'ineligible' });
    expect(mockSend).not.toHaveBeenCalled();
  });
  test('expired gate and closed task cannot receive suspend intent', async () => {
    expect(await saveMicrovmLifecycleIntent(snapshot(), 'suspend', DEADLINE)).toEqual({ status: 'ineligible' });
    expect(await saveMicrovmLifecycleIntent(snapshot({ status: 'CANCELLED' }), 'resume', NOW)).toEqual({ status: 'ineligible' });
    expect(mockSend).not.toHaveBeenCalled();
  });
  test('conditional conflict asks caller to re-observe rather than overwrite', async () => {
    mockSend.mockRejectedValueOnce({ name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    expect(await saveMicrovmLifecycleIntent(snapshot(), 'suspend', NOW)).toEqual({ status: 'stale' });
  });
  test('lost committed reply is recovered only by reading the exact saved generation', async () => {
    let saved: MicrovmLifecycleIntent;
    mockSend.mockImplementation(async command => {
      if (command instanceof TransactWriteCommand) {
        saved = command.input.TransactItems![0].Update!.ExpressionAttributeValues![':intent'] as MicrovmLifecycleIntent;
        throw new Error('lost response');
      }
      return { Item: command.input.TableName === 'LifecycleTasks' ? { ...task, microvm_lifecycle: saved! } : row };
    });
    expect(await saveMicrovmLifecycleIntent(snapshot(), 'suspend', NOW)).toMatchObject({ status: 'saved', intent: { generation: expect.any(String) } });
    expect(mockSend.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
    expect(mockSend.mock.calls.filter(([command]) => command instanceof GetCommand)).toHaveLength(2);
  });
  test('definite permission failure with no committed intent remains an error', async () => {
    mockSend.mockRejectedValueOnce(new Error('access denied')).mockResolvedValueOnce({ Item: task }).mockResolvedValueOnce({ Item: row });
    await expect(saveMicrovmLifecycleIntent(snapshot(), 'suspend', NOW)).rejects.toThrow('access denied');
  });
});
