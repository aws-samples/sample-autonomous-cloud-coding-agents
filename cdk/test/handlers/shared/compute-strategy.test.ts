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

import { resolveComputeStrategy } from '../../../src/handlers/shared/compute-strategy';
import { AgentCoreComputeStrategy } from '../../../src/handlers/shared/strategies/agentcore-strategy';

describe('resolveComputeStrategy', () => {
  test('returns AgentCoreComputeStrategy for compute_type agentcore', () => {
    const strategy = resolveComputeStrategy({
      compute_type: 'agentcore',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
    });
    expect(strategy).toBeInstanceOf(AgentCoreComputeStrategy);
    expect(strategy.type).toBe('agentcore');
  });

  test("throws 'not yet implemented' for compute_type ecs", () => {
    expect(() =>
      resolveComputeStrategy({
        compute_type: 'ecs',
        runtime_arn: 'arn:test',
      }),
    ).toThrow("compute_type 'ecs' is not yet implemented");
  });
});
