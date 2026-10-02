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

import { inspect } from 'node:util';

const mockMicrovmSend = jest.fn();
const mockEcsSend = jest.fn();
const mockAgentcoreSend = jest.fn();
const mockLifecycleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: mockLifecycleLogger }));
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  ...jest.requireActual('@aws-sdk/client-lambda-microvms'),
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockMicrovmSend })),
}));
jest.mock('@aws-sdk/client-ecs', () => ({
  ...jest.requireActual('@aws-sdk/client-ecs'),
  ECSClient: jest.fn(() => ({ send: mockEcsSend })),
}));
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  ...jest.requireActual('@aws-sdk/client-bedrock-agentcore'),
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentcoreSend })),
}));

import { ResumeMicrovmCommand, SuspendMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { resolveComputeStrategy, type SessionHandle } from '../../../src/handlers/shared/compute-strategy';
import { MICROVM_LIFECYCLE_REQUEST_TIMEOUT_MS } from '../../../src/handlers/shared/strategies/lambda-microvm-strategy';

const handles: SessionHandle[] = [
  { strategyType: 'agentcore', sessionId: 'session-agentcore', runtimeArn: 'arn:runtime' },
  { strategyType: 'ecs', sessionId: 'arn:task', taskArn: 'arn:task', clusterArn: 'arn:cluster' },
  { strategyType: 'lambda-microvm', sessionId: 'mvm-one', microvmId: 'mvm-one', endpoint: 'https://unused.example' },
];
const microvm = handles[2] as Extract<SessionHandle, { strategyType: 'lambda-microvm' }>;

beforeEach(() => {
  jest.clearAllMocks();
  mockMicrovmSend.mockReset().mockResolvedValue({});
  mockEcsSend.mockReset().mockResolvedValue({});
  mockAgentcoreSend.mockReset().mockResolvedValue({});
});

describe.each(handles.filter(handle => handle.strategyType !== 'lambda-microvm'))(
  '$strategyType caller budgets', handle => {
    test('an expired budget prevents poll/stop requests', async () => {
      const controller = new AbortController();
      controller.abort(new Error('caller deadline'));
      const options = { abortSignal: controller.signal };
      const strategy = resolveComputeStrategy({ compute_type: handle.strategyType, runtime_arn: '' });
      await expect(strategy.pollSession(handle, options)).rejects.toThrow('caller deadline');
      await expect(strategy.stopSession(handle, options)).resolves.toBeUndefined();
      expect(mockEcsSend).not.toHaveBeenCalled();
      expect(mockAgentcoreSend).not.toHaveBeenCalled();
    });
    test('stop propagates caller cancellation into its pending SDK request', async () => {
      const controller = new AbortController();
      const send = handle.strategyType === 'ecs' ? mockEcsSend : mockAgentcoreSend;
      send.mockImplementationOnce((_command, options) => new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(new Error('caller deadline')));
      }));
      const strategy = resolveComputeStrategy({ compute_type: handle.strategyType, runtime_arn: '' });
      const result = strategy.stopSession(handle, { abortSignal: controller.signal });
      controller.abort();
      await expect(result).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
    });
  },
);

describe.each(['pollSession', 'suspendSession', 'resumeSession', 'stopSession'] as const)(
  '%s composed budget', operation => {
    test('does not send a control request after its caller deadline', async () => {
      const controller = new AbortController();
      controller.abort(new Error('caller deadline'));
      const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
      const result = strategy[operation](microvm, { abortSignal: controller.signal });
      if (operation === 'stopSession') await expect(result).resolves.toMatchObject({ outcome: 'unconfirmed' });
      else await expect(result).rejects.toThrow('caller deadline');
      expect(mockMicrovmSend).not.toHaveBeenCalled();
    });
    test('a caller can end the in-flight request before the default limit', async () => {
      const controller = new AbortController();
      mockMicrovmSend.mockImplementationOnce((_command, options) => new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(new Error('caller deadline')));
      }));
      const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
      const result = strategy[operation](microvm, { abortSignal: controller.signal });
      const assertion = operation === 'stopSession'
        ? expect(result).resolves.toMatchObject({ outcome: 'unconfirmed' })
        : expect(result).rejects.toThrow('caller deadline');
      controller.abort();
      await assertion;
      expect(mockMicrovmSend).toHaveBeenCalledTimes(1);
      expect(mockMicrovmSend.mock.calls[0][1].abortSignal.aborted).toBe(true);
    });
  },
);

describe('MicroVM lifetime observations', () => {
  const startedAt = new Date('2026-09-15T10:00:00Z');
  test.each(['RUNNING', 'SUSPENDING', 'SUSPENDED', 'TERMINATED', 'UNKNOWN'])(
    'retains the original service lifetime in %s as durable JSON data', async state => {
      mockMicrovmSend.mockResolvedValue({ state, startedAt, maximumDurationInSeconds: 28_800 });
      const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
      const observation = await strategy.pollSession(microvm);
      expect(JSON.parse(JSON.stringify(observation))).toMatchObject({
        microvmStartedAtMs: startedAt.getTime(), microvmMaximumDurationSeconds: 28_800,
      });
    },
  );
  test.each([
    { startedAt: new Date('invalid'), maximumDurationInSeconds: 28_800 },
    { startedAt, maximumDurationInSeconds: 0 },
    { startedAt, maximumDurationInSeconds: -1 },
    { startedAt, maximumDurationInSeconds: 1.5 },
    { maximumDurationInSeconds: 28_800 },
  ])('does not invent a lifetime from incomplete service data: %j', async lifetime => {
    mockMicrovmSend.mockResolvedValue({ state: 'RUNNING', ...lifetime });
    const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
    const observation = await strategy.pollSession(microvm);
    expect(observation.microvmStartedAtMs).toBeUndefined();
    expect(observation.microvmMaximumDurationSeconds).toBeUndefined();
  });
});

describe.each(['suspendSession', 'resumeSession'] as const)('%s contract', operation => {
  test('records AWS acknowledgment identity without response or exception contents', async () => {
    const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
    mockMicrovmSend.mockResolvedValueOnce({
      $metadata: { requestId: 'aws-control-123', headers: { Authorization: 'secret-response' } },
      payload: 'secret-payload',
    });
    await expect(strategy[operation](microvm)).resolves.toEqual({ supported: true });
    expect(mockLifecycleLogger.info).toHaveBeenCalledWith(
      'MicroVM lifecycle request acknowledged',
      expect.objectContaining({ microvm_id: 'mvm-one', aws_request_id: 'aws-control-123', elapsed_ms: expect.any(Number) }),
    );
    mockMicrovmSend.mockRejectedValueOnce(Object.assign(new Error('secret-exception'), {
      name: 'ConflictException', $metadata: { requestId: 'aws-control-456' },
    }));
    await expect(strategy[operation](microvm)).rejects.toThrow();
    expect(mockLifecycleLogger.warn).toHaveBeenCalledWith(
      'MicroVM lifecycle request failed',
      expect.objectContaining({ error_type: 'ConflictException', aws_request_id: 'aws-control-456' }),
    );
    expect(JSON.stringify([mockLifecycleLogger.info.mock.calls, mockLifecycleLogger.warn.mock.calls])).not.toContain('secret-');
  });

  test.each(handles.filter(h => h.strategyType !== 'lambda-microvm'))(
    '$strategyType explicitly reports unsupported without calling AWS', async handle => {
      const strategy = resolveComputeStrategy({ compute_type: handle.strategyType, runtime_arn: 'arn:runtime' });
      await expect(strategy[operation](handle)).resolves.toEqual({ supported: false });
      expect(mockMicrovmSend).not.toHaveBeenCalled();
      expect(mockEcsSend).not.toHaveBeenCalled();
      expect(mockAgentcoreSend).not.toHaveBeenCalled();
    },
  );

  test.each(handles)('$strategyType rejects a handle from another backend', async handle => {
    const strategy = resolveComputeStrategy({ compute_type: handle.strategyType, runtime_arn: 'arn:runtime' });
    for (const other of handles.filter(h => h.strategyType !== handle.strategyType)) {
      await expect(strategy[operation](other)).rejects.toThrow(`${operation} called with non-${handle.strategyType} handle`);
    }
    expect(mockMicrovmSend).not.toHaveBeenCalled();
    expect(mockEcsSend).not.toHaveBeenCalled();
    expect(mockAgentcoreSend).not.toHaveBeenCalled();
  });

  test('sends only the identifier and reports acknowledgement, without pretending to observe state', async () => {
    const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
    await expect(strategy[operation](microvm)).resolves.toEqual({ supported: true });
    expect(mockMicrovmSend).toHaveBeenCalledTimes(1);
    const [command, options] = mockMicrovmSend.mock.calls[0];
    expect(command).toBeInstanceOf(operation === 'suspendSession' ? SuspendMicrovmCommand : ResumeMicrovmCommand);
    expect(command.input).toEqual({ microvmIdentifier: 'mvm-one' });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  test.each(['', '   ', undefined])('rejects an empty runtime identifier (%s)', async microvmId => {
    const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
    await expect(strategy[operation]({ ...microvm, microvmId } as SessionHandle)).rejects.toThrow('non-empty MicroVM identifier');
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  });

  test.each([
    'AccessDeniedException', 'ConflictException', 'ResourceNotFoundException',
    'ThrottlingException', 'InternalServerException', 'ValidationException',
  ])('preserves %s as an operational failure with a sanitized cause', async name => {
    mockMicrovmSend.mockRejectedValueOnce(Object.assign(new Error(
      'failed https://example.test/task?X-Amz-Signature=BEARER-SECRET',
      { cause: new Error('private request metadata: BEARER-SECRET') },
    ), { name }));
    const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
    await strategy[operation](microvm).then(
      () => { throw new Error('Expected lifecycle request to fail'); },
      (error: Error) => {
        expect(error.message).toContain(name);
        expect(error.cause).toMatchObject({ name });
        expect(inspect(error, { depth: null })).not.toContain('BEARER-SECRET');
      },
    );
  });

  test('a repeated command cannot silently turn a simulated state conflict into success', async () => {
    mockMicrovmSend.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('state changed'), { name: 'ConflictException' }));
    const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
    await expect(strategy[operation](microvm)).resolves.toEqual({ supported: true });
    await expect(strategy[operation](microvm)).rejects.toThrow('ConflictException');
    expect(mockMicrovmSend.mock.calls[0][0].input).toEqual(mockMicrovmSend.mock.calls[1][0].input);
  });

  test('bounds the SDK request and surfaces abort for later reconciliation', async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      mockMicrovmSend.mockImplementationOnce((_command, options) => new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })));
      }));
      const strategy = resolveComputeStrategy({ compute_type: 'lambda-microvm', runtime_arn: '' });
      const result = expect(strategy[operation](microvm)).rejects.toThrow('AbortError');
      controller.abort();
      await result;
      expect(timeout).toHaveBeenCalledWith(MICROVM_LIFECYCLE_REQUEST_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });
});
