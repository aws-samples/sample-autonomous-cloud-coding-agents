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
import { logger } from '../../../src/handlers/shared/logger';
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
function fileDesc(...urls: string[]): string {
  return `Some issue text\n\n${urls.map((u, i) => `[file${i}](${u})`).join('\n')}\n\nmore text`;
}
function labeledDesc(label: string, url: string): string {
  return `Some issue text\n\n[${label}](${url})\n\nmore text`;
}

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
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer lin_oauth_at');
  });

  test('two uploads whose names differ only by . vs - are BOTH kept', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const records = await downloadScreenAndStoreLinearAttachments(
      desc('https://uploads.linear.app/u/p/design.v1.png', 'https://uploads.linear.app/u/p/design-v1.png'),
      10,
      storageCtx(),
    );
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.attachment_id)).size).toBe(2);
  });

  test('a long descriptive label does NOT silently drop the attachment', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const longLabel = 'a detailed description of this diagram '.repeat(20);
    const records = await downloadScreenAndStoreLinearAttachments(
      `![${longLabel}](https://uploads.linear.app/u/p/spec.png)`, 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
  });

  test('a hostile URL-shaped description is bounded too, not just a bracket run', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const hostile = '[](https://a'.repeat(20_000);
      const records = await downloadScreenAndStoreLinearAttachments(hostile, 10, storageCtx());
      expect(records).toEqual([]);
      const capped = warn.mock.calls.some(([msg]) => String(msg).includes('attachment-scan cap'));
      expect(capped).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a large bracket-heavy description scans in bounded time, not quadratic', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const hostile = '['.repeat(200_000);
      const records = await downloadScreenAndStoreLinearAttachments(hostile, 10, storageCtx());
      expect(records).toEqual([]);
      expect(warn.mock.calls.some(([m]) => String(m).includes('attachment-scan cap'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
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

  test('overflow past remainingSlots throws (loud, not a silent truncation) — finding #2', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const urls = Array.from({ length: 5 }, (_, i) => `https://uploads.linear.app/u/${i}/p${i}.png`);
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(...urls), 2, storageCtx()),
    ).rejects.toThrow(/over the limit of 2|Remove some attachments/i);
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('exactly filling the slot budget is fine (no overflow error)', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const urls = Array.from({ length: 2 }, (_, i) => `https://uploads.linear.app/u/${i}/p${i}.png`);
    const records = await downloadScreenAndStoreLinearAttachments(desc(...urls), 2, storageCtx());
    expect(records).toHaveLength(2);
  });

  test('de-dupes the same upload referenced twice', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PNG_BYTES)));
    const records = await downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL, UPLOAD_URL), 10, storageCtx());
    expect(records).toHaveLength(1);
  });

  test('zero remainingSlots WITH a Linear upload present → REJECTS (no silent drop, finding #6)', async () => {
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 0, storageCtx()),
    ).rejects.toThrow(/already used up|limit/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('zero remainingSlots with NO uploads → clean no-op', async () => {
    const records = await downloadScreenAndStoreLinearAttachments('plain text, no uploads', 0, storageCtx());
    expect(records).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('401 on download → LinearAttachmentError (signed URL stale; fail-closed, no refresh loop)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 401));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('zero-byte body → LinearAttachmentError (fail-closed)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(Buffer.alloc(0)));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('magic-byte mismatch → LinearAttachmentError (fail-closed)', async () => {
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
    expect(records[0].token_estimate).toBeUndefined();
    expect(screenTextFileMock).toHaveBeenCalled();
    expect(screenImageMock).not.toHaveBeenCalled();
    expect(putSendMock).toHaveBeenCalledTimes(1);
  });

  test('matches the angle-bracket autolink URL form Linear normalizes links into', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PDF_BYTES, 200, 'application/pdf'));
    const autolinkDesc = 'See [design.pdf](<https://uploads.linear.app/u/p/design.pdf>) attached.';
    const records = await downloadScreenAndStoreLinearAttachments(autolinkDesc, 10, storageCtx());
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('file');
    expect(records[0].content_type).toBe('application/pdf');
    const fetchedUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(fetchedUrl).toBe('https://uploads.linear.app/u/p/design.pdf');
  });

  test('types a generic octet-stream response by the .log extension in its markdown label', async () => {
    // The uploads.linear.app URL path is a UUID with no extension.
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(TEXT_BYTES, 200, 'application/octet-stream'));
    const records = await downloadScreenAndStoreLinearAttachments(
      labeledDesc('output.log', 'https://uploads.linear.app/u/l/9c8b-uuid'), 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('file');
    expect(records[0].content_type).toBe('text/x-log');
    expect(screenTextFileMock).toHaveBeenCalled();
  });

  test('REJECTS an unsupported type fail-closed, naming the FRIENDLY filename + supported types', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      bytesResponse(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 200, 'application/zip'),
    );
    await expect(
      downloadScreenAndStoreLinearAttachments(
        labeledDesc('spec.docx', 'https://uploads.linear.app/u/z/9a8b7c6d-uuid'), 10, storageCtx(),
      ),
    ).rejects.toThrow(/Attachment 'spec\.docx' is not a supported file type.*PDF/i);
    expect(screenImageMock).not.toHaveBeenCalled();
    expect(screenTextFileMock).not.toHaveBeenCalled();
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('surfaces the friendly filename (markdown label) in a screening-block error, not the UUID', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PDF_BYTES, 200, 'application/pdf'));
    screenTextFileMock.mockRejectedValueOnce(new AttachmentScreeningError('blocked: prompt attack'));
    await expect(
      downloadScreenAndStoreLinearAttachments(
        labeledDesc('design.pdf', 'https://uploads.linear.app/u/p/deadbeef-uuid'), 10, storageCtx(),
      ),
    ).rejects.toThrow(/Attachment 'design\.pdf' was blocked by content screening/);
  });

  test('falls back to the path-safe filename when the markdown label is empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      bytesResponse(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 200, 'application/zip'),
    );
    await expect(
      downloadScreenAndStoreLinearAttachments(
        labeledDesc('', 'https://uploads.linear.app/u/z/bundle-uuid'), 10, storageCtx(),
      ),
    ).rejects.toThrow(/not a supported file type/i);
  });

  test('a .txt-LABELED binary payload is REJECTED, not stored as text (finding #3)', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(binary, 200, 'application/octet-stream'));
    await expect(
      downloadScreenAndStoreLinearAttachments(
        labeledDesc('diagram.txt', 'https://uploads.linear.app/u/x/evil-uuid'), 10, storageCtx(),
      ),
    ).rejects.toThrow(/not a supported file type|does not match its declared type/i);
    expect(screenTextFileMock).not.toHaveBeenCalled();
    expect(putSendMock).not.toHaveBeenCalled();
  });

  test('a .pdf-LABELED non-PDF is NOT promoted to application/pdf by the label (finding #3)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      bytesResponse(Buffer.from([0x00, 0x01, 0x02, 0x03]), 200, 'application/octet-stream'),
    );
    await expect(
      downloadScreenAndStoreLinearAttachments(
        labeledDesc('notreally.pdf', 'https://uploads.linear.app/u/x/fake-uuid'), 10, storageCtx(),
      ),
    ).rejects.toThrow(/not a supported file type/i);
  });

  test('hydrates a native paperclip attachment (uploads.linear.app) — finding #1', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PDF_BYTES, 200, 'application/pdf'));
    const records = await downloadScreenAndStoreLinearAttachments(
      'Implement the attached spec.', 10, storageCtx(),
      [{ title: 'spec.pdf', url: 'https://uploads.linear.app/u/pc/paperclip-uuid' }],
    );
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('file');
    expect(records[0].content_type).toBe('application/pdf');
    expect(screenTextFileMock).toHaveBeenCalled();
  });

  test('ignores an external-link paperclip (not uploads.linear.app)', async () => {
    const records = await downloadScreenAndStoreLinearAttachments(
      'See the design.', 10, storageCtx(),
      [{ title: 'Figma', url: 'https://figma.com/file/abc' }],
    );
    expect(records).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('de-dupes a file that is BOTH a paperclip and a description link', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => Promise.resolve(bytesResponse(PDF_BYTES, 200, 'application/pdf')));
    const url = 'https://uploads.linear.app/u/dup/same-uuid';
    const records = await downloadScreenAndStoreLinearAttachments(
      labeledDesc('spec.pdf', url), 10, storageCtx(),
      [{ title: 'spec.pdf', url }],
    );
    expect(records).toHaveLength(1);
  });

  test('sniffs JPEG when content-type is generic but bytes are a JPEG', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(JPEG_BYTES, 200, 'application/octet-stream'));
    const records = await downloadScreenAndStoreLinearAttachments(
      desc('https://uploads.linear.app/u/j/photo.jpg'), 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].content_type).toBe('image/jpeg');
  });

  test('a PDF served as text/plain is typed as PDF by magic bytes, NOT screened as raw text (finding #2)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PDF_BYTES, 200, 'text/plain'));
    const records = await downloadScreenAndStoreLinearAttachments(
      labeledDesc('sneaky.txt', 'https://uploads.linear.app/u/p/sneaky-uuid'), 10, storageCtx(),
    );
    expect(records).toHaveLength(1);
    expect(records[0].content_type).toBe('application/pdf');
    expect(screenTextFileMock).toHaveBeenCalledWith(expect.anything(), 'application/pdf', expect.anything(), expect.anything());
  });

  test('SSRF: an IPv4-mapped IPv6 metadata address (::ffff:169.254.169.254) is rejected (finding #8)', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: '::ffff:169.254.169.254', family: 6 }]);
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('SSRF: an fe80::/10 link-local address beyond the fe80 prefix (fea9::1) is rejected (finding #8)', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: 'fea9::1', family: 6 }]);
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(global.fetch).not.toHaveBeenCalled();
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

  describe('the error text is posted on the Linear issue, so it carries no internal error message', () => {
    test('a failed screening call: the SDK error stays in the log', async () => {
      const sdkText = 'User: arn:aws:sts::123456789012:assumed-role/Stack-WebhookProcessorRole/fn is not authorized to perform: bedrock:ApplyGuardrail';
      (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(PNG_BYTES));
      screenImageMock.mockRejectedValueOnce(Object.assign(new Error(sdkText), { name: 'AccessDeniedException' }));
      const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

      const err = await downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LinearAttachmentError);
      expect((err as Error).message).toContain('could not be screened');
      expect((err as Error).message).not.toContain('arn:aws');
      expect((err as Error).message).not.toContain('not authorized');
      expect(JSON.stringify(logged.mock.calls)).toContain(sdkText);
      expect(putSendMock).not.toHaveBeenCalled();
    });

    test.each([
      ['the DNS lookup', 'getaddrinfo ENOTFOUND uploads.linear.app'],
      ['the request', 'connect ECONNREFUSED 10.1.2.3:443'],
    ])('a failed download, %s: the network error stays in the log', async (step, networkText) => {
      if (step === 'the DNS lookup') dnsLookupMock.mockRejectedValueOnce(new Error(networkText));
      else (global.fetch as jest.Mock).mockRejectedValueOnce(new Error(networkText));
      const logged = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const err = await downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LinearAttachmentError);
      expect((err as Error).message).toContain('could not be downloaded');
      expect((err as Error).message).not.toContain(networkText);
      expect(JSON.stringify(logged.mock.calls)).toContain(networkText);
    });
  });

  test('SSRF: host resolving to a private IP → LinearAttachmentError, no fetch', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('body exceeding size limit while streaming → LinearAttachmentError', async () => {
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1)]);
    (global.fetch as jest.Mock).mockResolvedValueOnce(bytesResponse(tooBig));
    await expect(
      downloadScreenAndStoreLinearAttachments(desc(UPLOAD_URL), 10, storageCtx()),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
  });

  test('deletes already-uploaded objects when a later attachment fails (no orphans)', async () => {
    const deleteSendMock = putSendMock;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(bytesResponse(PNG_BYTES))
      .mockResolvedValueOnce(bytesResponse(Buffer.alloc(0), 401));
    await expect(
      downloadScreenAndStoreLinearAttachments(
        desc('https://uploads.linear.app/u/1/a.png', 'https://uploads.linear.app/u/2/b.png'),
        10, storageCtx(),
      ),
    ).rejects.toBeInstanceOf(LinearAttachmentError);
    const sentDeletes = deleteSendMock.mock.calls.filter(
      (c) => c[0]?.constructor?.name === 'DeleteObjectsCommand',
    );
    expect(sentDeletes.length).toBeGreaterThanOrEqual(1);
  });
});
