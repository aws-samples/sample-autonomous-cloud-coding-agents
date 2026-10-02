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

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { SessionControlOptions } from './compute-strategy';
import { logger } from './logger';
import { microvmErrorIdentity } from './microvm-control';
import { makeClient } from './ua';

export const MICROVM_SUSPEND_CONFIG_TIMEOUT_MS = 3_000;
let client: SSMClient | undefined;

/**
 * Durable executions pin their function version, including its environment.
 * Read a stable shared parameter without caching so existing executions can
 * observe disable. An unavailable setting loses savings, not a healthy worker.
 */
export async function readMicrovmSuspendEnabled(options: SessionControlOptions): Promise<boolean> {
  const name = process.env.MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME;
  if (!name) return false;
  const localSignal = AbortSignal.timeout(MICROVM_SUSPEND_CONFIG_TIMEOUT_MS);
  const abortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, localSignal]) : localSignal;
  try {
    abortSignal.throwIfAborted();
    client ??= makeClient(SSMClient, { maxAttempts: 1 });
    const response = await client.send(new GetParameterCommand({ Name: name }), { abortSignal });
    abortSignal.throwIfAborted();
    return response.Parameter?.Name === name && response.Parameter.Value === 'true';
  } catch (error) {
    logger.warn('MicroVM suspension setting unavailable; new suspension disabled', microvmErrorIdentity(error));
    return false;
  }
}
