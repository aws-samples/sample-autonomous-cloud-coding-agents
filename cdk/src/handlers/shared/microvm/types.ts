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
import type { SessionHandle } from '../compute-strategy';

export type MicrovmHandle = Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;

/**
 * Internal TaskTable `microvm_start` attribute, deliberately not part of the
 * task API. Each task owns one logical start; retries reuse the token.
 */
export interface MicrovmStartReceipt {
  readonly clientToken: string;
  readonly requestHash: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly handle?: MicrovmHandle;
}

/** Bounds one stop-and-confirm of a MicroVM worker during supervisor cleanup. */
export const MICROVM_STOP_TIMEOUT_MS = 25_000;
/** Poll cadence while a MicroVM is changing state (suspending, resuming, stopping). */
export const MICROVM_TRANSITION_POLL_MS = 5_000;
