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

import { allPolicies } from './policies';

/** Semantic version of the bootstrap policy bundle. */
export const BOOTSTRAP_VERSION = '1.0.0';

/**
 * Computes a SHA-256 hash over all bootstrap policies.
 * The hash is deterministic: policies are serialized with sorted keys
 * so that object property ordering does not affect the digest.
 */
export function computeBootstrapHash(): string {
  const policies = allPolicies();
  const normalized = policies.map((p) => {
    const json = p.toJSON();
    return JSON.stringify(json, Object.keys(json).sort());
  });
  const payload = JSON.stringify(normalized);
  return createHash('sha256').update(payload).digest('hex');
}
