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

// The backoff-curve pins live in watch.test.ts (they exercise the curve
// through withTransientRetry). This suite covers the classifier directly.

import { CliError, ApiError } from '../src/errors';
import { abortableSleep, isTransientError } from '../src/retry';

describe('isTransientError', () => {
  test('5xx ApiError is transient; 4xx is not', () => {
    expect(isTransientError(new ApiError(503, 'UNAVAILABLE', 'down', 'r1'))).toBe(true);
    expect(isTransientError(new ApiError(404, 'NOT_FOUND', 'missing', 'r2'))).toBe(false);
  });

  test('undici "fetch failed" TypeError is transient', () => {
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true);
  });

  test('mid-stream socket failure via err.cause.code is transient', () => {
    // undici "terminated" (body interrupted after headers) is NOT a
    // TypeError with "fetch failed" — without the cause.code check it was
    // misclassified as fatal, defeating the retry budget.
    // (cause assigned structurally: the compile target's lib predates
    // the ErrorOptions constructor overload.)
    const cause = new Error('read ECONNRESET') as Error & { code: string };
    cause.code = 'ECONNRESET';
    const err = new Error('terminated') as Error & { cause?: Error };
    err.cause = cause;
    expect(isTransientError(err)).toBe(true);
  });

  test('unrecognized cause codes stay non-transient (whitelist)', () => {
    const cause = new Error('permission denied') as Error & { code: string };
    cause.code = 'EACCES';
    const err = new Error('request failed') as Error & { cause?: Error };
    err.cause = cause;
    expect(isTransientError(err)).toBe(false);
  });

  test('CliError and plain errors are non-transient', () => {
    expect(isTransientError(new CliError('bad input'))).toBe(false);
    expect(isTransientError(new Error('boom'))).toBe(false);
    expect(isTransientError('not even an error')).toBe(false);
  });
});

describe('abortableSleep', () => {
  test('resolves (not rejects) when the signal aborts mid-sleep', async () => {
    // Poll loops check signal.aborted after the sleep; a rejection here
    // would crash them instead of letting them exit cleanly.
    const controller = new AbortController();
    const sleep = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(sleep).resolves.toBeUndefined();
  });

  test('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
  });
});
