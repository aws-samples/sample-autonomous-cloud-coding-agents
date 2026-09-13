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

import { TaskStatus } from '../../../src/constructs/task-status';

const mockDdbSend = jest.fn();
const mockMicrovmSend = jest.fn();
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ kind: 'get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ kind: 'update', input })),
}));
jest.mock('@aws-sdk/client-lambda-microvms', () => ({
  LambdaMicrovmsClient: jest.fn(() => ({ send: mockMicrovmSend })),
  RunMicrovmCommand: jest.fn((input: unknown) => ({ kind: 'run', input })),
  TerminateMicrovmCommand: jest.fn((input: unknown) => ({ kind: 'terminate', input })),
  MicrovmState: {},
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://payloads.s3.us-east-1.amazonaws.com/task/payload.json?X-Amz-Signature=' + Date.now() }));
const mockObjects = new Map<string, string>();
jest.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: jest.fn((input: unknown) => ({ kind: 'delete', input })),
  GetObjectCommand: jest.fn((input: unknown) => ({ kind: 'get', input })),
  S3Client: jest.fn(() => ({ send: mockS3Send, config: { credentials: async () => ({ accessKeyId: 'EXAMPLE', secretAccessKey: 'unused' }) } })),
  PutObjectCommand: jest.fn((input: unknown) => ({ kind: 'put', input })),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

Object.assign(process.env, {
  TASK_TABLE_NAME: 'tasks',
  TASK_EVENTS_TABLE_NAME: 'events',
  MICROVM_IMAGE_IDENTIFIER: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
  MICROVM_IMAGE_VERSION: '1',
  MICROVM_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/execution',
  MICROVM_EGRESS_CONNECTOR_ARNS: 'arn:aws:lambda:us-east-1:123456789012:network-connector:egress',
  MICROVM_INGRESS_CONNECTOR_ARNS: 'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS',
  MICROVM_PAYLOAD_BUCKET: 'payloads',
  GITHUB_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:token',
  AGENT_SESSION_ROLE_ARN: 'arn:aws:iam::123456789012:role/session',
});

import { MicrovmStartUncertainError } from '../../../src/handlers/shared/error-classifier';
import { claimMicrovmStart, MICROVM_START_REPLAY_WINDOW_MS, microvmStartRequestHash } from '../../../src/handlers/shared/microvm-start';
import { startSessionWithRetry } from '../../../src/handlers/shared/session-start-retry';
import { LambdaMicrovmComputeStrategy } from '../../../src/handlers/shared/strategies/lambda-microvm-strategy';

const TASK_ID = '01K4YKCNV8P7WZBCSFDV2RNH49';
const input = {
  taskId: TASK_ID,
  userId: 'user',
  payload: { task_id: TASK_ID, prompt: 'x'.repeat(5_000) },
  blueprintConfig: { compute_type: 'lambda-microvm' as const, runtime_arn: '' },
};
const handle = {
  strategyType: 'lambda-microvm' as const,
  sessionId: 'mvm-one',
  microvmId: 'mvm-one',
  endpoint: 'https://example.invalid',
};
let record: Record<string, any>;
let lostResponses: number;
let created: Map<string, Record<string, unknown>>;
let now: number;

beforeEach(() => {
  jest.clearAllMocks();
  record = { user_id: 'user', status: TaskStatus.HYDRATING };
  lostResponses = 0;
  created = new Map();
  now = Date.parse('2026-09-13T15:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockObjects.clear();
  mockS3Send.mockReset().mockImplementation(async ({ kind: type, input: command }) => {
    if (type === 'get') {
      if (!mockObjects.has(command.Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => mockObjects.get(command.Key) } };
    }
    if (type === 'delete') { mockObjects.delete(command.Key); return {}; }
    if (command.IfNoneMatch === '*' && mockObjects.has(command.Key)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
    mockObjects.set(command.Key, command.Body);
    return {};
  });
  mockDdbSend.mockReset().mockImplementation(async ({ kind, input: command }) => {
    if (kind === 'get') return { Item: structuredClone(record) };
    const values = command.ExpressionAttributeValues;
    if (values[':receipt']) {
      if (record.microvm_start || record.status !== TaskStatus.HYDRATING) {
        throw Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
      }
      record.microvm_start = structuredClone(values[':receipt']);
    } else {
      record.microvm_start.handle = values[':handle'];
      record.session_id = values[':id'];
      record.compute_type = values[':type'];
      record.compute_metadata = values[':metadata'];
    }
    return {};
  });
  // Service emulator: same-token/same-request replay returns the original ID.
  // This tests our use of the API contract; AWS retention still needs live proof.
  mockMicrovmSend.mockReset().mockImplementation(async ({ kind, input: command }) => {
    if (kind === 'terminate') return {};
    const token = command.clientToken ?? `sdk-generated-${created.size}`;
    if (!created.has(token)) created.set(token, structuredClone(command));
    expect(created.get(token)).toEqual(command);
    if (lostResponses-- > 0) {
      throw Object.assign(new Error('response lost after creation'), { name: 'TimeoutError' });
    }
    return { microvmId: handle.microvmId, endpoint: handle.endpoint, state: 'RUNNING' };
  });
});

afterEach(() => jest.restoreAllMocks());

function runCalls() {
  return mockMicrovmSend.mock.calls.filter(([command]) => command.kind === 'run');
}

test('a lost successful response retries one logical start and records the recovered handle', async () => {
  lostResponses = 1;
  const result = await startSessionWithRetry(new LambdaMicrovmComputeStrategy(), input, {
    taskId: TASK_ID, emitRetryEvent: jest.fn(), logger: { warn: jest.fn() },
  });
  expect(result).toEqual({ handle, autoRetried: true });
  expect(runCalls()).toHaveLength(2);
  expect(created.size).toBe(1);
  expect(record.microvm_start.clientToken).toBe(TASK_ID);
  expect(record.microvm_start.handle).toEqual(handle);
  expect(record.compute_metadata).toEqual({ microvmId: handle.microvmId, endpoint: handle.endpoint });
  expect(mockDdbSend.mock.calls.filter(([command]) => command.kind === 'get')
    .every(([command]) => command.input.ConsistentRead)).toBe(true);
});

test('a fresh strategy after a process restart reuses the persisted token', async () => {
  lostResponses = 1;
  await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow('response lost');
  const second = await new LambdaMicrovmComputeStrategy().startSession(input);
  expect(second).toEqual(handle);
  expect(created.size).toBe(1);
  expect(runCalls()).toHaveLength(2);
});

test('a definite rejection after a lost response does not erase the first unknown outcome', async () => {
  mockMicrovmSend
    .mockRejectedValueOnce(Object.assign(new Error('response lost'), { name: 'TimeoutError' }))
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  await expect(startSessionWithRetry(new LambdaMicrovmComputeStrategy(), input, {
    taskId: TASK_ID, emitRetryEvent: jest.fn(), logger: { warn: jest.fn() },
  })).rejects.toBeInstanceOf(MicrovmStartUncertainError);
});

test.each([
  { name: 'RequestTimeout', $metadata: { httpStatusCode: 400 } },
  { name: 'RequestTimeoutException', $metadata: { httpStatusCode: 400 } },
  { name: 'ServiceError', $metadata: { httpStatusCode: 408 } },
])('a service timeout stays uncertain despite its HTTP status ($name)', async (timeout) => {
  mockMicrovmSend
    .mockRejectedValueOnce(Object.assign(new Error('start response timed out'), timeout))
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
  await expect(startSessionWithRetry(new LambdaMicrovmComputeStrategy(), input, {
    taskId: TASK_ID, emitRetryEvent: jest.fn(), logger: { warn: jest.fn() },
  })).rejects.toBeInstanceOf(MicrovmStartUncertainError);
  expect(runCalls().map(([command]) => command.input.clientToken)).toEqual([TASK_ID, TASK_ID]);
});

test('a confirmed rejection may retry the same token without creating an extra computer', async () => {
  mockMicrovmSend.mockRejectedValueOnce(Object.assign(new Error('quota'), { name: 'ServiceQuotaExceededException' }));
  const result = await startSessionWithRetry(new LambdaMicrovmComputeStrategy(), input, {
    taskId: TASK_ID, emitRetryEvent: jest.fn(), logger: { warn: jest.fn() },
  });
  expect(result.handle).toEqual(handle);
  expect(created.size).toBe(1);
  expect(runCalls().map(([command]) => command.input.clientToken)).toEqual([TASK_ID, TASK_ID]);
});

test('different tasks receive different persisted tokens', async () => {
  expect((await claimMicrovmStart(TASK_ID, 'user', 'hash')).clientToken).toBe(TASK_ID);
  record = { user_id: 'user', status: TaskStatus.HYDRATING };
  expect((await claimMicrovmStart('another-task', 'user', 'hash')).clientToken).toBe('another-task');
});

test('a task owner mismatch prevents all start side effects', async () => {
  record.user_id = 'different-user';
  await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow('owner');
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockMicrovmSend).not.toHaveBeenCalled();
});

test('replay after saving a handle makes no further RunMicrovm or payload write', async () => {
  await new LambdaMicrovmComputeStrategy().startSession(input);
  now += MICROVM_START_REPLAY_WINDOW_MS * 10;
  expect(await new LambdaMicrovmComputeStrategy().startSession(input)).toEqual(handle);
  expect(runCalls()).toHaveLength(1);
  expect(mockS3Send.mock.calls.filter(([c]) => c.kind === 'put' && c.input.Key.endsWith('/payload.json'))).toHaveLength(1);
});

test('changed input is refused before overwriting the first task payload', async () => {
  lostResponses = 1;
  await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow();
  await expect(new LambdaMicrovmComputeStrategy().startSession({
    ...input, payload: { ...input.payload, prompt: 'changed'.repeat(1_000) },
  })).rejects.toThrow('MICROVM_START_INPUT_CHANGED');
  expect(mockS3Send.mock.calls.filter(([c]) => c.kind === 'put' && c.input.Key.endsWith('/payload.json'))).toHaveLength(1);
  expect(runCalls()).toHaveLength(1);
});

test('an expired unknown start never receives a new token or another RunMicrovm call', async () => {
  lostResponses = 1;
  await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow();
  now += MICROVM_START_REPLAY_WINDOW_MS;
  await expect(new LambdaMicrovmComputeStrategy().startSession(input))
    .rejects.toThrow('MICROVM_START_OUTCOME_UNKNOWN');
  expect(runCalls()).toHaveLength(1);
  expect(mockS3Send.mock.calls.filter(([c]) => c.kind === 'put' && c.input.Key.endsWith('/payload.json'))).toHaveLength(1);
});

test.each([TaskStatus.CANCELLED, TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.TIMED_OUT])(
  '%s before starting never creates a MicroVM or writes a payload', async (status) => {
    record.status = status;
    await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow('MICROVM_START_TASK_CLOSED');
    expect(mockMicrovmSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  },
);

test('cancellation during payload upload prevents RunMicrovm', async () => {
  mockS3Send.mockImplementationOnce(async () => { record.status = TaskStatus.CANCELLED; });
  await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow('MICROVM_START_TASK_CLOSED');
  expect(runCalls()).toHaveLength(0);
});

test('a cancelled task with a saved handle reaps that computer instead of starting another', async () => {
  await new LambdaMicrovmComputeStrategy().startSession(input);
  record.status = TaskStatus.CANCELLED;
  await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow('MICROVM_START_TASK_CLOSED');
  expect(runCalls()).toHaveLength(1);
  expect(mockMicrovmSend).toHaveBeenLastCalledWith({
    kind: 'terminate', input: { microvmIdentifier: handle.microvmId },
  });
});

test('failure to save a returned handle terminates the known computer', async () => {
  const normal = mockDdbSend.getMockImplementation()!;
  mockDdbSend.mockImplementation(async (command) => {
    if (command.input.ExpressionAttributeValues?.[':handle']) throw new Error('DynamoDB unavailable');
    return normal(command);
  });
  await expect(new LambdaMicrovmComputeStrategy().startSession(input))
    .rejects.toThrow('MICROVM_START_RECEIPT_SAVE_FAILED');
  expect(mockMicrovmSend).toHaveBeenLastCalledWith({
    kind: 'terminate', input: { microvmIdentifier: handle.microvmId },
  });
});

test('a lost receipt-write response recovers the committed handle without termination', async () => {
  const normal = mockDdbSend.getMockImplementation()!;
  mockDdbSend.mockImplementation(async (command) => {
    const result = await normal(command);
    if (command.input.ExpressionAttributeValues?.[':handle']) throw new Error('write response lost');
    return result;
  });
  expect(await new LambdaMicrovmComputeStrategy().startSession(input)).toEqual(handle);
  expect(mockMicrovmSend).toHaveBeenCalledTimes(1);
  expect(record.microvm_start.handle).toEqual(handle);
});

test.each(['get', 'update'])(
  'a failed initial receipt %s prevents both payload upload and service creation', async (failedOperation) => {
    const normal = mockDdbSend.getMockImplementation()!;
    mockDdbSend.mockImplementation(async (command) => {
      if (command.kind === failedOperation) throw new Error('DynamoDB unavailable');
      return normal(command);
    });
    await expect(new LambdaMicrovmComputeStrategy().startSession(input)).rejects.toThrow('DynamoDB unavailable');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  },
);

test('a competing receipt claim is re-read rather than overwritten', async () => {
  const normal = mockDdbSend.getMockImplementation()!;
  let raced = false;
  mockDdbSend.mockImplementation(async (command) => {
    if (command.input.ExpressionAttributeValues?.[':receipt'] && !raced) {
      raced = true;
      record.microvm_start = command.input.ExpressionAttributeValues[':receipt'];
    }
    return normal(command);
  });
  expect(await claimMicrovmStart(TASK_ID, 'user', 'hash')).toEqual({ clientToken: TASK_ID, closed: false });
  expect(mockDdbSend.mock.calls.filter(([command]) => command.kind === 'update')).toHaveLength(1);
});

test('request fingerprints cover platform settings and full S3 content', () => {
  const first = microvmStartRequestHash({ image: 'a', pointer: 's3://b/k' }, { prompt: 'one', repo: 'r' });
  expect(microvmStartRequestHash({ pointer: 's3://b/k', image: 'a' }, { repo: 'r', prompt: 'one' })).toBe(first);
  expect(microvmStartRequestHash({ image: 'b', pointer: 's3://b/k' }, { prompt: 'one', repo: 'r' })).not.toBe(first);
  expect(microvmStartRequestHash({ image: 'a', pointer: 's3://b/k' }, { prompt: 'two', repo: 'r' })).not.toBe(first);
});
