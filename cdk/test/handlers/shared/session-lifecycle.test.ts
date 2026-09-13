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
});

describe.each(['suspendSession', 'resumeSession'] as const)('%s contract', operation => {
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
