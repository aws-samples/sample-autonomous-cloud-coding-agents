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
}

export interface ComputeDeploymentStatus {
  readonly stack_name: string;
  readonly compute_substrate: string | null;
  readonly compute_deployment_mode: string | null;
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

/** Explicit mode distinguishes exclusive deployments from existing additive stacks. */
export function defaultComputeType(deployment: Pick<ComputeDeployment, 'computeSubstrate' | 'computeDeploymentMode'>): OnboardComputeType {
  if (deployment.computeDeploymentMode !== 'exclusive') return 'agentcore';
  const value = deployment.computeSubstrate;
  if (value === 'agentcore' || value === 'ecs' || value === 'lambda-microvm') return value;
  throw new CliError('Exclusive compute deployment has an invalid or missing ComputeSubstrate output. Re-deploy the CDK stack.');
}

export function describeComputeDeployment(deployment: ComputeDeployment): ComputeDeploymentStatus {
  return {
    stack_name: deployment.stackName,
    compute_substrate: deployment.computeSubstrate ?? null,
    compute_deployment_mode: deployment.computeDeploymentMode ?? null,
    default_compute_type: defaultComputeType(deployment),
  };
}

function computeConfigurationError(args: ComputeDeployment & { computeType: string | undefined }): string | undefined {
  const selected = defaultComputeType(args);
  const requested = args.computeType ?? selected;
  if (!['agentcore', 'ecs', 'lambda-microvm'].includes(requested)) {
    return `Unsupported repository compute_type '${requested}'. Choose agentcore, ecs or lambda-microvm.`;
  }
  if (args.computeDeploymentMode === 'exclusive') {
    if (requested === selected) return;
    return `Stack '${args.stackName}' deploys only '${selected}' (ComputeSubstrate=${args.computeSubstrate}); --compute-type ${requested} is unavailable. Use --compute-type ${selected}, or drain tasks and redeploy with --context compute_type=${requested}.`;
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
