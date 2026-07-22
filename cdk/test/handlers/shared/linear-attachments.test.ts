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

// dns.lookup is used for the SSRF guard — resolve to a public IP by default.
const dnsLookupMock = jest.fn();
jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}));

import { AttachmentScreeningError, type ScreeningConfig } from '../../../src/handlers/shared/attachment-screening';
import {
  downloadScreenAndStoreLinearAttachments,
  isLinearUploadsUrl,
  LinearAttachmentError,
} from '../../../src/handlers/shared/linear-attachments';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../../../src/handlers/shared/validation';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const TEXT_BYTES = Buffer.from('log line one\nlog line two\n');

const putSendMock = jest.fn();
const s3Client = { send: putSendMock } as unknown as import('@aws-sdk/client-s3').S3Client;

const screeningConfig: ScreeningConfig = {
  guardrailId: 'gr-1',
  guardrailVersion: '1',
  bedrockClient: {} as never,
};

function storageCtx() {
  return {
    s3Client,
    bucketName: 'attachments-bucket',
    screeningConfig,
    userId: 'user-1',
    taskId: 'task-1',
    accessToken: 'lin_oauth_at',
    linearWorkspaceId: 'ws-1',
  };
}

const UPLOAD_URL = 'https://uploads.linear.app/aaaa-1111/bbbb-2222/screenshot.png?signature=abc';
function desc(...urls: string[]): string {
  return `Some issue text\n\n${urls.map((u, i) => `![img${i}](${u})`).join('\n')}\n\nmore text`;
}
/** Description with plain-link (file) markdown `[label](url)` rather than image `![]()`. */
function fileDesc(...urls: string[]): string {
  return `Some issue text\n\n${urls.map((u, i) => `[file${i}](${u})`).join('\n')}\n\nmore text`;
}

/** A fetch Response-like object whose body streams the given buffer once. */
function bytesResponse(buf: Buffer, status = 200, contentType = 'image/png'): Response {
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
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

beforeEach(() => {
  screenImageMock.mockReset();
  screenImageMock.mockImplementation((content: Buffer) => Promise.resolve({
    content,
    checksum: 'sha256:abc',
    screening: { status: 'passed', screened_at: '2026-07-22T00:00:00Z' },
  }));
  screenTextFileMock.mockReset();
  screenTextFileMock.mockImplementation((content: Buffer) => Promise.resolve({
    content,
    checksum: 'sha256:def',
    screening: { status: 'passed', screened_at: '2026-07-22T00:00:00Z' },
  }));
  putSendMock.mockReset();
  putSendMock.mockResolvedValue({ VersionId: 'v1' });
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: '203.0.113.7', family: 4 }]);
  (global.fetch as unknown) = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isLinearUploadsUrl', () => {
  test('matches uploads.linear.app and subdomains, rejects others', () => {
    expect(isLinearUploadsUrl('https://uploads.linear.app/x/y/z.png')).toBe(true);
    expect(isLinearUploadsUrl('https://eu.uploads.linear.app/x/y/z.png')).toBe(true);
    expect(isLinearUploadsUrl('https://cdn.example.com/z.png')).toBe(false);
    expect(isLinearUploadsUrl('not a url')).toBe(false);
  });
});

describe('downloadScreenAndStoreLinearAttachments', () => {
  test('happy path: fetches uploads.linear.app image with the OAuth bearer, screens, uploads, returns a passed record', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PNG_BYTES));
    const records = await downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx());

    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('image');
    expect(records[0].content_type).toBe('image/png');
    expect(records[0].screening.status).toBe('passed');
    expect(screenImageMock).toHaveBeenCalled();
    expect(putSendMock).toHaveBeenCalledTimes(1);
    // Bearer header carried the workspace token.
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer lin_oauth_at');
  });

  test('ignores non-uploads.linear.app images (public CDN images go via the URL path)', async () => {
    const records = await downloadScreenAndStoreLinearAttachments(
      desc('https://cdn.example.com/pic.png'), 10, storageCtx(),
    );
    expect(records).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('no-op when description is empty or has no uploads', async () => {
    expect(await downloadScreenAndStoreLinearAttachments(undefined, 10, storageCtx())).toEqual([]);
    expect(await downloadScreenAndStoreLinearAttachments('plain text', 10, storageCtx())).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('respects remainingSlots (combined 10-attachment cap)', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const urls = Array.from({ length: 5 }, (_, i) => `https://uploads.linear.app/u/${i}/p${i}.png`);
    const records = await downloadScreenAndStoreLinearAttachments(desc(...urls), 2, storageCtx());
    expect(records).toHaveLength(2); // only 2 slots free
  });

  test('de-dupes the same upload referenced twice', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const records = await downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL, UPLOAD_URL), 10, storageCtx());
    expect(records).toHaveLength(1);
  });

  test('zero remainingSlots → no fetch', async () => {
    const records = await downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 0, storageCtx());
    expect(records).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('401 on download → LinearAttachmentError (signed URL stale; fail-closed, no refresh loop)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 401));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1); // no retry loop for a stale signed URL
  });

  test('zero-byte body → LinearAttachmentError (fail-closed)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.alloc(0)));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('magic-byte mismatch → LinearAttachmentError (fail-closed)', async () => {
    // content-type says png but bytes are junk
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.from([0x00, 0x01, 0x02]), 200, 'image/png'));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(screenImageMock).not.toHaveBeenCalled();
  });

  test('fetches a PDF file link, screens it as text, returns a file record', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PDF_BYTES, 200, 'application/pdf'));
    const records = await downloadScreenAndStoreLinearAttachments(
      fileDesc('https://uploads.linear.app/u/p/design.pdf'), 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('file');
    expect(records[0].content_type).toBe('application/pdf');
    expect(records[0].token_estimate).toBeUndefined(); // files don't carry a vision-token estimate
    expect(screenTextFileMock).toHaveBeenCalled();
    expect(screenImageMock).not.toHaveBeenCalled();
    expect(putSendMock).toHaveBeenCalledTimes(1);
  });

  test('matches the angle-bracket autolink URL form Linear normalizes links into (ABCA-744)', async () => {
    // Linear round-trips `[f](https://…)` into `[f](<https://…>)`. The un-bracketed
    // pattern dropped it silently (live-caught on ABCA-744) — the attachment
    // never reached S3 and the task ran without it.
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PDF_BYTES, 200, 'application/pdf'));
    const desc = 'See [design.pdf](<https://uploads.linear.app/u/p/design.pdf>) attached.';
    const records = await downloadScreenAndStoreLinearAttachments(desc, 10, storageCtx());
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('file');
    expect(records[0].content_type).toBe('application/pdf');
    // The captured URL must NOT include the trailing '>' (the fetch must hit the real URL).
    const fetchedUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(fetchedUrl).toBe('https://uploads.linear.app/u/p/design.pdf');
  });

  test('types a generic octet-stream response by its .log extension and screens as text', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(TEXT_BYTES, 200, 'application/octet-stream'));
    const records = await downloadScreenAndStoreLinearAttachments(
      fileDesc('https://uploads.linear.app/u/l/output.log'), 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('file');
    expect(records[0].content_type).toBe('text/x-log');
    expect(screenTextFileMock).toHaveBeenCalled();
  });

  test('silently SKIPS an unsupported type (docx/zip) — not a task error', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      bytesResponse(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 200, 'application/zip'),
    );
    const records = await downloadScreenAndStoreLinearAttachments(
      fileDesc('https://uploads.linear.app/u/z/bundle.zip'), 10, storageCtx(),
    );
    expect(records).toHaveLength(0);
    expect(screenImageMock).not.toHaveBeenCalled();
    expect(screenTextFileMock).not.toHaveBeenCalled();
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('sniffs JPEG when content-type is generic but bytes are a JPEG', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(JPEG_BYTES, 200, 'application/octet-stream'));
    const records = await downloadScreenAndStoreLinearAttachments(
      desc('https://uploads.linear.app/u/j/photo.jpg'), 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].content_type).toBe('image/jpeg');
  });

  test('screening block → LinearAttachmentError (fail-closed)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PNG_BYTES));
    screenImageMock.mockRejectedValueOnce(new AttachmentScreeningError('blocked: prompt attack'));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('screening returns blocked status → LinearAttachmentError', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PNG_BYTES));
    screenImageMock.mockResolvedValueOnce({
      content: PNG_BYTES,
      checksum: 'sha256:abc',
      screening: { status: 'blocked', categories: ['VIOLENCE'], screened_at: '2026-07-22T00:00:00Z' },
    });
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
  });

  test('SSRF: host resolving to a private IP → LinearAttachmentError, no fetch', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('body exceeding size limit while streaming → LinearAttachmentError', async () => {
    // Stream a body larger than the cap in one chunk.
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1)]);
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(tooBig));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
  });

  test('deletes already-uploaded objects when a later attachment fails (no orphans)', async () => {
    const deleteSendMock = putSendMock; // same client.send
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(bytesResponse(PNG_BYTES)) // #1 ok
      .mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 401)); // #2 auth-fail → throw
    await expect(
      downloadScreenAndStoreLinearAttachments(
        desc('https://uploads.linear.app/u/1/a.png', 'https://uploads.linear.app/u/2/b.png'),
        10, storageCtx(),
      ),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    // A DeleteObjectsCommand was sent to clean up the one uploaded object.
    const sentDeletes = deleteSendMock.mock.calls.filter(
      (c) => c[0]?.constructor?.name === 'DeleteObjectsCommand',
    );
    expect(sentDeletes.length).toBeGreaterThanOrEqual(1);
  });
});
