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

export interface CoerceContext {
  readonly field: string;
  readonly task_id?: string;
  readonly event_id?: string;
}

export interface CoerceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const RAW_LOG_CHARS = 100;

/**
 * Coerce a value that should be a number but may arrive as a string
 * into a finite ``number`` or ``null``.
 *
 * Rules:
 *   - ``null`` / ``undefined`` / empty-string → ``null`` (treated as
 *     "absent"; no warn).
 *   - Finite number (either a real ``number`` or a parseable string)
 *     → that number.
 *   - Non-finite coercion (``NaN``, ``Infinity``) → ``null`` AND emits
 *     a warn via the provided logger.
 */
export function coerceNumericOrNull(
  value: number | string | null | undefined,
  context: CoerceContext,
  logger: CoerceLogger,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length === 0) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    logger.warn('[numeric] non-finite coercion — dropping field', {
      event: 'numeric.coercion_failed',
      field: context.field,
      raw: String(value).slice(0, RAW_LOG_CHARS),
      task_id: context.task_id,
      event_id: context.event_id,
    });
    return null;
  }
  return n;
}
