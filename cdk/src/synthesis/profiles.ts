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

import { DISABLE_ASSET_STAGING_CONTEXT } from 'aws-cdk-lib/cx-api';
import { AGENTCORE_AZS_CONTEXT_KEY } from '../constructs/agentcore-azs';
import {
  DEPLOYMENT_FEATURES, DEPLOYMENT_PROFILE_CONTEXT, DeploymentFeature, FEATURE_CONTEXT_KEYS,
} from '../deployment/features';
import { DEFAULT_BEDROCK_MODEL_IDS } from '../handlers/shared/bedrock-model-constants';

const EXTRA_MODEL_COUNT = 16;

type Compute = 'agentcore' | 'ecs' | 'lambda-microvm';
type Image = 'none' | 'managed' | 'external';
export type Context = Readonly<Record<string, string | boolean | readonly string[]>>;

/** Structural profiles describe provisioned resources, not live backend readiness. */
export interface SynthesisProfile {
  readonly name: string;
  readonly context: Context;
  readonly microvmImageConfigured: boolean;
  /** An error prefix or the specific resource ceiling that must reject this profile. */
  readonly expectedError?: string | { readonly stackName: string; readonly resourceLimit: number };
}

export const FIXTURE = {
  account: '123456789012',
  region: 'us-east-1',
  zones: [
    { zoneName: 'us-east-1a', zoneId: 'use1-az2' },
    { zoneName: 'us-east-1b', zoneId: 'use1-az4' },
    { zoneName: 'us-east-1c', zoneId: 'use1-az1' },
  ],
} as const;

/** CDK's own context lookup is separate from buildApp's injected AWS lookup functions. */
export const STRUCTURAL_CONTEXT: Context = {
  'aws:cdk:version-reporting': true,
  'aws:cdk:enable-path-metadata': true,
  [DISABLE_ASSET_STAGING_CONTEXT]: true,
  [DEPLOYMENT_PROFILE_CONTEXT]: 'none',
  [`availability-zones:account=${FIXTURE.account}:region=${FIXTURE.region}`]: FIXTURE.zones.map(zone => zone.zoneName),
};

const CENSUS_ARTIFACT_SHA256 = 'a'.repeat(64); // eslint-disable-line @typescript-eslint/no-magic-numbers

function profile(compute: Compute, gateway: boolean, registry: boolean, vault: boolean, image: Image): SynthesisProfile {
  return {
    name: `${compute}-gw${+gateway}-reg${+registry}-vault${+vault}-${image}`,
    microvmImageConfigured: compute === 'lambda-microvm' && image !== 'none',
    context: {
      stackName: 'backgroundagent-dev',
      networkTopology: 'inline',
      blueprintRepo: 'awslabs/agent-plugins',
      bedrockGeoRegion: 'global',
      compute_types: compute,
      enableToolGateway: gateway,
      enableAgentRegistry: registry,
      enableLinearIdentityVault: vault,
      microvm_nested_stack: true,
      ...(image === 'managed' ? {
        microvm_base_image_arn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
        microvm_base_image_version: '1',
        microvm_artifact_sha256: CENSUS_ARTIFACT_SHA256,
      } : {}),
      ...(image === 'external' ? {
        microvm_image_identifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:census-image',
        microvm_image_version: '1',
      } : {}),
    },
  };
}

export function synthesisProfiles(): readonly SynthesisProfile[] {
  const profiles: SynthesisProfile[] = [];
  for (const compute of ['agentcore', 'ecs', 'lambda-microvm'] as const) {
    for (const gateway of [false, true]) {
      for (const registry of [true, false]) {
        for (const vault of [false, true]) {
          const images: readonly Image[] = compute === 'lambda-microvm' ? ['none', 'managed', 'external'] : ['none'];
          for (const image of images) profiles.push(profile(compute, gateway, registry, vault, image));
        }
      }
    }
  }

  const supplemental: SynthesisProfile[] = [
    profile('agentcore', false, true, false, 'none'),
    profile('agentcore', true, true, true, 'none'),
    profile('ecs', true, true, true, 'none'),
    profile('lambda-microvm', true, true, true, 'managed'),
  ].map(base => ({
    ...base,
    name: `${base.name}-email-fork`,
    context: {
      ...base.context,
      alertEmail: 'census@example.com',
      forkBlueprintRepo: 'example/census-blueprints',
      enableLinearAgentSessions: true,
    },
  }));
  profiles.push(...supplemental);
  const externalConsent = profile('ecs', true, true, true, 'none');
  profiles.push({
    ...externalConsent,
    name: `${externalConsent.name}-external-consent`,
    context: { ...externalConsent.context, linearVaultHostedReturnUrl: 'https://example.com/consent' },
  });
  const topologies: SynthesisProfile[] = [...profiles, ...profiles.map(candidate => ({
    ...candidate,
    name: `${candidate.name}-split`,
    context: { ...candidate.context, networkTopology: 'split' },
  }))];
  for (const base of supplemental.filter(candidate => candidate.context.enableToolGateway)) {
    for (const networkTopology of ['inline', 'split'] as const) {
      topologies.push({
        ...base,
        name: `${base.name}-az3${networkTopology === 'split' ? '-split' : ''}`,
        context: {
          ...base.context,
          networkTopology,
          [AGENTCORE_AZS_CONTEXT_KEY]: FIXTURE.zones.map(zone => zone.zoneName),
        },
      });
    }
  }
  const expandedModels = [
    ...DEFAULT_BEDROCK_MODEL_IDS,
    ...Array.from({ length: EXTRA_MODEL_COUNT }, (_, index) => `anthropic.claude-census-${index}-v1:0`),
  ];
  for (const base of supplemental.filter(candidate => candidate.context.enableToolGateway)) {
    for (const networkTopology of ['inline', 'split'] as const) {
      topologies.push({
        ...base,
        name: `${base.name}-expanded-models${networkTopology === 'split' ? '-split' : ''}`,
        context: { ...base.context, networkTopology, bedrockModels: expandedModels },
      });
    }
  }
  const additive: Array<readonly Compute[]> = [
    ['agentcore', 'lambda-microvm'], ['agentcore', 'ecs'], ['ecs', 'lambda-microvm'],
    ['agentcore', 'ecs', 'lambda-microvm'],
  ];
  for (const backends of additive) {
    for (const wide of [false, true]) {
      const microvm = backends.includes('lambda-microvm');
      const base = profile(microvm ? 'lambda-microvm' : backends[backends.length - 1], wide, true, wide, microvm ? 'managed' : 'none');
      for (const networkTopology of ['inline', 'split'] as const) {
        topologies.push({
          ...base,
          name: `additive-${backends.join('+')}-${wide ? 'widest' : 'default'}-${networkTopology}`,
          context: {
            ...base.context,
            compute_types: backends.join(','),
            networkTopology,
            ...(wide ? { alertEmail: 'census@example.com', forkBlueprintRepo: 'example/census-blueprints' } : {}),
          },
        });
      }
    }
  }
  for (const compute of ['ecs', 'lambda-microvm'] as const) {
    const base = profile(compute, false, true, false, compute === 'lambda-microvm' ? 'managed' : 'none');
    const { compute_types: _explicit, ...context } = base.context;
    for (const networkTopology of ['inline', 'split'] as const) {
      topologies.push({
        ...base,
        name: `legacy-${compute}-${networkTopology}`,
        context: { ...context, compute_type: compute, networkTopology },
      });
    }
  }
  const featureSets: ReadonlyArray<readonly [string, readonly DeploymentFeature[]]> = [
    ['minimal', []],
    ...DEPLOYMENT_FEATURES.map(feature => [feature, [feature]] as const),
    ['linear+jira', ['linear', 'jira']],
    ['linear+deployPreviewScreenshots', ['linear', 'deployPreviewScreenshots']],
    ['all', DEPLOYMENT_FEATURES],
  ];
  for (const [label, selected] of featureSets) {
    const base = profile('agentcore', false, false, false, 'none');
    const switches = Object.fromEntries(DEPLOYMENT_FEATURES.map(feature =>
      [FEATURE_CONTEXT_KEYS[feature], selected.includes(feature)]));
    for (const networkTopology of ['inline', 'split'] as const) {
      topologies.push({
        ...base,
        name: `features-${label}-${networkTopology}`,
        context: { ...base.context, ...switches, networkTopology },
      });
    }
  }
  return topologies;
}

/** Never inherit deploy context, credentials, NODE_OPTIONS, or blueprint overrides. */
export function synthesisEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(parent.PATH ? { PATH: parent.PATH } : {}),
    ...(parent.TMPDIR ? { TMPDIR: parent.TMPDIR } : {}),
    AWS_REGION: FIXTURE.region,
    AWS_EC2_METADATA_DISABLED: 'true',
    CDK_CONTEXT_JSON: JSON.stringify({ 'aws:cdk:bundling-stacks': [] }),
  };
}
