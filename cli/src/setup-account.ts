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

/** Account preparation for `bgagent setup`. Decisions only; the wizard carries them out. */

import type { ComputeBackend } from './deployment-profile';
import { DEFAULT_STACK_NAME } from './operator-context';

/**
 * Minimum ABCA bootstrap bundle this CLI deploys against. Mirrors
 * `BOOTSTRAP_VERSION` in `cdk/src/bootstrap/version.ts` (parity-tested).
 */
export const REQUIRED_BOOTSTRAP_VERSION = '1.12.0';

/** ABCA's least-privilege bootstrap scopes its deploy role to these names (cdk/src/bootstrap/policies/*). */
const BOOTSTRAP_STACK_NAME_PATTERN = new RegExp(`^${DEFAULT_STACK_NAME}(-[A-Za-z0-9-]+)?$`);

/** One-time account changes a deploy needs, in execution order. */
export type AccountPreparation = 'bootstrap' | 'rebootstrap' | 'computeTypes';

/** What the plan reads from the bootstrap stack (`CDKToolkit`). */
export interface BootstrapStack {
  readonly outputs: ReadonlyMap<string, string>;
  readonly parameters: ReadonlyMap<string, string>;
}

export function versionAtLeast(actual: string, required: string): boolean {
  const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
  const [a, r] = [parse(actual), parse(required)];
  for (let index = 0; index < Math.max(a.length, r.length); index += 1) {
    if ((a[index] ?? 0) !== (r[index] ?? 0)) return (a[index] ?? 0) > (r[index] ?? 0);
  }
  return true;
}

/**
 * What the account needs before ABCA can deploy. A standard CDK bootstrap (no
 * ABCA policy outputs) is shared with other apps and is never modified.
 */
export function planAccountPreparation(
  bootstrap: BootstrapStack | null,
  compute: readonly ComputeBackend[],
): { steps: AccountPreparation[]; computeTypes: ComputeBackend[]; standardBootstrap: boolean } {
  if (!bootstrap) {
    // AgentCore stays in the list: Memory and the Gateway are AgentCore resources on every backend.
    const computeTypes = [...new Set<ComputeBackend>(['agentcore', ...compute])];
    return { steps: computeTypes.length > 1 ? ['bootstrap', 'computeTypes'] : ['bootstrap'], computeTypes, standardBootstrap: false };
  }
  const policyVersion = bootstrap.outputs.get('BootstrapPolicyVersion');
  if (policyVersion === undefined) return { steps: [], computeTypes: [], standardBootstrap: true };
  const steps: AccountPreparation[] = versionAtLeast(policyVersion, REQUIRED_BOOTSTRAP_VERSION) ? [] : ['rebootstrap'];
  const configured = (bootstrap.parameters.get('ComputeTypes') ?? 'agentcore').split(',').map(value => value.trim()).filter(Boolean);
  const computeTypes = [...new Set([...configured, ...compute])] as ComputeBackend[];
  if (computeTypes.length !== configured.length) steps.push('computeTypes');
  return { steps, computeTypes, standardBootstrap: false };
}

/** Why ABCA's least-privilege bootstrap cannot deploy `stackName`, or `undefined` when it can. */
export function bootstrapNameProblem(stackName: string): string | undefined {
  if (BOOTSTRAP_STACK_NAME_PATTERN.test(stackName)) return undefined;
  return `ABCA's least-privilege bootstrap only deploys stacks named ${DEFAULT_STACK_NAME} or ${DEFAULT_STACK_NAME}-<suffix>; `
    + `try ${DEFAULT_STACK_NAME}-${stackName.toLowerCase()}.`;
}
