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

import { readdirSync } from 'node:fs';
import { App, AssetStaging, Stack } from 'aws-cdk-lib';
import { FIXTURE, STRUCTURAL_CONTEXT, synthesisEnvironment, synthesisProfiles } from '../../src/synthesis/profiles';

describe('structural synthesis profiles', () => {
  const profiles = synthesisProfiles();
  const matrix = profiles.filter(p => /-(none|managed|external)(-split)?$/.test(p.name));

  test.each(['legacy', 'prepare', 'adopt', 'managed'] as const)('measures the complete matrix in %s provisioning mode', mode => {
    const selected = synthesisProfiles(mode);
    expect(selected.map(profile => profile.name)).toEqual(profiles.map(profile => profile.name));
    expect(selected.every(profile => profile.context.blueprintProvisioning === mode)).toBe(true);
    expect(selected.map(profile => profile.expectedError)).toEqual(profiles.map(profile => profile.expectedError));
  });

  test.each(['inline', 'split'])('enumerates the real 40-cell product for the %s topology', topology => {
    const topologyMatrix = matrix.filter(profile => profile.context.networkTopology === topology);
    expect(matrix).toHaveLength(80);
    expect(topologyMatrix).toHaveLength(40);
    expect(profiles).toHaveLength(90);
    expect(new Set(profiles.map(p => p.name)).size).toBe(profiles.length);
    for (const compute of ['agentcore', 'ecs', 'lambda-microvm']) {
      for (const gateway of [false, true]) {
        for (const registry of [false, true]) {
          for (const vault of [false, true]) {
            const matches = topologyMatrix.filter(p =>
              p.context.compute_type === compute && p.context.enableToolGateway === gateway &&
              p.context.enableAgentRegistry === registry && p.context.enableLinearIdentityVault === vault,
            );
            expect(matches).toHaveLength(compute === 'lambda-microvm' ? 3 : 1);
          }
        }
      }
    }
  });

  test('expects all backend and optional-service combinations to synthesize', () => {
    expect(matrix.filter(p => p.expectedError)).toHaveLength(0);
  });

  test('distinguishes configured images from provisioning-only MicroVM profiles', () => {
    const microvm = matrix.filter(p => p.context.compute_type === 'lambda-microvm' && !p.expectedError);
    expect(microvm.filter(p => p.microvmImageConfigured)).toHaveLength(32);
    for (const p of matrix) {
      expect(p.microvmImageConfigured).toBe(!!(p.context.microvm_base_image_arn || p.context.microvm_image_identifier));
      expect(!!p.context.microvm_base_image_arn && !!p.context.microvm_image_identifier).toBe(false);
    }
  });

  test('satisfies the CDK availability-zone lookup from the same explicit fixture', () => {
    const app = new App({ autoSynth: false, postCliContext: STRUCTURAL_CONTEXT });
    const stack = new Stack(app, 'Fixture', { env: FIXTURE });
    expect(stack.availabilityZones).toEqual(FIXTURE.zones.map(zone => zone.zoneName));
    expect(app.synth().manifest.missing ?? []).toEqual([]);
  });

  test.each(['agentcore', 'ecs', 'lambda-microvm'])('exercises supplemental resources together on the widest %s profile', compute => {
    expect(profiles).toContainEqual(expect.objectContaining({
      context: expect.objectContaining({
        compute_type: compute,
        enableToolGateway: true,
        enableAgentRegistry: true,
        enableLinearIdentityVault: true,
        alertEmail: 'census@example.com',
        forkBlueprintRepo: 'example/census-blueprints',
      }),
    }));
    expect(profiles.some(p => p.context.linearVaultHostedReturnUrl)).toBe(true);
  });

  test('disables real CDK asset copying so a census does not duplicate dependency archives per profile', () => {
    const app = new App({ autoSynth: false, postCliContext: STRUCTURAL_CONTEXT });
    const stack = new Stack(app, 'AssetFixture');
    const asset = new AssetStaging(stack, 'Source', { sourcePath: __dirname });
    expect(asset.stagedPath).toBe(__dirname);
    expect(readdirSync(app.synth().directory).filter(name => name.startsWith('asset.'))).toEqual([]);
  });

  test('isolates worker configuration and credentials while keeping metadata/bundling explicit', () => {
    const environment = synthesisEnvironment({
      PATH: '/fixture/bin',
      TMPDIR: '/fixture/tmp',
      HOME: '/operator',
      BLUEPRINT_REPO: 'operator/override',
      FORK_BLUEPRINT_REPO: 'operator/fork',
      AWS_REGION: 'eu-west-1',
      AWS_PROFILE: 'production',
      AWS_ACCESS_KEY_ID: 'not-a-credential',
      CDK_CONTEXT_JSON: '{"compute_type":"ecs"}',
      CDK_DEFAULT_ACCOUNT: '999999999999',
      NODE_OPTIONS: '--require=unexpected.js',
    });
    expect(environment).toEqual({
      PATH: '/fixture/bin',
      TMPDIR: '/fixture/tmp',
      AWS_REGION: FIXTURE.region,
      AWS_EC2_METADATA_DISABLED: 'true',
      CDK_CONTEXT_JSON: '{"aws:cdk:bundling-stacks":[]}',
    });
    expect(synthesisEnvironment({})).not.toHaveProperty('PATH');
    expect(synthesisEnvironment({})).not.toHaveProperty('TMPDIR');
  });
});
