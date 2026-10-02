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

/** Mirrored from cdk/src/handlers/shared/compute-backend.ts. */
export type OnboardComputeType = 'agentcore' | 'ecs' | 'lambda-microvm';

export interface ComputeDeployment {
  readonly stackName: string;
  readonly computeSubstrate: string | null | undefined;
  readonly computeDeploymentMode?: string | null;
  /** Complete ordered list; its first entry is the repository default. */
  readonly computeTypes?: string | null;
}

export interface ComputeDeploymentStatus {
  readonly stack_name: string;
  readonly compute_substrate: string | null;
  readonly compute_deployment_mode: string | null;
  readonly compute_types: readonly OnboardComputeType[] | null;
  readonly default_compute_type: OnboardComputeType;
}

/** Availability describes the deployment contract, not live backend health. */
export interface RepositoryComputeBinding {
  readonly compute_type: string;
  readonly compute_available: boolean;
  readonly configuration_error?: string;
}

/** Older deployments advertised optional backends as a comma-separated list. */
export function parseComputeSubstrateOutput(raw: string | null | undefined): readonly string[] | undefined {
  const values = raw?.split(',').map(value => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

type ComputeOutputs = Pick<ComputeDeployment, 'computeSubstrate' | 'computeDeploymentMode' | 'computeTypes'>;

/** Explicit outputs are authoritative; only stacks without them imply AgentCore. */
function declaredComputeTypes(deployment: ComputeOutputs): readonly OnboardComputeType[] | undefined {
  const mode = deployment.computeDeploymentMode;
  if (mode != null && mode !== 'exclusive' && mode !== 'additive') {
    throw new CliError(`Unknown ComputeDeploymentMode '${mode}'. Update the CLI or re-deploy the CDK stack.`);
  }
  if (deployment.computeTypes == null && mode == null) return undefined;
  const output = deployment.computeTypes != null ? 'ComputeTypes' : 'ComputeSubstrate';
  const raw = deployment.computeTypes ?? deployment.computeSubstrate;
  const values = raw?.split(',').map(value => value.trim());
  if (!values?.length || values.some(value => !['agentcore', 'ecs', 'lambda-microvm'].includes(value))
    || new Set(values).size !== values.length
    || (mode === 'exclusive' && values.length !== 1)
    || (mode === 'additive' && values.length < 2)) {
    throw new CliError(`Compute deployment has an invalid or missing ${output} output. Re-deploy the CDK stack.`);
  }
  if (deployment.computeTypes != null && deployment.computeSubstrate != null
    && values.join(',') !== deployment.computeSubstrate.split(',').map(value => value.trim()).join(',')) {
    throw new CliError('ComputeTypes and ComputeSubstrate outputs disagree. Re-deploy the CDK stack before changing repository configuration.');
  }
  return values as OnboardComputeType[];
}

export function defaultComputeType(deployment: ComputeOutputs): OnboardComputeType {
  return declaredComputeTypes(deployment)?.[0] ?? 'agentcore';
}

export function describeComputeDeployment(deployment: ComputeDeployment): ComputeDeploymentStatus {
  return {
    stack_name: deployment.stackName,
    compute_substrate: deployment.computeSubstrate ?? null,
    compute_deployment_mode: deployment.computeDeploymentMode ?? null,
    compute_types: declaredComputeTypes(deployment) ?? null,
    default_compute_type: defaultComputeType(deployment),
  };
}

function computeConfigurationError(args: ComputeDeployment & { computeType: string | undefined }): string | undefined {
  const declared = declaredComputeTypes(args);
  const selected = declared?.[0] ?? 'agentcore';
  const requested = args.computeType ?? selected;
  if (!['agentcore', 'ecs', 'lambda-microvm'].includes(requested)) {
    return `Unsupported repository compute_type '${requested}'. Choose agentcore, ecs or lambda-microvm.`;
  }
  if (declared) {
    if (declared.includes(requested as OnboardComputeType)) return;
    return `Stack '${args.stackName}' deploys only '${declared.join(', ')}' (ComputeSubstrate=${args.computeSubstrate}); --compute-type ${requested} is unavailable. Use --compute-type ${selected}, or add the backend with --context compute_types=${[...declared, requested].join(',')} and review the deployment change set.`;
  }
  const provisioned = parseComputeSubstrateOutput(args.computeSubstrate);
  if (requested === 'agentcore' || !provisioned || provisioned.includes(requested)) return;
  const label = requested === 'ecs' ? 'ECS' : 'Lambda MicroVMs';
  return `Stack '${args.stackName}' was deployed without the ${label} substrate (ComputeSubstrate=${args.computeSubstrate}), so a repo onboarded as --compute-type ${requested} would fail at session start. Redeploy the stack with --context compute_type=${requested} first, then re-run this — or onboard with --compute-type agentcore.`;
}

/** Report each stale pin without preventing inspection of other repositories. */
export function resolveRepositoryCompute(deployment: ComputeDeployment, computeType?: string): RepositoryComputeBinding {
  const configurationError = computeConfigurationError({ ...deployment, computeType });
  return {
    compute_type: computeType ?? defaultComputeType(deployment),
    compute_available: configurationError === undefined,
    ...(configurationError ? { configuration_error: configurationError } : {}),
  };
}

/** Reject incompatible repository pins before writing RepoTable or probing MicroVM availability. */
export function assertComputeSubstrateDeployed(args: ComputeDeployment & { computeType: string | undefined }): void {
  const configurationError = computeConfigurationError(args);
  if (configurationError) throw new CliError(configurationError);
}
