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

/**
 * Semantic version of the bootstrap policy bundle.
 *
 * Bump history: 1.0.0 → 1.1.0 added the `compute-ecs` policy (#162), 1.1.0 →
 * 1.2.0 refreshed policies for a full deploy (#350), 1.2.0 → 1.3.0 added the
 * `compute-lambda-microvm` policy (#645 / ADR-021), 1.3.0 → 1.4.0 adds that
 * policy's `MicrovmPassRoles` statement (#645, ADR-021 P2r2-F9).
 *
 * On the 1.4.0 bump specifically: it is a *statement* addition, not a new policy,
 * and it is still a MINOR bump for the reason 1.2.0 was — **an operator must
 * re-bootstrap to pick it up**, and the version is the only signal that says so.
 * Without it the CDK-managed MicroVM image path fails at deploy with a caller-side
 * `iam:PassRole` AccessDenied on the build role (live-verified; see
 * `policies/compute-lambda-microvm.ts`), which is exactly the class of breakage a
 * patch-level bump would under-advertise. Adding a whole policy remains a minor
 * bump too — the precedent `compute-ecs` set.
 */
export const BOOTSTRAP_VERSION = '1.4.0';

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
