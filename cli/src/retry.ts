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

import { ApiError } from './errors';

const RETRY_BASE_DELAY_MS = 500;

const RETRY_CEILING_MS = 5_000;

const TRANSIENT_CAUSE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Classify an error into retryable (transient) vs. terminal. Whitelist
 * approach: only conditions we specifically recognize as transient retry.
 *
 * Transient:
 *   - ``ApiError`` with status 5xx (server-side hiccup).
 *   - Network failures surfaced by ``fetch`` as a ``TypeError`` — Node's
 *     undici reports connect-refused / reset / DNS failure this way.
 *   - Any ``Error`` whose ``cause.code`` is a known socket-level transient
 *     (see ``TRANSIENT_CAUSE_CODES``) — covers mid-stream terminations
 *     that undici does NOT wrap as ``TypeError: fetch failed``.
 *
 * Non-transient: everything else (``ApiError`` 4xx, ``CliError``, any unrecognized error).
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.statusCode >= 500 && err.statusCode < 600;
  }
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) {
    return true;
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const code = cause instanceof Error
      ? (cause as Error & { code?: unknown }).code
      : undefined;
    if (typeof code === 'string' && TRANSIENT_CAUSE_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

/** Exponential backoff with equal-jitter (AWS Architecture Blog variant):
 *  half the base delay is fixed, the other half randomized.
 *  Bounded at ``RETRY_CEILING_MS``. ``attempt`` is 1-based: the base is 1000ms
 *  for the first retry, then 2000/4000/5000 (cap). */
export function transientRetryDelayMs(attempt: number): number {
  const base = Math.min(RETRY_CEILING_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  const half = Math.floor(base / 2);
  return half + Math.floor(Math.random() * (base - half));
}

/** Sleep that honours an optional AbortSignal — resolves on abort instead of
 *  rejecting, so a poll loop can check ``signal.aborted`` and exit cleanly.
 *  With no signal it is a plain ``setTimeout`` sleep. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
