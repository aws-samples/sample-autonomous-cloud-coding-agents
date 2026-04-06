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

import { createHash } from 'crypto';

/**
 * Compute a deterministic prompt version hash from the system prompt template
 * and optional overrides. Excludes runtime-variable data (memory context,
 * task-specific values) so the version tracks the _instruction set_ only.
 *
 * @param template - the base system prompt template text.
 * @param overrides - optional key-value overrides appended to the prompt.
 * @returns 12-character hex hash (first 12 chars of SHA-256).
 */
export function computePromptVersion(template: string, overrides?: Record<string, string>): string {
  let input = template;
  if (overrides && Object.keys(overrides).length > 0) {
    const sorted = Object.keys(overrides).sort().reduce<Record<string, string>>((acc, key) => {
      acc[key] = overrides[key];
      return acc;
    }, {});
    input += JSON.stringify(sorted);
  }
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
