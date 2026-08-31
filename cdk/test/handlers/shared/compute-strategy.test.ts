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

jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeAgentRuntimeCommand: jest.fn(),
  StopRuntimeSessionCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn(() => ({ send: jest.fn() })),
  RunTaskCommand: jest.fn(),
  DescribeTasksCommand: jest.fn(),
  StopTaskCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: jest.fn() })),
  RunMicrovmCommand: jest.fn(),
  GetMicrovmCommand: jest.fn(),
  TerminateMicrovmCommand: jest.fn(),
  MicrovmState: {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    SUSPENDED: 'SUSPENDED',
    SUSPENDING: 'SUSPENDING',
    TERMINATED: 'TERMINATED',
    TERMINATING: 'TERMINATING',
  },
}));

import { resolveComputeStrategy } from '../../../src/handlers/shared/compute-strategy';
import type { ComputeType } from '../../../src/handlers/shared/repo-config';
import { AgentCoreComputeStrategy } from '../../../src/handlers/shared/strategies/agentcore-strategy';
import { EcsComputeStrategy } from '../../../src/handlers/shared/strategies/ecs-strategy';
import { LambdaMicrovmComputeStrategy } from '../../../src/handlers/shared/strategies/lambda-microvm-strategy';

describe('resolveComputeStrategy', () => {
  test('returns AgentCoreComputeStrategy for compute_type agentcore', () => {
    const strategy = resolveComputeStrategy({
      compute_type: 'agentcore',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
    });
    expect(strategy).toBeInstanceOf(AgentCoreComputeStrategy);
    expect(strategy.type).toBe('agentcore');
  });

  test('returns EcsComputeStrategy for compute_type ecs', () => {
    const strategy = resolveComputeStrategy({
      compute_type: 'ecs',
      runtime_arn: 'arn:test',
    });
    expect(strategy).toBeInstanceOf(EcsComputeStrategy);
    expect(strategy.type).toBe('ecs');
  });

  test('returns LambdaMicrovmComputeStrategy for compute_type lambda-microvm', () => {
    const strategy = resolveComputeStrategy({
      compute_type: 'lambda-microvm',
      runtime_arn: 'arn:test',
    });
    expect(strategy).toBeInstanceOf(LambdaMicrovmComputeStrategy);
    expect(strategy.type).toBe('lambda-microvm');
  });

  test('throws a named error for an unknown compute_type (exhaustive-never default)', () => {
    expect(() =>
      resolveComputeStrategy({
        // Cast past the exhaustive union to exercise the runtime default arm —
        // a hand-edited RepoTable row can carry a value the type system forbids.
        compute_type: 'quantum-annealer' as ComputeType,
        runtime_arn: 'arn:test',
      }),
    ).toThrow("Unknown compute_type: 'quantum-annealer'");
  });

  test('every ComputeType member resolves to a strategy whose type field round-trips', () => {
    // Guards the pairing itself: a new backend added to ComputeType but wired to
    // the wrong class would still be instanceof-correct in the tests above.
    const all: ComputeType[] = ['agentcore', 'ecs', 'lambda-microvm'];
    for (const computeType of all) {
      const strategy = resolveComputeStrategy({ compute_type: computeType, runtime_arn: 'arn:test' });
      expect(strategy.type).toBe(computeType);
    }
  });
});
