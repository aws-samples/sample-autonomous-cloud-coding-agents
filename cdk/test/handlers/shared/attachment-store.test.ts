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

// `screenAndStore` and `deleteStoredObjects`, called directly. What comes before
// them (the download, the limits, the batch and its cleanup) belongs to the Linear
// and the Jira module and is tested in their suites.

const screenImageMock = jest.fn();
const screenTextFileMock = jest.fn();
jest.mock('../../../src/handlers/shared/attachment-screening', () => ({
  ...jest.requireActual('../../../src/handlers/shared/attachment-screening'),
  screenImage: (...args: unknown[]) => screenImageMock(...args),
  screenTextFile: (...args: unknown[]) => screenTextFileMock(...args),
}));

import { DeleteObjectsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { AttachmentScreeningError, type ScreeningConfig } from '../../../src/handlers/shared/attachment-screening';
import { deleteStoredObjects, screenAndStore } from '../../../src/handlers/shared/attachment-store';
import { logger } from '../../../src/handlers/shared/logger';

/** The header of a PNG of that size, padded to `length` bytes: all that the type check and the token estimate read. */
function png(width: number, height: number, length = 24): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const PNG = png(640, 480);
// No frame header, so no dimensions to read.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TEXT = Buffer.from('log line one\nlog line two\n');

const KEY = 'attachments/user-1/task-1/att-1/stored-name';
const screeningConfig: ScreeningConfig = { guardrailId: 'gr-1', guardrailVersion: '1', bedrockClient: {} as never };

const s3Send = jest.fn();
const s3Client = { send: s3Send } as unknown as S3Client;

// What the caller's `fail` returns, whatever it is told.
const refused = new Error('refused');
const fail = jest.fn();

let logInfo: jest.SpyInstance;
let logError: jest.SpyInstance;

type Input = Parameters<typeof screenAndStore>[0];

function input(overrides: Partial<Input> = {}): Input {
  return {
    surface: 'Linear',
    content: PNG,
    mimeType: 'image/png',
    attachmentId: 'att-1',
    filename: 'stored-name',
    displayName: 'Display name',
    store: { s3Client, bucketName: 'attachments-bucket', screeningConfig, userId: 'user-1', taskId: 'task-1' },
    uploadedKeys: [],
    logFields: { linear_workspace_id: 'ws-1' },
    fail,
    ...overrides,
  };
}

/** A screening call that passes the bytes it was given. */
const passes = (content: Buffer) => Promise.resolve({ content, checksum: 'sha256:abc', screening: { status: 'passed' } });

beforeEach(() => {
  screenImageMock.mockReset().mockImplementation(passes);
  screenTextFileMock.mockReset().mockImplementation(passes);
  s3Send.mockReset().mockResolvedValue({ VersionId: 'v1' });
  fail.mockReset().mockReturnValue(refused);
  logInfo = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  logError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('screenAndStore', () => {
  test('screens an image under its display name, stores it under the path-safe name and returns its record', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-22T10:00:00Z'));
    const call = input();

    const record = await screenAndStore(call);

    expect(screenImageMock).toHaveBeenCalledWith(PNG, 'image/png', 'Display name', screeningConfig);
    expect(screenTextFileMock).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledTimes(1);
    const put = s3Send.mock.calls[0][0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toEqual({ Bucket: 'attachments-bucket', Key: KEY, Body: PNG, ContentType: 'image/png' });
    expect(record).toStrictEqual({
      attachment_id: 'att-1',
      type: 'image',
      content_type: 'image/png',
      filename: 'stored-name',
      s3_key: KEY,
      s3_version_id: 'v1',
      size_bytes: 24,
      screening: { status: 'passed', screened_at: '2026-07-22T10:00:00.000Z' },
      checksum_sha256: 'sha256:abc',
      token_estimate: 520,
    });
    expect(call.uploadedKeys).toEqual([KEY]);
    expect(logInfo).toHaveBeenCalledWith('Linear attachment downloaded, screened, and stored', {
      linear_workspace_id: 'ws-1',
      attachment_filename: 'Display name',
      s3_key: KEY,
    });
  });

  test('stores and measures the bytes the screening call hands back', async () => {
    const screened = png(320, 240, 30);
    screenImageMock.mockResolvedValue({ content: screened, checksum: 'sha256:abc', screening: { status: 'passed' } });

    const record = await screenAndStore(input());

    expect((s3Send.mock.calls[0][0] as PutObjectCommand).input.Body).toBe(screened);
    // The estimate of a 320 x 240 image: the 640 x 480 one that went in gives 520.
    expect(record).toMatchObject({ size_bytes: 30, token_estimate: 136 });
  });

  test("records 'unversioned' when the bucket answers without a version id", async () => {
    s3Send.mockResolvedValue({});

    expect((await screenAndStore(input())).s3_version_id).toBe('unversioned');
  });

  test('screens a file as text, under its display name too, and records no token estimate', async () => {
    const record = await screenAndStore(input({ content: TEXT, mimeType: 'text/plain' }));

    expect(screenTextFileMock).toHaveBeenCalledWith(TEXT, 'text/plain', 'Display name', screeningConfig);
    expect(screenImageMock).not.toHaveBeenCalled();
    expect(record).toMatchObject({ type: 'file', content_type: 'text/plain', filename: 'stored-name', s3_key: KEY });
    expect(record).not.toHaveProperty('token_estimate');
  });

  test('screens a JPEG as an image, and records no token estimate when its dimensions cannot be read', async () => {
    const record = await screenAndStore(input({ content: JPEG, mimeType: 'image/jpeg' }));

    expect(screenImageMock).toHaveBeenCalledWith(JPEG, 'image/jpeg', 'Display name', screeningConfig);
    expect(record.type).toBe('image');
    expect(record).not.toHaveProperty('token_estimate');
  });

  test('refuses bytes that do not match the declared type, before any screening call', async () => {
    await expect(screenAndStore(input({ content: TEXT }))).rejects.toBe(refused);

    expect(fail).toHaveBeenCalledWith("Attachment 'Display name' content does not match its declared type 'image/png'.");
    expect(screenImageMock).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  test('refuses with the verdict that the screening call throws, and hands it over as the cause', async () => {
    const verdict = new AttachmentScreeningError('blocked: prompt attack');
    screenImageMock.mockRejectedValue(verdict);

    await expect(screenAndStore(input())).rejects.toBe(refused);

    expect(fail).toHaveBeenCalledWith("Attachment 'Display name' was blocked by content screening: blocked: prompt attack", verdict);
    expect(logError).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  test('refuses in general words when the screening call fails: its error is the cause, and its text goes to the log only', async () => {
    const denied = new Error('not authorized to perform: bedrock:ApplyGuardrail');
    screenImageMock.mockRejectedValue(denied);

    await expect(screenAndStore(input())).rejects.toBe(refused);

    expect(fail).toHaveBeenCalledWith("Attachment 'Display name' could not be screened: the content screening service is unavailable.", denied);
    expect(logError).toHaveBeenCalledWith('Screening call failed for Linear attachment', {
      linear_workspace_id: 'ws-1',
      attachment_filename: 'Display name',
      error: 'not authorized to perform: bedrock:ApplyGuardrail',
    });
    expect(s3Send).not.toHaveBeenCalled();
  });

  test('refuses a blocked result with its categories and stores nothing', async () => {
    screenImageMock.mockResolvedValue({ content: PNG, checksum: 'sha256:abc', screening: { status: 'blocked', categories: ['VIOLENCE', 'HATE'] } });

    await expect(screenAndStore(input())).rejects.toBe(refused);

    expect(fail).toHaveBeenCalledWith("Attachment 'Display name' was blocked by content policy: VIOLENCE, HATE");
    expect(s3Send).not.toHaveBeenCalled();
  });

  test('refuses in general words when the put fails: its error is the cause, and its text goes to the log with the metric type', async () => {
    const denied = new Error('not authorized to perform: s3:PutObject');
    s3Send.mockRejectedValue(denied);
    const call = input();

    await expect(screenAndStore(call)).rejects.toBe(refused);

    expect(fail).toHaveBeenCalledWith("Attachment 'Display name' could not be stored.", denied);
    expect(logError).toHaveBeenCalledWith('S3 upload failed for Linear attachment', {
      linear_workspace_id: 'ws-1',
      attachment_filename: 'Display name',
      s3_key: KEY,
      error: 'not authorized to perform: s3:PutObject',
      metric_type: 'linear_attachment_upload_failure',
    });
    expect(call.uploadedKeys).toEqual([]);
  });

  test('puts the key on the list of the caller as soon as the object is stored, also when the record then throws', async () => {
    // An empty file passes the checks and is stored; the record refuses a size of 0.
    const call = input({ content: Buffer.alloc(0), mimeType: 'text/plain' });

    await expect(screenAndStore(call)).rejects.toThrow('Passed screening requires');

    expect(call.uploadedKeys).toEqual([KEY]);
    expect(logInfo).not.toHaveBeenCalled();
  });
});

describe('deleteStoredObjects', () => {
  const keys = ['attachments/user-1/task-1/att-1/one.png', 'attachments/user-1/task-1/att-2/two.txt'];

  test('sends nothing for an empty list', async () => {
    await deleteStoredObjects(s3Client, 'attachments-bucket', [], 'Jira');

    expect(s3Send).not.toHaveBeenCalled();
  });

  test('deletes every key in one call and logs nothing when all are deleted', async () => {
    s3Send.mockResolvedValue({ Deleted: keys.map((Key) => ({ Key })), Errors: [] });

    await deleteStoredObjects(s3Client, 'attachments-bucket', keys, 'Jira');

    expect(s3Send).toHaveBeenCalledTimes(1);
    const command = s3Send.mock.calls[0][0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({ Bucket: 'attachments-bucket', Delete: { Objects: [{ Key: keys[0] }, { Key: keys[1] }] } });
    expect(logError).not.toHaveBeenCalled();
  });

  test('logs the keys that remain after a partial failure', async () => {
    s3Send.mockResolvedValue({ Deleted: [{ Key: keys[0] }], Errors: [{ Key: keys[1], Code: 'AccessDenied' }] });

    await expect(deleteStoredObjects(s3Client, 'attachments-bucket', keys, 'Jira')).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith('Partial cleanup of Jira attachment objects — some remain', { failed_keys: [keys[1]] });
  });

  test('logs a rejected call with every key and does not throw', async () => {
    s3Send.mockRejectedValue(new Error('not authorized to perform: s3:DeleteObject'));

    await expect(deleteStoredObjects(s3Client, 'attachments-bucket', keys, 'Jira')).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith('Cleanup of Jira attachment objects failed (90-day lifecycle is backstop)', {
      keys,
      error: 'not authorized to perform: s3:DeleteObject',
    });
  });
});
