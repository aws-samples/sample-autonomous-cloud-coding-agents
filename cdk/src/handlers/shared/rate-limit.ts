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
 * Cedar HITL per-user per-minute rate-limit helpers.
 *
 * The synthetic ``RATE#<user_id>#<verb>`` rows on ``TaskApprovalsTable``
 * carry a minute-bucketed counter (TTL-reaped after ~120s) keyed on the
 * UTC `yyyymmddhhmm` produced by {@link formatMinuteBucket}. Centralising
 * the formatter here removes the per-handler duplication flagged in
 * PR review (S5) and keeps the bucket boundary identical across
 * approve, deny, get-pending, get-policies, and nudge-task.
 */

/**
 * UTC minute bucket as ``YYYYMMDDhhmm``. Stable across handlers — drift
 * here would invalidate per-minute rate-limit counters.
 */
export function formatMinuteBucket(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  const mi = date.getUTCMinutes().toString().padStart(2, '0');
  return `${y}${m}${d}${h}${mi}`;
}
