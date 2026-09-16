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

const mockRead = jest.fn();
const mockSave = jest.fn();
const mockSend = jest.fn();
const mockEmit = jest.fn();
const mockLogger = { warn: jest.fn(), info: jest.fn() };
jest.mock('../../../src/handlers/shared/microvm-lifecycle', () => ({
  readMicrovmLifecycleSnapshot: (...args: unknown[]) => mockRead(...args),
  saveMicrovmLifecycleIntent: (...args: unknown[]) => mockSave(...args),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: mockLogger }));
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockSend })),
  GetMicrovmCommand: jest.fn(input => ({ type: 'get', input })),
  ResumeMicrovmCommand: jest.fn(input => ({ type: 'resume', input })),
}));

import { approvalPostCommitOptions, wakeMicrovmAfterApproval } from '../../../src/handlers/shared/microvm-approval-wake';
import type { MicrovmLifecycleSnapshot } from '../../../src/handlers/shared/microvm-lifecycle';

const NOW = Date.parse('2026-09-15T12:00:00Z');
let row: MicrovmLifecycleSnapshot;
let controller: AbortController;
function wake(decision: 'APPROVED' | 'DENIED' = 'APPROVED') {
  return wakeMicrovmAfterApproval({
    taskId: 'task',
    userId: 'user',
    requestId: 'gate',
    decision,
    options: { abortSignal: controller.signal },
    emitEvent: mockEmit,
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  controller = new AbortController();
  row = {
    taskId: 'task',
    userId: 'user',
    status: 'AWAITING_APPROVAL',
    requestId: 'gate',
    handle: { strategyType: 'lambda-microvm', microvmId: 'vm', sessionId: 'vm', endpoint: 'https://vm.example' },
    approval: {
      kind: 'present',
      status: 'APPROVED',
      created_at: new Date(NOW - 60_000).toISOString(),
      timeout_s: 600,
      createdAtMs: NOW - 60_000,
      deadlineMs: NOW + 540_000,
    },
  };
  mockRead.mockReset().mockImplementation(async () => structuredClone(row));
  mockSave.mockReset().mockImplementation(async (snapshot, action) => {
    row = {
      ...snapshot,
      intent: {
        version: 1,
        microvm_id: 'vm',
        request_id: snapshot.requestId,
        generation: 'wake-generation',
        action,
        requested_at_ms: NOW,
        deadline_ms: NOW + 540_000,
      },
    };
    return { status: 'saved', intent: row.intent };
  });
  mockSend.mockReset().mockResolvedValue({ state: 'SUSPENDED' });
  mockEmit.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test('ties the saved decision generation to the accepted AWS request without logging its body', async () => {
  mockSend.mockResolvedValueOnce({ state: 'SUSPENDED' }).mockResolvedValueOnce({
    $metadata: { requestId: 'aws-inline-123' }, private: 'secret-response',
  });
  await wake();
  expect(mockLogger.info).toHaveBeenCalledWith('MicroVM wake requested after approval decision', expect.objectContaining({
    task_id: 'task',
    request_id: 'gate',
    microvm_id: 'vm',
    generation: 'wake-generation',
    intent_requested_at_ms: NOW,
    aws_request_id: 'aws-inline-123',
    elapsed_ms: 0,
  }));
  expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain('secret-response');
  expect(mockRead).toHaveBeenCalledTimes(3);
});

test.each(['APPROVED', 'DENIED'] as const)('%s saves wake before Get, rechecks ownership, then requests Resume and reads again', async decision => {
  if (row.approval.kind === 'present') row = { ...row, approval: { ...row.approval, status: decision } };
  await wake(decision);
  expect(mockSend.mock.calls.map(([command]) => command.type)).toEqual(['get', 'resume']);
  expect(mockSave.mock.calls[0][1]).toBe('resume');
  expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(mockSend.mock.invocationCallOrder[0]);
  expect(mockRead).toHaveBeenCalledTimes(3);
  expect(mockRead.mock.invocationCallOrder[1]).toBeLessThan(mockSend.mock.invocationCallOrder[1]);
  expect(mockSend.mock.invocationCallOrder[1]).toBeLessThan(mockRead.mock.invocationCallOrder[2]);
  expect(mockSend.mock.calls[1][0].input).toEqual({ microvmIdentifier: 'vm' });
  expect(row.intent?.action).toBe('resume');
});

test.each(['RUNNING', 'SUSPENDING', 'PENDING', 'UNKNOWN', 'TERMINATED'])('%s retains wake intent without premature Resume', async state => {
  mockSend.mockResolvedValue({ state });
  await wake();
  expect(row.intent?.action).toBe('resume');
  expect(mockSend.mock.calls.map(([command]) => command.type)).toEqual(['get']);
});

test.each(['missing', 'cancelled', 'new-gate', 'pending'])('%s snapshot cannot trigger compute control', async kind => {
  if (kind === 'missing') mockRead.mockResolvedValue(undefined);
  if (kind === 'cancelled') row = { ...row, status: 'CANCELLED' };
  if (kind === 'new-gate') row = { ...row, requestId: 'new-gate' };
  if (kind === 'pending' && row.approval.kind === 'present') row = { ...row, approval: { ...row.approval, status: 'PENDING' } };
  await wake();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['stale', 'ineligible'])('a %s intent write cannot authorize Get or Resume', async status => {
  mockSave.mockResolvedValue({ status });
  await wake();
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['cancel', 'gate', 'worker', 'generation'])('%s winning after Get blocks Resume', async change => {
  mockSend.mockImplementationOnce(async () => {
    if (change === 'cancel') row = { ...row, status: 'CANCELLED' };
    if (change === 'gate') row = { ...row, requestId: 'new-gate' };
    if (change === 'worker') row = { ...row, handle: { ...row.handle, microvmId: 'other' } };
    if (change === 'generation') row = { ...row, intent: { ...row.intent!, generation: 'other' } };
    return { state: 'SUSPENDED' };
  });
  await wake();
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('a consumed decision can fence its old suspend while task RUNNING', async () => {
  row = {
    ...row,
    status: 'RUNNING',
    requestId: null,
    approval: { kind: 'none' },
    intent: {
      version: 1,
      microvm_id: 'vm',
      request_id: 'gate',
      action: 'suspend',
      generation: 'old',
      requested_at_ms: NOW - 5_000,
      deadline_ms: NOW + 540_000,
    },
  };
  await wake();
  expect(row.intent?.request_id).toBeNull();
  expect(row.intent?.action).toBe('resume');
  expect(mockSend.mock.calls.map(([command]) => command.type)).toEqual(['get', 'resume']);
});

test('a failed Resume still reads again, retains wake and only logs safe identifiers', async () => {
  mockSend.mockResolvedValueOnce({ state: 'SUSPENDED' }).mockRejectedValueOnce(Object.assign(
    new Error('private SDK details'), { name: 'AccessDeniedException', $metadata: { requestId: 'safe-123' } },
  ));
  await expect(wake()).resolves.toBeUndefined();
  expect(mockRead).toHaveBeenCalledTimes(3);
  expect(row.intent?.action).toBe('resume');
  expect(mockLogger.warn.mock.calls[0][1]).toMatchObject({ error_type: 'AccessDeniedException', aws_request_id: 'safe-123' });
  expect(mockEmit).toHaveBeenCalledWith('microvm_resume_orphan', expect.objectContaining({
    task_id: 'task',
    request_id: 'gate',
    microvm_id: 'vm',
    stage: 'resume-request',
    reason: 'resume-request-failed',
    error_type: 'AccessDeniedException',
    aws_request_id: 'safe-123',
  }), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
  expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('private SDK details');
});

test('an orphan-event failure remains best-effort and never discards the wake intent', async () => {
  mockSend.mockResolvedValueOnce({ state: 'SUSPENDED' }).mockRejectedValueOnce(new Error('request failed'));
  mockEmit.mockRejectedValue(new Error('private audit error'));
  await expect(wake()).resolves.toBeUndefined();
  expect(row.intent?.action).toBe('resume');
  expect(mockRead).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('private audit error');
});

test.each(['before-read', 'after-read', 'after-get'])('expired parent budget %s blocks subsequent work', async stage => {
  if (stage === 'before-read') controller.abort();
  if (stage === 'after-read') mockRead.mockImplementationOnce(async () => { controller.abort(); return row; });
  if (stage === 'after-get') mockSend.mockImplementationOnce(async () => { controller.abort(); return { state: 'SUSPENDED' }; });
  await wake();
  if (stage === 'before-read') expect(mockRead).not.toHaveBeenCalled();
  if (stage !== 'after-get') expect(mockSave).not.toHaveBeenCalled();
  expect(mockSend.mock.calls.filter(([command]) => command.type === 'resume')).toHaveLength(0);
});

test('postcommit budget reserves response time and does not restart an expired invocation', () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  approvalPostCommitOptions(NOW, { getRemainingTimeInMillis: () => 14_000 });
  expect(timeout).toHaveBeenLastCalledWith(8_000);
  approvalPostCommitOptions(NOW, { getRemainingTimeInMillis: () => 2_000 });
  expect(timeout).toHaveBeenLastCalledWith(1_000);
  expect(approvalPostCommitOptions(NOW, { getRemainingTimeInMillis: () => 900 }).abortSignal?.aborted).toBe(true);
  expect(approvalPostCommitOptions(NOW - 14_500).abortSignal?.aborted).toBe(true);
});
