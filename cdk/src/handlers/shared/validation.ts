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

import { TaskStatus } from '../../constructs/task-status';
import {
  type CreateTaskRequest,
  type AttachmentType,
  type ValidatedAttachment,
  type InlineAttachment,
  type PresignedAttachment,
  type UrlAttachment,
  MAX_BUDGET_USD_MIN,
  MAX_BUDGET_USD_MAX,
} from './types';
import { type WorkflowRequiredInputs } from './workflows';

export const DEFAULT_MAX_TURNS = 100;
const MIN_MAX_TURNS = 1;
const MAX_MAX_TURNS = 500;
export const MAX_TASK_DESCRIPTION_LENGTH = 10_000;

const REPO_PATTERN = /^(?!\.+\/)[a-zA-Z0-9._-]+\/(?!\.+$)[a-zA-Z0-9._-]+$/;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_IDEMPOTENCY_KEY_LENGTH}}$`);
const WEBHOOK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}[a-zA-Z0-9]$/;
export const ULID_LENGTH = 26;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALL_STATUSES = new Set(Object.values(TaskStatus));

/**
 * Parse a JSON request body. Returns null if the body is missing or not valid JSON.
 */
export function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- parseBody contract: invalid JSON yields null, same as a missing body
  }
}

/**
 * Validate GitHub repository format (`owner/repo`).
 */
export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

function inputSatisfied(req: CreateTaskRequest, input: string): boolean {
  switch (input) {
    case 'issue_number':
      return req.issue_number !== undefined && req.issue_number !== null;
    case 'pr_number':
      return req.pr_number !== undefined && req.pr_number !== null;
    case 'task_description':
      return req.task_description !== undefined
        && req.task_description !== null
        && req.task_description.trim().length > 0;
    default:
      return true;
  }
}

/**
 * Validate that a create task request satisfies the resolved workflow's
 * required-input contract.
 */
export function hasTaskSpec(req: CreateTaskRequest, requiredInputs: WorkflowRequiredInputs): boolean {
  const allOf = requiredInputs.allOf ?? [];
  if (!allOf.every((input) => inputSatisfied(req, input))) {
    return false;
  }
  const oneOf = requiredInputs.oneOf ?? [];
  if (oneOf.length > 0 && !oneOf.some((input) => inputSatisfied(req, input))) {
    return false;
  }
  return true;
}

/**
 * Validate an idempotency key format (alphanumeric, dashes, underscores, max 128 chars).
 */
export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Parse and validate a status filter query parameter.
 * Accepts a single status or comma-separated list.
 * @returns array of valid status strings, or null if any status is invalid.
 */
export function parseStatusFilter(statusParam: string | undefined): string[] | null {
  if (!statusParam) return null;
  const statuses = statusParam.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (statuses.length === 0) return null;
  for (const s of statuses) {
    if (!ALL_STATUSES.has(s as never)) return null;
  }
  return statuses;
}

/**
 * Parse and clamp a pagination limit query parameter.
 */
export function parseLimit(limitParam: string | undefined, defaultLimit: number, maxLimit: number): number {
  if (!limitParam) return defaultLimit;
  const parsed = parseInt(limitParam, 10);
  if (isNaN(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

/**
 * Decode a base64-encoded pagination token to a DynamoDB ExclusiveStartKey.
 * @returns the decoded key object, undefined if there is no token, or null if the
 *   token is no cursor.
 */
export function decodePaginationToken(token: string | undefined): Record<string, unknown> | null | undefined {
  if (!token) return undefined;
  try {
    const key: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    // DynamoDB takes nothing but an object for a start key.
    return typeof key === 'object' && key !== null && !Array.isArray(key) ? key as Record<string, unknown> : null;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- null is the answer for a token that cannot be decoded, and every caller refuses it with a 400
  }
}

/**
 * Encode a DynamoDB LastEvaluatedKey as a base64 pagination token.
 * @returns the encoded token string, or null if there is no next page.
 */
export function encodePaginationToken(lastKey: Record<string, unknown> | undefined): string | null {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey)).toString('base64');
}

/**
 * Validate a ULID string (26-char Crockford Base32, case-insensitive).
 */
export function isValidUlid(value: string): boolean {
  if (typeof value !== 'string' || value.length !== ULID_LENGTH) return false;
  return ULID_PATTERN.test(value.toUpperCase());
}

/**
 * Validate a webhook name (1-64 characters, alphanumeric, spaces, hyphens, underscores).
 * Must start and end with an alphanumeric character.
 */
export function isValidWebhookName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 1) return /^[a-zA-Z0-9]$/.test(name);
  return WEBHOOK_NAME_PATTERN.test(name);
}

/**
 * Validate a max_turns value from a request body.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent (use default).
 */
export function validateMaxTurns(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < MIN_MAX_TURNS || value > MAX_MAX_TURNS) return null;
  return value;
}

/**
 * Validate a max_budget_usd value from a request body.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent (use default).
 */
export function validateMaxBudgetUsd(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < MAX_BUDGET_USD_MIN || value > MAX_BUDGET_USD_MAX) return null;
  return value;
}

export function isValidTaskDescriptionLength(description: string): boolean {
  return description.length <= MAX_TASK_DESCRIPTION_LENGTH;
}

/**
 * Compute a TTL epoch (seconds since Unix epoch) for DynamoDB TTL.
 * @param retentionDays - number of days from now until expiry.
 */
export function computeTtlEpoch(retentionDays: number): number {
  return Math.floor(Date.now() / 1000) + retentionDays * 86400;
}

/**
 * Validate a pr_number or issue_number value from a request body.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent.
 */
export function validatePrNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < 1) return null;
  return value;
}

export const MAX_ATTACHMENTS_PER_TASK = 10;
/** Maximum decoded size for inline attachments. */
export const MAX_INLINE_ATTACHMENT_SIZE_BYTES = 500 * 1024;
const MAX_TOTAL_INLINE_SIZE_MB = 3;
/** Maximum total decoded inline size per request. */
export const MAX_TOTAL_INLINE_SIZE_BYTES = MAX_TOTAL_INLINE_SIZE_MB * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE_MB = 50;
/** Maximum size per attachment (inline or presigned, decoded). */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = MAX_TOTAL_ATTACHMENT_SIZE_MB * 1024 * 1024;

const ATTACHMENT_TYPE_LIST = ['image', 'file', 'url'] as const satisfies readonly AttachmentType[];
type _AssertAttachmentExhaustive = Exclude<AttachmentType, (typeof ATTACHMENT_TYPE_LIST)[number]> extends never ? true : never;
const _attachmentExhaustiveCheck: _AssertAttachmentExhaustive = true;
// `void` consumes the binding: tsconfig noUnusedLocals does not honor the `_` prefix.
void _attachmentExhaustiveCheck;
const VALID_ATTACHMENT_TYPES = new Set<string>(ATTACHMENT_TYPE_LIST);

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
]);

const ALLOWED_FILE_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/pdf',
  'text/x-log',
]);

/* eslint-disable @typescript-eslint/no-magic-numbers -- file format magic-byte signatures */
const MAGIC_BYTES: ReadonlyArray<{ readonly mime: string; readonly bytes: readonly number[]; readonly offset?: number }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] },
];
/* eslint-enable @typescript-eslint/no-magic-numbers */

const TEXT_MAGIC_BYTE_CHECK_BYTES = 8192;

const JSON_OBJECT_START_BYTE = 0x7B;
const JSON_ARRAY_START_BYTE = 0x5B;

const MAX_FILENAME_LENGTH = 255;

/**
 * Validate content against declared MIME type using magic bytes.
 * For text types, checks for valid UTF-8 and no null bytes.
 */
export function validateMagicBytes(data: Buffer, contentType: string): boolean {
  const sig = MAGIC_BYTES.find(s => s.mime === contentType);
  if (sig) {
    if (data.length < sig.bytes.length) return false;
    const offset = sig.offset ?? 0;
    return sig.bytes.every((b, i) => data[offset + i] === b);
  }

  if (contentType.startsWith('text/') || contentType === 'application/json') {
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      return false;
    }
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0) return false;
    }
    return true;
  }

  return false;
}

function detectMimeTypeFromMagicBytes(data: Buffer): string | null {
  for (const sig of MAGIC_BYTES) {
    if (data.length >= sig.bytes.length) {
      const offset = sig.offset ?? 0;
      if (sig.bytes.every((b, i) => data[offset + i] === b)) return sig.mime;
    }
  }
  const check = data.subarray(0, TEXT_MAGIC_BYTE_CHECK_BYTES);
  let hasNullByte = false;
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) { hasNullByte = true; break; }
  }
  if (!hasNullByte && data.length > 0) {
    const first = data[0];
    if (first === JSON_OBJECT_START_BYTE || first === JSON_ARRAY_START_BYTE) return 'application/json';
    return 'text/plain';
  }
  return null;
}

export function isAllowedMimeType(mimeType: string, attachmentType: string): boolean {
  if (attachmentType === 'image') return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
  if (attachmentType === 'file') return ALLOWED_FILE_MIME_TYPES.has(mimeType);
  if (attachmentType === 'url') {
    return ALLOWED_IMAGE_MIME_TYPES.has(mimeType) || ALLOWED_FILE_MIME_TYPES.has(mimeType);
  }
  return false;
}

function isValidHttpsUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Reject filenames with path traversal, null bytes, or unusual characters. */
export function isValidFilename(filename: string): boolean {
  if (filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.includes('\0')) return false;
  if (filename.startsWith('.') || filename.startsWith('-')) return false;
  if (filename === '.' || filename === '..') return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._\- ]{0,253}[a-zA-Z0-9._]$/.test(filename)
    || /^[a-zA-Z0-9][a-zA-Z0-9._]$/.test(filename)
    || /^[a-zA-Z0-9]$/.test(filename);
}

function generateFilename(_type: string, contentType: string, index: number): string {
  const ext = MIME_TO_EXTENSION[contentType] ?? 'bin';
  return `attachment_${index}.${ext}`;
}

function filenameFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (lastSegment && lastSegment.includes('.') && lastSegment.length <= MAX_FILENAME_LENGTH) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(lastSegment);
      } catch {
        decoded = lastSegment;
      }
      const sanitized = decoded.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (isValidFilename(sanitized)) {
        return sanitized;
      }
    }
  } catch {
    // URL parse failure — fall through to default
  }
  return `url_attachment_${index}`;
}

/**
 * Canonical MIME → file-extension map for the platform-allowed attachment types.
 */
export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'text/x-log': 'log',
};

/**
 * Reverse of {@link MIME_TO_EXTENSION}: file-extension → MIME, plus the common
 * `.jpeg` alias.
 */
export const EXTENSION_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(MIME_TO_EXTENSION).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg',
});

/**
 * Human-friendly list of supported attachment file extensions, derived from
 * {@link EXTENSION_TO_MIME}'s KEYS (deduped, upper-cased) — e.g. "PNG, JPG, JPEG,
 * TXT, CSV, MD, JSON, PDF, LOG".
 */
export const SUPPORTED_ATTACHMENT_EXTENSIONS_LABEL: string =
  [...new Set(Object.keys(EXTENSION_TO_MIME))].map((e) => e.toUpperCase()).join(', ');

export type AttachmentValidationResult =
  | { readonly valid: true; readonly parsed: ValidatedAttachment[] }
  | { readonly valid: false; readonly error: string };

/**
 * Synchronous attachment validation. Checks schema, limits, magic bytes,
 * MIME types, and filename safety. Returns a discriminated union of
 * validated attachments on success.
 */
// eslint-disable-next-line complexity -- predates the ceiling (44 when it landed); must not grow
export function validateAttachments(
  attachments: unknown[] | undefined,
): AttachmentValidationResult {
  if (!attachments) {
    return { valid: true, parsed: [] };
  }
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'attachments must be an array' };
  }
  if (attachments.length > MAX_ATTACHMENTS_PER_TASK) {
    return { valid: false, error: `Maximum ${MAX_ATTACHMENTS_PER_TASK} attachments per task` };
  }

  let totalInlineSize = 0;
  let totalDeclaredSize = 0;
  const parsed: ValidatedAttachment[] = [];

  for (const [i, att] of (attachments as Record<string, unknown>[]).entries()) {
    if (!att || !att.type || typeof att.type !== 'string' || !VALID_ATTACHMENT_TYPES.has(att.type)) {
      return { valid: false, error: `attachments[${i}].type must be 'image', 'file', or 'url'` };
    }

    const attType = att.type as AttachmentType;

    if (attType === 'url') {
      if (!att.url || typeof att.url !== 'string') {
        return { valid: false, error: `attachments[${i}]: url required for type 'url'` };
      }
      if (att.data) {
        return { valid: false, error: `attachments[${i}]: data not allowed for type 'url'` };
      }
      if (!isValidHttpsUrl(att.url)) {
        return { valid: false, error: `attachments[${i}]: must be a valid HTTPS URL` };
      }
    } else if (att.url) {
      const reason = att.data ? 'provide data or url, not both' : "url is only allowed for type 'url'";
      return { valid: false, error: `attachments[${i}]: ${reason}` };
    }

    let decoded: Buffer | undefined;

    if (att.data) {
      if (typeof att.data !== 'string') {
        return { valid: false, error: `attachments[${i}]: data must be a base64 string` };
      }
      decoded = Buffer.from(att.data, 'base64');
      if (decoded.length > MAX_INLINE_ATTACHMENT_SIZE_BYTES) {
        return { valid: false, error: `attachments[${i}]: inline data exceeds 500 KB limit. Use presigned upload for larger files.` };
      }
      totalInlineSize += decoded.length;
    }

    if (!att.data && !att.url && attType !== 'url') {
      if (typeof att.expected_size_bytes !== 'number' || att.expected_size_bytes <= 0) {
        return { valid: false, error: `attachments[${i}]: expected_size_bytes required for presigned uploads` };
      }
      if (att.expected_size_bytes > MAX_ATTACHMENT_SIZE_BYTES) {
        return { valid: false, error: `attachments[${i}]: expected size exceeds 10 MB limit` };
      }
      totalDeclaredSize += att.expected_size_bytes;
    }

    let resolvedContentType: string;
    if (att.content_type && typeof att.content_type === 'string') {
      if (!isAllowedMimeType(att.content_type, attType)) {
        return { valid: false, error: `attachments[${i}]: content_type '${att.content_type}' not allowed for type '${attType}'` };
      }
      resolvedContentType = att.content_type;
    } else if (decoded) {
      const detected = detectMimeTypeFromMagicBytes(decoded);
      if (!detected) {
        return { valid: false, error: `attachments[${i}]: could not determine file type. Please provide content_type explicitly.` };
      }
      if (!isAllowedMimeType(detected, attType)) {
        return { valid: false, error: `attachments[${i}]: detected content_type '${detected}' not allowed for type '${attType}'` };
      }
      resolvedContentType = detected;
    } else if (attType === 'url') {
      resolvedContentType = 'application/octet-stream';
    } else {
      return { valid: false, error: `attachments[${i}]: content_type is required for presigned uploads` };
    }

    if (decoded) {
      if (!validateMagicBytes(decoded, resolvedContentType)) {
        return { valid: false, error: `attachments[${i}]: content does not match declared type` };
      }
    }

    let resolvedFilename: string;
    if (att.filename && typeof att.filename === 'string') {
      resolvedFilename = att.filename;
    } else if (attType === 'url' && att.url && typeof att.url === 'string') {
      resolvedFilename = filenameFromUrl(att.url as string, i);
    } else {
      resolvedFilename = generateFilename(attType, resolvedContentType, i);
    }
    if (!isValidFilename(resolvedFilename)) {
      return { valid: false, error: `attachments[${i}]: invalid filename` };
    }

    if (attType === 'url') {
      parsed.push({
        delivery: 'url_fetch',
        type: 'url',
        url: att.url as string,
        filename: resolvedFilename,
        content_type: resolvedContentType,
      } satisfies UrlAttachment);
    } else if (decoded) {
      parsed.push({
        delivery: 'inline',
        type: attType,
        data: att.data as string,
        filename: resolvedFilename,
        content_type: resolvedContentType,
        decoded_size_bytes: decoded.length,
      } satisfies InlineAttachment);
    } else {
      parsed.push({
        delivery: 'presigned',
        type: attType,
        filename: resolvedFilename,
        content_type: resolvedContentType,
        expected_size_bytes: att.expected_size_bytes as number,
      } satisfies PresignedAttachment);
    }
  }

  if (totalInlineSize > MAX_TOTAL_INLINE_SIZE_BYTES) {
    return { valid: false, error: 'Total inline attachment size exceeds 3 MB limit. Use presigned upload for larger files.' };
  }

  if (totalInlineSize + totalDeclaredSize > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
    return { valid: false, error: 'Total attachment size exceeds 50 MB limit' };
  }

  return { valid: true, parsed };
}

const RFC1918_172_SECOND_OCTET_MIN = 16;
const RFC1918_172_SECOND_OCTET_MAX = 31;

const RFC6598_CGN_SECOND_OCTET_MIN = 64;
const RFC6598_CGN_SECOND_OCTET_MAX = 127;

const PRIVATE_IP_RANGES = [
  { prefix: '10.', mask: null },
  {
    prefix: '172.',
    mask: (ip: string) => {
      const second = parseInt(ip.split('.')[1], 10);
      return second >= RFC1918_172_SECOND_OCTET_MIN && second <= RFC1918_172_SECOND_OCTET_MAX;
    },
  },
  { prefix: '192.168.', mask: null },
  { prefix: '169.254.', mask: null },
  { prefix: '127.', mask: null },
  { prefix: '0.', mask: null },
  {
    prefix: '100.',
    mask: (ip: string) => {
      const second = parseInt(ip.split('.')[1], 10);
      return second >= RFC6598_CGN_SECOND_OCTET_MIN && second <= RFC6598_CGN_SECOND_OCTET_MAX;
    },
  },
  { prefix: '::1', mask: null },
  // Unspecified address (could route to localhost).
  { prefix: '::', mask: (ip: string) => ip === '::' },
  { prefix: 'fc', mask: null },
  { prefix: 'fd', mask: null },
  // Link-local is the whole of fe80::/10: a first group from fe80 to febf.
  { prefix: 'fe8', mask: null },
  { prefix: 'fe9', mask: null },
  { prefix: 'fea', mask: null },
  { prefix: 'feb', mask: null },
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254).
  { prefix: '::ffff:', mask: null },
  { prefix: '0:0:0:0:0:ffff:', mask: null },
] as const;

/**
 * Check if an IP address belongs to a private/internal range.
 * Returns a reason string if private, undefined if public.
 */
export function isPrivateIp(ip: string): string | undefined {
  const normalized = ip.toLowerCase();

  // A resolver writes an IPv6 address with an IPv4 address inside (::ffff:10.0.0.1,
  // ::10.0.0.1) only for the mapped and the deprecated compatible form, and
  // neither is the address of a public host.
  if (normalized.includes(':') && normalized.includes('.')) {
    return `IP ${ip} is in private/reserved range`;
  }

  for (const range of PRIVATE_IP_RANGES) {
    if (typeof range.mask === 'function') {
      if (normalized.startsWith(range.prefix) && range.mask(normalized)) {
        return `IP ${ip} is in private range (${range.prefix}x)`;
      }
    } else if (normalized.startsWith(range.prefix) || normalized === range.prefix) {
      return `IP ${ip} is in private/reserved range`;
    }
  }

  return undefined;
}
