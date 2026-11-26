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

import { createHash } from 'node:crypto';

import { nestedStackExecutionPolicy } from './nested-stack-policy';
import { allPolicies } from './policies';

/**
 * Semantic version of the bootstrap policy bundle.
 */
export const BOOTSTRAP_VERSION = '1.12.0';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(entries).sort().map((key) => [key, canonicalize(entries[key])]),
    );
  }
  return value;
}

/**
 * Hashes all ABCA managed and inline execution policies. Sort object keys
 * recursively without dropping nested fields; preserve array ordering.
 */
export function computeBootstrapHash(): string {
  const policies = [
    ...allPolicies().map((policy) => policy.toJSON()),
    nestedStackExecutionPolicy(),
  ];
  const payload = JSON.stringify(canonicalize(policies));
  return createHash('sha256').update(payload).digest('hex');
}
