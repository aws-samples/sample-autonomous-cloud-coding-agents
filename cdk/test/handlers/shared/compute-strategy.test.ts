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

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: jest.fn() })),
  DescribeInstancesCommand: jest.fn(),
  CreateTagsCommand: jest.fn(),
  DeleteTagsCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  SendCommandCommand: jest.fn(),
  GetCommandInvocationCommand: jest.fn(),
  CancelCommandCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
}));

import { resolveComputeStrategy } from '../../../src/handlers/shared/compute-strategy';
import { AgentCoreComputeStrategy } from '../../../src/handlers/shared/strategies/agentcore-strategy';
import { Ec2ComputeStrategy } from '../../../src/handlers/shared/strategies/ec2-strategy';
import { EcsComputeStrategy } from '../../../src/handlers/shared/strategies/ecs-strategy';

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

  test('returns Ec2ComputeStrategy for compute_type ec2', () => {
    const strategy = resolveComputeStrategy({
      compute_type: 'ec2',
      runtime_arn: 'arn:test',
    });
    expect(strategy).toBeInstanceOf(Ec2ComputeStrategy);
    expect(strategy.type).toBe('ec2');
  });
});
