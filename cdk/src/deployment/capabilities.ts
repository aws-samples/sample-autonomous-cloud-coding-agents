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

import { Token } from 'aws-cdk-lib';
import { DeploymentFeature, DeploymentFeatures, enabledFeatures } from './features';
import catalog from '../../../contracts/deployment-capabilities.json';

/** Region data for one capability; `regions` absent means no constraint beyond core. */
export interface Capability {
  readonly label: string;
  readonly requiredServices: readonly string[];
  readonly regions?: readonly string[];
  readonly remediation: string;
}

export interface FeatureCapability extends Capability {
  readonly description: string;
  readonly maturity: 'stable' | 'experimental';
  /** Approximate root-stack resources; checked against synthesis by the census tests. */
  readonly approximateResources: number;
  /** Disabling deletes data (tables, secrets, registry records). */
  readonly stateful: boolean;
}

export interface CapabilityCatalog {
  readonly schemaVersion: number;
  readonly lastVerified: string;
  readonly source: string;
  readonly core: Capability;
  readonly features: Readonly<Record<DeploymentFeature, FeatureCapability>>;
}

/** Single source shared with the CLI mirror (`cli/src/deployment-capabilities.ts`). */
export const CAPABILITY_CATALOG = catalog as CapabilityCatalog;

function supports(capability: Capability, region: string): boolean {
  return capability.regions === undefined || capability.regions.includes(region);
}

/** Region-specific errors for core and every enabled feature; empty when deployable. */
export function capabilityViolations(
  features: DeploymentFeatures,
  region: string,
  source: CapabilityCatalog = CAPABILITY_CATALOG,
): string[] {
  const violations: string[] = [];
  const describe = (capability: Capability): string =>
    `${capability.label} is not available in ${region} (requires ${capability.requiredServices.join(', ')}; `
    + `supported: ${capability.regions?.join(', ')}). ${capability.remediation}`;
  if (!supports(source.core, region)) violations.push(describe(source.core));
  for (const feature of enabledFeatures(features)) {
    const capability = source.features[feature];
    if (!supports(capability, region)) violations.push(`${describe(capability)} (feature '${feature}')`);
  }
  return violations;
}

/**
 * Fail synthesis for an unsupported concrete Region instead of a late,
 * opaque CloudFormation error. Environment-agnostic synthesis cannot know the
 * Region and is left to the deploy-time service checks.
 */
export function assertCapabilitiesAvailable(features: DeploymentFeatures, region: string | undefined): void {
  if (region === undefined || Token.isUnresolved(region)) return;
  const violations = capabilityViolations(features, region);
  if (violations.length > 0) {
    throw new Error(
      `Deployment profile is not deployable in ${region}:\n- ${violations.join('\n- ')}\n`
      + `Regional data verified ${CAPABILITY_CATALOG.lastVerified} against ${CAPABILITY_CATALOG.source}; `
      + 'see docs/guides/DEPLOYMENT_GUIDE.md#deployment-profiles to update it.',
    );
  }
}
