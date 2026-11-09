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

import { createHash } from 'node:crypto';

const mockSend = jest.fn();
const mockSign = jest.fn();
const mockCredentials = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend, config: { credentials: mockCredentials } })),
  PutObjectCommand: jest.fn(input => ({ kind: 'put', input })),
  GetObjectCommand: jest.fn(input => ({ kind: 'get', input })),
  DeleteObjectCommand: jest.fn(input => ({ kind: 'delete', input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockSign(...args),
}));

import { deletePayloadReference, PAYLOAD_BOOTSTRAP, preparePayloadReference, redactPayloadUrls } from '../../../src/handlers/shared/payload-bootstrap';

const objects = new Map<string, string>();
const input = {
  bucket: 'payload-bucket',
  taskId: 'task-1',
  backend: 'lambda-microvm' as const,
  payload: { task_id: 'task-1', prompt: 'hello' },
  platformConfig: { github_token_secret_arn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:github' },
};
let loseReplyFor: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  objects.clear();
  loseReplyFor = undefined;
  mockCredentials.mockResolvedValue({ accessKeyId: 'EXAMPLE', secretAccessKey: 'unused' });
  mockSign.mockImplementation(async () => `https://payload-bucket.s3.us-east-1.amazonaws.com/task-1/payload.json?X-Amz-Security-Token=secret&X-Amz-Signature=${mockSign.mock.calls.length}`);
  mockSend.mockImplementation(async ({ kind, input: request }) => {
    if (kind === 'get') {
      if (!objects.has(request.Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => objects.get(request.Key)! } };
    }
    if (kind === 'delete') { objects.delete(request.Key); return {}; }
    if (request.IfNoneMatch === '*' && objects.has(request.Key)) {
      throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
    }
    objects.set(request.Key, request.Body);
    if (loseReplyFor === request.Key) {
      loseReplyFor = undefined;
      throw new Error('lost committed reply');
    }
    return {};
  });
});

test('separates public manifest from private payload and saved capability', async () => {
  const ref = await preparePayloadReference(input);
  const key = ref.bootstrap_s3_uri.split('/').slice(3).join('/');
  const manifest = objects.get(key)!;
  expect(key).toBe(`bootstrap/${createHash('sha256').update(manifest).digest('hex')}.json`);
  expect(JSON.parse(manifest)).toEqual({
    version: 2, backend: 'lambda-microvm', platform_config: input.platformConfig,
  });
  expect(manifest).not.toContain('hello');
  expect(manifest).not.toContain('X-Amz');
  expect(JSON.parse(objects.get('task-1/payload.json')!).agent_payload).toEqual(input.payload);
  expect(JSON.parse(objects.get('task-1/launch.json')!).reference).toEqual(ref);
  expect(mockSign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    input: { Bucket: input.bucket, Key: 'task-1/payload.json' },
  }), { expiresIn: 900 });
});

test('replay and concurrent preparation return identical launch bytes without resigning on replay', async () => {
  const first = await preparePayloadReference(input);
  const replay = await preparePayloadReference({ ...input, payload: { prompt: 'hello', task_id: 'task-1' } });
  expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  expect(mockSign).toHaveBeenCalledTimes(1);
  // Fixed pair, covering conditional object publication by competing callers.
  objects.clear();
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  const [a, b] = await Promise.all([preparePayloadReference(input), preparePayloadReference(input)]);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test.each(['task-1/payload.json', 'task-1/launch.json'])('recovers a lost committed response for %s', async key => {
  loseReplyFor = key;
  const first = await preparePayloadReference(input);
  expect(await preparePayloadReference(input)).toEqual(first);
});

test('changed instructions cannot overwrite an existing payload or launch reference', async () => {
  await preparePayloadReference(input);
  const before = objects.get('task-1/payload.json');
  await expect(preparePayloadReference({ ...input, payload: { ...input.payload, prompt: 'changed' } }))
    .rejects.toThrow('PAYLOAD_BOOTSTRAP_CONFLICT');
  expect(objects.get('task-1/payload.json')).toBe(before);
});

test('orphaned payload after a crash cannot be overwritten with changed instructions', async () => {
  await preparePayloadReference(input);
  objects.delete('task-1/launch.json');
  await expect(preparePayloadReference({ ...input, payload: { ...input.payload, prompt: 'changed' } }))
    .rejects.toThrow('PAYLOAD_BOOTSTRAP_CONFLICT');
  expect(JSON.parse(objects.get('task-1/payload.json')!).agent_payload.prompt).toBe('hello');
});

test('expired references fail closed without signing a replacement', async () => {
  await preparePayloadReference(input);
  const record = JSON.parse(objects.get('task-1/launch.json')!);
  record.reference.expires_at = Date.now() - 1;
  objects.set('task-1/launch.json', JSON.stringify(record));
  await expect(preparePayloadReference(input)).rejects.toThrow('PAYLOAD_BOOTSTRAP_EXPIRED');
  expect(mockSign).toHaveBeenCalledTimes(1);
});

test('credential lifetime bounds the link and refuses credentials expiring too soon', async () => {
  mockCredentials.mockResolvedValue({ expiration: new Date(Date.now() + 20_000) });
  await expect(preparePayloadReference(input)).rejects.toThrow('CREDENTIALS_EXPIRING');
  expect(mockSign).not.toHaveBeenCalled();
});

test.each(['../bootstrap', 'task/other', ''])('invalid task key %s performs no S3 writes', async taskId => {
  await expect(preparePayloadReference({ ...input, taskId })).rejects.toThrow('identity');
  expect(mockSend).not.toHaveBeenCalled();
});

test('oversized payload fails before uploading or signing', async () => {
  await expect(preparePayloadReference({
    ...input, payload: { ...input.payload, prompt: 'x'.repeat(PAYLOAD_BOOTSTRAP.max_payload_bytes) },
  })).rejects.toThrow('TOO_LARGE');
  expect(mockSend).not.toHaveBeenCalled();
});

test('cleanup removes the capability and payload, preserving shared configuration', async () => {
  const ref = await preparePayloadReference(input);
  await deletePayloadReference(input.bucket, input.taskId);
  expect(objects.has('task-1/payload.json')).toBe(false);
  expect(objects.has('task-1/launch.json')).toBe(false);
  expect(objects.has(ref.bootstrap_s3_uri.split('/').slice(3).join('/'))).toBe(true);
});

test('error redaction removes the whole signed URL including the session token', () => {
  expect(redactPayloadUrls('failed https://b.s3.us-east-1.amazonaws.com/key?X-Amz-Security-Token=secret&X-Amz-Signature=abc end'))
    .toBe('failed [redacted payload URL] end');
});
