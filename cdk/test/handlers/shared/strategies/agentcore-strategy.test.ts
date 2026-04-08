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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockSend })),
  InvokeAgentRuntimeCommand: jest.fn((input: unknown) => ({ _type: 'InvokeAgentRuntime', input })),
  StopRuntimeSessionCommand: jest.fn((input: unknown) => ({ _type: 'StopRuntimeSession', input })),
}));

import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreComputeStrategy } from '../../../../src/handlers/shared/strategies/agentcore-strategy';

const MockedClient = jest.mocked(BedrockAgentCoreClient);
const defaultRuntimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/default';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AgentCoreComputeStrategy', () => {
  test('type is agentcore', () => {
    const strategy = new AgentCoreComputeStrategy();
    expect(strategy.type).toBe('agentcore');
  });

  describe('startSession', () => {
    test('invokes agent runtime and returns SessionHandle', async () => {
      mockSend.mockResolvedValueOnce({});
      const strategy = new AgentCoreComputeStrategy();

      const handle = await strategy.startSession({
        taskId: 'TASK001',
        payload: { repo_url: 'org/repo', task_id: 'TASK001' },
        blueprintConfig: { compute_type: 'agentcore', runtime_arn: defaultRuntimeArn },
      });

      expect(handle.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(handle.strategyType).toBe('agentcore');
      expect(handle.metadata.runtimeArn).toBe(defaultRuntimeArn);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('uses runtime_arn from blueprintConfig (single source of truth)', async () => {
      mockSend.mockResolvedValueOnce({});
      const strategy = new AgentCoreComputeStrategy();
      const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom';

      const handle = await strategy.startSession({
        taskId: 'TASK001',
        payload: { repo_url: 'org/repo', task_id: 'TASK001' },
        blueprintConfig: { compute_type: 'agentcore', runtime_arn: runtimeArn },
      });

      expect(handle.metadata.runtimeArn).toBe(runtimeArn);
      const invokeCall = mockSend.mock.calls[0][0];
      expect(invokeCall.input.agentRuntimeArn).toBe(runtimeArn);
    });

    test('reuses shared BedrockAgentCoreClient across instances', async () => {
      // The lazy singleton may already be initialized from prior tests.
      // Record the current call count, then verify no additional constructor calls happen.
      const callsBefore = MockedClient.mock.calls.length;

      mockSend.mockResolvedValue({});
      const strategy1 = new AgentCoreComputeStrategy();
      const strategy2 = new AgentCoreComputeStrategy();

      await strategy1.startSession({
        taskId: 'T1',
        payload: {},
        blueprintConfig: { compute_type: 'agentcore', runtime_arn: defaultRuntimeArn },
      });
      await strategy2.startSession({
        taskId: 'T2',
        payload: {},
        blueprintConfig: { compute_type: 'agentcore', runtime_arn: defaultRuntimeArn },
      });

      // Lazy singleton: at most one constructor call total across all strategy instances
      const callsAfter = MockedClient.mock.calls.length;
      expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('pollSession', () => {
    test('throws because AgentCore polling is done at orchestrator level', async () => {
      const strategy = new AgentCoreComputeStrategy();
      await expect(
        strategy.pollSession({
          sessionId: 'test-session',
          strategyType: 'agentcore',
          metadata: { runtimeArn: defaultRuntimeArn },
        }),
      ).rejects.toThrow('pollSession is not implemented for AgentCore');
    });
  });

  describe('stopSession', () => {
    test('sends StopRuntimeSessionCommand', async () => {
      mockSend.mockResolvedValueOnce({});
      const strategy = new AgentCoreComputeStrategy();

      await strategy.stopSession({
        sessionId: 'test-session',
        strategyType: 'agentcore',
        metadata: { runtimeArn: defaultRuntimeArn },
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.input.agentRuntimeArn).toBe(defaultRuntimeArn);
      expect(call.input.runtimeSessionId).toBe('test-session');
    });

    test('logs info for ResourceNotFoundException (session already gone)', async () => {
      const err = new Error('Not found');
      err.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(err);
      const strategy = new AgentCoreComputeStrategy();

      await expect(
        strategy.stopSession({
          sessionId: 'test-session',
          strategyType: 'agentcore',
          metadata: { runtimeArn: defaultRuntimeArn },
        }),
      ).resolves.toBeUndefined();
    });

    test('logs error for ThrottlingException', async () => {
      const err = new Error('Rate exceeded');
      err.name = 'ThrottlingException';
      mockSend.mockRejectedValueOnce(err);
      const strategy = new AgentCoreComputeStrategy();

      await expect(
        strategy.stopSession({
          sessionId: 'test-session',
          strategyType: 'agentcore',
          metadata: { runtimeArn: defaultRuntimeArn },
        }),
      ).resolves.toBeUndefined();
    });

    test('logs error for AccessDeniedException', async () => {
      const err = new Error('Access denied');
      err.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(err);
      const strategy = new AgentCoreComputeStrategy();

      await expect(
        strategy.stopSession({
          sessionId: 'test-session',
          strategyType: 'agentcore',
          metadata: { runtimeArn: defaultRuntimeArn },
        }),
      ).resolves.toBeUndefined();
    });

    test('logs warn for unknown errors (best-effort)', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network error'));
      const strategy = new AgentCoreComputeStrategy();

      await expect(
        strategy.stopSession({
          sessionId: 'test-session',
          strategyType: 'agentcore',
          metadata: { runtimeArn: defaultRuntimeArn },
        }),
      ).resolves.toBeUndefined();
    });

    test('skips stop when no runtimeArn in metadata', async () => {
      const strategy = new AgentCoreComputeStrategy();

      await strategy.stopSession({
        sessionId: 'test-session',
        strategyType: 'agentcore',
        metadata: {},
      });

      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
