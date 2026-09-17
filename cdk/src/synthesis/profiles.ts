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

export type Compute = 'agentcore' | 'ecs' | 'lambda-microvm';
export type Image = 'none' | 'managed' | 'external';
export type Context = Readonly<Record<string, string | boolean | readonly string[]>>;

/** Structural profiles describe provisioned resources, not live backend readiness. */
export interface SynthesisProfile {
  readonly name: string;
  readonly context: Context;
  readonly microvmImageConfigured: boolean;
  readonly expectedError?: string;
}

export const FIXTURE = {
  account: '123456789012',
  region: 'us-east-1',
  zones: [
    { zoneName: 'us-east-1a', zoneId: 'use1-az2' },
    { zoneName: 'us-east-1b', zoneId: 'use1-az4' },
  ],
} as const;

/** CDK's own context lookup is separate from buildApp's injected AWS lookup functions. */
export const STRUCTURAL_CONTEXT: Context = {
  'aws:cdk:version-reporting': true,
  'aws:cdk:enable-path-metadata': true,
  'aws:cdk:asset-staging': false,
  [`availability-zones:account=${FIXTURE.account}:region=${FIXTURE.region}`]: FIXTURE.zones.map(zone => zone.zoneName),
};

const VAULT_MICROVM_ERROR = 'enableLinearIdentityVault cannot be combined with compute_type=lambda-microvm:';

function profile(compute: Compute, gateway: boolean, registry: boolean, vault: boolean, image: Image): SynthesisProfile {
  return {
    name: `${compute}-gw${+gateway}-reg${+registry}-vault${+vault}-${image}`,
    microvmImageConfigured: compute === 'lambda-microvm' && image !== 'none',
    ...(compute === 'lambda-microvm' && vault ? { expectedError: VAULT_MICROVM_ERROR } : {}),
    context: {
      stackName: 'backgroundagent-dev',
      blueprintRepo: 'awslabs/agent-plugins',
      bedrockGeoRegion: 'global',
      compute_type: compute,
      enableToolGateway: gateway,
      enableAgentRegistry: registry,
      enableLinearIdentityVault: vault,
      ...(image === 'managed' ? {
        microvm_base_image_arn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
        microvm_base_image_version: '1',
      } : {}),
      ...(image === 'external' ? {
        microvm_image_identifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:census-image',
        microvm_image_version: '1',
      } : {}),
    },
  };
}

/** One profile product shared by the CLI and its coverage assertions. */
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

  // Probe supplemental options together in the high-resource ECS profile too:
  // IAM policy overflow means their effects cannot be added to default counts.
  for (const base of [profile('agentcore', false, true, false, 'none'), profile('ecs', true, true, true, 'none')]) {
    profiles.push({
      ...base,
      name: `${base.name}-email-fork`,
      context: { ...base.context, alertEmail: 'census@example.com', forkBlueprintRepo: 'example/census-blueprints' },
    });
  }
  const externalConsent = profile('ecs', true, true, true, 'none');
  profiles.push({
    ...externalConsent,
    name: `${externalConsent.name}-external-consent`,
    context: { ...externalConsent.context, linearVaultHostedReturnUrl: 'https://example.com/consent' },
  });
  return profiles;
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
