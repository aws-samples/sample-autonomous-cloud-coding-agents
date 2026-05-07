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
 * Truncate a string to `maxLen`, appending "..." if it was cut.
 * @param text - the string to truncate.
 * @param maxLen - the maximum length of the returned string (including the "...").
 * @returns the truncated string.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Format a duration in seconds as a human-readable string (e.g. "45s", "2m 10s", "1h 5m").
 * @param seconds - the duration in seconds. Non-numeric values are coerced with Number().
 * @returns the formatted duration string.
 */
export function formatDuration(seconds: number): string {
  const s = Number(seconds);
  if (s < 60) return `${Math.round(s)}s`;
  const minutes = Math.floor(s / 60);
  const remS = Math.round(s % 60);
  if (minutes < 60) return remS > 0 ? `${minutes}m ${remS}s` : `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const remainM = minutes % 60;
  return remainM > 0 ? `${h}h ${remainM}m` : `${h}h`;
}
