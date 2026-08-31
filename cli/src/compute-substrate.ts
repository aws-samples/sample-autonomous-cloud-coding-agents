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

import { CliError } from './errors';

/** Per-repo compute backend, mirrored from `cdk/src/handlers/shared/repo-config.ts`. */
export type OnboardComputeType = 'agentcore' | 'ecs' | 'lambda-microvm';

/**
 * Parse the stack's `ComputeSubstrate` output into the set of OPTIONAL substrates
 * the deploy provisioned.
 *
 * ## What the output actually contains today: ONE value
 *
 * `cdk/src/stacks/agent.ts` emits
 * `ecsCluster ? 'ecs' : (lambdaMicrovm ? 'lambda-microvm' : 'agentcore')`, and both
 * constructs are gated on the SAME single-valued `compute_type` deploy context
 * (`--context compute_type=…`). So the two optional backends are **mutually
 * exclusive today** — a mixed `ecs` + `lambda-microvm` deploy is not
 * expressible, which is why that ternary can never have to arbitrate, and why
 * the CDK test asserts "does NOT provision the ECS substrate (the gates are
 * mutually exclusive)" on a MicroVM stack.
 *
 * The three reachable values are therefore:
 *
 * | Output | Substrates available to tasks |
 * |---|---|
 * | `agentcore` | AgentCore only |
 * | `ecs` | AgentCore **and** ECS (the optional backends are additive) |
 * | `lambda-microvm` | AgentCore **and** Lambda MicroVMs |
 *
 * ## Why this parses a LIST anyway
 *
 * ADR-021 sub-decision 4 explicitly flags the single-value tag as "already
 * imprecise with two backends, wrong with three" and names a `compute_types` list
 * as the intended follow-up. If that lands, a stack would emit
 * `ecs,lambda-microvm` — and an `!== 'ecs'` equality check would then start
 * REFUSING valid onboardings, silently, in the safe-looking direction. Splitting
 * on commas makes that future value work correctly with no change here, while
 * being byte-identical in behaviour for the single values above.
 *
 * @param raw - the raw `ComputeSubstrate` output value, or null when absent.
 * @returns the provisioned substrate names, or `undefined` when the output is
 *   missing/blank (an older stack predating the output — "unknown", not "none").
 */
export function parseComputeSubstrateOutput(
  raw: string | null | undefined,
): readonly string[] | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

/** Backend-specific remedy copy for {@link assertComputeSubstrateDeployed}. */
const SUBSTRATE_REMEDIES: Record<Exclude<OnboardComputeType, 'agentcore'>, {
  readonly label: string;
  readonly context: string;
  readonly adds: string;
  readonly runtimeFailure: string;
}> = {
  'ecs': {
    label: 'ECS',
    context: '`--context compute_type=ecs`',
    adds: 'adds the Fargate substrate alongside AgentCore',
    runtimeFailure: 'fail at task start',
  },
  'lambda-microvm': {
    label: 'Lambda MicroVMs',
    context: '`--context compute_type=lambda-microvm`',
    adds: 'adds the Lambda MicroVMs substrate alongside AgentCore',
    // More specific than the ECS wording because the MicroVM failure surfaces
    // later and less legibly: the strategy's own env-var guard fires first if no
    // image is configured, and otherwise RunMicrovm rejects the call.
    runtimeFailure: 'fail at session start (no MICROVM_* configuration on the orchestrator)',
  },
};

/**
 * Refuse to onboard a repo onto a compute backend the deployed stack never
 * provisioned.
 *
 * Without this the row is written happily and every task on that repo dies at
 * session start — for `ecs` with "ECS compute strategy requires ECS_CLUSTER_ARN…",
 * for `lambda-microvm` with the strategy's "deployed without the Lambda MicroVMs
 * substrate" error (or, if an image somehow IS configured, a `RunMicrovm`
 * rejection). Catching it here turns a per-task runtime failure into one
 * config-time message with a fixable remedy.
 *
 * Two deliberate non-strictnesses, both carried over from the original ECS check:
 *
 *  - **`agentcore` is never gated.** The AgentCore runtime is unconditional; the
 *    other two backends are additive on top of it.
 *  - **An absent output means "unknown", not "none".** Stacks deployed before
 *    `ComputeSubstrate` existed return null, and hard-blocking there would break
 *    onboarding against a perfectly good older deploy. The runtime error remains
 *    the backstop in that case.
 *
 * @param args.stackName - stack the outputs were read from, for the message.
 * @param args.computeType - the backend the operator asked for.
 * @param args.computeSubstrate - raw `ComputeSubstrate` stack output (or null).
 * @throws CliError when the requested backend is definitely not deployed.
 */
export function assertComputeSubstrateDeployed(args: {
  stackName: string;
  computeType: OnboardComputeType | undefined;
  computeSubstrate: string | null | undefined;
}): void {
  const { stackName, computeType, computeSubstrate } = args;
  if (!computeType || computeType === 'agentcore') {
    return;
  }

  const provisioned = parseComputeSubstrateOutput(computeSubstrate);
  if (!provisioned || provisioned.includes(computeType)) {
    return;
  }

  const remedy = SUBSTRATE_REMEDIES[computeType];
  throw new CliError(
    `Stack '${stackName}' was deployed without the ${remedy.label} substrate `
    + `(ComputeSubstrate=${computeSubstrate}), so a repo onboarded as --compute-type ${computeType} `
    + `would ${remedy.runtimeFailure}. Redeploy the stack with ${remedy.context} first `
    + `(${remedy.adds}), then re-run this — or onboard with --compute-type agentcore.`,
  );
}
