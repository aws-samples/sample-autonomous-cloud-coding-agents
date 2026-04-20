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

import {
  computeTtlEpoch,
  decodePaginationToken,
  encodePaginationToken,
  hasTaskSpec,
  isValidIdempotencyKey,
  isValidRepo,
  isValidTaskDescriptionLength,
  isValidTaskType,
  isValidUlid,
  isValidWebhookName,
  MAX_TASK_DESCRIPTION_LENGTH,
  parseBody,
  parseLimit,
  parseStatusFilter,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidUlid(42 as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidUlid(null as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
