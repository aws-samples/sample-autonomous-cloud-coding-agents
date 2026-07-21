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

const resolveJiraOauthTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: (...args: unknown[]) => resolveJiraOauthTokenMock(...args),
}));

const screenImageMock = jest.fn();
const screenTextFileMock = jest.fn();
jest.mock('../../../src/handlers/shared/attachment-screening', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/attachment-screening');
  return {
    ...actual,
    screenImage: (...args: unknown[]) => screenImageMock(...args),
    screenTextFile: (...args: unknown[]) => screenTextFileMock(...args),
  };
});

import { AttachmentScreeningError, type ScreeningConfig } from '../../../src/handlers/shared/attachment-screening';
import {
  downloadScreenAndStoreJiraAttachments,
  fetchRecentHumanComments,
  JiraAttachmentError,
} from '../../../src/handlers/shared/jira-attachments';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../../../src/handlers/shared/validation';

// Plain text validates on absence of null bytes; a leading PNG signature for
// image cases.
const TEXT_BYTES = Buffer.from('error: boom\nstacktrace...');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const putSendMock = jest.fn();
const s3Client = { send: putSendMock } as unknown as import('@aws-sdk/client-s3').S3Client;

const screeningConfig: ScreeningConfig = {
  guardrailId: 'gr-1',
  guardrailVersion: '1',
  bedrockClient: {} as never,
};

function storageCtx() {
  return {
    cloudId: 'cloud-1',
    registryTableName: 'JiraRegistry',
    s3Client,
    bucketName: 'attachments-bucket',
    screeningConfig,
    userId: 'user-1',
    taskId: 'task-1',
  };
}

/** A fetch Response-like object whose body streams the given buffer once. */
function bytesResponse(buf: Buffer, status = 200): Response {
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: new Uint8Array(buf) });
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
  } as unknown as Response;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const goodToken = {
  accessToken: 'at-1',
  scope: 'read:jira-work',
  siteUrl: 'https://acme.atlassian.net',
  oauthSecretArn: 'arn:secret',
};

beforeEach(() => {
  resolveJiraOauthTokenMock.mockReset();
  resolveJiraOauthTokenMock.mockResolvedValue(goodToken);
  screenImageMock.mockReset();
  screenTextFileMock.mockReset();
  putSendMock.mockReset();
  putSendMock.mockResolvedValue({ VersionId: 'v1' });
  (global.fetch as unknown) = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('downloadScreenAndStoreJiraAttachments', () => {
  test('happy path: downloads, screens, uploads, returns passed records', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(TEXT_BYTES));
    screenTextFileMock.mockResolvedValueOnce({
      content: TEXT_BYTES,
      contentType: 'text/plain',
      checksum: 'sum',
      screening: { status: 'passed' },
    });

    const records = await downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: TEXT_BYTES.length }],
      10,
      storageCtx(),
    );

    expect(records).toHaveLength(1);
    expect(records[0].screening.status).toBe('passed');
    expect(records[0].s3_key).toBe('attachments/user-1/task-1/att-1/error.log');
    expect(records[0].type).toBe('file');
    expect(putSendMock).toHaveBeenCalledTimes(1);
    // GET was addressed by attachment id on the gateway base, not the raw content URL.
    const fetchUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(fetchUrl).toContain('api.atlassian.com/ex/jira/cloud-1/rest/api/3/attachment/content/att-1');
    // Accept must be permissive: the content endpoint 406s on
    // `application/octet-stream` and serves the file's own media type.
    const fetchInit = (global.fetch as jest.Mock).mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchInit.headers.Accept).toBe('*/*');
  });

  test('routes images through screenImage and marks type image', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PNG_BYTES));
    screenImageMock.mockResolvedValueOnce({
      content: PNG_BYTES,
      contentType: 'image/png',
      checksum: 'sum',
      screening: { status: 'passed' },
    });

    const records = await downloadScreenAndStoreJiraAttachments(
      [{ id: 'img-1', filename: 'shot.png', mimeType: 'image/png', size: PNG_BYTES.length }],
      10,
      storageCtx(),
    );

    expect(screenImageMock).toHaveBeenCalled();
    expect(records[0].type).toBe('image');
  });

  test('filters unsupported MIME and oversized before download (silently skipped)', async () => {
    const records = await downloadScreenAndStoreJiraAttachments(
      [
        { id: 'a', filename: 'clip.gif', mimeType: 'image/gif', size: 10 },
        { id: 'b', filename: 'huge.log', mimeType: 'text/plain', size: MAX_ATTACHMENT_SIZE_BYTES + 1 },
      ],
      10,
      storageCtx(),
    );

    expect(records).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    // No token needed when nothing survives the filter.
    expect(resolveJiraOauthTokenMock).not.toHaveBeenCalled();
  });

  test('respects remainingSlots (combined 10-attachment cap)', async () => {
    // Fresh response per call — bytesResponse's stream is single-use.
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(TEXT_BYTES)));
    screenTextFileMock.mockResolvedValue({
      content: TEXT_BYTES, contentType: 'text/plain', checksum: 's', screening: { status: 'passed' },
    });

    const raw = Array.from({ length: 5 }, (_, i) => ({
      id: `att-${i}`, filename: `f${i}.log`, mimeType: 'text/plain', size: TEXT_BYTES.length,
    }));
    const records = await downloadScreenAndStoreJiraAttachments(raw, 2, storageCtx());

    expect(records).toHaveLength(2);
  });

  test('enforces the 50MB total cap on REAL downloaded bytes (declared size ignored)', async () => {
    // Each body is a real ~9MB buffer, but the declared size lies ("1"). The
    // cap must key off real bytes, so 6×9MB = 54MB > 50MB → throws mid-batch.
    const nineMb = Buffer.alloc(9 * 1024 * 1024, 0x61); // 'a' — valid text bytes
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(nineMb)));
    screenTextFileMock.mockResolvedValue({
      content: nineMb, contentType: 'text/plain', checksum: 's', screening: { status: 'passed' },
    });
    const raw = Array.from({ length: 6 }, (_, i) => ({
      id: `att-${i}`, filename: `f${i}.log`, mimeType: 'text/plain', size: 1, // under-declared
    }));

    await expect(downloadScreenAndStoreJiraAttachments(raw, 10, storageCtx()))
      .rejects.toThrow(/total size limit/);
  });

  test('rejects a zero-byte attachment fail-closed', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.alloc(0)));
    await expect(downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'empty.log', mimeType: 'text/plain', size: 0 }],
      10,
      storageCtx(),
    )).rejects.toThrow(/empty \(0 bytes\)/);
    // Nothing screened or uploaded for an empty file.
    expect(screenTextFileMock).not.toHaveBeenCalled();
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('deletes already-uploaded objects when a later attachment fails (no orphans)', async () => {
    // First attachment succeeds + uploads; second fails to download → the
    // batch throws and the first object must be cleaned up.
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(bytesResponse(TEXT_BYTES))
      .mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 500));
    screenTextFileMock.mockResolvedValueOnce({
      content: TEXT_BYTES, contentType: 'text/plain', checksum: 's', screening: { status: 'passed' },
    });

    await expect(downloadScreenAndStoreJiraAttachments(
      [
        { id: 'att-1', filename: 'a.log', mimeType: 'text/plain', size: TEXT_BYTES.length },
        { id: 'att-2', filename: 'b.log', mimeType: 'text/plain', size: TEXT_BYTES.length },
      ],
      10,
      storageCtx(),
    )).rejects.toBeInstanceOf(JiraAttachmentError);

    // One PutObject (att-1) then one DeleteObjects cleanup covering it.
    const deleteCalls = putSendMock.mock.calls.filter(
      (c: any) => c[0]?.constructor?.name === 'DeleteObjectsCommand' || c[0]?.input?.Delete,
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('magic-byte mismatch throws JiraAttachmentError (fail-closed)', async () => {
    // Declared text/plain but bytes contain a null → validateMagicBytes fails.
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.from([0x00, 0x01, 0x02])));

    await expect(downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: 3 }],
      10,
      storageCtx(),
    )).rejects.toBeInstanceOf(JiraAttachmentError);
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('screening block throws JiraAttachmentError (fail-closed)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(TEXT_BYTES));
    screenTextFileMock.mockRejectedValueOnce(new AttachmentScreeningError('PROMPT_ATTACK'));

    await expect(downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: TEXT_BYTES.length }],
      10,
      storageCtx(),
    )).rejects.toThrow(/blocked by content screening/);
  });

  test('screening returns blocked status → JiraAttachmentError', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(TEXT_BYTES));
    screenTextFileMock.mockResolvedValueOnce({
      content: TEXT_BYTES,
      contentType: 'text/plain',
      checksum: 's',
      screening: { status: 'blocked', categories: ['HATE'] },
    });

    await expect(downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: TEXT_BYTES.length }],
      10,
      storageCtx(),
    )).rejects.toThrow(/blocked by content policy/);
  });

  test('401 on download forces token refresh and retries once', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 401))
      .mockResolvedValueOnce(bytesResponse(TEXT_BYTES));
    resolveJiraOauthTokenMock
      .mockResolvedValueOnce(goodToken) // initial
      .mockResolvedValueOnce({ ...goodToken, accessToken: 'at-2' }); // forced refresh
    screenTextFileMock.mockResolvedValueOnce({
      content: TEXT_BYTES, contentType: 'text/plain', checksum: 's', screening: { status: 'passed' },
    });

    const records = await downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: TEXT_BYTES.length }],
      10,
      storageCtx(),
    );

    expect(records).toHaveLength(1);
    expect(resolveJiraOauthTokenMock).toHaveBeenLastCalledWith('cloud-1', 'JiraRegistry', { forceRefresh: true });
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(2);
  });

  test('persistent 401 (refresh returns same token) → JiraAttachmentError, no second GET', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 401));
    resolveJiraOauthTokenMock.mockResolvedValue(goodToken); // refresh yields same token

    await expect(downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: 5 }],
      10,
      storageCtx(),
    )).rejects.toThrow(/rejected the credential/);
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('body exceeding size limit while streaming → JiraAttachmentError', async () => {
    const tooBig = Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 10, 0x61);
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(tooBig));

    await expect(downloadScreenAndStoreJiraAttachments(
      // metadata claims small; the body is authoritative and overshoots.
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: 5 }],
      10,
      storageCtx(),
    )).rejects.toThrow(/could not be downloaded/);
  });

  test('unresolvable token throws JiraAttachmentError when attachments are selected', async () => {
    resolveJiraOauthTokenMock.mockResolvedValueOnce(null);
    await expect(downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'error.log', mimeType: 'text/plain', size: 5 }],
      10,
      storageCtx(),
    )).rejects.toThrow(/Could not resolve a Jira OAuth token/);
  });

  test('empty input returns [] without resolving a token', async () => {
    expect(await downloadScreenAndStoreJiraAttachments([], 10, storageCtx())).toEqual([]);
    expect(await downloadScreenAndStoreJiraAttachments('not-an-array', 10, storageCtx())).toEqual([]);
    expect(resolveJiraOauthTokenMock).not.toHaveBeenCalled();
  });

  test('sanitizes an unsafe filename into a path-traversal-safe S3 key', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(TEXT_BYTES));
    screenTextFileMock.mockResolvedValueOnce({
      content: TEXT_BYTES, contentType: 'text/plain', checksum: 's', screening: { status: 'passed' },
    });

    const records = await downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: '../../../etc/evil', mimeType: 'text/plain', size: TEXT_BYTES.length }],
      10,
      storageCtx(),
    );

    // No path traversal survives: the key stays under the per-task prefix and
    // the filename segment carries no slashes or `..`.
    expect(records).toHaveLength(1);
    expect(records[0].s3_key.startsWith('attachments/user-1/task-1/att-1/')).toBe(true);
    expect(records[0].filename).not.toContain('/');
    expect(records[0].filename).not.toContain('..');
  });

  test('rejects (skips) an attachment whose id is not a safe token', async () => {
    const records = await downloadScreenAndStoreJiraAttachments(
      [{ id: '../evil', filename: 'ok.log', mimeType: 'text/plain', size: 5 }],
      10,
      storageCtx(),
    );
    // Unsafe id → dropped before any download; nothing selected.
    expect(records).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('fetchRecentHumanComments', () => {
  const ctx = { cloudId: 'cloud-1', registryTableName: 'JiraRegistry' };

  function adf(text: string) {
    return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
  }

  test('keeps human (atlassian) authors, drops app/bot authors, renders oldest-first', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({
      comments: [
        // API returns newest-first.
        { author: { displayName: 'Grace', accountType: 'atlassian' }, body: adf('Latest human note'), created: '2026-07-03T00:00:00Z' },
        { author: { displayName: 'ABCA Bot', accountType: 'app' }, body: adf('Starting…'), created: '2026-07-02T00:00:00Z' },
        { author: { displayName: 'Ada', accountType: 'atlassian' }, body: adf('First human note'), created: '2026-07-01T00:00:00Z' },
      ],
    }));

    const comments = await fetchRecentHumanComments(ctx, 'ENG-1');

    expect(comments).toHaveLength(2);
    // Reversed to oldest-first.
    expect(comments[0].author).toBe('Ada');
    expect(comments[0].markdown).toBe('First human note');
    expect(comments[1].author).toBe('Grace');
    // URL requests newest-first, capped by maxResults.
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('orderBy=-created');
    expect(url).toContain('maxResults=10');
  });

  test('skips comments with empty rendered body', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({
      comments: [
        { author: { displayName: 'Ada', accountType: 'atlassian' }, body: adf(''), created: '2026-07-01T00:00:00Z' },
      ],
    }));
    expect(await fetchRecentHumanComments(ctx, 'ENG-1')).toEqual([]);
  });

  test('fail-open: non-2xx returns []', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({}, 500));
    expect(await fetchRecentHumanComments(ctx, 'ENG-1')).toEqual([]);
  });

  test('fail-open: fetch throws returns []', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    expect(await fetchRecentHumanComments(ctx, 'ENG-1')).toEqual([]);
  });

  test('fail-open: unresolvable token returns []', async () => {
    resolveJiraOauthTokenMock.mockResolvedValueOnce(null);
    expect(await fetchRecentHumanComments(ctx, 'ENG-1')).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
