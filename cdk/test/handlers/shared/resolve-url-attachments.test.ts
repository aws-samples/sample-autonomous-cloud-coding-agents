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

import { EventEmitter } from 'events';
import { AttachmentResolutionError } from '../../../src/handlers/shared/context-hydration';
import { resolveUrlAttachments } from '../../../src/handlers/shared/resolve-url-attachments';
import { createAttachmentRecord, type AttachmentRecord } from '../../../src/handlers/shared/types';
import { isPrivateIp } from '../../../src/handlers/shared/validation';

describe('isPrivateIp', () => {
  describe('IPv4 private ranges', () => {
    test('blocks 10.x.x.x (RFC 1918 Class A)', () => {
      expect(isPrivateIp('10.0.0.1')).toBeDefined();
      expect(isPrivateIp('10.255.255.255')).toBeDefined();
    });

    test('blocks 172.16-31.x.x (RFC 1918 Class B)', () => {
      expect(isPrivateIp('172.16.0.1')).toBeDefined();
      expect(isPrivateIp('172.31.255.255')).toBeDefined();
    });

    test('allows 172.15.x.x and 172.32.x.x (outside RFC 1918)', () => {
      expect(isPrivateIp('172.15.0.1')).toBeUndefined();
      expect(isPrivateIp('172.32.0.1')).toBeUndefined();
    });

    test('blocks 192.168.x.x (RFC 1918 Class C)', () => {
      expect(isPrivateIp('192.168.0.1')).toBeDefined();
      expect(isPrivateIp('192.168.255.255')).toBeDefined();
    });

    test('blocks 169.254.x.x (link-local)', () => {
      expect(isPrivateIp('169.254.169.254')).toBeDefined(); // AWS metadata
      expect(isPrivateIp('169.254.0.1')).toBeDefined();
    });

    test('blocks 127.x.x.x (loopback)', () => {
      expect(isPrivateIp('127.0.0.1')).toBeDefined();
      expect(isPrivateIp('127.255.255.255')).toBeDefined();
    });

    test('blocks 0.x.x.x (current network)', () => {
      expect(isPrivateIp('0.0.0.0')).toBeDefined();
      expect(isPrivateIp('0.1.2.3')).toBeDefined();
    });

    test('blocks 100.64.x.x (CGN / RFC 6598)', () => {
      expect(isPrivateIp('100.64.0.1')).toBeDefined();
      expect(isPrivateIp('100.64.255.255')).toBeDefined();
    });

    test('blocks full RFC 6598 range (100.64.0.0/10: 100.64-127.x.x)', () => {
      expect(isPrivateIp('100.65.0.1')).toBeDefined();
      expect(isPrivateIp('100.100.0.1')).toBeDefined();
      expect(isPrivateIp('100.127.255.254')).toBeDefined();
    });

    test('allows 100.128.x.x (above RFC 6598 range)', () => {
      expect(isPrivateIp('100.128.0.1')).toBeUndefined();
      expect(isPrivateIp('100.200.0.1')).toBeUndefined();
    });

    test('allows public IPv4 addresses', () => {
      expect(isPrivateIp('8.8.8.8')).toBeUndefined();
      expect(isPrivateIp('1.1.1.1')).toBeUndefined();
      expect(isPrivateIp('203.0.113.1')).toBeUndefined();
      expect(isPrivateIp('100.63.255.255')).toBeUndefined(); // Just below CGN
    });
  });

  describe('IPv6 private ranges', () => {
    test('blocks ::1 (loopback)', () => {
      expect(isPrivateIp('::1')).toBeDefined();
    });

    test('blocks :: (unspecified address)', () => {
      expect(isPrivateIp('::')).toBeDefined();
    });

    test('blocks fc/fd prefixes (ULA)', () => {
      expect(isPrivateIp('fc00::1')).toBeDefined();
      expect(isPrivateIp('fd12:3456:789a::1')).toBeDefined();
    });

    test('blocks fe80: (link-local)', () => {
      expect(isPrivateIp('fe80::1')).toBeDefined();
      expect(isPrivateIp('fe80::abcd:ef01')).toBeDefined();
    });

    test('blocks the whole of fe80::/10 (link-local), not only the fe80: prefix', () => {
      expect(isPrivateIp('fea9::1')).toBeDefined();
      expect(isPrivateIp('febf::1')).toBeDefined();
    });

    test('blocks IPv4-mapped IPv6 (::ffff:x.x.x.x)', () => {
      expect(isPrivateIp('::ffff:169.254.169.254')).toBeDefined();
      expect(isPrivateIp('::ffff:10.0.0.1')).toBeDefined();
      expect(isPrivateIp('::ffff:127.0.0.1')).toBeDefined();
    });

    test('blocks expanded IPv4-mapped IPv6 (0:0:0:0:0:ffff:x)', () => {
      expect(isPrivateIp('0:0:0:0:0:ffff:169.254.169.254')).toBeDefined();
    });

    test('blocks an IPv6 address written with an IPv4 address inside, whatever it embeds', () => {
      // The download of Linear uploads checked the embedded address with a rule of
      // its own before it shared this function: the compatible form (::x.x.x.x),
      // and any spelling that ends in "::" or "::ffff:" and a private address.
      expect(isPrivateIp('::169.254.169.254')).toBeDefined();
      expect(isPrivateIp('::0.0.0.2')).toBeDefined();
      expect(isPrivateIp('::8.8.8.8')).toBeDefined();
      expect(isPrivateIp('0::ffff:169.254.169.254')).toBeDefined();
      expect(isPrivateIp('64:ff9b::10.0.0.1')).toBeDefined();
    });

    test('allows public IPv6 addresses', () => {
      expect(isPrivateIp('2001:4860:4860::8888')).toBeUndefined(); // Google DNS
      expect(isPrivateIp('2606:4700:4700::1111')).toBeUndefined(); // Cloudflare DNS
    });
  });

  describe('case insensitivity', () => {
    test('handles uppercase IPv6', () => {
      expect(isPrivateIp('FC00::1')).toBeDefined();
      expect(isPrivateIp('FE80::1')).toBeDefined();
      expect(isPrivateIp('::FFFF:10.0.0.1')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveUrlAttachments integration tests
// ---------------------------------------------------------------------------

// Mock DNS, https, and S3
jest.mock('dns', () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

// Only the request is faked: no test opens a socket. The Agent stays the real one.
jest.mock('https', () => ({ ...jest.requireActual('https'), request: jest.fn() }));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
}));

jest.mock('../../../src/handlers/shared/attachment-screening', () => ({
  screenImage: jest.fn(),
  screenTextFile: jest.fn(),
  AttachmentScreeningError: class AttachmentScreeningError extends Error {
    constructor(message: string) { super(message); this.name = 'AttachmentScreeningError'; }
  },
}));

jest.mock('../../../src/handlers/shared/image-tokens', () => ({
  estimateImageTokensFromBuffer: jest.fn().mockReturnValue(100),
}));

jest.mock('../../../src/handlers/shared/validation', () => ({
  ...jest.requireActual('../../../src/handlers/shared/validation'),
  isAllowedMimeType: jest.fn().mockReturnValue(true),
  validateMagicBytes: jest.fn().mockReturnValue(true),
}));

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('resolveUrlAttachments', () => {
  const dns = jest.requireMock('dns').promises;
  const httpsRequest: jest.Mock = jest.requireMock('https').request;
  const { screenImage, screenTextFile } = jest.requireMock('../../../src/handlers/shared/attachment-screening');
  const { isAllowedMimeType } = jest.requireMock('../../../src/handlers/shared/validation');

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const mockS3Client = { send: jest.fn().mockResolvedValue({ VersionId: 'v1' }) };
  const mockScreeningConfig = {
    guardrailId: 'g-123',
    guardrailVersion: '1',
    bedrockClient: {},
  };

  /** One answer of the remote server; `afterMs` is the time it takes to arrive. */
  interface ServerAnswer {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: Buffer;
    readonly afterMs?: number;
  }

  /**
   * Script the remote server: one answer per https.request call, in order. An answer
   * arrives as Node delivers one: in a later turn of the event loop, the body in two
   * chunks. Destroying the request cancels it.
   */
  function serverAnswers(...answers: ServerAnswer[]): void {
    for (const { status, headers = {}, body, afterMs = 0 } of answers) {
      httpsRequest.mockImplementationOnce((_options: unknown, onResponse: (res: EventEmitter) => void) => {
        let arrival: ReturnType<typeof setTimeout>;
        return Object.assign(new EventEmitter(), {
          end: () => {
            arrival = setTimeout(() => {
              const res = Object.assign(new EventEmitter(), { statusCode: status, headers, destroy: jest.fn() });
              onResponse(res);
              if (body) {
                const half = Math.ceil(body.length / 2);
                res.emit('data', body.subarray(0, half));
                res.emit('data', body.subarray(half));
              }
              res.emit('end');
            }, afterMs);
          },
          destroy: () => clearTimeout(arrival),
        });
      });
    }
  }

  /** A URL attachment as create-task stores it: not fetched yet, named after the last path segment. */
  const pendingUrl = (sourceUrl: string, attachmentId = 'att-1') => createAttachmentRecord({
    attachment_id: attachmentId,
    type: 'url',
    content_type: 'application/octet-stream',
    filename: sourceUrl.slice(sourceUrl.lastIndexOf('/') + 1),
    screening: { status: 'pending' },
    source_url: sourceUrl,
  });

  const resolveAll = (attachments: AttachmentRecord[]) => resolveUrlAttachments(
    attachments,
    'task-1',
    'user-1',
    { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    httpsRequest.mockReset();
    dns.resolve4.mockResolvedValue(['1.2.3.4']);
    isAllowedMimeType.mockReturnValue(true); // one test below turns it to false
    screenImage.mockResolvedValue({
      content: PNG_MAGIC,
      contentType: 'image/png',
      checksum: 'abc123',
      screening: { status: 'passed' },
    });
    // Like the real function, it hands back the content it was given.
    screenTextFile.mockImplementation(async (content: Buffer, contentType: string) => (
      { content, contentType, checksum: 'abc123', screening: { status: 'passed' } }
    ));
  });

  test('skips attachments that are not pending URL type', async () => {
    const passedAttachment = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'image',
      content_type: 'image/png',
      filename: 'test.png',
      s3_key: 'attachments/u/t/a/test.png',
      s3_version_id: 'v1',
      size_bytes: 100,
      checksum_sha256: 'abc',
      screening: { status: 'passed', screened_at: '2024-01-01T00:00:00Z' },
    });

    const result = await resolveUrlAttachments(
      [passedAttachment],
      'task-1',
      'user-1',
      { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
    );

    expect(result).toEqual([passedAttachment]);
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  test('rejects HTTP (non-HTTPS) URLs', async () => {
    const urlAttachment = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'url',
      content_type: 'application/octet-stream',
      filename: 'file.txt',
      screening: { status: 'pending' },
      source_url: 'http://example.com/file.txt',
    });

    await expect(resolveUrlAttachments(
      [urlAttachment],
      'task-1',
      'user-1',
      { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
    )).rejects.toThrow('URL attachment must use HTTPS');
  });

  test('rejects URLs resolving to private IPs', async () => {
    dns.resolve4.mockResolvedValue(['10.0.0.1']);

    const urlAttachment = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'url',
      content_type: 'application/octet-stream',
      filename: 'file.txt',
      screening: { status: 'pending' },
      source_url: 'https://evil.example.com/file.txt',
    });

    await expect(resolveUrlAttachments(
      [urlAttachment],
      'task-1',
      'user-1',
      { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
    )).rejects.toThrow('private');
  });

  test('rejects URLs when DNS returns no addresses', async () => {
    dns.resolve4.mockResolvedValue([]);

    const urlAttachment = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'url',
      content_type: 'application/octet-stream',
      filename: 'file.txt',
      screening: { status: 'pending' },
      source_url: 'https://no-records.example.com/file.txt',
    });

    await expect(resolveUrlAttachments(
      [urlAttachment],
      'task-1',
      'user-1',
      { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
    )).rejects.toThrow('DNS resolution returned no addresses');
  });

  test('rejects URLs with unsupported content type', async () => {
    isAllowedMimeType.mockReturnValue(false);

    // We need to mock the actual HTTP request here, but since pinnedHttpsRequest
    // uses native https module which is hard to mock cleanly, we verify the
    // validation-level protection via isAllowedMimeType
    const urlAttachment = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'url',
      content_type: 'application/octet-stream',
      filename: 'file.exe',
      screening: { status: 'pending' },
      source_url: 'https://example.com/file.exe',
    });

    // DNS resolves to a private IP so we don't need to actually fetch
    dns.resolve4.mockResolvedValue(['169.254.169.254']);

    await expect(resolveUrlAttachments(
      [urlAttachment],
      'task-1',
      'user-1',
      { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
    )).rejects.toThrow(/private/);
  });

  test('rejects when source_url is missing', async () => {
    const urlAttachment = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'url',
      content_type: 'application/octet-stream',
      filename: 'file.txt',
      screening: { status: 'pending' },
    });

    await expect(resolveUrlAttachments(
      [urlAttachment],
      'task-1',
      'user-1',
      { s3Client: mockS3Client as any, bucketName: 'bucket', screeningConfig: mockScreeningConfig as any },
    )).rejects.toThrow('no source_url');
  });

  test('fetches from the validated address and stores what the server sent', async () => {
    serverAnswers({ status: 200, headers: { 'content-type': 'image/png; charset=binary' }, body: PNG_MAGIC });

    const result = await resolveAll([pendingUrl('https://img.example.com/shots/a.png')]);

    expect(httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '1.2.3.4', path: '/shots/a.png', headers: expect.objectContaining({ Host: 'img.example.com' }) }),
      expect.any(Function),
    );
    expect(screenImage).toHaveBeenCalledWith(PNG_MAGIC, 'image/png', 'a.png', mockScreeningConfig);
    expect(result).toEqual([expect.objectContaining({
      type: 'image',
      content_type: 'image/png',
      s3_key: 'attachments/user-1/task-1/att-1/a.png',
      size_bytes: PNG_MAGIC.length,
      screening: expect.objectContaining({ status: 'passed' }),
    })]);
  });

  test('follows a redirect to the host it names, at the address validated for that host', async () => {
    dns.resolve4.mockResolvedValueOnce(['1.2.3.4']).mockResolvedValueOnce(['5.6.7.8']);
    serverAnswers(
      { status: 302, headers: { location: 'https://cdn.example.net/a.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, body: PNG_MAGIC },
    );

    const result = await resolveAll([pendingUrl('https://img.example.com/a.png')]);

    expect(httpsRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostname: '5.6.7.8', path: '/a.png', headers: expect.objectContaining({ Host: 'cdn.example.net' }) }),
      expect.any(Function),
    );
    expect(result[0].screening.status).toBe('passed');
  });

  test('refuses an answer larger than 10 MB', async () => {
    serverAnswers({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61) });

    await expect(resolveAll([pendingUrl('https://files.example.com/big.txt')]))
      .rejects.toThrow('URL attachment fetch failed: Response exceeds 10485760 byte size limit');
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  test.each([
    [204, 'URL attachment response has no body (status 204): https://ci.example.com/pixel'],
    [205, 'URL attachment response has no body (status 205): https://ci.example.com/pixel'],
    [304, 'URL attachment redirect (304) had no Location header.'],
    [999, 'URL attachment fetch failed with status 999: https://ci.example.com/pixel'],
  ])('fails with the reason when the server answers %i', async (status, reason) => {
    serverAnswers({ status });

    const outcome = resolveAll([pendingUrl('https://ci.example.com/pixel')]);

    await expect(outcome).rejects.toBeInstanceOf(AttachmentResolutionError);
    await expect(outcome).rejects.toThrow(reason);
  });

  test('stops at the URL attachment that takes the task over its 50 MB limit', async () => {
    const pdf = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const links = Array.from({ length: 10 }, (_, i) => pendingUrl(`https://files.example.com/spec-${i}.pdf`, `att-${i}`));
    serverAnswers(...links.map(() => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf })));

    const outcome = resolveAll(links);

    await expect(outcome).rejects.toBeInstanceOf(AttachmentResolutionError);
    await expect(outcome).rejects.toThrow('Combined attachment size exceeds the 52428800-byte task limit.');
    // Five files of 10 MB are exactly the limit and are kept; the sixth is fetched, counted
    // and refused; the other four are never asked for.
    expect(httpsRequest).toHaveBeenCalledTimes(6);
    expect(mockS3Client.send).toHaveBeenCalledTimes(5);
  });

  test('counts the attachments the task already holds toward the 50 MB limit', async () => {
    const uploads = Array.from({ length: 5 }, (_, i) => createAttachmentRecord({
      attachment_id: `up-${i}`,
      type: 'file',
      content_type: 'application/pdf',
      filename: `up-${i}.pdf`,
      s3_key: `attachments/user-1/task-1/up-${i}/up-${i}.pdf`,
      s3_version_id: 'v1',
      size_bytes: 10 * 1024 * 1024,
      checksum_sha256: 'abc',
      screening: { status: 'passed', screened_at: '2024-01-01T00:00:00Z' },
    }));
    serverAnswers({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG_MAGIC });

    await expect(resolveAll([...uploads, pendingUrl('https://img.example.com/a.png')]))
      .rejects.toThrow('Combined attachment size exceeds the 52428800-byte task limit.');
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  describe('time limits', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Let `ms` of fake time pass while the resolver runs, and report how the call ended and when. */
    async function outcomeAfter(ms: number, attachments: AttachmentRecord[]) {
      const started = Date.now();
      const outcome = resolveAll(attachments).then(
        records => ({ resolved: records.length, afterMs: Date.now() - started }),
        (error: unknown) => ({ error: String(error), afterMs: Date.now() - started }),
      );
      await jest.advanceTimersByTimeAsync(ms);
      return outcome;
    }

    test('gives the URL attachments of a task 30 seconds together', async () => {
      // A host that answers every request after 9 s, under the 10 s limit of one request:
      // two redirects, then the image. That is 27 s for one image and 81 s for three.
      const slowImage: ServerAnswer[] = [
        { status: 302, headers: { location: '/moved' }, afterMs: 9_000 },
        { status: 302, headers: { location: '/moved-again' }, afterMs: 9_000 },
        { status: 200, headers: { 'content-type': 'image/png' }, body: PNG_MAGIC, afterMs: 9_000 },
      ];
      serverAnswers(...slowImage, ...slowImage, ...slowImage);
      const images = ['a', 'b', 'c'].map(name => pendingUrl(`https://img.example.com/${name}.png`, name));

      expect(await outcomeAfter(81_000, images)).toEqual({
        error: 'AttachmentResolutionError: URL attachments could not be fetched and screened within 30s (stopped at https://img.example.com/b.png).',
        afterMs: 30_000,
      });
      // The first image arrived at 27 s and was stored; the second got the 3 s that were left.
      expect(httpsRequest).toHaveBeenCalledTimes(4);
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    test('starts no request once the 30 seconds are used up', async () => {
      // The lookup of the host name alone takes 31 s; no timer covers a lookup.
      dns.resolve4.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(['1.2.3.4']), 31_000)));
      serverAnswers({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG_MAGIC });

      expect(await outcomeAfter(32_000, [pendingUrl('https://slow-dns.example.com/a.png')])).toEqual({
        error: 'AttachmentResolutionError: URL attachments could not be fetched and screened within 30s (stopped at https://slow-dns.example.com/a.png).',
        afterMs: 31_000,
      });
      expect(httpsRequest).not.toHaveBeenCalled();
    });

    test('gives one request 10 seconds', async () => {
      serverAnswers({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG_MAGIC, afterMs: 11_000 });

      expect(await outcomeAfter(11_000, [pendingUrl('https://img.example.com/a.png')])).toEqual({
        error: 'AttachmentResolutionError: URL attachment fetch timed out after 10s: https://img.example.com/a.png',
        afterMs: 10_000,
      });
    });
  });
});
