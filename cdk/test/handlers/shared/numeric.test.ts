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

import { coerceNumericOrNull, type CoerceLogger } from '../../../src/handlers/shared/numeric';

function mkLogger(): { logger: CoerceLogger; warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const warnCalls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger: CoerceLogger = {
    warn: (message, meta) => { warnCalls.push({ message, meta }); },
  };
  return { logger, warnCalls };
}

describe('coerceNumericOrNull', () => {
  test('passes real numbers through unchanged', () => {
    const { logger, warnCalls } = mkLogger();
    expect(coerceNumericOrNull(42, { field: 'x' }, logger)).toBe(42);
    expect(coerceNumericOrNull(0, { field: 'x' }, logger)).toBe(0);
    expect(coerceNumericOrNull(-1.5, { field: 'x' }, logger)).toBe(-1.5);
    expect(warnCalls).toHaveLength(0);
  });

  test('parses numeric strings (DDB Document-client shape)', () => {
    // The actual shape observed in Scenario 7-extended deploy
    // validation: ``duration_s: "96.0"`` and
    // ``cost_usd: "0.20939010000000002"``.
    const { logger, warnCalls } = mkLogger();
    expect(coerceNumericOrNull('96.0', { field: 'duration_s' }, logger)).toBe(96);
    expect(coerceNumericOrNull('0.20939010000000002', { field: 'cost_usd' }, logger))
      .toBeCloseTo(0.2094, 4);
    expect(warnCalls).toHaveLength(0);
  });

  test('treats null / undefined / empty-string as absent (no warn)', () => {
    const { logger, warnCalls } = mkLogger();
    expect(coerceNumericOrNull(null, { field: 'x' }, logger)).toBeNull();
    expect(coerceNumericOrNull(undefined, { field: 'x' }, logger)).toBeNull();
    expect(coerceNumericOrNull('', { field: 'x' }, logger)).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  test('non-finite coercion collapses to null AND emits a warn', () => {
    // Corrupt input (non-numeric string, real NaN, Infinity) must
    // surface in CloudWatch so writer bugs are visible rather than
    // silently dropping data from the consumer's render.
    const { logger, warnCalls } = mkLogger();

    expect(coerceNumericOrNull('not-a-number', { field: 'cost_usd', task_id: 't-1' }, logger))
      .toBeNull();
    expect(coerceNumericOrNull(NaN, { field: 'x' }, logger)).toBeNull();
    expect(coerceNumericOrNull(Infinity, { field: 'x' }, logger)).toBeNull();
    expect(coerceNumericOrNull(-Infinity, { field: 'x' }, logger)).toBeNull();

    expect(warnCalls).toHaveLength(4);
    for (const call of warnCalls) {
      expect(call.meta?.event).toBe('numeric.coercion_failed');
      expect(call.meta?.field).toBeDefined();
      expect(call.meta?.raw).toBeDefined();
    }
    // The task_id context propagates through.
    expect(warnCalls[0].meta?.task_id).toBe('t-1');
  });

  test('warn payload preserves the raw input for operator triage', () => {
    const { logger, warnCalls } = mkLogger();
    coerceNumericOrNull('oops', { field: 'cost_usd', task_id: 't-1', event_id: 'e-1' }, logger);
    expect(warnCalls[0].meta?.raw).toBe('oops');
    expect(warnCalls[0].meta?.event_id).toBe('e-1');
  });
});
