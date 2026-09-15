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
const mockWarn = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: { warn: mockWarn } }));

import { readMicrovmSuspendEnabled } from '../../../src/handlers/shared/microvm-suspend-config';

const parameterName = '/backgroundagent-dev/microvm-approval-suspend-enabled';
const originalName = process.env.MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME;
beforeEach(() => {
  process.env.MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME = parameterName;
  mockSend.mockReset().mockResolvedValue({ Parameter: { Name: parameterName, Value: 'true' } });
  mockWarn.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalName === undefined) delete process.env.MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME;
  else process.env.MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME = originalName;
});

test('rereads the exact parameter and observes disable without an environment change', async () => {
  expect(await readMicrovmSuspendEnabled({})).toBe(true);
  mockSend.mockResolvedValue({ Parameter: { Name: parameterName, Value: 'false' } });
  expect(await readMicrovmSuspendEnabled({})).toBe(false);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenLastCalledWith({ input: { Name: parameterName } }, { abortSignal: expect.any(AbortSignal) });
});

test.each(['false', 'TRUE', ' true ', '', undefined])('does not enable on value %s', async value => {
  mockSend.mockResolvedValue({ Parameter: { Name: parameterName, Value: value } });
  expect(await readMicrovmSuspendEnabled({})).toBe(false);
});

test.each([{}, { Parameter: { Name: '/other', Value: 'true' } }])('requires the requested parameter identity', async response => {
  mockSend.mockResolvedValue(response);
  expect(await readMicrovmSuspendEnabled({})).toBe(false);
});

test('missing configuration never starts a request', async () => {
  delete process.env.MICROVM_APPROVAL_SUSPEND_PARAMETER_NAME;
  expect(await readMicrovmSuspendEnabled({})).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test('read failure disables savings and logs only safe error identifiers', async () => {
  mockSend.mockRejectedValue(Object.assign(new Error('signed-url-secret'), {
    name: 'AccessDeniedException', $metadata: { requestId: 'request-123' },
  }));
  expect(await readMicrovmSuspendEnabled({})).toBe(false);
  expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('signed-url-secret');
  expect(mockWarn).toHaveBeenCalledWith(expect.any(String), {
    error_type: 'AccessDeniedException', aws_request_id: 'request-123',
  });
});

test('an exhausted parent budget starts no request', async () => {
  expect(await readMicrovmSuspendEnabled({ abortSignal: AbortSignal.abort() })).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['parent', 'local'])('%s expiry aborts the actual SDK request and rejects a late true response', async source => {
  const parent = new AbortController();
  const local = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(local.signal);
  mockSend.mockImplementation(async (_command, options) => {
    (source === 'parent' ? parent : local).abort();
    expect(options.abortSignal.aborted).toBe(true);
    return { Parameter: { Name: parameterName, Value: 'true' } };
  });
  expect(await readMicrovmSuspendEnabled({ abortSignal: parent.signal })).toBe(false);
  expect(timeout).toHaveBeenCalledWith(3_000);
});
