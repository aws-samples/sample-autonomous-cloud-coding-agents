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

/** Names of AWS SDK errors that a stream-record retry can plausibly clear
 *  (throttles, transient 5xx). Distinguishes "retry the record" from a
 *  poison-pill that would stall the shard forever. */
const RETRYABLE_AWS_ERROR = /Throttling|ProvisionedThroughputExceeded|RequestLimitExceeded|ServiceUnavailable|InternalServerError|InternalFailure|TransactionInProgress|5\d\d/i;

/**
 * True when an error is a transient infra fault (throttle / 5xx) that a stream
 * retry can clear — as opposed to a benign conditional failure or a
 * deterministic client error that would just fail again. Governance
 * enforcement paths rethrow these so the FanOut record enters
 * ``batchItemFailures`` instead of silently skipping a cancel/approval (#230).
 */
export function isRetryableInfraError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
    if (e.$retryable) return true;
    const status = e.$metadata?.httpStatusCode;
    if (typeof status === 'number' && status >= 500) return true;
    if (e.name && RETRYABLE_AWS_ERROR.test(e.name)) return true;
  }
  return false;
}
