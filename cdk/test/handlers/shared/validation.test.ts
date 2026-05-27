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

import { createAttachmentRecord } from '../../../src/handlers/shared/types';
import {
  computeTtlEpoch,
  decodePaginationToken,
  encodePaginationToken,
  hasTaskSpec,
  isAllowedMimeType,
  isValidFilename,
  isValidIdempotencyKey,
  isValidRepo,
  isValidTaskDescriptionLength,
  isValidTaskType,
  isValidUlid,
  isValidWebhookName,
  MAX_ATTACHMENTS_PER_TASK,
  MAX_TASK_DESCRIPTION_LENGTH,
  parseBody,
  parseLimit,
  parseStatusFilter,
  validateAttachments,
  validateMagicBytes,
  VALID_TASK_TYPES,
  validateMaxTurns,
  validatePrNumber,
} from '../../../src/handlers/shared/validation';

describe('parseBody', () => {
  test('parses valid JSON', () => {
    expect(parseBody('{"key":"value"}')).toEqual({ key: 'value' });
  });

  test('returns null for null body', () => {
    expect(parseBody(null)).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseBody('not json')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseBody('')).toBeNull();
  });
});

describe('isValidRepo', () => {
  test('accepts valid owner/repo format', () => {
    expect(isValidRepo('org/myapp')).toBe(true);
    expect(isValidRepo('my-org/my-repo')).toBe(true);
    expect(isValidRepo('user123/repo.js')).toBe(true);
    expect(isValidRepo('org/repo_name')).toBe(true);
  });

  test('rejects invalid formats', () => {
    expect(isValidRepo('')).toBe(false);
    expect(isValidRepo('noslash')).toBe(false);
    expect(isValidRepo('too/many/slashes')).toBe(false);
    expect(isValidRepo('/leading-slash')).toBe(false);
    expect(isValidRepo('trailing-slash/')).toBe(false);
    expect(isValidRepo('has spaces/repo')).toBe(false);
  });
});

describe('hasTaskSpec', () => {
  test('returns true when issue_number is provided', () => {
    expect(hasTaskSpec({ repo: 'org/repo', issue_number: 42 })).toBe(true);
  });

  test('returns true when task_description is provided', () => {
    expect(hasTaskSpec({ repo: 'org/repo', task_description: 'Fix the bug' })).toBe(true);
  });

  test('returns true when both are provided', () => {
    expect(hasTaskSpec({ repo: 'org/repo', issue_number: 1, task_description: 'Fix it' })).toBe(true);
  });

  test('returns false when neither is provided', () => {
    expect(hasTaskSpec({ repo: 'org/repo' })).toBe(false);
  });

  test('returns false when task_description is empty/whitespace', () => {
    expect(hasTaskSpec({ repo: 'org/repo', task_description: '  ' })).toBe(false);
  });

  test('returns true when task_type is pr_iteration and pr_number is provided', () => {
    expect(hasTaskSpec({ repo: 'org/repo', task_type: 'pr_iteration', pr_number: 42 })).toBe(true);
  });

  test('returns false for pr_iteration without pr_number', () => {
    expect(hasTaskSpec({ repo: 'org/repo', task_type: 'pr_iteration' })).toBe(false);
  });

  test('returns true when task_type is pr_review and pr_number is provided', () => {
    expect(hasTaskSpec({ repo: 'org/repo', task_type: 'pr_review', pr_number: 42 })).toBe(true);
  });

  test('returns false for pr_review without pr_number', () => {
    expect(hasTaskSpec({ repo: 'org/repo', task_type: 'pr_review' })).toBe(false);
  });
});

describe('isValidIdempotencyKey', () => {
  test('accepts valid keys', () => {
    expect(isValidIdempotencyKey('abc-123')).toBe(true);
    expect(isValidIdempotencyKey('key_with_underscores')).toBe(true);
    expect(isValidIdempotencyKey('a')).toBe(true);
  });

  test('rejects keys longer than 128 chars', () => {
    expect(isValidIdempotencyKey('a'.repeat(129))).toBe(false);
  });

  test('accepts key of exactly 128 chars', () => {
    expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true);
  });

  test('rejects keys with special characters', () => {
    expect(isValidIdempotencyKey('key with spaces')).toBe(false);
    expect(isValidIdempotencyKey('key/slash')).toBe(false);
    expect(isValidIdempotencyKey('')).toBe(false);
  });
});

describe('parseStatusFilter', () => {
  test('parses single valid status', () => {
    expect(parseStatusFilter('RUNNING')).toEqual(['RUNNING']);
  });

  test('parses comma-separated statuses', () => {
    expect(parseStatusFilter('RUNNING,HYDRATING')).toEqual(['RUNNING', 'HYDRATING']);
  });

  test('trims whitespace', () => {
    expect(parseStatusFilter(' RUNNING , HYDRATING ')).toEqual(['RUNNING', 'HYDRATING']);
  });

  test('returns null for undefined', () => {
    expect(parseStatusFilter(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseStatusFilter('')).toBeNull();
  });

  test('returns null if any status is invalid', () => {
    expect(parseStatusFilter('RUNNING,INVALID')).toBeNull();
    expect(parseStatusFilter('NOT_A_STATUS')).toBeNull();
  });
});

describe('parseLimit', () => {
  test('returns default when param is undefined', () => {
    expect(parseLimit(undefined, 20, 100)).toBe(20);
  });

  test('parses valid limit', () => {
    expect(parseLimit('50', 20, 100)).toBe(50);
  });

  test('clamps to max', () => {
    expect(parseLimit('200', 20, 100)).toBe(100);
  });

  test('returns default for invalid number', () => {
    expect(parseLimit('abc', 20, 100)).toBe(20);
  });

  test('returns default for zero', () => {
    expect(parseLimit('0', 20, 100)).toBe(20);
  });

  test('returns default for negative', () => {
    expect(parseLimit('-5', 20, 100)).toBe(20);
  });
});

describe('isValidWebhookName', () => {
  test('accepts valid names', () => {
    expect(isValidWebhookName('my-webhook')).toBe(true);
    expect(isValidWebhookName('GitHub Actions CI')).toBe(true);
    expect(isValidWebhookName('webhook_1')).toBe(true);
    expect(isValidWebhookName('AB')).toBe(true);
    expect(isValidWebhookName('x')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidWebhookName('')).toBe(false);
  });

  test('rejects names starting with special char', () => {
    expect(isValidWebhookName('-webhook')).toBe(false);
    expect(isValidWebhookName(' webhook')).toBe(false);
  });

  test('rejects names ending with special char', () => {
    expect(isValidWebhookName('webhook-')).toBe(false);
    expect(isValidWebhookName('webhook ')).toBe(false);
  });

  test('rejects names longer than 64 characters', () => {
    expect(isValidWebhookName('a' + 'b'.repeat(63))).toBe(true); // 64 chars OK
    expect(isValidWebhookName('a' + 'b'.repeat(64))).toBe(false); // 65 chars too long
  });

  test('rejects names with invalid characters', () => {
    expect(isValidWebhookName('web@hook')).toBe(false);
    expect(isValidWebhookName('web/hook')).toBe(false);
    expect(isValidWebhookName('web.hook')).toBe(false);
  });
});

describe('isValidTaskDescriptionLength', () => {
  test('accepts descriptions within the limit', () => {
    expect(isValidTaskDescriptionLength('Fix the bug')).toBe(true);
    expect(isValidTaskDescriptionLength('a'.repeat(MAX_TASK_DESCRIPTION_LENGTH))).toBe(true);
  });

  test('rejects descriptions exceeding the limit', () => {
    expect(isValidTaskDescriptionLength('a'.repeat(MAX_TASK_DESCRIPTION_LENGTH + 1))).toBe(false);
  });

  test('accepts empty string', () => {
    expect(isValidTaskDescriptionLength('')).toBe(true);
  });
});

describe('computeTtlEpoch', () => {
  test('returns epoch seconds in the future', () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = computeTtlEpoch(90);
    expect(ttl).toBeGreaterThan(now);
    expect(ttl).toBeLessThanOrEqual(now + 90 * 86400 + 1);
  });

  test('adds correct number of seconds for given days', () => {
    const before = Math.floor(Date.now() / 1000);
    const ttl = computeTtlEpoch(30);
    const after = Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThanOrEqual(before + 30 * 86400);
    expect(ttl).toBeLessThanOrEqual(after + 30 * 86400);
  });

  test('returns current epoch for 0 days', () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = computeTtlEpoch(0);
    expect(ttl).toBeGreaterThanOrEqual(now);
    expect(ttl).toBeLessThanOrEqual(now + 1);
  });
});

describe('validateMaxTurns', () => {
  test('returns undefined when value is undefined', () => {
    expect(validateMaxTurns(undefined)).toBeUndefined();
  });

  test('returns undefined when value is null', () => {
    expect(validateMaxTurns(null)).toBeUndefined();
  });

  test('returns the value for valid integers in range', () => {
    expect(validateMaxTurns(1)).toBe(1);
    expect(validateMaxTurns(50)).toBe(50);
    expect(validateMaxTurns(100)).toBe(100);
    expect(validateMaxTurns(500)).toBe(500);
  });

  test('returns null for values below minimum', () => {
    expect(validateMaxTurns(0)).toBeNull();
    expect(validateMaxTurns(-1)).toBeNull();
  });

  test('returns null for values above maximum', () => {
    expect(validateMaxTurns(501)).toBeNull();
    expect(validateMaxTurns(1000)).toBeNull();
  });

  test('returns null for non-integer numbers', () => {
    expect(validateMaxTurns(1.5)).toBeNull();
    expect(validateMaxTurns(99.9)).toBeNull();
  });

  test('returns null for non-number types', () => {
    expect(validateMaxTurns('100')).toBeNull();
    expect(validateMaxTurns(true)).toBeNull();
    expect(validateMaxTurns({})).toBeNull();
    expect(validateMaxTurns([])).toBeNull();
  });
});

describe('pagination token encode/decode', () => {
  test('encode and decode are inverse operations', () => {
    const key = { task_id: { S: 'abc' }, user_id: { S: 'user1' } };
    const token = encodePaginationToken(key);
    expect(token).not.toBeNull();
    const decoded = decodePaginationToken(token!);
    expect(decoded).toEqual(key);
  });

  test('encode returns null for undefined', () => {
    expect(encodePaginationToken(undefined)).toBeNull();
  });

  test('decode returns undefined for undefined', () => {
    expect(decodePaginationToken(undefined)).toBeUndefined();
  });

  test('decode returns undefined for invalid base64', () => {
    expect(decodePaginationToken('not-valid-base64!!!')).toBeUndefined();
  });
});

describe('isValidTaskType', () => {
  test('returns true for valid task types', () => {
    expect(isValidTaskType('new_task')).toBe(true);
    expect(isValidTaskType('pr_iteration')).toBe(true);
  });

  test('returns true for undefined/null (defaults to new_task)', () => {
    expect(isValidTaskType(undefined)).toBe(true);
    expect(isValidTaskType(null)).toBe(true);
  });

  test('returns true for pr_review', () => {
    expect(isValidTaskType('pr_review')).toBe(true);
  });

  test('returns false for invalid values', () => {
    expect(isValidTaskType('invalid')).toBe(false);
    expect(isValidTaskType('')).toBe(false);
    expect(isValidTaskType(42)).toBe(false);
    expect(isValidTaskType(true)).toBe(false);
  });
});

describe('isValidUlid', () => {
  test('accepts a canonical 26-char Crockford Base32 ULID', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });

  test('accepts ULIDs containing every allowed character', () => {
    // timestamp-only characters 0-9 and a spread of allowed letters
    expect(isValidUlid('0123456789ABCDEFGHJKMNPQRS')).toBe(true);
    expect(isValidUlid('TVWXYZ0123456789ABCDEFGHJK')).toBe(true);
  });

  test('accepts lowercase input (case-insensitive)', () => {
    expect(isValidUlid('01arz3ndektsv4rrffq69g5fav')).toBe(true);
  });

  test('rejects wrong length', () => {
    expect(isValidUlid('')).toBe(false);
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false); // 27
  });

  test('rejects Crockford-excluded letters I, L, O, U', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAL')).toBe(false);
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toBe(false);
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false);
  });

  test('rejects non-Base32 punctuation', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5F!V')).toBe(false);
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5F-V')).toBe(false);
  });

  test('rejects non-string input', () => {
    expect(isValidUlid(42 as any)).toBe(false);

    expect(isValidUlid(null as any)).toBe(false);

    expect(isValidUlid(undefined as any)).toBe(false);
  });
});

describe('validatePrNumber', () => {
  test('returns the number for valid positive integers', () => {
    expect(validatePrNumber(1)).toBe(1);
    expect(validatePrNumber(42)).toBe(42);
    expect(validatePrNumber(999)).toBe(999);
  });

  test('returns undefined for absent values', () => {
    expect(validatePrNumber(undefined)).toBeUndefined();
    expect(validatePrNumber(null)).toBeUndefined();
  });

  test('returns null for invalid values', () => {
    expect(validatePrNumber(0)).toBeNull();
    expect(validatePrNumber(-1)).toBeNull();
    expect(validatePrNumber(1.5)).toBeNull();
    expect(validatePrNumber('42')).toBeNull();
    expect(validatePrNumber(true)).toBeNull();
  });
});

describe('validateAttachments', () => {
  // Helper: minimal valid PNG (1x1 pixel)
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
  const pngBase64 = PNG_HEADER.toString('base64');

  // Helper: valid JSON content
  const jsonContent = Buffer.from('{"key": "value"}');
  const jsonBase64 = jsonContent.toString('base64');

  test('returns valid with empty parsed array for undefined input', () => {
    const result = validateAttachments(undefined);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.parsed).toEqual([]);
  });

  test('returns valid with empty parsed array for empty array', () => {
    const result = validateAttachments([]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.parsed).toEqual([]);
  });

  test('rejects more than MAX_ATTACHMENTS_PER_TASK', () => {
    const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_TASK + 1 }, () => ({
      type: 'image', data: pngBase64, content_type: 'image/png', filename: 'img.png',
    }));
    const result = validateAttachments(tooMany);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Maximum');
  });

  test('validates a valid inline image attachment', () => {
    const result = validateAttachments([{
      type: 'image', data: pngBase64, content_type: 'image/png', filename: 'screenshot.png',
    }]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].delivery).toBe('inline');
      expect(result.parsed[0].filename).toBe('screenshot.png');
    }
  });

  test('validates a valid inline file attachment', () => {
    const result = validateAttachments([{
      type: 'file', data: jsonBase64, content_type: 'application/json', filename: 'data.json',
    }]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].delivery).toBe('inline');
      expect(result.parsed[0].type).toBe('file');
    }
  });

  test('validates a valid URL attachment', () => {
    const result = validateAttachments([{
      type: 'url', url: 'https://example.com/image.png', content_type: 'image/png', filename: 'remote.png',
    }]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].delivery).toBe('url_fetch');
    }
  });

  test('validates a valid presigned upload attachment', () => {
    const result = validateAttachments([{
      type: 'image', content_type: 'image/png', filename: 'big.png', expected_size_bytes: 2_000_000,
    }]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].delivery).toBe('presigned');
    }
  });

  test('rejects invalid type', () => {
    const result = validateAttachments([{ type: 'video', data: 'abc' }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('type');
  });

  test('rejects url type without url field', () => {
    const result = validateAttachments([{ type: 'url', content_type: 'image/png', filename: 'x.png' }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('url required');
  });

  test('rejects non-HTTPS URL', () => {
    const result = validateAttachments([{
      type: 'url', url: 'http://example.com/img.png', content_type: 'image/png', filename: 'x.png',
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('HTTPS');
  });

  test('rejects data + url together', () => {
    const result = validateAttachments([{
      type: 'image',
      data: pngBase64,
      url: 'https://example.com/x.png',
      content_type: 'image/png',
      filename: 'x.png',
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('not both');
  });

  test('rejects inline data exceeding 500 KB', () => {
    const bigData = Buffer.alloc(501 * 1024).fill(0x50); // starts with P (text-ish)
    const result = validateAttachments([{
      type: 'file', data: bigData.toString('base64'), content_type: 'text/plain', filename: 'big.txt',
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('500 KB');
  });

  test('rejects presigned upload without expected_size_bytes', () => {
    const result = validateAttachments([{
      type: 'image', content_type: 'image/png', filename: 'big.png',
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('expected_size_bytes');
  });

  test('rejects presigned upload exceeding 10 MB', () => {
    const result = validateAttachments([{
      type: 'image',
      content_type: 'image/png',
      filename: 'huge.png',
      expected_size_bytes: 11 * 1024 * 1024,
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('10 MB');
  });

  test('rejects disallowed MIME type for image', () => {
    const result = validateAttachments([{
      type: 'image', data: pngBase64, content_type: 'image/svg+xml', filename: 'icon.svg',
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('not allowed');
  });

  test('rejects magic bytes mismatch (PNG header with JPEG declared type)', () => {
    const result = validateAttachments([{
      type: 'image', data: pngBase64, content_type: 'image/jpeg', filename: 'fake.jpg',
    }]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('does not match');
  });

  test('generates filename when not provided', () => {
    const result = validateAttachments([{
      type: 'file', data: jsonBase64, content_type: 'application/json',
    }]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed[0].filename).toBe('attachment_0.json');
    }
  });
});

describe('isValidFilename', () => {
  test('accepts valid filenames', () => {
    expect(isValidFilename('screenshot.png')).toBe(true);
    expect(isValidFilename('my-file_v2.txt')).toBe(true);
    expect(isValidFilename('a')).toBe(true);
    expect(isValidFilename('a1')).toBe(true);
  });

  test('rejects path traversal', () => {
    expect(isValidFilename('../etc/passwd')).toBe(false);
    expect(isValidFilename('foo/bar.txt')).toBe(false);
    expect(isValidFilename('foo\\bar.txt')).toBe(false);
  });

  test('rejects dotfiles and dash-prefix', () => {
    expect(isValidFilename('.hidden')).toBe(false);
    expect(isValidFilename('-flag')).toBe(false);
  });

  test('rejects null bytes', () => {
    expect(isValidFilename('file\x00.txt')).toBe(false);
  });

  test('rejects empty and too-long filenames', () => {
    expect(isValidFilename('')).toBe(false);
    expect(isValidFilename('a'.repeat(256))).toBe(false);
  });
});

describe('validateMagicBytes', () => {
  test('validates PNG magic bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
    expect(validateMagicBytes(png, 'image/png')).toBe(true);
  });

  test('validates JPEG magic bytes', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    expect(validateMagicBytes(jpeg, 'image/jpeg')).toBe(true);
  });

  test('validates text content', () => {
    const text = Buffer.from('Hello, world!');
    expect(validateMagicBytes(text, 'text/plain')).toBe(true);
  });

  test('rejects text with null bytes', () => {
    const binary = Buffer.from([0x48, 0x65, 0x00, 0x6C]);
    expect(validateMagicBytes(binary, 'text/plain')).toBe(false);
  });

  test('rejects mismatched signatures', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(validateMagicBytes(jpeg, 'image/png')).toBe(false);
  });
});

describe('isAllowedMimeType', () => {
  test('allows valid image types', () => {
    expect(isAllowedMimeType('image/png', 'image')).toBe(true);
    expect(isAllowedMimeType('image/jpeg', 'image')).toBe(true);
  });

  test('rejects GIF and WebP image types', () => {
    expect(isAllowedMimeType('image/gif', 'image')).toBe(false);
    expect(isAllowedMimeType('image/webp', 'image')).toBe(false);
  });

  test('allows valid file types', () => {
    expect(isAllowedMimeType('text/plain', 'file')).toBe(true);
    expect(isAllowedMimeType('application/json', 'file')).toBe(true);
    expect(isAllowedMimeType('application/pdf', 'file')).toBe(true);
  });

  test('rejects disallowed types', () => {
    expect(isAllowedMimeType('application/javascript', 'file')).toBe(false);
    expect(isAllowedMimeType('image/svg+xml', 'image')).toBe(false);
    expect(isAllowedMimeType('application/zip', 'file')).toBe(false);
  });

  test('url type allows both image and file types', () => {
    expect(isAllowedMimeType('image/png', 'url')).toBe(true);
    expect(isAllowedMimeType('text/plain', 'url')).toBe(true);
  });
});

describe('createAttachmentRecord', () => {
  test('creates a valid record with passed screening', () => {
    const record = createAttachmentRecord({
      attachment_id: 'att-1',
      type: 'file',
      content_type: 'text/plain',
      filename: 'log.txt',
      s3_key: 'attachments/user/task/att/log.txt',
      s3_version_id: 'v1',
      size_bytes: 100,
      screening: { status: 'passed', screened_at: '2026-01-01T00:00:00Z' },
      checksum_sha256: 'a'.repeat(64),
    });
    expect(record.attachment_id).toBe('att-1');
    expect(record.screening.status).toBe('passed');
  });

  test('creates a valid pending record (URL type)', () => {
    const record = createAttachmentRecord({
      attachment_id: 'att-2',
      type: 'url',
      content_type: 'image/png',
      filename: 'remote.png',
      screening: { status: 'pending' },
      source_url: 'https://example.com/img.png',
    });
    expect(record.screening.status).toBe('pending');
  });

  test('throws when passed screening lacks s3_key', () => {
    expect(() => createAttachmentRecord({
      attachment_id: 'att-3',
      type: 'file',
      content_type: 'text/plain',
      filename: 'log.txt',
      screening: { status: 'passed', screened_at: '2026-01-01T00:00:00Z' },
    })).toThrow('s3_key');
  });

  test('accepts image with passed screening without token_estimate (computed during hydration)', () => {
    const record = createAttachmentRecord({
      attachment_id: 'att-4',
      type: 'image',
      content_type: 'image/png',
      filename: 'img.png',
      s3_key: 'attachments/user/task/att/img.png',
      s3_version_id: 'v1',
      size_bytes: 5000,
      screening: { status: 'passed', screened_at: '2026-01-01T00:00:00Z' },
      checksum_sha256: 'b'.repeat(64),
    });
    expect(record.attachment_id).toBe('att-4');
    expect(record.token_estimate).toBeUndefined();
  });
});
