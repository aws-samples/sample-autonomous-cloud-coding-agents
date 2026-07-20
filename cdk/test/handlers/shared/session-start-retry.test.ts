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

import type { SessionHandle } from '../../../src/handlers/shared/compute-strategy';
import { isAutoRetried, startSessionWithRetry } from '../../../src/handlers/shared/session-start-retry';

const HANDLE: SessionHandle = {
  sessionId: 'sess-1',
  strategyType: 'agentcore',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/r',
};

/** A transient session-start failure the classifier recognizes (ECS deploy race). */
const TRANSIENT = new Error('TaskDefinition is inactive');
/** A non-transient failure (a retry won't help). */
const NON_TRANSIENT = new Error('ECS_CLUSTER_ARN is not configured');

function deps(overrides?: { emitRetryEvent?: (reason: string) => Promise<void> }) {
  const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const emitReasons: string[] = [];
  return {
    warns,
    emitReasons,
    d: {
      emitRetryEvent:
        overrides?.emitRetryEvent ??
        (async (reason: string) => {
          emitReasons.push(reason);
        }),
      logger: { warn: (message: string, meta?: Record<string, unknown>) => warns.push({ message, meta }) },
      taskId: 't-1',
    },
  };
}

describe('startSessionWithRetry — the 4 branches (#599 B2)', () => {
  it('1. first attempt succeeds → returns handle, autoRetried false, no retry', async () => {
    const startSession = jest.fn().mockResolvedValueOnce(HANDLE);
    const { d, emitReasons } = deps();
    const res = await startSessionWithRetry({ startSession }, {} as never, d);
    expect(res).toEqual({ handle: HANDLE, autoRetried: false });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(emitReasons).toEqual([]); // no retry event on the happy path
  });

  it('2. first attempt fails NON-transient → re-throws original, NO retry', async () => {
    const startSession = jest.fn().mockRejectedValueOnce(NON_TRANSIENT);
    const { d, emitReasons } = deps();
    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(NON_TRANSIENT);
    expect(startSession).toHaveBeenCalledTimes(1); // never retried
    expect(emitReasons).toEqual([]);
  });

  it('3. transient then success → returns handle, autoRetried true, emits retry event', async () => {
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockResolvedValueOnce(HANDLE);
    const { d, emitReasons } = deps();
    const res = await startSessionWithRetry({ startSession }, {} as never, d);
    expect(res).toEqual({ handle: HANDLE, autoRetried: true });
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(emitReasons).toHaveLength(1); // the session_start_retry event fired once
  });

  it('4. transient then transient → throws the retry error TAGGED autoRetried (#599 N1)', async () => {
    const secondErr = new Error('TaskDefinition is inactive (again)');
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockRejectedValueOnce(secondErr);
    const { d } = deps();
    // The double-transient error must carry the retry fact across the throw so the
    // caller stamps `[auto-retried]` (a first-attempt failure must NOT be tagged).
    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(secondErr);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(isAutoRetried(secondErr)).toBe(true);
  });

  it('isAutoRetried is false for a first-attempt (non-transient) failure and non-objects', async () => {
    // Branch 2's re-thrown error ran no retry → must NOT be tagged, else the caller
    // would wrongly tell the user "I already retried".
    const startSession = jest.fn().mockRejectedValueOnce(NON_TRANSIENT);
    const { d } = deps();
    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(NON_TRANSIENT);
    expect(isAutoRetried(NON_TRANSIENT)).toBe(false);
    expect(isAutoRetried(undefined)).toBe(false);
    expect(isAutoRetried('a string error')).toBe(false);
  });
});

describe('startSessionWithRetry — retry-event emit is best-effort (#599 B1)', () => {
  it('a telemetry failure does NOT abort or mis-attribute the retry', async () => {
    // The exact B1 scenario: the TaskEvents PutItem throws (throttle/timeout,
    // co-occurring with the transient session-start failure). The retry must
    // still run and succeed — the emit fault must not surface as the failure.
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockResolvedValueOnce(HANDLE);
    const emitErr = new Error('ProvisionedThroughputExceededException');
    const { d, warns } = deps({
      emitRetryEvent: async () => {
        throw emitErr;
      },
    });
    const res = await startSessionWithRetry({ startSession }, {} as never, d);
    // Retry proceeded and succeeded despite the emit throwing.
    expect(res).toEqual({ handle: HANDLE, autoRetried: true });
    expect(startSession).toHaveBeenCalledTimes(2);
    // The emit failure was logged (WARN), not propagated.
    expect(warns.some((w) => w.message.includes('event emit failed'))).toBe(true);
  });
});
