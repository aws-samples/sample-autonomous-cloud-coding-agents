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
  parseComputeSubstrateOutput,
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
  ])('parses the single value %s that the stack emits today', (raw, expected) => {
    expect(parseComputeSubstrateOutput(raw)).toEqual(expected);
  });

  test('tolerates a comma list, so a future compute_types output cannot silently over-refuse', () => {
    // ADR-021 sub-decision 4 names a `compute_types` list as the intended
    // follow-up to the single-valued tag. An `!== 'ecs'` equality check would
    // start rejecting valid onboardings the day that lands.
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

describe('assertComputeSubstrateDeployed', () => {
  test('never gates agentcore — the runtime is unconditional', () => {
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
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(/MICROVM_\*/);
  });

  test('refuses each optional backend on the OTHER one (they are mutually exclusive today)', () => {
    expect(assertFor('lambda-microvm', 'ecs')).toThrow(/without the Lambda MicroVMs substrate/);
    expect(assertFor('ecs', 'lambda-microvm')).toThrow(/without the ECS substrate/);
  });

  test('names the stack so an operator pointed at the wrong stack sees it', () => {
    expect(assertFor('lambda-microvm', 'agentcore')).toThrow(new RegExp(`'${STACK}'`));
  });

  test('allows both optional backends against a hypothetical multi-substrate output', () => {
    // Behavioural proof of the list tolerance above: this must NOT throw, or the
    // `compute_types` follow-up would break onboarding for both backends.
    expect(assertFor('ecs', 'ecs,lambda-microvm')).not.toThrow();
    expect(assertFor('lambda-microvm', 'ecs,lambda-microvm')).not.toThrow();
  });
});
