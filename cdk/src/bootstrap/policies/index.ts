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

import { aws_iam as iam } from 'aws-cdk-lib';

import { applicationPolicy } from './application';
import { computeAgentcorePolicy } from './compute-agentcore';
import { computeEcsPolicy } from './compute-ecs';
import { infrastructurePolicy } from './infrastructure';
import { observabilityPolicy } from './observability';
import { getRequiredBootstrapPolicies } from '../required-policies';

export { applicationPolicy } from './application';
export { computeAgentcorePolicy } from './compute-agentcore';
export { computeEcsPolicy } from './compute-ecs';
export { infrastructurePolicy } from './infrastructure';
export { observabilityPolicy } from './observability';

/**
 * Returns all bootstrap IAM PolicyDocuments as an array.
 *
 * This is the UNION of every variant. Validating an app against it answers
 * "could some bootstrap configuration allow this?", not "does THIS deploy's
 * bootstrap allow it" — so prefer {@link policiesForComputeType} when the
 * compute substrate is known. See RFC #120's sufficiency model
 * (`deployed PolicySet ⊇ the app's required set`).
 */
export function allPolicies(): iam.PolicyDocument[] {
  return [
    infrastructurePolicy(),
    applicationPolicy(),
    observabilityPolicy(),
    computeAgentcorePolicy(),
    computeEcsPolicy(),
  ];
}

/** Policy documents keyed by the artifact name emitted under `cdk/bootstrap/policies/`. */
const POLICY_BY_NAME: Record<string, () => iam.PolicyDocument> = {
  'infrastructure': infrastructurePolicy,
  'application': applicationPolicy,
  'observability': observabilityPolicy,
  'compute-agentcore': computeAgentcorePolicy,
  'compute-ecs': computeEcsPolicy,
};

/**
 * The PolicyDocuments an operator actually deploys for ``computeType``.
 *
 * An agentcore-only operator never deploys `compute-ecs`, so validating their
 * app against {@link allPolicies} silently accepts `ecs:*` actions their real
 * IaCRole cannot perform — the over-permissive direction this map exists to
 * catch. Resolves names through {@link getRequiredBootstrapPolicies} so the
 * selection and the generated artifacts cannot drift.
 */
export function policiesForComputeType(computeType: string): iam.PolicyDocument[] {
  return getRequiredBootstrapPolicies(computeType).map((name) => {
    const factory = POLICY_BY_NAME[name];
    if (!factory) {
      // Fail loud: a name with no document means the selection list and this
      // registry have drifted, which would silently under-scope validation.
      throw new Error(
        `No bootstrap policy document registered for '${name}'. `
        + `Known: ${Object.keys(POLICY_BY_NAME).join(', ')}.`,
      );
    }
    return factory();
  });
}
