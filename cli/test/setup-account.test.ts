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

import { DEFAULT_STACK_NAME } from '../src/operator-context';
import {
  bootstrapNameProblem,
  BootstrapStack,
  planAccountPreparation,
  REQUIRED_BOOTSTRAP_VERSION,
  versionAtLeast,
} from '../src/setup-account';

const abcaBootstrap = (version: string, computeTypes?: string): BootstrapStack => ({
  outputs: new Map([['BootstrapPolicyVersion', version]]),
  parameters: new Map(computeTypes === undefined ? [] : [['ComputeTypes', computeTypes]]),
});
const OUTDATED = '0.0.1';
const NEWER = '999.0.0';

describe('planAccountPreparation', () => {
  test('installs the bootstrap in an account that has none', () => {
    expect(planAccountPreparation(null, ['agentcore']))
      .toEqual({ steps: ['bootstrap'], computeTypes: ['agentcore'], standardBootstrap: false });
  });

  test('keeps AgentCore allowed when a new bootstrap is installed for another backend', () => {
    expect(planAccountPreparation(null, ['ecs']))
      .toEqual({ steps: ['bootstrap', 'computeTypes'], computeTypes: ['agentcore', 'ecs'], standardBootstrap: false });
  });

  test('plans no change to a standard CDK bootstrap, whatever the compute', () => {
    const standard = { outputs: new Map([['BucketName', 'cdk-assets']]), parameters: new Map<string, string>() };
    expect(planAccountPreparation(standard, ['agentcore', 'ecs']))
      .toEqual({ steps: [], computeTypes: [], standardBootstrap: true });
  });

  test('needs nothing when the bootstrap is current and already allows the compute', () => {
    expect(planAccountPreparation(abcaBootstrap(REQUIRED_BOOTSTRAP_VERSION, 'agentcore,ecs'), ['ecs']))
      .toEqual({ steps: [], computeTypes: ['agentcore', 'ecs'], standardBootstrap: false });
  });

  test('updates an outdated bootstrap first, then allows the new backend', () => {
    expect(planAccountPreparation(abcaBootstrap(OUTDATED, 'agentcore'), ['agentcore', 'ecs']))
      .toEqual({ steps: ['rebootstrap', 'computeTypes'], computeTypes: ['agentcore', 'ecs'], standardBootstrap: false });
  });

  test('leaves a bootstrap newer than this CLI requires as it is', () => {
    expect(planAccountPreparation(abcaBootstrap(NEWER, 'agentcore'), ['agentcore']))
      .toEqual({ steps: [], computeTypes: ['agentcore'], standardBootstrap: false });
  });

  test('adds to the backends the bootstrap allows and drops none of them', () => {
    expect(planAccountPreparation(abcaBootstrap(REQUIRED_BOOTSTRAP_VERSION, 'agentcore, ecs'), ['agentcore', 'lambda-microvm']))
      .toEqual({ steps: ['computeTypes'], computeTypes: ['agentcore', 'ecs', 'lambda-microvm'], standardBootstrap: false });
  });

  test('reads a bootstrap without the ComputeTypes parameter as AgentCore only', () => {
    expect(planAccountPreparation(abcaBootstrap(REQUIRED_BOOTSTRAP_VERSION), ['agentcore']).steps).toEqual([]);
    expect(planAccountPreparation(abcaBootstrap(REQUIRED_BOOTSTRAP_VERSION), ['ecs']))
      .toEqual({ steps: ['computeTypes'], computeTypes: ['agentcore', 'ecs'], standardBootstrap: false });
  });

  test('reads an empty ComputeTypes parameter as no backend allowed', () => {
    expect(planAccountPreparation(abcaBootstrap(REQUIRED_BOOTSTRAP_VERSION, ''), ['agentcore']))
      .toEqual({ steps: ['computeTypes'], computeTypes: ['agentcore'], standardBootstrap: false });
  });
});

describe('versionAtLeast', () => {
  test.each([
    ['1.12.0', '1.12.0', true],
    ['1.12.1', '1.12.0', true],
    ['2.0.0', '1.12.0', true],
    ['1.9.0', '1.12.0', false],
    ['0.99.99', '1.0.0', false],
    ['1.12', '1.12.0', true],
    ['1.12', '1.12.1', false],
    ['1.12.1', '1.12', true],
    ['1.12.x', '1.12.0', true],
  ])('%s against a required %s: %s', (actual, required, expected) => {
    expect(versionAtLeast(actual, required)).toBe(expected);
  });
});

describe('bootstrapNameProblem', () => {
  test.each([DEFAULT_STACK_NAME, `${DEFAULT_STACK_NAME}-2`, `${DEFAULT_STACK_NAME}-team-b`])('accepts %s', (stackName) => {
    expect(bootstrapNameProblem(stackName)).toBeUndefined();
  });

  test('rejects any other name and suggests one the bootstrap covers', () => {
    expect(bootstrapNameProblem('Team-B')).toBe(
      "ABCA's least-privilege bootstrap only deploys stacks named backgroundagent-dev or backgroundagent-dev-<suffix>; "
      + 'try backgroundagent-dev-team-b.',
    );
  });

  test.each([
    `${DEFAULT_STACK_NAME}2`, `x-${DEFAULT_STACK_NAME}`, `my${DEFAULT_STACK_NAME}-b`,
  ])('rejects %s: containing the default name is not enough', (stackName) => {
    expect(bootstrapNameProblem(stackName)).toMatch(/only deploys stacks named/);
  });
});
