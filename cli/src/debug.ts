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

let verbose = false;

/** Enable verbose debug output. */
export function setVerbose(enabled: boolean): void {
  verbose = enabled;
}

/** Returns whether verbose mode is on. */
export function isVerbose(): boolean {
  return verbose;
}

/** Log a debug message to stderr when verbose mode is on. */
export function debug(message: string): void {
  if (verbose) {
    console.error(`[DEBUG] ${message}`);
  }
}

/**
 * Field names whose values must never appear in `--verbose` output.
 * Webhook creation returns a one-time `secret`; OAuth flows carry
 * `access_token` / `refresh_token`. Verbose logs land in scrollback and
 * CI logs, which outlive the "shown once" guarantee of those values.
 */
const SENSITIVE_FIELDS = new Set([
  'secret',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'authorization',
  'password',
  'token',
]);

/**
 * Deep-copy a JSON-shaped value with sensitive field values replaced by
 * `[REDACTED]`, for safe debug logging of request/response bodies.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_FIELDS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(val);
    }
    return out;
  }
  return value;
}
