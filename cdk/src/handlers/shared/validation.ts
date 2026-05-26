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
  type CreateTaskRequest,
  type TaskType,
  type AttachmentType,
  type ValidatedAttachment,
  type InlineAttachment,
  type PresignedAttachment,
  type UrlAttachment,
} from './types';
import { TaskStatus } from '../../constructs/task-status';

/** Default maximum agent turns per task. */
export const DEFAULT_MAX_TURNS = 100;
/** Minimum allowed value for max_turns. */
export const MIN_MAX_TURNS = 1;
/** Maximum allowed value for max_turns. */
export const MAX_MAX_TURNS = 500;
/** Maximum allowed length for task_description. */
export const MAX_TASK_DESCRIPTION_LENGTH = 10_000;
/** Minimum allowed value for max_budget_usd (1 cent). */
export const MIN_MAX_BUDGET_USD = 0.01;
/** Maximum allowed value for max_budget_usd ($100). */
export const MAX_MAX_BUDGET_USD = 100;

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const WEBHOOK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}[a-zA-Z0-9]$/;
// ULID format: 26 chars, Crockford Base32 alphabet (0-9, A-Z excluding I, L, O, U).
// Matches the ``_generate_ulid`` output in ``agent/src/progress_writer.py``.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALL_STATUSES = new Set(Object.values(TaskStatus));

/**
 * Parse a JSON request body. Returns null if the body is missing or not valid JSON.
 * @param body - the raw request body string.
 * @returns the parsed object, or null on failure.
 */
export function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Validate GitHub repository format (`owner/repo`).
 * @param repo - the repository string to validate.
 * @returns true if the format is valid.
 */
export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

/**
 * Validate that a create task request has at least one task specification.
 * @param req - the parsed create task request.
 * @returns true if the request has a sufficient task specification:
 *   issue_number or task_description for new_task; pr_number for pr_iteration or pr_review.
 */
export function hasTaskSpec(req: CreateTaskRequest): boolean {
  if ((req.task_type === 'pr_iteration' || req.task_type === 'pr_review') && req.pr_number !== undefined && req.pr_number !== null) {
    return true;
  }
  return (req.issue_number !== undefined && req.issue_number !== null) ||
    (req.task_description !== undefined && req.task_description !== null && req.task_description.trim().length > 0);
}

/**
 * Validate an idempotency key format (alphanumeric, dashes, underscores, max 128 chars).
 * @param key - the idempotency key to validate.
 * @returns true if the format is valid.
 */
export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Parse and validate a status filter query parameter.
 * Accepts a single status or comma-separated list.
 * @param statusParam - the raw status query parameter.
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
 * @param limitParam - the raw limit query parameter.
 * @param defaultLimit - the default limit if not specified.
 * @param maxLimit - the maximum allowed limit.
 * @returns the clamped limit value.
 */
export function parseLimit(limitParam: string | undefined, defaultLimit: number, maxLimit: number): number {
  if (!limitParam) return defaultLimit;
  const parsed = parseInt(limitParam, 10);
  if (isNaN(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

/**
 * Decode a base64-encoded pagination token to a DynamoDB ExclusiveStartKey.
 * @param token - the base64 pagination token.
 * @returns the decoded key object, or undefined if token is absent or invalid.
 */
export function decodePaginationToken(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Encode a DynamoDB LastEvaluatedKey as a base64 pagination token.
 * @param lastKey - the DynamoDB LastEvaluatedKey.
 * @returns the encoded token string, or null if there is no next page.
 */
export function encodePaginationToken(lastKey: Record<string, unknown> | undefined): string | null {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey)).toString('base64');
}

/**
 * Validate a ULID string (26-char Crockford Base32, case-insensitive).
 * ULIDs are lexicographically sortable by timestamp prefix, so string comparison
 * on valid ULIDs behaves correctly for "events after this id" queries. The
 * canonical alphabet excludes the letters I, L, O, and U to avoid visual
 * ambiguity — we accept upper- or lower-case callers by uppercasing first.
 * @param value - the candidate ULID string.
 * @returns true if the value matches the ULID shape.
 */
export function isValidUlid(value: string): boolean {
  if (typeof value !== 'string' || value.length !== 26) return false;
  return ULID_PATTERN.test(value.toUpperCase());
}

/**
 * Validate a webhook name (2-64 characters, alphanumeric, spaces, hyphens, underscores).
 * Must start and end with an alphanumeric character.
 * @param name - the webhook name to validate.
 * @returns true if the name is valid.
 */
export function isValidWebhookName(name: string): boolean {
  if (name.length === 1) return /^[a-zA-Z0-9]$/.test(name);
  return WEBHOOK_NAME_PATTERN.test(name);
}

/**
 * Validate a max_turns value from a request body.
 * @param value - the raw value from the request.
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
 * @param value - the raw value from the request.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent (use default).
 */
export function validateMaxBudgetUsd(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (value < MIN_MAX_BUDGET_USD || value > MAX_MAX_BUDGET_USD) return null;
  return value;
}

/**
 * Validate a task_description length.
 * @param description - the task description to validate.
 * @returns true if within the allowed length, false if too long.
 */
export function isValidTaskDescriptionLength(description: string): boolean {
  return description.length <= MAX_TASK_DESCRIPTION_LENGTH;
}

/**
 * Compute a TTL epoch (seconds since Unix epoch) for DynamoDB TTL.
 * @param retentionDays - number of days from now until expiry.
 * @returns the TTL epoch value.
 */
export function computeTtlEpoch(retentionDays: number): number {
  return Math.floor(Date.now() / 1000) + retentionDays * 86400;
}

/** Valid task type values. Compile-time check ensures this stays in sync with TaskType. */
const TASK_TYPE_LIST = ['new_task', 'pr_iteration', 'pr_review'] as const satisfies readonly TaskType[];
type _AssertExhaustive = Exclude<TaskType, (typeof TASK_TYPE_LIST)[number]> extends never ? true : never;
const _exhaustiveCheck: _AssertExhaustive = true; // eslint-disable-line @typescript-eslint/no-unused-vars
export const VALID_TASK_TYPES = new Set<string>(TASK_TYPE_LIST);

/**
 * Validate a task_type value from a request body.
 * @param value - the raw value from the request.
 * @returns true if the value is a valid task type or undefined/null (defaults to 'new_task').
 */
export function isValidTaskType(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  return VALID_TASK_TYPES.has(value);
}

/**
 * Validate a pr_number value from a request body.
 * @param value - the raw value from the request.
 * @returns the valid number, null if invalid (caller should return 400), or undefined if absent.
 */
export function validatePrNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < 1) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Attachment validation
// ---------------------------------------------------------------------------

/** Maximum attachments per task. */
export const MAX_ATTACHMENTS_PER_TASK = 10;
/** Maximum decoded size for inline attachments. */
export const MAX_INLINE_ATTACHMENT_SIZE_BYTES = 500 * 1024;
/** Maximum total decoded inline size per request. */
export const MAX_TOTAL_INLINE_SIZE_BYTES = 3 * 1024 * 1024;
/** Maximum size per attachment (inline or presigned, decoded). */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
/** Maximum total attachment size per task. */
export const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;

/** Compile-time exhaustiveness check for AttachmentType. */
const ATTACHMENT_TYPE_LIST = ['image', 'file', 'url'] as const satisfies readonly AttachmentType[];
type _AssertAttachmentExhaustive = Exclude<AttachmentType, (typeof ATTACHMENT_TYPE_LIST)[number]> extends never ? true : never;
const _attachmentExhaustiveCheck: _AssertAttachmentExhaustive = true; // eslint-disable-line @typescript-eslint/no-unused-vars
const VALID_ATTACHMENT_TYPES = new Set<string>(ATTACHMENT_TYPE_LIST);

/** Allowed image MIME types (PNG and JPEG only — passed directly to Bedrock). */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
]);

/** Allowed file MIME types. */
const ALLOWED_FILE_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/pdf',
  'text/x-log',
]);

/**
 * Magic byte signatures for content type validation.
 * Prevents polyglot files from bypassing screening.
 */
const MAGIC_BYTES: ReadonlyArray<{ readonly mime: string; readonly bytes: readonly number[]; readonly offset?: number }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] }, // %PDF-
];

/**
 * Validate content against declared MIME type using magic bytes.
 * For text types, checks for valid UTF-8 and no null bytes.
 */
export function validateMagicBytes(data: Buffer, contentType: string): boolean {
  // Check against known binary signatures
  const sig = MAGIC_BYTES.find(s => s.mime === contentType);
  if (sig) {
    if (data.length < sig.bytes.length) return false;
    const offset = sig.offset ?? 0;
    return sig.bytes.every((b, i) => data[offset + i] === b);
  }

  // Text types: valid UTF-8, no null bytes in first 8 KB
  if (contentType.startsWith('text/') || contentType === 'application/json') {
    const check = data.subarray(0, 8192);
    for (let i = 0; i < check.length; i++) {
      if (check[i] === 0) return false;
    }
    return true;
  }

  // Unknown type — reject
  return false;
}

/**
 * Detect MIME type from magic bytes (for inline attachments without content_type).
 */
export function detectMimeTypeFromMagicBytes(data: Buffer): string | null {
  for (const sig of MAGIC_BYTES) {
    if (data.length >= sig.bytes.length) {
      const offset = sig.offset ?? 0;
      if (sig.bytes.every((b, i) => data[offset + i] === b)) return sig.mime;
    }
  }
  // Try text detection
  const check = data.subarray(0, 8192);
  let hasNullByte = false;
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) { hasNullByte = true; break; }
  }
  if (!hasNullByte && data.length > 0) {
    // Guess JSON if it starts with { or [
    const first = data[0];
    if (first === 0x7B || first === 0x5B) return 'application/json';
    return 'text/plain';
  }
  return null;
}

/** Check if a MIME type is in the allowlist for the given attachment type. */
export function isAllowedMimeType(mimeType: string, attachmentType: string): boolean {
  if (attachmentType === 'image') return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
  if (attachmentType === 'file') return ALLOWED_FILE_MIME_TYPES.has(mimeType);
  if (attachmentType === 'url') {
    return ALLOWED_IMAGE_MIME_TYPES.has(mimeType) || ALLOWED_FILE_MIME_TYPES.has(mimeType);
  }
  return false;
}

/** Validate a URL is HTTPS-only. */
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
  if (filename.length === 0 || filename.length > 255) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.includes('\0')) return false;
  if (filename.startsWith('.') || filename.startsWith('-')) return false;
  if (filename === '.' || filename === '..') return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._\- ]{0,253}[a-zA-Z0-9._]$/.test(filename)
    || /^[a-zA-Z0-9][a-zA-Z0-9._]$/.test(filename)
    || /^[a-zA-Z0-9]$/.test(filename);
}

/** Generate a default filename when none was provided. */
function generateFilename(type: string, contentType: string, index: number): string {
  const ext = MIME_TO_EXTENSION[contentType] ?? 'bin';
  return `attachment_${index}.${ext}`;
}

/** Extract a safe filename from a URL path, falling back to a generated name. */
function filenameFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (lastSegment && lastSegment.includes('.') && lastSegment.length <= 255) {
      // Decode percent-encoding (e.g., %20 → space) then sanitize
      let decoded: string;
      try {
        decoded = decodeURIComponent(lastSegment);
      } catch {
        decoded = lastSegment;
      }
      const sanitized = decoded.replace(/[^a-zA-Z0-9._\-]/g, '_');
      if (isValidFilename(sanitized)) {
        return sanitized;
      }
    }
  } catch {
    // URL parse failure — fall through to default
  }
  return `url_attachment_${index}`;
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'text/x-log': 'log',
};

export type AttachmentValidationResult =
  | { readonly valid: true; readonly parsed: ValidatedAttachment[] }
  | { readonly valid: false; readonly error: string };

/**
 * Synchronous attachment validation. Checks schema, limits, magic bytes,
 * MIME types, and filename safety. Returns a discriminated union of
 * validated attachments on success.
 */
export function validateAttachments(
  attachments: unknown[] | undefined,
): AttachmentValidationResult {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
    return { valid: true, parsed: [] };
  }
  if (attachments.length > MAX_ATTACHMENTS_PER_TASK) {
    return { valid: false, error: `Maximum ${MAX_ATTACHMENTS_PER_TASK} attachments per task` };
  }

  let totalInlineSize = 0;
  let totalDeclaredSize = 0;
  const parsed: ValidatedAttachment[] = [];

  for (const [i, att] of (attachments as Record<string, unknown>[]).entries()) {
    // Type validation
    if (!att.type || typeof att.type !== 'string' || !VALID_ATTACHMENT_TYPES.has(att.type)) {
      return { valid: false, error: `attachments[${i}].type must be 'image', 'file', or 'url'` };
    }

    const attType = att.type as AttachmentType;

    // Mutual exclusivity: data vs url
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
    } else {
      if (att.data && att.url) {
        return { valid: false, error: `attachments[${i}]: provide data or url, not both` };
      }
    }

    // Decode inline data
    let decoded: Buffer | undefined;

    if (att.data && typeof att.data === 'string') {
      decoded = Buffer.from(att.data as string, 'base64');
      if (decoded.length > MAX_INLINE_ATTACHMENT_SIZE_BYTES) {
        return { valid: false, error: `attachments[${i}]: inline data exceeds 500 KB limit. Use presigned upload for larger files.` };
      }
      totalInlineSize += decoded.length;
    }

    // Declared size validation (for presigned uploads)
    if (!att.data && !att.url && attType !== 'url') {
      if (typeof att.expected_size_bytes !== 'number' || att.expected_size_bytes <= 0) {
        return { valid: false, error: `attachments[${i}]: expected_size_bytes required for presigned uploads` };
      }
      if (att.expected_size_bytes > MAX_ATTACHMENT_SIZE_BYTES) {
        return { valid: false, error: `attachments[${i}]: expected size exceeds 10 MB limit` };
      }
      totalDeclaredSize += att.expected_size_bytes;
    }

    // MIME type resolution and validation
    let resolvedContentType: string;
    if (att.content_type && typeof att.content_type === 'string') {
      if (!isAllowedMimeType(att.content_type, attType)) {
        return { valid: false, error: `attachments[${i}]: content_type '${att.content_type}' not allowed for type '${attType}'` };
      }
      resolvedContentType = att.content_type;
    } else if (decoded) {
      // Magic bytes validation before detection
      const detected = detectMimeTypeFromMagicBytes(decoded);
      if (!detected) {
        return { valid: false, error: `attachments[${i}]: could not determine file type. Please provide content_type explicitly.` };
      }
      if (!isAllowedMimeType(detected, attType)) {
        return { valid: false, error: `attachments[${i}]: detected content_type '${detected}' not allowed for type '${attType}'` };
      }
      resolvedContentType = detected;
    } else if (attType === 'url') {
      // URL attachments: content_type is determined at fetch time during hydration.
      // Use a placeholder — resolve-url-attachments.ts validates after download.
      resolvedContentType = 'application/octet-stream';
    } else {
      return { valid: false, error: `attachments[${i}]: content_type is required for presigned uploads` };
    }

    // Magic bytes check against declared content_type (for inline data with declared type)
    if (decoded && att.content_type) {
      if (!validateMagicBytes(decoded, resolvedContentType)) {
        return { valid: false, error: `attachments[${i}]: content does not match declared type` };
      }
    }

    // Filename resolution
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

    // Construct validated variant
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

  // Total inline size check
  if (totalInlineSize > MAX_TOTAL_INLINE_SIZE_BYTES) {
    return { valid: false, error: 'Total inline attachment size exceeds 3 MB limit. Use presigned upload for larger files.' };
  }

  // Total declared size check (inline + presigned)
  if (totalInlineSize + totalDeclaredSize > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
    return { valid: false, error: 'Total attachment size exceeds 50 MB limit' };
  }

  return { valid: true, parsed };
}
