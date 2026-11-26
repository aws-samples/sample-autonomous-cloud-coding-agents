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
 * Numeric coercion helpers for the DynamoDB / Document-client boundary.
 *
 * Rationale: the Python agent stores ``cost_usd``, ``duration_s`` and the
 * turn counters on the task row as DynamoDB String attributes
 * (``agent/src/task_state.py::write_terminal`` passes them through
 * ``str()``), and the Document client returns a String attribute as a
 * JavaScript ``string``; only a Number attribute comes back as a ``number``.
 * A caller that goes on to call ``.toFixed()`` on such a field fails
 * with ``TypeError: input.costUsd.toFixed is not a function``, and
 * ``+`` concatenates instead of adding (Scenario 7-extended deploy
 * validation uncovered the first in the GitHub fan-out dispatcher).
 *
 * Use these helpers at any boundary that passes those fields on to
 * numeric consumers. ``TaskRecord`` declares them ``number | string``,
 * so ``.toFixed()`` or arithmetic on the raw field does not compile.
 */

export interface CoerceContext {
  readonly field: string;
  readonly task_id?: string;
  readonly event_id?: string;
}

/** Minimal logger shape used by the coercion helper. Structural so the
 *  shared ``logger`` export and test mocks both satisfy it without an
 *  explicit interface import. */
export interface CoerceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * How much of a value that is not a number the warning quotes. The value is
 * read from storage, where it can be as long as its record, and the warning
 * repeats at every read: the first characters are enough to tell what a
 * writer stored.
 */
const RAW_LOG_CHARS = 100;

/**
 * Coerce a value that should be a number but may arrive as a string
 * (the agent stores some task fields as DynamoDB String attributes)
 * into a finite ``number`` or ``null``.
 *
 * Rules:
 *   - ``null`` / ``undefined`` / empty-string → ``null`` (treated as
 *     "absent"; no warn).
 *   - Finite number (either a real ``number`` or a parseable string)
 *     → that number.
 *   - Non-finite coercion (``NaN``, ``Infinity``) → ``null`` AND emits
 *     a warn via the provided logger so writer bugs surface in
 *     CloudWatch rather than silently dropping the consumer's render.
 *
 * The logger argument keeps this helper free of a direct import of
 * ``./logger`` so the same shape is usable from tests without a full
 * mock.
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
