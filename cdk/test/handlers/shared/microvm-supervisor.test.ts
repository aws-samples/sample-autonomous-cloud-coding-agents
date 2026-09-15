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

// SPDX-License-Identifier: MIT-0

import type { ComputeStrategy, SessionStatus } from '../../../src/handlers/shared/compute-strategy';
import type { MicrovmLifecycleSnapshot } from '../../../src/handlers/shared/microvm-lifecycle';

const mockRead = jest.fn();
const mockSave = jest.fn();
const mockSuspendEnabled = jest.fn();
jest.mock('../../../src/handlers/shared/microvm-suspend-config', () => ({
  readMicrovmSuspendEnabled: (...args: unknown[]) => mockSuspendEnabled(...args),
}));
const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/microvm-lifecycle', () => ({
  ...jest.requireActual('../../../src/handlers/shared/microvm-lifecycle'),
  readMicrovmLifecycleSnapshot: (...args: unknown[]) => mockRead(...args),
  saveMicrovmLifecycleIntent: (...args: unknown[]) => mockSave(...args),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: mockLogger }));

import {
  stopMicrovmWithDiagnostics, superviseMicrovm, MICROVM_RECOVERY_TIMEOUT_MS,
  type MicrovmSupervisorInput, type MicrovmSupervisorState,
} from '../../../src/handlers/shared/microvm-supervisor';

const NOW = Date.parse('2026-09-15T10:00:00Z');
const handle = {
  strategyType: 'lambda-microvm' as const,
  sessionId: 'vm',
  microvmId: 'vm',
  endpoint: 'https://vm.example',
  imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:agent',
  imageVersion: '3.0',
  lifecycleProtocol: '1',
};
let time: number;
let row: MicrovmLifecycleSnapshot;
let strategy: {
  type: ComputeStrategy['type'];
  startSession: jest.Mock;
  pollSession: jest.Mock;
  stopSession: jest.Mock;
  suspendSession: jest.Mock;
  resumeSession: jest.Mock;
};
let emitEvent: jest.Mock;
let generation: number;

function observation(state: string = 'RUNNING'): SessionStatus {
  return {
    status: state === 'TERMINATED' ? 'completed' : state.startsWith('SUSPEND') ? 'suspended' : 'running',
    microvmState: state as SessionStatus['microvmState'],
    microvmStartedAtMs: NOW - 60_000,
    microvmMaximumDurationSeconds: 28_800,
  };
}
function intent(action: 'suspend' | 'resume', requestedAt = NOW - 10_000) {
  row = {
    ...row,
    intent: {
      version: 1,
      generation: `generation-${++generation}`,
      microvm_id: 'vm',
      request_id: row.requestId,
      action,
      requested_at_ms: requestedAt,
      deadline_ms: row.approval.kind === 'present' ? row.approval.deadlineMs : null,
    },
  };
}
function working() {
  row = { ...row, status: 'RUNNING', requestId: null, approval: { kind: 'none' } };
}
function approve() {
  if (row.approval.kind !== 'present') throw new Error('fixture has no approval');
  row = { ...row, approval: { ...row.approval, status: 'APPROVED' } };
}
function run(previous?: MicrovmSupervisorState, change: Partial<MicrovmSupervisorInput> = {}) {
  return superviseMicrovm({
    taskId: 'task',
    userId: 'user',
    handle,
    strategy,
    pollIntervalMs: 30_000,
    suspendEnabled: true,
    previous: previous ? JSON.parse(JSON.stringify(previous)) : undefined,
    emitEvent,
    ...change,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  time = NOW;
  generation = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => time);
  row = {
    taskId: 'task',
    userId: 'user',
    status: 'AWAITING_APPROVAL',
    handle,
    requestId: 'gate',
    approval: {
      kind: 'present',
      status: 'PENDING',
      created_at: new Date(NOW - 45_000).toISOString(),
      timeout_s: 600,
      createdAtMs: NOW - 45_000,
      deadlineMs: NOW + 555_000,
    },
  };
  mockRead.mockReset().mockImplementation(async () => structuredClone(row));
  mockSuspendEnabled.mockReset().mockResolvedValue(true);
  mockSave.mockReset().mockImplementation(async (_snapshot, action) => {
    if (row.intent?.action !== action || row.intent.request_id !== row.requestId) intent(action, time);
    return { status: 'saved', intent: row.intent };
  });
  strategy = {
    type: 'lambda-microvm',
    startSession: jest.fn(),
    pollSession: jest.fn().mockResolvedValue(observation()),
    stopSession: jest.fn().mockResolvedValue(undefined),
    suspendSession: jest.fn().mockResolvedValue({ supported: true }),
    resumeSession: jest.fn().mockResolvedValue({ supported: true }),
  };
  emitEvent = jest.fn().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test('saves intent, rechecks the gate, requests suspend and rechecks the outcome', async () => {
  const result = await run();
  expect(result.kind).toBe('continue');
  expect(result.state.recovery?.kind).toBe('suspend');
  expect(strategy.suspendSession).toHaveBeenCalledTimes(1);
  expect(mockRead).toHaveBeenCalledTimes(3);
  expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(mockRead.mock.invocationCallOrder[1]);
  expect(mockRead.mock.invocationCallOrder[1]).toBeLessThan(strategy.suspendSession.mock.invocationCallOrder[0]);
  expect(strategy.suspendSession.mock.invocationCallOrder[0]).toBeLessThan(mockRead.mock.invocationCallOrder[2]);
  expect(strategy.stopSession).not.toHaveBeenCalled();
});

test.each(['disabled', 'legacy', 'unverified-lifetime', 'short-window'])('%s keeps a working VM awake', async kind => {
  if (kind === 'legacy') row = { ...row, handle: { ...handle, lifecycleProtocol: undefined } };
  if (kind === 'unverified-lifetime') strategy.pollSession.mockResolvedValue({ status: 'running', microvmState: 'RUNNING' });
  if (kind === 'short-window') time = NOW + 480_000;
  expect((await run(undefined, { suspendEnabled: kind !== 'disabled' })).kind).toBe('continue');
  expect(strategy.suspendSession).not.toHaveBeenCalled();
  expect(strategy.resumeSession).not.toHaveBeenCalled();
  expect(mockSuspendEnabled).not.toHaveBeenCalled();
});

test('an existing opt-in execution observes live disable without failing healthy compute', async () => {
  working();
  const first = await run();
  row = {
    ...row,
    status: 'AWAITING_APPROVAL',
    requestId: 'next-gate',
    approval: {
      kind: 'present',
      status: 'PENDING',
      created_at: new Date(NOW - 45_000).toISOString(),
      timeout_s: 600,
      createdAtMs: NOW - 45_000,
      deadlineMs: NOW + 555_000,
    },
  };
  mockSuspendEnabled.mockResolvedValue(false);
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await run(first.state);
    expect(result.kind).toBe('continue');
    expect(result.state.consecutivePollFailures).toBe(0);
  }
  expect(strategy.suspendSession).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

test('disable after intent commit fences wake before any Suspend request', async () => {
  mockSuspendEnabled.mockResolvedValueOnce(true).mockResolvedValue(false);
  const result = await run();
  expect(result.state.recovery?.kind).toBe('wake');
  expect(row.intent?.action).toBe('resume');
  expect(strategy.suspendSession).not.toHaveBeenCalled();
  expect(mockSuspendEnabled).toHaveBeenCalledTimes(2);
});

test('wake recovery never depends on reading the suspension setting', async () => {
  const first = await run();
  approve();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  mockSuspendEnabled.mockClear().mockResolvedValue(false);
  expect((await run(first.state)).kind).toBe('continue');
  expect(strategy.resumeSession).toHaveBeenCalledTimes(1);
  expect(mockSuspendEnabled).not.toHaveBeenCalled();
});

test('later polls and serialized restart cannot extend the original service deadline', async () => {
  working();
  const first = await run();
  const deadline = NOW - 60_000 + 28_800_000;
  expect(first.state.sessionDeadlineMs).toBe(deadline);
  time += 60_000;
  strategy.pollSession.mockResolvedValue({ ...observation(), microvmStartedAtMs: time, microvmMaximumDurationSeconds: 99_999 });
  const later = await run(first.state);
  expect(later.state.sessionDeadlineMs).toBe(deadline);
  time = deadline;
  expect(await run(later.state)).toMatchObject({ kind: 'failure', reason: 'session-deadline' });
});

test('unknown state has a fixed recovery window across serialized polls', async () => {
  working();
  strategy.pollSession.mockResolvedValue(observation('UNKNOWN'));
  const first = await run();
  time += MICROVM_RECOVERY_TIMEOUT_MS;
  const expired = await run(first.state);
  expect(expired).toMatchObject({ kind: 'failure', reason: 'recovery-deadline' });
  expect(expired.state.recovery?.sinceMs).toBe(first.state.recovery?.sinceMs);
});

test('repeated Get errors retain their count even when task reads succeed', async () => {
  strategy.pollSession.mockRejectedValue(Object.assign(new Error('network'), { name: 'TimeoutError' }));
  const first = await run();
  const second = await run(first.state);
  const third = await run(second.state);
  expect(first.kind).toBe('continue');
  expect(second.state.consecutivePollFailures).toBe(2);
  expect(third).toMatchObject({ kind: 'failure', state: { consecutivePollFailures: 3 } });
});

test('a complete successful observation clears prior poll failures', async () => {
  working();
  strategy.pollSession.mockRejectedValueOnce(new Error('network'));
  const failed = await run();
  expect(failed.state.consecutivePollFailures).toBe(1);
  expect((await run(failed.state)).state.consecutivePollFailures).toBe(0);
});

test('permanent Get denial escalates without waiting for more requests', async () => {
  strategy.pollSession.mockRejectedValue(Object.assign(new Error('private-detail'), { name: 'AccessDeniedException' }));
  expect((await run()).kind).toBe('failure');
  expect(JSON.stringify(emitEvent.mock.calls)).not.toContain('private-detail');
});

test.each(['missing', 'replaced'])('%s worker ownership is never followed to another VM', async kind => {
  if (kind === 'missing') mockRead.mockResolvedValue(undefined);
  else row = { ...row, handle: { ...handle, microvmId: 'other-vm', sessionId: 'other-vm' } };
  expect((await run()).kind).toBe('ownership-lost');
  expect(strategy.pollSession).not.toHaveBeenCalled();
  expect(strategy.suspendSession).not.toHaveBeenCalled();
});

test('a cancelled task is returned for cleanup without any wake or status change', async () => {
  row = { ...row, status: 'CANCELLED' };
  expect(await run()).toMatchObject({ kind: 'closed', status: 'CANCELLED' });
  expect(strategy.pollSession).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

test('terminal substrate observations are handed back for strong task reconciliation', async () => {
  strategy.pollSession.mockResolvedValue(observation('TERMINATED'));
  expect((await run()).kind).toBe('substrate-terminal');
  expect(mockSave).not.toHaveBeenCalled();
});

test('an intended long sleep stays asleep and does not fail heartbeat liveness', async () => {
  intent('suspend');
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  const result = await run();
  expect(result).toMatchObject({ kind: 'continue', deferHeartbeat: true });
  expect(result.state.recovery).toBeUndefined();
  expect(strategy.resumeSession).not.toHaveBeenCalled();
});

test('a service stuck in SUSPENDING has a bounded transition window', async () => {
  intent('suspend', NOW - MICROVM_RECOVERY_TIMEOUT_MS);
  strategy.pollSession.mockResolvedValue(observation('SUSPENDING'));
  expect((await run()).kind).toBe('failure');
});

test('approval between intent save and the pre-command read prevents suspend', async () => {
  mockRead.mockImplementationOnce(async () => structuredClone(row))
    .mockImplementationOnce(async () => { approve(); return structuredClone(row); });
  expect((await run()).kind).toBe('continue');
  expect(strategy.suspendSession).not.toHaveBeenCalled();
  expect(row.intent?.action).toBe('resume');
});

test('approval during suspend saves sticky wake, then waits for SUSPENDED before Resume', async () => {
  strategy.suspendSession.mockImplementationOnce(async () => { approve(); return { supported: true }; });
  const first = await run();
  expect(row.intent?.action).toBe('resume');
  expect(strategy.resumeSession).not.toHaveBeenCalled();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDING'));
  const suspending = await run(first.state);
  expect(strategy.resumeSession).not.toHaveBeenCalled();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  const waking = await run(suspending.state);
  expect(strategy.resumeSession).toHaveBeenCalledTimes(1);
  expect(waking.state.recovery?.kind).toBe('wake');
  strategy.pollSession.mockResolvedValue(observation());
  const awake = await run(waking.state);
  expect(row.intent?.action).toBe('resume');
  expect(awake.state.recovery?.kind).toBe('wake');
  working();
  row = { ...row, heartbeatAtMs: time };
  const restored = await run(awake.state);
  expect(row.intent).toMatchObject({ action: 'resume', request_id: null });
  expect((await run(restored.state)).state.recovery).toBeUndefined();
});

test('cancellation during a command cannot trigger a post-command resume', async () => {
  strategy.suspendSession.mockImplementationOnce(async () => {
    row = { ...row, status: 'CANCELLED' };
    return { supported: true };
  });
  expect(await run()).toMatchObject({ kind: 'closed', status: 'CANCELLED' });
  expect(strategy.resumeSession).not.toHaveBeenCalled();
});

test('an uncertain suspend failure leaves coding recoverable and fences late suspension', async () => {
  strategy.suspendSession.mockRejectedValueOnce(Object.assign(new Error('private-detail'), { name: 'TimeoutError' }));
  const result = await run();
  expect(result.kind).toBe('continue');
  expect(row.intent?.action).toBe('resume');
  expect(result.state.recovery?.kind).toBe('wake');
  expect(JSON.stringify(emitEvent.mock.calls)).not.toContain('private-detail');
});

test('repeated resume failures escalate despite successful state reads', async () => {
  approve();
  intent('suspend');
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  strategy.resumeSession.mockRejectedValue(Object.assign(new Error('retry'), { name: 'TimeoutError' }));
  const first = await run();
  const second = await run(first.state);
  expect(await run(second.state)).toMatchObject({
    kind: 'failure', reason: 'resume-request-failed-repeatedly', state: { consecutiveResumeFailures: 3 },
  });
});

test('uncertain observations cannot reset a wake recovery clock', async () => {
  approve();
  intent('suspend');
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  const first = await run();
  time += 60_000;
  strategy.pollSession.mockResolvedValue(observation('UNKNOWN'));
  const unknown = await run(first.state);
  expect(unknown.state.recovery).toEqual(first.state.recovery);
  time += 60_000;
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  expect((await run(unknown.state)).kind).toBe('failure');
  expect(strategy.resumeSession).toHaveBeenCalledTimes(1);
});

test('durable wake recovery repairs a missing wake write even after a RUNNING observation', async () => {
  intent('suspend');
  const initial = await run(undefined, { suspendEnabled: false });
  const previous = { ...initial.state, recovery: { kind: 'wake' as const, sinceMs: NOW } };
  const result = await run(previous);
  expect(result.kind).toBe('continue');
  expect(row.intent?.action).toBe('resume');
  expect(strategy.suspendSession).not.toHaveBeenCalled();
});

test('recovered RUNNING gets heartbeat grace only until a fresh heartbeat', async () => {
  working();
  row = { ...row, heartbeatAtMs: NOW - 300_000 };
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  const waking = await run();
  strategy.pollSession.mockResolvedValue(observation());
  time += 5_000;
  const waiting = await run(waking.state);
  expect(waiting.deferHeartbeat).toBe(true);
  time += 45_000;
  row = { ...row, heartbeatAtMs: time };
  const healthy = await run(waiting.state);
  expect(healthy.deferHeartbeat).toBe(false);
  expect(healthy.state.recovery).toBeUndefined();
  time += 300_000;
  expect((await run(healthy.state)).deferHeartbeat).toBe(false);
});

test('a resumed RUNNING worker with no fresh heartbeat cannot retain grace forever', async () => {
  working();
  row = { ...row, heartbeatAtMs: NOW - 300_000 };
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  const waking = await run();
  strategy.pollSession.mockResolvedValue(observation());
  time += MICROVM_RECOVERY_TIMEOUT_MS;
  expect((await run(waking.state)).kind).toBe('failure');
});

test('intent storage failures remain bounded when all observations succeed', async () => {
  approve();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  mockSave.mockRejectedValue(new Error('store timeout'));
  const first = await run();
  const second = await run(first.state);
  expect((await run(second.state)).kind).toBe('failure');
  expect(strategy.resumeSession).not.toHaveBeenCalled();
});

test('an audit failure does not discard the wake recovery outcome', async () => {
  working();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  emitEvent.mockRejectedValue(new Error('private audit detail'));
  expect((await run()).kind).toBe('continue');
  expect(strategy.resumeSession).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('private audit detail');
});

test.each(['post-read', 'wake-write'])('lost %s after Suspend retains the wake obligation across restart', async failure => {
  if (failure === 'post-read') {
    mockRead.mockResolvedValueOnce(structuredClone(row))
      .mockImplementationOnce(async () => structuredClone(row))
      .mockRejectedValueOnce(new Error('lost read'));
  } else {
    strategy.suspendSession.mockImplementationOnce(async () => {
      approve();
      mockSave.mockRejectedValueOnce(new Error('lost compensating write'));
      return { supported: true };
    });
  }
  const uncertain = await run();
  expect(uncertain.state.recovery?.kind).toBe('wake');
  const repaired = await run(uncertain.state);
  expect(repaired.kind).toBe('continue');
  expect(row.intent?.action).toBe('resume');
  expect(strategy.suspendSession).toHaveBeenCalledTimes(1);
});

test('a normal wake in progress is not reported as an unintended suspension', async () => {
  approve();
  intent('resume');
  strategy.pollSession.mockResolvedValue(observation('SUSPENDING'));
  await run();
  expect(emitEvent).not.toHaveBeenCalled();
});

test('HYDRATING startup is bounded even when AWS reports RUNNING', async () => {
  working();
  row = { ...row, status: 'HYDRATING' };
  const starting = await run();
  time += 300_000;
  expect(await run(starting.state)).toMatchObject({ kind: 'failure', reason: 'startup-deadline' });
});

test('FINALIZING can finish normally but cannot exceed the original lifetime', async () => {
  working();
  const active = await run();
  row = { ...row, status: 'FINALIZING' };
  expect((await run(active.state)).kind).toBe('closed');
  time = active.state.sessionDeadlineMs;
  expect(await run(active.state)).toMatchObject({ kind: 'failure', reason: 'session-deadline' });
});

test('ordinary RUNNING heartbeat failures remain visible after recovery ends', async () => {
  working();
  row = { ...row, taskStartedAtMs: NOW - 600_000, heartbeatAtMs: NOW - 300_000 };
  expect((await run()).heartbeatUnhealthy).toBe(true);
  row = { ...row, heartbeatAtMs: NOW };
  expect((await run()).heartbeatUnhealthy).toBe(false);
  row = { ...row, heartbeatAtMs: undefined };
  expect((await run()).heartbeatUnhealthy).toBe(true);
});

test('AWS RUNNING cannot hide a worker that never consumes a committed decision', async () => {
  approve();
  const first = await run();
  expect(first.state.recovery?.kind).toBe('wake');
  time += MICROVM_RECOVERY_TIMEOUT_MS;
  expect(await run(first.state)).toMatchObject({ kind: 'failure', reason: 'wake-deadline' });
});

test('an expired gate stuck PENDING is bounded even when AWS stays RUNNING', async () => {
  time += 600_000;
  const first = await run();
  expect(first.state.recovery?.kind).toBe('wake');
  time += MICROVM_RECOVERY_TIMEOUT_MS;
  expect((await run(first.state)).kind).toBe('failure');
});

test('multiple failed requests within one cycle count as one failed cycle', async () => {
  row = { ...row, approval: { kind: 'unavailable', errorType: 'TimeoutError' } };
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  mockSave.mockRejectedValue(new Error('write timeout'));
  const first = await run();
  expect(first.state.consecutivePollFailures).toBe(1);
  const second = await run(first.state);
  expect(second.state.consecutivePollFailures).toBe(2);
  expect((await run(second.state)).kind).toBe('failure');
});

test('a new gate between wake intent and dispatch prevents that stale Resume', async () => {
  approve();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  mockRead.mockImplementationOnce(async () => structuredClone(row))
    .mockImplementationOnce(async () => { row = { ...row, requestId: 'next-gate' }; return structuredClone(row); });
  await run();
  expect(strategy.resumeSession).not.toHaveBeenCalled();
});

test('anomaly reporting survives a failed poll and rearms after a fresh recovered heartbeat', async () => {
  working();
  row = { ...row, heartbeatAtMs: time };
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  const first = await run();
  expect(emitEvent.mock.calls.filter(([type]) => type === 'microvm_suspend_anomaly')).toHaveLength(1);
  strategy.pollSession.mockRejectedValueOnce(new Error('transient'));
  const failed = await run(first.state);
  expect(failed.state.anomalyReported).toBe(true);
  const recovering = await run(failed.state);
  expect(emitEvent.mock.calls.filter(([type]) => type === 'microvm_suspend_anomaly')).toHaveLength(1);
  strategy.pollSession.mockResolvedValue(observation());
  const recovered = await run(recovering.state);
  expect(recovered.state.recovery).toBeUndefined();
  strategy.pollSession.mockResolvedValue(observation('SUSPENDED'));
  await run(recovered.state);
  expect(emitEvent.mock.calls.filter(([type]) => type === 'microvm_suspend_anomaly')).toHaveLength(2);
});

describe('cleanup evidence', () => {
  test.each(['requested', 'not-found'] as const)('%s ends cleanup without claiming more evidence', async outcome => {
    strategy.stopSession.mockResolvedValue({ outcome });
    await stopMicrovmWithDiagnostics({ taskId: 'task', handle, strategy, emitEvent });
    expect(strategy.stopSession).toHaveBeenCalledTimes(1);
    expect(emitEvent).not.toHaveBeenCalled();
  });
  test('a conflict gets one bounded retry, then reports uncertainty with the retained handle', async () => {
    strategy.stopSession.mockResolvedValue({ outcome: 'unconfirmed', error_type: 'ConflictException', aws_request_id: 'safe-123' });
    await stopMicrovmWithDiagnostics({ taskId: 'task', handle, strategy, emitEvent });
    expect(strategy.stopSession).toHaveBeenCalledTimes(2);
    expect(strategy.stopSession.mock.calls[1][1]).toBe(strategy.stopSession.mock.calls[0][1]);
    expect(emitEvent).toHaveBeenCalledWith('microvm_cleanup_unconfirmed', {
      task_id: 'task', microvm_id: 'vm', error_type: 'ConflictException', aws_request_id: 'safe-123',
    }, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
  });
  test('denied cleanup does not keep retrying and failed audit never masks finalization', async () => {
    strategy.stopSession.mockResolvedValue({ outcome: 'unconfirmed', error_type: 'AccessDeniedException' });
    emitEvent.mockRejectedValue(new Error('private audit details'));
    await expect(stopMicrovmWithDiagnostics({ taskId: 'task', handle, strategy, emitEvent })).resolves.toBeUndefined();
    expect(strategy.stopSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('private audit details');
  });
});
