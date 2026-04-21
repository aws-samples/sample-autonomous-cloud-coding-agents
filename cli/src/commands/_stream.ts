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

/**
 * Shared helpers for commands that open an SSE stream (`watch`, `run`).
 *
 * Both commands accept `--stream-timeout-seconds` and share the same
 * proactive-restart ceiling; keep the single source of truth here so they
 * can't drift.
 */

import { CliError } from '../errors';

/** Default stream timeout — 58 min, pre-empts AgentCore's 60-min streaming cap. */
export const DEFAULT_STREAM_TIMEOUT_SECONDS = 3500;

/**
 * Validate the `--stream-timeout-seconds` CLI flag.
 * Accepts a number or a numeric string; throws `CliError` on anything else.
 */
export function validateStreamTimeout(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(
      `Invalid --stream-timeout-seconds value: ${String(raw)}. Must be a positive integer.`,
    );
  }
  return n;
}
