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
import { Readable } from 'node:stream';

const mockS3 = jest.fn();
const mockDdb = jest.fn();
jest.mock('../../../src/handlers/shared/ua', () => ({
  makeClient: () => ({ send: mockS3 }),
  makeDocClient: () => ({ send: mockDdb }),
}));
import {
  deleteClosedTaskContinuations, loadContinuationLaunch, saveContinuationLaunch, verifyContinuationCheckpoint,
} from '../../../src/handlers/shared/microvm-continuation-storage';
import type { ContinuationRecord } from '../../../src/handlers/shared/microvm-continuation-types';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const payload = { task_id: 'task', user_id: 'user', prompt: 'saved instruction' };
const blueprint = { compute_type: 'lambda-microvm' as const };
const inputs = { version: 1, task_id: 'task', user_id: 'user', payload, blueprint, orchestrator_version: '42' };
function launch(value: unknown = inputs) {
  const bytes = Buffer.from(JSON.stringify(value));
  const sha256 = digest(bytes);
  return {
    bytes,
    receipt: {
      version: 1,
      key: `continuations/task/launch/${sha256}.json`,
      sha256,
      version_id: 'version-1',
      size_bytes: bytes.length,
      orchestrator_version: '42',
    },
  };
}
function object(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return { Body: Readable.from([bytes]), ContentLength: bytes.length, VersionId: 'version-1', ...overrides };
}
beforeEach(() => {
  mockS3.mockReset();
  mockDdb.mockReset();
  process.env.CONTINUATION_BUCKET_NAME = 'bucket';
  process.env.AWS_LAMBDA_FUNCTION_VERSION = '42';
});
afterEach(() => {
  delete process.env.CONTINUATION_BUCKET_NAME;
  delete process.env.AWS_LAMBDA_FUNCTION_VERSION;
});

test('loads the exact published launch version and rejects changed bytes', async () => {
  const saved = launch();
  mockS3.mockResolvedValueOnce(object(saved.bytes));
  expect(await loadContinuationLaunch('task', 'user', saved.receipt)).toEqual(inputs);
  expect(mockS3.mock.calls[0][0].input.VersionId).toBe('version-1');
  mockS3.mockResolvedValueOnce(object(Buffer.from('x'.repeat(saved.bytes.length))));
  await expect(loadContinuationLaunch('task', 'user', saved.receipt)).rejects.toThrow('checksum');
});

test.each([
  { VersionId: 'null' }, { VersionId: 'different' }, { ContentLength: 0 }, { ContentLength: 100_000_000 },
])('rejects incomplete or unpinned object metadata %j and closes the stream', async overrides => {
  const saved = launch();
  const response = object(saved.bytes, overrides);
  mockS3.mockResolvedValue(response);
  await expect(loadContinuationLaunch('task', 'user', saved.receipt)).rejects.toThrow('STORAGE_INVALID');
  expect(response.Body.destroyed).toBe(true);
});

test('stops a response that sends more bytes than declared', async () => {
  const saved = launch();
  const response = object(Buffer.concat([saved.bytes, Buffer.from('extra')]), { ContentLength: saved.bytes.length });
  mockS3.mockResolvedValue(response);
  await expect(loadContinuationLaunch('task', 'user', saved.receipt)).rejects.toThrow('exceeded');
  expect(response.Body.destroyed).toBe(true);
});

test('aborting checkpoint verification closes a stalled response body', async () => {
  const controller = new AbortController();
  const body = new Readable({ read() { /* Deliberately stalled transport. */ } });
  mockS3.mockImplementation(async () => {
    setImmediate(() => controller.abort());
    return { Body: body, ContentLength: 10, VersionId: 'v1' };
  });
  const record = { manifest: { key: 'manifest', version_id: 'v1' } } as ContinuationRecord;
  await expect(verifyContinuationCheckpoint(record, { abortSignal: controller.signal })).rejects.toThrow('TIMEOUT');
  expect(body.destroyed).toBe(true);
});

test.each([null, { ...inputs, user_id: 'other' }])('rejects saved input identity %j', async value => {
  const saved = launch(value);
  mockS3.mockResolvedValue(object(saved.bytes));
  await expect(loadContinuationLaunch('task', 'user', saved.receipt)).rejects.toThrow('INPUT_INVALID');
});

test('recovers a lost Put reply only after exact versioned readback', async () => {
  let published: Buffer;
  mockS3.mockImplementation(async command => {
    if (command.constructor.name === 'PutObjectCommand') {
      published = command.input.Body;
      throw new Error('reply lost');
    }
    return object(published);
  });
  mockDdb.mockResolvedValue({});
  await saveContinuationLaunch('task', 'user', payload, blueprint);
  expect(mockS3.mock.calls[0][0].input).toMatchObject({ IfNoneMatch: '*', ServerSideEncryption: 'AES256' });
  const committed = mockDdb.mock.calls[0][0].input;
  expect(committed.ExpressionAttributeValues[':receipt']).toMatchObject({ version_id: 'version-1', orchestrator_version: '42' });
  expect(committed.UpdateExpression).toContain('REMOVE #ttl');
});

test('verifies both archive versions and checksums before permitting retirement', async () => {
  const identity = { task_id: 'task', user_id: 'user', repo: 'owner/repo', attempt_id: 'vm', request_id: 'request' };
  const prefix = 'continuations/task/vm/request/';
  const conversation = { key: `${prefix}${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), size_bytes: 100, version_id: 'conversation-v' };
  const workspace = { key: `${prefix}workspace/${'b'.repeat(64)}.tar`, sha256: 'b'.repeat(64), size_bytes: 512, version_id: 'workspace-v' };
  const bytes = Buffer.from(JSON.stringify({ version: 1, identity, conversation, workspace }));
  const record: ContinuationRecord = {
    version: 1,
    state: 'READY',
    identity,
    manifest: { kind: 'manifest', key: 'manifest', sha256: digest(bytes), size_bytes: bytes.length, version_id: 'version-1' },
  };
  mockS3.mockResolvedValueOnce(object(bytes));
  for (const receipt of [conversation, workspace]) {
    mockS3.mockResolvedValueOnce({
      VersionId: receipt.version_id,
      ContentLength: receipt.size_bytes,
      ChecksumSHA256: Buffer.from(receipt.sha256, 'hex').toString('base64'),
    });
  }
  await verifyContinuationCheckpoint(record);
  expect(mockS3.mock.calls.slice(1).map(([command]) => command.input.VersionId)).toEqual(['conversation-v', 'workspace-v']);
  mockS3.mockResolvedValueOnce(object(bytes)).mockResolvedValueOnce({ VersionId: 'wrong' });
  await expect(verifyContinuationCheckpoint(record)).rejects.toThrow('version, length or checksum');
});

test('cleanup preserves pending data and removes every closed-task version before clearing its pointer', async () => {
  const options = { abortSignal: AbortSignal.timeout(1000) };
  mockDdb.mockResolvedValueOnce({ Item: { user_id: 'user', status: 'AWAITING_APPROVAL' } });
  await deleteClosedTaskContinuations('task', 'user', options);
  expect(mockS3).not.toHaveBeenCalled();
  mockDdb.mockResolvedValueOnce({ Item: { user_id: 'user', status: 'CANCELLED' } }).mockResolvedValue({});
  mockS3.mockResolvedValueOnce({
    Versions: [{ Key: 'continuations/task/object', VersionId: 'v1' }],
    DeleteMarkers: [{ Key: 'continuations/task/object', VersionId: 'v2' }],
  }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
  await deleteClosedTaskContinuations('task', 'user', options);
  expect(mockS3.mock.calls[1][0].input.Delete.Objects).toHaveLength(2);
  expect(mockDdb.mock.calls.at(-1)![0].input.UpdateExpression).toContain('REMOVE continuation, continuation_launch');
});

test('partial delete failure retains the cleanup marker for a later retry', async () => {
  mockDdb.mockResolvedValue({ Item: { user_id: 'user', status: 'FAILED' } });
  mockS3.mockResolvedValueOnce({ Versions: [{ Key: 'continuations/task/object', VersionId: 'v1' }] })
    .mockResolvedValueOnce({ Errors: [{ Code: 'AccessDenied' }] });
  await expect(deleteClosedTaskContinuations('task', 'user', {})).rejects.toThrow('CLEANUP_FAILED');
  expect(mockDdb).toHaveBeenCalledTimes(1);
});
