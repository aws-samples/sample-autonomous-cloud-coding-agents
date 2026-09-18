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
const mockInvoke = jest.fn();
const mockAdmit = jest.fn();
const mockWarn = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({
  makeDocClient: () => ({ send: mockSend }), makeClient: () => ({ send: mockInvoke }),
}));
jest.mock('../../../src/handlers/shared/microvm-continuation-start', () => ({
  admitContinuation: (...args: unknown[]) => mockAdmit(...args),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: { info: jest.fn(), warn: mockWarn } }));

import { dispatchMicrovmContinuation } from '../../../src/handlers/shared/microvm-continuation-dispatch';

let task: any;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CONTINUATION_BUCKET_NAME = 'saved';
  process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123456789012:function:coordinator:live';
  task = {
    task_id: 'task',
    user_id: 'user',
    compute_type: 'lambda-microvm',
    status: 'AWAITING_APPROVAL',
    awaiting_approval_request_id: 'request',
    continuation: { state: 'PARKED', attempt_id: 'new-worker' },
    continuation_launch: { orchestrator_version: '42' },
  };
  mockSend.mockImplementation(async () => ({ Item: structuredClone(task) }));
  mockAdmit.mockImplementation(async () => ({ kind: 'ready', task: structuredClone(task) }));
  mockInvoke.mockResolvedValue({ StatusCode: 202 });
});
afterEach(() => {
  delete process.env.CONTINUATION_BUCKET_NAME;
  delete process.env.ORCHESTRATOR_FUNCTION_ARN;
});

test('uses the original published version and identical durable identity on repeated dispatch', async () => {
  expect(await dispatchMicrovmContinuation('task', 'user', 'request')).toBe(true);
  expect(await dispatchMicrovmContinuation('task', 'user', 'request')).toBe(true);
  const [first, second] = mockInvoke.mock.calls.map(([command]) => command.input);
  expect(first).toEqual(second);
  expect(first.FunctionName).toBe('arn:aws:lambda:us-west-2:123456789012:function:coordinator:42');
  expect(first.DurableExecutionName).toMatch(/^[a-f0-9]{64}$/);
  expect(first.DurableExecutionName.length).toBeLessThanOrEqual(64);
  expect(JSON.parse(first.Payload.toString())).toEqual({
    task_id: 'task', continuation_request_id: 'request', continuation_attempt_id: 'new-worker',
  });
});

test('does not invoke a worker while capacity is unavailable', async () => {
  mockAdmit.mockResolvedValue({ kind: 'capacity' });
  expect(await dispatchMicrovmContinuation('task', 'user', 'request')).toBe(true);
  expect(mockInvoke).not.toHaveBeenCalled();
});

test('fenced source must not be resumed while retirement is finishing', async () => {
  task.continuation.state = 'FENCED';
  expect(await dispatchMicrovmContinuation('task', 'user', 'request')).toBe(true);
  expect(mockAdmit).not.toHaveBeenCalled();
  expect(mockInvoke).not.toHaveBeenCalled();
});

test.each(['READY', 'CONSUMED'])('leaves ordinary %s worker handling to the wake path', async state => {
  task.continuation.state = state;
  expect(await dispatchMicrovmContinuation('task', 'user', 'request')).toBe(false);
  expect(mockInvoke).not.toHaveBeenCalled();
});

test('an invocation failure preserves the assigned token for the scheduled retry', async () => {
  mockInvoke.mockRejectedValue(new Error('lost invocation response'));
  await expect(dispatchMicrovmContinuation('task', 'user', 'request')).rejects.toThrow('lost invocation');
  expect(task.continuation.attempt_id).toBe('new-worker');
});

test('reports bounded validation detail and operation identity for dispatch diagnosis', async () => {
  const error = Object.assign(new Error('durableExecutionName must have length less than or equal to 64'), {
    name: 'ValidationException',
  });
  mockInvoke.mockRejectedValue(error);
  await expect(dispatchMicrovmContinuation('task', 'user', 'request')).rejects.toBe(error);
  expect(mockWarn).toHaveBeenCalledWith(
    'Saved task continuation dispatch needs reconciliation',
    expect.objectContaining({
      operation: 'Invoke',
      coordinator_version: '42',
      durable_execution_name_length: 64,
      validation_detail: error.message,
    }),
  );
});
