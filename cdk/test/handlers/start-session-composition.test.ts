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

/**
 * Integration-style tests for the start-session step composition:
 *   resolveComputeStrategy → strategy.startSession → transitionTask → emitTaskEvent
 * These verify that the orchestrate-task handler's step 4 logic correctly
 * wires the strategy, state transitions, and event emission together.
 */

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentCoreSend })),
  InvokeAgentRuntimeCommand: jest.fn((input: unknown) => ({ _type: 'InvokeAgentRuntime', input })),
  StopRuntimeSessionCommand: jest.fn((input: unknown) => ({ _type: 'StopRuntimeSession', input })),
}));

const mockMicrovmSend = jest.fn();
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockMicrovmSend })),
  RunMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'RunMicrovm', input })),
  GetMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'GetMicrovm', input })),
  TerminateMicrovmCommand: jest.fn((input: unknown) => ({ _type: 'TerminateMicrovm', input })),
  MicrovmState: {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    SUSPENDED: 'SUSPENDED',
    SUSPENDING: 'SUSPENDING',
    TERMINATED: 'TERMINATED',
    TERMINATING: 'TERMINATING',
  },
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ _type: 'DeleteObject', input })),
}));

jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: jest.fn(),
  checkRepoOnboarded: jest.fn(),
}));

jest.mock('../../src/handlers/shared/memory', () => ({
  writeMinimalEpisode: jest.fn(),
}));

jest.mock('../../src/handlers/shared/prompt-version', () => ({
  computePromptVersion: jest.fn().mockReturnValue('abc123'),
}));

jest.mock('../../src/handlers/shared/context-hydration', () => ({
  hydrateContext: jest.fn(),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';
process.env.RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test';
process.env.MAX_CONCURRENT_TASKS_PER_USER = '3';
process.env.TASK_RETENTION_DAYS = '90';
process.env.MICROVM_IMAGE_IDENTIFIER = 'arn:aws:lambda:us-east-1:123456789012:microvm-image/abca-agent';
process.env.MICROVM_EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/AbcaMicrovmExecution';
process.env.MICROVM_EGRESS_CONNECTOR_ARNS = 'arn:aws:lambda:us-east-1:123456789012:network-connector/egress-1';
process.env.MICROVM_PAYLOAD_BUCKET = 'test-microvm-payload-bucket';

import { TaskStatus } from '../../src/constructs/task-status';
import { resolveComputeStrategy } from '../../src/handlers/shared/compute-strategy';
import { transitionTask, emitTaskEvent, failTask, buildComputeMetadata } from '../../src/handlers/shared/orchestrator';
import type { BlueprintConfig } from '../../src/handlers/shared/repo-config';

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
});

describe('start-session step composition', () => {
  const taskId = 'TASK001';
  const userId = 'user-123';
  const blueprintConfig: BlueprintConfig = {
    compute_type: 'agentcore',
    runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
  };
  const payload = { repo_url: 'org/repo', task_id: taskId };

  test('happy path: strategy.startSession → transitionTask → emitTaskEvent', async () => {
    mockAgentCoreSend.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValue({}); // transitionTask + emitTaskEvent

    const strategy = resolveComputeStrategy(blueprintConfig);
    const handle = await strategy.startSession({ taskId, userId: 'cognito-test', payload, blueprintConfig });

    await transitionTask(taskId, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
      session_id: handle.sessionId,
      started_at: expect.any(String),
    });
    await emitTaskEvent(taskId, 'session_started', {
      session_id: handle.sessionId,
      strategy_type: handle.strategyType,
    });

    // Verify AgentCore was invoked
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    // Verify DDB was called for transition + event
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    // Verify handle shape
    expect(handle.strategyType).toBe('agentcore');
    expect(handle.sessionId).toBeDefined();
  });

  test('error path: strategy.startSession fails → failTask is called', async () => {
    mockAgentCoreSend.mockRejectedValueOnce(new Error('InvokeAgent failed'));
    mockDdbSend.mockResolvedValue({}); // failTask transitions

    const strategy = resolveComputeStrategy(blueprintConfig);

    try {
      await strategy.startSession({ taskId, userId: 'cognito-test', payload, blueprintConfig });
      fail('Expected startSession to throw');
    } catch (err) {
      await failTask(taskId, TaskStatus.HYDRATING, `Session start failed: ${String(err)}`, userId, true);
    }

    // failTask should have been called — transitions to FAILED + emits event + decrements concurrency
    // transitionTask (1) + emitTaskEvent (1) + decrementConcurrency (1) = 3 DDB calls
    expect(mockDdbSend).toHaveBeenCalledTimes(3);
  });

  test('partial failure: strategy succeeds but transitionTask throws', async () => {
    mockAgentCoreSend.mockResolvedValueOnce({});
    const condErr = new Error('Conditional check failed');
    condErr.name = 'ConditionalCheckFailedException';
    mockDdbSend
      .mockRejectedValueOnce(condErr) // transitionTask fails
      .mockResolvedValue({}); // failTask calls

    const strategy = resolveComputeStrategy(blueprintConfig);
    const handle = await strategy.startSession({ taskId, userId: 'cognito-test', payload, blueprintConfig });

    try {
      await transitionTask(taskId, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
        session_id: handle.sessionId,
        started_at: new Date().toISOString(),
      });
      fail('Expected transitionTask to throw');
    } catch (err) {
      await failTask(taskId, TaskStatus.HYDRATING, `Session start failed: ${String(err)}`, userId, true);
    }

    // AgentCore was invoked
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    // transitionTask failed (1) + failTask: transitionTask (1) + emitTaskEvent (1) + decrement (1) = 4
    expect(mockDdbSend).toHaveBeenCalledTimes(4);
  });
});

describe('start-session step composition — lambda-microvm (ADR-021)', () => {
  const taskId = 'TASK001';
  const MICROVM_ID = 'mvm-0123456789abcdef';
  const ENDPOINT = 'https://mvm-0123456789abcdef.microvm.lambda.us-east-1.amazonaws.com';
  const blueprintConfig: BlueprintConfig = { compute_type: 'lambda-microvm', runtime_arn: '' };
  const payload = { repo_url: 'org/repo', task_id: taskId };

  test('startSession → buildComputeMetadata → transitionTask persists microvmId and endpoint', async () => {
    mockMicrovmSend.mockResolvedValueOnce({
      microvmId: MICROVM_ID,
      endpoint: ENDPOINT,
      state: 'RUNNING',
      imageArn: 'arn:image',
      imageVersion: '7',
    });
    mockDdbSend.mockResolvedValue({});

    const strategy = resolveComputeStrategy(blueprintConfig);
    const handle = await strategy.startSession({ taskId, userId: 'cognito-test', payload, blueprintConfig });

    await transitionTask(taskId, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
      session_id: handle.sessionId,
      started_at: new Date().toISOString(),
      compute_type: handle.strategyType,
      compute_metadata: buildComputeMetadata(handle),
    });

    // RunMicrovm actually went out.
    expect(mockMicrovmSend).toHaveBeenCalledTimes(1);
    expect(mockMicrovmSend.mock.calls[0][0]._type).toBe('RunMicrovm');

    // The persisted attributes are what cancel-task (and P3's approve/deny
    // resume) read back, so assert them on the real UpdateCommand input.
    const update = mockDdbSend.mock.calls.find(c => c[0]._type === 'Update')![0];
    const values = update.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':attr_compute_type']).toBe('lambda-microvm');
    expect(values[':attr_compute_metadata']).toEqual({ microvmId: MICROVM_ID, endpoint: ENDPOINT });
    expect(values[':attr_session_id']).toBe(MICROVM_ID);
    expect(values[':toStatus']).toBe(TaskStatus.RUNNING);
  });

  test('compute_metadata carries ONLY the two lifecycle keys (no image ARN)', async () => {
    mockMicrovmSend.mockResolvedValueOnce({
      microvmId: MICROVM_ID,
      endpoint: ENDPOINT,
      state: 'RUNNING',
      imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image/abca-agent',
      imageVersion: '7',
    });

    const strategy = resolveComputeStrategy(blueprintConfig);
    const handle = await strategy.startSession({ taskId, userId: 'cognito-test', payload, blueprintConfig });
    const metadata = buildComputeMetadata(handle);

    // ADR-021: the image ARN is deployment-time config, logged not persisted.
    expect(Object.keys(metadata).sort()).toEqual(['endpoint', 'microvmId']);
    expect(JSON.stringify(metadata)).not.toContain('microvm-image');
  });

  test('error path: a marked RunMicrovm failure flows into failTask', async () => {
    const err = new Error('Rate exceeded');
    err.name = 'ThrottlingException';
    mockMicrovmSend.mockRejectedValueOnce(err);
    mockDdbSend.mockResolvedValue({});

    const strategy = resolveComputeStrategy(blueprintConfig);

    await expect(
      strategy.startSession({ taskId, userId: 'cognito-test', payload, blueprintConfig }),
    ).rejects.toThrow('MicroVM RunMicrovm failed: ThrottlingException: Rate exceeded');

    await failTask(taskId, TaskStatus.HYDRATING, 'Session start failed: boom', 'user-123', true);
    expect(mockDdbSend).toHaveBeenCalled();
  });
});
