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

import {
  assertComputeSubstrateDeployed,
  defaultComputeType,
  describeComputeDeployment,
  parseComputeSubstrateOutput,
  resolveRepositoryCompute,
} from '../src/compute-substrate';
import { CliError } from '../src/errors';

const STACK = 'backgroundagent-dev';

function assertFor(computeType: 'agentcore' | 'ecs' | 'lambda-microvm' | undefined, substrate: string | null) {
  return () => assertComputeSubstrateDeployed({
    stackName: STACK,
    computeType,
    computeSubstrate: substrate,
  });
}

describe('parseComputeSubstrateOutput', () => {
  test.each([
    ['agentcore', ['agentcore']],
    ['ecs', ['ecs']],
    ['lambda-microvm', ['lambda-microvm']],
  ])('parses the single value %s from legacy or single-backend stacks', (raw, expected) => {
    expect(parseComputeSubstrateOutput(raw)).toEqual(expected);
  });

  test('parses complete comma-separated backend lists', () => {
    expect(parseComputeSubstrateOutput('ecs,lambda-microvm')).toEqual(['ecs', 'lambda-microvm']);
    expect(parseComputeSubstrateOutput(' ecs , lambda-microvm ')).toEqual(['ecs', 'lambda-microvm']);
  });

  test.each([[null], [undefined], [''], ['   '], [',']])(
    'reports %p as UNKNOWN (undefined), not as an empty substrate set',
    (raw) => {
      // Load-bearing distinction: "unknown" must not hard-block onboarding
      // against a stack deployed before the output existed.
      expect(parseComputeSubstrateOutput(raw)).toBeUndefined();
    },
  );
});

describe('assertComputeSubstrateDeployed with legacy outputs', () => {
  test('preserves the unconditional AgentCore backend of legacy stacks', () => {
    expect(assertFor('agentcore', 'agentcore')).not.toThrow();
    expect(assertFor('agentcore', 'ecs')).not.toThrow();
    expect(assertFor('agentcore', 'lambda-microvm')).not.toThrow();
  });

  test('never gates an unspecified compute type', () => {
    // The effective type may be inherited from the existing repo row, which this
    // function cannot see; `onboardRepo` resolves and probes that case.
    expect(assertFor(undefined, 'agentcore')).not.toThrow();
  });

  test.each([['ecs'], ['lambda-microvm']] as const)(
    'allows %s when the stack provisioned it',
    (computeType) => {
      expect(assertFor(computeType, computeType)).not.toThrow();
    },
  );

  test.each([['ecs'], ['lambda-microvm']] as const)(
    'allows %s when the output is absent (older stack → unknown)',
    (computeType) => {
      expect(assertFor(computeType, null)).not.toThrow();
    },
  );

  test('refuses ecs on an agentcore-only stack, naming the substrate and the remedy', () => {
    expect(assertFor('ecs', 'agentcore')).toThrow(CliError);
    expect(assertFor('ecs', 'agentcore')).toThrow(/without the ECS substrate/);
    expect(assertFor('ecs', 'agentcore')).toThrow(/ComputeSubstrate=agentcore/);
    expect(assertFor('ecs', 'agentcore')).toThrow(/--context compute_type=ecs/);
    expect(assertFor('ecs', 'agentcore')).toThrow(/--compute-type agentcore/);
  });

  test('refuses lambda-microvm on an agentcore-only stack, naming the substrate and the remedy', () => {
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(CliError);
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(/without the Lambda MicroVMs substrate/);
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(/ComputeSubstrate=agentcore/);
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(/--context compute_type=lambda-microvm/);
    // The MicroVM remedy is more specific than ECS's about WHERE it fails,
    // because the strategy's env-var guard fires before any AWS call.
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(/fail at session start/);
  });

  test('refuses an optional backend absent from the legacy output', () => {
    expect(assertFor('lambda-microvm', 'ecs')).toThrow(/without the Lambda MicroVMs substrate/);
    expect(assertFor('ecs', 'lambda-microvm')).toThrow(/without the ECS substrate/);
  });

  test('names the stack so an operator pointed at the wrong stack sees it', () => {
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(new RegExp(`'${STACK}'`));
  });

  test('allows each optional backend listed in ComputeSubstrate', () => {
    expect(assertFor('ecs', 'ecs,lambda-microvm')).not.toThrow();
    expect(assertFor('lambda-microvm', 'ecs,lambda-microvm')).not.toThrow();
  });
});

describe('exclusive backend output', () => {
  test.each(['agentcore', 'ecs', 'lambda-microvm'] as const)('inherits %s and rejects every other backend', backend => {
    const deployment = { stackName: 'test', computeSubstrate: backend, computeDeploymentMode: 'exclusive' };
    expect(() => assertComputeSubstrateDeployed({ ...deployment, computeType: undefined })).not.toThrow();
    for (const requested of ['agentcore', 'ecs', 'lambda-microvm'] as const) {
      const check = () => assertComputeSubstrateDeployed({ ...deployment, computeType: requested });
      if (requested === backend) expect(check).not.toThrow();
      else expect(check).toThrow(/deploys only/);
    }
  });
  test.each([null, '', 'ecs,lambda-microvm', 'unknown'])('rejects malformed exclusive output %p', computeSubstrate => {
    expect(() => assertComputeSubstrateDeployed({ stackName: 'test', computeSubstrate, computeDeploymentMode: 'exclusive', computeType: undefined })).toThrow(/invalid or missing/);
  });
});

describe('ordered ComputeTypes output', () => {
  const deployment = {
    stackName: STACK,
    computeTypes: 'lambda-microvm,ecs',
    computeSubstrate: 'lambda-microvm,ecs',
    computeDeploymentMode: 'additive',
  };

  test('inherits the first entry and enforces membership without assuming AgentCore', () => {
    expect(defaultComputeType(deployment)).toBe('lambda-microvm');
    expect(resolveRepositoryCompute(deployment)).toEqual({ compute_type: 'lambda-microvm', compute_available: true });
    expect(resolveRepositoryCompute(deployment, 'ecs')).toEqual({ compute_type: 'ecs', compute_available: true });
    expect(resolveRepositoryCompute(deployment, 'agentcore')).toMatchObject({
      compute_type: 'agentcore',
      compute_available: false,
      configuration_error: expect.stringContaining('compute_types=lambda-microvm,ecs,agentcore'),
    });
    expect(describeComputeDeployment(deployment)).toMatchObject({
      compute_types: ['lambda-microvm', 'ecs'],
      default_compute_type: 'lambda-microvm',
    });
  });

  test('supports the complete additive substrate output when ComputeTypes is absent', () => {
    expect(defaultComputeType({ ...deployment, computeTypes: null })).toBe('lambda-microvm');
    expect(resolveRepositoryCompute({ ...deployment, computeTypes: null }, 'agentcore').compute_available).toBe(false);
  });

  test.each(['', ' ', ',', 'ecs,', 'ecs,unknown', 'ecs,ecs'])('rejects malformed ComputeTypes %p', computeTypes => {
    expect(() => defaultComputeType({ ...deployment, computeTypes })).toThrow(/invalid or missing ComputeTypes/);
  });

  test('refuses contradictory outputs and an unknown deployment mode', () => {
    expect(() => defaultComputeType({ ...deployment, computeSubstrate: 'ecs' })).toThrow(/outputs disagree/);
    expect(() => defaultComputeType({ ...deployment, computeDeploymentMode: 'exclusive' })).toThrow(/invalid or missing/);
    expect(() => defaultComputeType({ ...deployment, computeTypes: 'ecs', computeSubstrate: 'ecs' })).toThrow(/invalid or missing/);
    expect(() => defaultComputeType({ ...deployment, computeDeploymentMode: 'unknown' })).toThrow(/Unknown ComputeDeploymentMode/);
  });
});
