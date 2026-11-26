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

const TRANSIENT = new Error('TaskDefinition is inactive');
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
    expect(emitReasons).toEqual([]);
  });

  it('2. first attempt fails NON-transient → re-throws original, NO retry', async () => {
    const startSession = jest.fn().mockRejectedValueOnce(NON_TRANSIENT);
    const { d, emitReasons } = deps();
    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(NON_TRANSIENT);
    expect(startSession).toHaveBeenCalledTimes(1);
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
    expect(emitReasons).toHaveLength(1);
  });

  it('4. transient then transient → throws the retry error TAGGED autoRetried (#599 N1)', async () => {
    const secondErr = new Error('TaskDefinition is inactive (again)');
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(TRANSIENT)
      .mockRejectedValueOnce(secondErr);
    const { d } = deps();
    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(secondErr);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(isAutoRetried(secondErr)).toBe(true);
  });

  it('isAutoRetried is false for a first-attempt (non-transient) failure and non-objects', async () => {
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
    expect(res).toEqual({ handle: HANDLE, autoRetried: true });
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(warns.some((w) => w.message.includes('event emit failed'))).toBe(true);
  });
});

describe('startSessionWithRetry — Lambda MicroVM start failures (ADR-021)', () => {
  const MICROVM_HANDLE: SessionHandle = {
    sessionId: 'mvm-0123456789abcdef',
    strategyType: 'lambda-microvm',
    microvmId: 'mvm-0123456789abcdef',
    endpoint: 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com',
  };

  it('auto-retries a ThrottlingException once and returns the MicroVM handle', async () => {
    const throttle = new Error('MicroVM RunMicrovm failed: ThrottlingException: Rate exceeded');
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce(MICROVM_HANDLE);
    const { d, emitReasons } = deps();

    const res = await startSessionWithRetry({ startSession }, {} as never, d);

    expect(res).toEqual({ handle: MICROVM_HANDLE, autoRetried: true });
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(emitReasons).toHaveLength(1);
  });

  it('auto-retries a ServiceQuotaExceededException (capacity frees as MicroVMs terminate)', async () => {
    const quota = new Error(
      'MicroVM RunMicrovm failed: ServiceQuotaExceededException: MicroVM memory quota exceeded',
    );
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(quota)
      .mockResolvedValueOnce(MICROVM_HANDLE);
    const { d } = deps();

    const res = await startSessionWithRetry({ startSession }, {} as never, d);

    expect(res).toEqual({ handle: MICROVM_HANDLE, autoRetried: true });
    expect(startSession).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a regional-unavailability failure — the Region will never gain the service', async () => {
    const regional = new Error(
      "UnknownEndpoint: Inaccessible host: `lambda.eu-central-1.amazonaws.com'. "
      + "This service may not be available in the `eu-central-1' region.",
    );
    const startSession = jest.fn().mockRejectedValueOnce(regional);
    const { d, emitReasons } = deps();

    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(regional);

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(emitReasons).toEqual([]);
  });

  it('does NOT retry a missing-substrate config error (no MICROVM_* env vars)', async () => {
    const configErr = new Error(
      'This repository is configured compute_type=lambda-microvm, but this stack was deployed without the '
      + 'Lambda MicroVMs substrate (missing MICROVM_IMAGE_IDENTIFIER/...).',
    );
    const startSession = jest.fn().mockRejectedValueOnce(configErr);
    const { d } = deps();

    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(configErr);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a ResourceNotFoundException (bad image/role/connector ARN)', async () => {
    const notFound = new Error('MicroVM RunMicrovm failed: ResourceNotFoundException: MicroVM image not found');
    const startSession = jest.fn().mockRejectedValueOnce(notFound);
    const { d } = deps();

    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(notFound);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it.each(['AccessDeniedException', 'UnauthorizedException', 'ValidationException', 'InvalidParameterValueException'])(
    'does NOT retry a MicroVM %s', async (name) => {
      const error = new Error(`MicroVM RunMicrovm failed: ${name}: request rejected`);
      const startSession = jest.fn().mockRejectedValueOnce(error);
      const { d, emitReasons } = deps();
      await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(error);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(emitReasons).toEqual([]);
    },
  );
});

describe('startSessionWithRetry — other backends keep their pre-ADR-021 retry behaviour', () => {
  it('does NOT auto-retry an unmarked ThrottlingException (agentcore/ECS path)', async () => {
    const throttle = new Error('ThrottlingException: Rate exceeded');
    const startSession = jest.fn().mockRejectedValueOnce(throttle);
    const { d, emitReasons } = deps();

    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(throttle);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(emitReasons).toEqual([]);
  });

  it('does NOT auto-retry an unmarked ServiceQuotaExceededException (agentcore/ECS path)', async () => {
    const quota = new Error('ServiceQuotaExceededException: quota exceeded');
    const startSession = jest.fn().mockRejectedValueOnce(quota);
    const { d } = deps();

    await expect(startSessionWithRetry({ startSession }, {} as never, d)).rejects.toBe(quota);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('still auto-retries the ECS deploy-race, proving the gate itself is unchanged', async () => {
    const startSession = jest
      .fn()
      .mockRejectedValueOnce(new Error('TaskDefinition is inactive'))
      .mockResolvedValueOnce(HANDLE);
    const { d } = deps();

    const res = await startSessionWithRetry({ startSession }, {} as never, d);
    expect(res).toEqual({ handle: HANDLE, autoRetried: true });
    expect(startSession).toHaveBeenCalledTimes(2);
  });
});
