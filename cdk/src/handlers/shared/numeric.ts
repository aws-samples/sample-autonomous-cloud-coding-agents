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
 * Rationale: the AWS SDK v3 Document client deserializes DynamoDB
 * ``Number`` attributes as JavaScript ``string``s in some code paths
 * (notably ``TaskRecord.{duration_s,cost_usd}`` from ``TaskTable``),
 * even though our TypeScript types declare them as ``number | null``.
 * Callers that go on to call ``.toFixed()`` / do arithmetic on those
 * fields silently fail with ``TypeError: input.costUsd.toFixed is not
 * a function`` (Scenario 7-extended deploy validation uncovered this
 * in the GitHub fan-out dispatcher).
 *
 * Use these helpers at any boundary that passes those fields on to
 * numeric consumers. Adding a third call site is a signal that the
 * underlying type declaration should be widened (``number | string |
 * null``) at the DDB load boundary; for now, coerce locally.
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
 * Coerce a value that should be a number but may arrive as a string
 * (DynamoDB Document-client deserializes ``Number`` attributes as
 * strings) into a finite ``number`` or ``null``.
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
      raw: String(value),
      task_id: context.task_id,
      event_id: context.event_id,
    });
    return null;
  }
  return n;
}
