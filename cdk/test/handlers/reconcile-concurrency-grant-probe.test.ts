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

// The reconciler kicks the Linear grant health probe (#1004).
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
  InvocationType: { Event: 'Event' },
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: jest.fn() })),
  ScanCommand: jest.fn(),
  QueryCommand: jest.fn(),
  UpdateItemCommand: jest.fn(),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';
process.env.LINEAR_GRANT_PROBE_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:processor';
process.env.RECONCILER_TICK_MINUTES = '15';

import { triggerLinearGrantProbe } from '../../src/handlers/reconcile-concurrency';

const WINDOW = 12 * 3_600_000;

beforeEach(() => mockLambdaSend.mockReset());

test('async-invokes the processor with the probe event on the window tick only', async () => {
  mockLambdaSend.mockResolvedValue({});
  expect(await triggerLinearGrantProbe(WINDOW * 100 + 60_000)).toBe(true);
  expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  const { input } = mockLambdaSend.mock.calls[0][0];
  expect(input.FunctionName).toBe(process.env.LINEAR_GRANT_PROBE_FUNCTION_ARN);
  expect(input.InvocationType).toBe('Event');
  expect(JSON.parse(Buffer.from(input.Payload).toString())).toEqual({ grant_health_probe: true });

  expect(await triggerLinearGrantProbe(WINDOW * 100 + 20 * 60_000)).toBe(false);
  expect(mockLambdaSend).toHaveBeenCalledTimes(1);
});

test('an invoke failure never breaks the reconciler', async () => {
  mockLambdaSend.mockRejectedValue(new Error('throttled'));
  await expect(triggerLinearGrantProbe(WINDOW * 7)).resolves.toBe(false);
});
