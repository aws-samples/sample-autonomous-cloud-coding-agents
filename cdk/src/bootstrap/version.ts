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
 *
 * Bump history: 1.0.0 → 1.1.0 added the `compute-ecs` policy (#162), 1.1.0 →
 * 1.2.0 refreshed policies for a full deploy (#350), 1.2.0 → 1.3.0 added the
 * `compute-lambda-microvm` policy (#645 / ADR-021), 1.3.0 → 1.4.0 granted SNS
 * topic + customer-managed-KMS-key create/lifecycle for the OperationalAlerts
 * notification channel (#629), 1.4.0 → 1.5.0 added the agent asset registry
 * policies (#246: Step Functions, Cognito group, and CloudFormation
 * nested-stack actions — the registry's own control-plane calls run under the
 * custom resource's Lambda execution role), 1.5.0 → 1.6.0 adds the
 * `compute-lambda-microvm` policy's `MicrovmPassRoles` statement (#645, ADR-021
 * P2r2-F9). Adding policies to the bundle is a minor bump — that is the
 * precedent `compute-ecs` set.
 *
 * On the 1.6.0 bump specifically: it is a *statement* addition, not a new policy,
 * and it is still a MINOR bump for the reason 1.2.0 was — **an operator must
 * re-bootstrap to pick it up**, and the version is the only signal that says so.
 * Without it the CDK-managed MicroVM image path fails at deploy with a caller-side
 * `iam:PassRole` AccessDenied on the build role (live-verified; see
 * `policies/compute-lambda-microvm.ts`), which is exactly the class of breakage a
 * patch-level bump would under-advertise.
 *
 * The 1.6.0 release was not 1.4.0 because #629 and #246 landed on `main` first and took
 * 1.4.0 and 1.5.0 in the interim. The number is an operator-visible contract (the
 * `CDKToolkit` stack's `BootstrapPolicyVersion` output), so re-using a published
 * version would make two different bundles indistinguishable to the `>=` check
 * operators are told to run.
 *
 * 1.6.0 → 1.7.0 adds an exact-self, CloudFormation-only PassRole inline policy
 * for nested stacks (#645 clean deployment). The policy hash now includes that
 * inline policy and every nested JSON field; the old root-key replacer omitted
 * Action/Resource/Condition changes from its input.
 *
 * 1.7.0 → 1.8.0 adds scoped SSM parameter lifecycle/tag permissions for the P3
 * MicroVM suspension switch. Re-bootstrap before deploying the live parameter.
 */
export const BOOTSTRAP_VERSION = '1.8.0';

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
