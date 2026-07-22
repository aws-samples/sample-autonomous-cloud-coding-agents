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

/**
 * Authenticated Linear attachment enrichment at task-admission time (ADR-016).
 *
 * ABCA runs Linear 100% deterministically — there is NO Linear MCP (see
 * ADR-016 "Linear is fully deterministic"). The agent therefore cannot fetch
 * `uploads.linear.app`-hosted files at runtime (that used to be
 * `mcp__linear-server__extract_images`). Instead, the webhook processor fetches
 * them here at admission time, AUTHENTICATED with the workspace `@bgagent`
 * OAuth token, screens each through the same Bedrock Guardrail pipeline as
 * every other attachment, uploads the cleaned bytes to S3, and returns `passed`
 * AttachmentRecords for `createTaskCore` to persist verbatim.
 *
 * All platform-supported attachment types come through here, not just images:
 * images (PNG/JPEG) are screened visually, files (PDF/text/csv/markdown/json/
 * log) as text — same set the inline/URL paths and `jira-attachments.ts` allow.
 * An unsupported type (docx, zip, …) FAILS the task closed with a message naming
 * the supported types (user deletes it + re-triggers) — not silently skipped, so
 * a user who attached a spec isn't left wondering why it was ignored.
 *
 * This is the Linear analog of `jira-attachments.ts` (#619) — same
 * select → fetch → magic-bytes → screen → upload → record shape, same
 * fail-closed contract ({@link LinearAttachmentError}), same batch cleanup. The
 * one Linear-specific difference is the FETCH primitive: Linear embeds uploaded
 * images inline as `![alt](https://uploads.linear.app/…)` and attaches uploaded
 * files as plain `[label](https://uploads.linear.app/…)` links in the issue
 * description, and those signed URLs require the workspace OAuth bearer (the
 * unauthenticated URL-resolver in `resolve-url-attachments.ts` deliberately
 * SKIPS `uploads.linear.app` for exactly this reason — see
 * `linear-webhook-processor.extractImageUrlAttachments`). Non-Linear-hosted
 * markdown images (public CDNs) stay on that unauthenticated URL path; only the
 * `uploads.linear.app` ones come through here.
 *
 * Tests: cdk/test/handlers/shared/linear-attachments.test.ts
 */

import * as dns from 'dns/promises';
import * as net from 'net';
import { PutObjectCommand, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { createAttachmentRecord, type PassedAttachmentRecord } from './types';
import { EXTENSION_TO_MIME, isAllowedMimeType, isValidFilename, validateMagicBytes, MAX_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_TASK, SUPPORTED_ATTACHMENT_EXTENSIONS_LABEL } from './validation';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from '../../constructs/attachments-bucket';

/** Per-request timeout for a single attachment download. */
const ATTACHMENT_FETCH_TIMEOUT_MS = 10_000;

/** Cap on `uploads.linear.app` files pulled from one issue description. */
const MAX_LINEAR_UPLOADS_PER_ISSUE = 10;

/** Max length of the derived, path-safe attachment id (S3 key segment). */
const MAX_ATTACHMENT_ID_LENGTH = 128;

/* eslint-disable @typescript-eslint/no-magic-numbers -- file-format magic-byte signatures */
/** Magic-byte signatures used to sniff a body when the content-type is generic. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-
/* eslint-enable @typescript-eslint/no-magic-numbers */

/**
 * Markdown reference to a `uploads.linear.app` file. Matches BOTH the image form
 * `![alt](url)` AND the plain link form `[label](url)` — Linear embeds uploaded
 * images inline (`!`) but attaches uploaded files (PDFs, logs, specs) as plain
 * links. The leading `!` is optional so both are captured.
 *
 * Capture groups: **1 = label** (the `[…]` text — for a file link this IS the
 * original filename, e.g. `spec.docx`, surfaced in user-facing messages), **2 =
 * URL**. The URL may be wrapped in angle brackets — `[label](<https://…>)` —
 * which is the CommonMark autolink form Linear NORMALIZES uploaded-file links
 * into (live-caught on ABCA-744: a plain `[f](https://…)` link round-tripped
 * through Linear comes back as `(<https://…>)`, and the un-bracketed pattern
 * silently dropped it). The `<`/`>` are optional and excluded from the captured
 * URL, and `>` is excluded from the URL body so the closing bracket can't leak in.
 */
const MARKDOWN_LINK_OR_IMAGE_PATTERN = /!?\[([^\]]*)\]\(<?(https:\/\/[^)>]+)>?\)/g;

/**
 * Thrown when a Linear attachment that was SELECTED for inclusion cannot be
 * safely fetched, validated, or screened. The caller treats this as a
 * fail-closed signal: reject the whole task rather than let the agent run with
 * missing or unscreened context. (Attachments filtered out *before* download —
 * non-`uploads.linear.app`, over-cap — are silently skipped and never raise.)
 */
export class LinearAttachmentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LinearAttachmentError';
  }
}

/** S3 + screening dependencies for the attachment download path. */
export interface LinearAttachmentStorage {
  readonly s3Client: S3Client;
  readonly bucketName: string;
  readonly screeningConfig: ScreeningConfig;
  /** Platform user the task is attributed to — part of the S3 key. */
  readonly userId: string;
  /** Task ID minted by the caller — part of the S3 key. */
  readonly taskId: string;
  /** Workspace `@bgagent` OAuth access token (already resolved by the caller). */
  readonly accessToken: string;
  /** For log correlation only. */
  readonly linearWorkspaceId: string;
}

/** A `uploads.linear.app` file selected from the description for download. */
interface SelectedUpload {
  readonly url: string;
  /** Path-traversal-safe, unique filename for the S3 key + on-disk name. */
  readonly filename: string;
  /** Stable id derived from the upload path (S3 key segment + on-disk dir). */
  readonly id: string;
  /**
   * Human-friendly name for USER-FACING messages/logs only (the markdown
   * `[label]` — the original filename the user attached, e.g. `spec.docx`).
   * Never used in an S3 key or on disk (that's {@link filename}, which is
   * path-safe). Falls back to `filename` when the label is empty.
   */
  readonly displayName: string;
}

/** Is this a Linear-hosted upload URL (needs the OAuth bearer to fetch)? */
export function isLinearUploadsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'uploads.linear.app' || host.endsWith('.uploads.linear.app');
  } catch {
    return false;
  }
}

// Private/reserved IPv4 first-octet (and second-octet range) constants, named to
// document the RFC each blocks and to satisfy no-magic-numbers.
const OCTET_10_PRIVATE = 10; // 10.0.0.0/8 (RFC 1918)
const OCTET_127_LOOPBACK = 127; // 127.0.0.0/8
const OCTET_0_ANY = 0; // 0.0.0.0/8
const OCTET_172_PRIVATE = 172; // 172.16.0.0/12 (RFC 1918)
const OCTET_172_LO = 16;
const OCTET_172_HI = 31;
const OCTET_192_PRIVATE = 192; // 192.168.0.0/16 (RFC 1918)
const OCTET_192_SECOND = 168;
const OCTET_169_LINKLOCAL = 169; // 169.254.0.0/16 (link-local)
const OCTET_169_SECOND = 254;
const OCTET_100_CGN = 100; // 100.64.0.0/10 (carrier-grade NAT)
const OCTET_100_LO = 64;
const OCTET_100_HI = 127;

/** Reject private / internal IPs (basic SSRF guard for the resolved host). */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === OCTET_10_PRIVATE || a === OCTET_127_LOOPBACK || a === OCTET_0_ANY) return true;
    if (a === OCTET_172_PRIVATE && b >= OCTET_172_LO && b <= OCTET_172_HI) return true;
    if (a === OCTET_192_PRIVATE && b === OCTET_192_SECOND) return true;
    if (a === OCTET_169_LINKLOCAL && b === OCTET_169_SECOND) return true;
    if (a === OCTET_100_CGN && b >= OCTET_100_LO && b <= OCTET_100_HI) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  // IPv6 loopback, link-local, unique-local, all-zeros.
  return lower === '::1' || lower === '::' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd');
}

/**
 * Derive a stable, path-traversal-safe id + filename from a `uploads.linear.app`
 * URL. The id becomes an S3 key segment AND the agent-side on-disk directory
 * name, so it must never traverse. Linear upload URLs look like
 * `https://uploads.linear.app/<uuid>/<uuid>/<name>?signature=…`; we key on the
 * path (minus query) and sanitize the trailing name.
 */
function deriveUploadIdentity(url: string, index: number): { id: string; filename: string } {
  let pathname = '';
  let lastSegment = '';
  try {
    const u = new URL(url);
    pathname = u.pathname;
    lastSegment = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    pathname = url;
  }
  // Stable id: the path with unsafe chars collapsed to '-' (query dropped so a
  // re-signed URL for the same object maps to the same id). Bounded length.
  const id = (pathname.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `upload-${index}`).slice(0, MAX_ATTACHMENT_ID_LENGTH);
  const sanitized = lastSegment.replace(/[^a-zA-Z0-9._-]/g, '_');
  // No .png default: a link-form upload may be a PDF/log. A generic fallback name
  // keeps the extension out of the type decision (content-type/magic-bytes win).
  const filename = isValidFilename(sanitized) ? sanitized : `linear-upload-${index}`;
  return { id, filename };
}

/** Lowercased file extension (no dot) of a filename, or '' if none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Scan an issue description for `uploads.linear.app` markdown files (both image
 * `![](url)` and link `[](url)` forms), capped at
 * {@link MAX_LINEAR_UPLOADS_PER_ISSUE} and the remaining per-task slot budget.
 * Non-Linear-hosted URLs are ignored here (the unauthenticated URL path in
 * `resolve-url-attachments.ts` handles public images). De-dupes by id.
 */
function selectLinearUploads(description: string | undefined, remainingSlots: number): SelectedUpload[] {
  if (!description) return [];
  const slotCap = Math.max(0, Math.min(remainingSlots, MAX_LINEAR_UPLOADS_PER_ISSUE, MAX_ATTACHMENTS_PER_TASK));
  if (slotCap === 0) return [];

  const selected: SelectedUpload[] = [];
  const seenIds = new Set<string>();
  let index = 0;
  let match: RegExpExecArray | null;
  MARKDOWN_LINK_OR_IMAGE_PATTERN.lastIndex = 0;
  while ((match = MARKDOWN_LINK_OR_IMAGE_PATTERN.exec(description)) !== null) {
    if (selected.length >= slotCap) break;
    const label = (match[1] ?? '').trim();
    const url = match[2];
    if (!isLinearUploadsUrl(url)) continue; // public CDN URLs go via the URL path
    const { id, filename } = deriveUploadIdentity(url, index++);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    // The markdown label is the original filename for a file link (Linear sets
    // it to the upload's name). Use it for user-facing messages only; fall back
    // to the path-safe filename when the link had no/empty label.
    selected.push({ url, filename, id, displayName: label || filename });
  }
  return selected;
}

/**
 * GET the raw bytes of one `uploads.linear.app` URL with the OAuth bearer,
 * enforcing the size cap while reading. SSRF-guarded: HTTPS-only, host must be a
 * Linear uploads host, and the resolved IP must be public. Returns an outcome
 * kind so the caller can force a token refresh on a 401/403.
 */
async function fetchUploadBytes(
  accessToken: string,
  url: string,
): Promise<
  | { readonly kind: 'ok'; readonly content: Buffer; readonly contentType: string }
  | { readonly kind: 'auth' }
  | { readonly kind: 'error'; readonly message: string }
> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'error', message: 'invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { kind: 'error', message: 'non-HTTPS URL' };
  }
  if (!isLinearUploadsUrl(url)) {
    return { kind: 'error', message: 'not a Linear uploads host' };
  }
  // SSRF: resolve the host and reject private/internal targets before connecting.
  try {
    const addrs = await dns.lookup(parsed.hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      return { kind: 'error', message: 'host resolves to a private/reserved address' };
    }
  } catch (err) {
    return { kind: 'error', message: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: '*/*',
      },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { kind: 'auth' };
    }
    if (!resp.ok) {
      return { kind: 'error', message: `HTTP ${resp.status}` };
    }
    const contentType = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const reader = resp.body?.getReader();
    if (!reader) {
      return { kind: 'error', message: 'empty response body' };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ATTACHMENT_SIZE_BYTES) {
        await reader.cancel();
        return { kind: 'error', message: 'exceeds size limit' };
      }
      chunks.push(Buffer.from(value));
    }
    return { kind: 'ok', content: Buffer.concat(chunks), contentType };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch, screen, and store the `uploads.linear.app` files embedded in an issue
 * description, returning `passed` AttachmentRecords for `createTaskCore` to
 * persist verbatim.
 *
 * @param description     the Linear issue description markdown (untrusted).
 * @param remainingSlots  attachment slots still free after public-URL image
 *                        extraction (so the combined total respects the
 *                        per-task cap of {@link MAX_ATTACHMENTS_PER_TASK}).
 * @param ctx             OAuth token + S3/screening storage deps.
 * @throws LinearAttachmentError if a SELECTED upload cannot be safely fetched,
 *         validated, or screened (fail-closed — reject the task).
 */
export async function downloadScreenAndStoreLinearAttachments(
  description: string | undefined,
  remainingSlots: number,
  ctx: LinearAttachmentStorage,
): Promise<PassedAttachmentRecord[]> {
  if (remainingSlots <= 0) return [];
  const selected = selectLinearUploads(description, remainingSlots);
  if (selected.length === 0) return [];

  const records: PassedAttachmentRecord[] = [];
  // Keys uploaded so far this batch — deleted on any failure so a
  // partially-successful batch doesn't orphan S3 objects.
  const uploadedKeys: string[] = [];
  // Running total of REAL downloaded bytes (declared sizes don't exist for a
  // signed URL, so this is the only ceiling).
  let totalBytes = 0;

  try {
    for (const upload of selected) {
      let outcome = await fetchUploadBytes(ctx.accessToken, upload.url);

      // uploads.linear.app auth failures are terminal here: the caller already
      // resolved a fresh workspace token (resolveLinearOauthToken refreshes
      // proactively within 60s of expiry), so a 401/403 means the signed URL
      // itself is stale/invalid, not a refreshable token — fail closed.
      if (outcome.kind === 'auth') {
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' could not be downloaded: Linear rejected the credential ` +
          '(the signed upload URL may have expired — re-trigger the task).',
        );
      }
      if (outcome.kind === 'error') {
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' could not be downloaded (${outcome.message}).`,
        );
      }

      const content = outcome.content;

      totalBytes += content.length;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
        throw new LinearAttachmentError(
          `Issue attachments exceed the total size limit of ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES} bytes.`,
        );
      }
      if (content.length === 0) {
        throw new LinearAttachmentError(`Attachment '${upload.displayName}' is empty (0 bytes).`);
      }

      // Infer the MIME from the response content-type, the filename extension,
      // then the magic bytes (in that order of trust). The extension comes from
      // the markdown LABEL (displayName — the original filename like `design.pdf`),
      // not the S3 filename (derived from the URL path, a UUID with no extension).
      // Linear embeds uploaded images inline and attaches uploaded files (PDFs,
      // logs, CSVs, JSON, text) as links — both come through here. The platform
      // allowlist gates the supported set: images (PNG/JPEG) and files
      // (PDF/text/csv/markdown/json/log). Anything else (docx, zip, …) fails closed.
      const mimeType = inferMime(outcome.contentType, upload.displayName, content);
      const isImage = mimeType.startsWith('image/');
      const attachmentType = isImage ? 'image' : 'file';
      if (!mimeType || !isAllowedMimeType(mimeType, attachmentType)) {
        // Unsupported type (docx, zip, …) — there's no safe screening path, so
        // fail closed and tell the user to remove it and re-trigger. (We reject
        // rather than silently skip: a user who attached a spec would otherwise
        // get no signal it was ignored.) The supported-extension list is derived
        // from the allowlist so it never drifts.
        logger.warn('Rejecting Linear task: unsupported attachment type', {
          linear_workspace_id: ctx.linearWorkspaceId,
          attachment_filename: upload.displayName,
          content_type: outcome.contentType || 'unknown',
          inferred_mime: mimeType || 'unknown',
        });
        // Message states the fact + the supported set; the processor's reject
        // wrapper appends the "remove and re-apply the trigger label" instruction,
        // so we don't repeat it here.
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' is not a supported file type ` +
          `(supported: ${SUPPORTED_ATTACHMENT_EXTENSIONS_LABEL}).`,
        );
      }
      // Confirm the bytes match the resolved type (blocks a masquerading/polyglot
      // payload). Text types have no signature — validateMagicBytes checks for
      // valid, null-free UTF-8 instead.
      if (!validateMagicBytes(content, mimeType)) {
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' content does not match its declared type '${mimeType}'.`,
        );
      }

      // Screen through the same Bedrock Guardrail pipeline as every other
      // attachment — images visually, files as text. Any block or screening
      // failure is fail-closed. (Pass displayName — screening uses it only in
      // its own error text, never as a path.)
      let screenResult;
      try {
        screenResult = isImage
          ? await screenImage(content, mimeType, upload.displayName, ctx.screeningConfig)
          : await screenTextFile(content, mimeType, upload.displayName, ctx.screeningConfig);
      } catch (err) {
        if (err instanceof AttachmentScreeningError) {
          throw new LinearAttachmentError(
            `Attachment '${upload.displayName}' was blocked by content screening: ${err.message}`,
            { cause: err },
          );
        }
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' could not be screened: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      if (screenResult.screening.status === 'blocked') {
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' was blocked by content policy: ${screenResult.screening.categories.join(', ')}`,
        );
      }

      // S3 key + record filename stay path-safe (upload.filename) — the agent
      // writes the attachment to disk at `<dir>/<filename>` (agent/src/attachments.py),
      // so it must never carry the raw user label.
      const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${ctx.userId}/${ctx.taskId}/${upload.id}/${upload.filename}`;
      let putResult;
      try {
        putResult = await ctx.s3Client.send(new PutObjectCommand({
          Bucket: ctx.bucketName,
          Key: s3Key,
          Body: screenResult.content,
          ContentType: mimeType,
        }));
      } catch (s3Err) {
        logger.error('S3 upload failed for Linear attachment', {
          linear_workspace_id: ctx.linearWorkspaceId,
          attachment_filename: upload.displayName,
          s3_key: s3Key,
          error: s3Err instanceof Error ? s3Err.message : String(s3Err),
          metric_type: 'linear_attachment_upload_failure',
        });
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' could not be stored.`,
          { cause: s3Err },
        );
      }
      uploadedKeys.push(s3Key);

      // Only images carry a token estimate (files aren't fed to the model as
      // vision tokens). Mirrors jira-attachments.
      const tokenEstimate = isImage
        ? estimateImageTokensFromBuffer(screenResult.content, mimeType)
        : undefined;

      records.push(createAttachmentRecord({
        attachment_id: upload.id,
        type: attachmentType,
        content_type: mimeType,
        filename: upload.filename,
        s3_key: s3Key,
        s3_version_id: putResult.VersionId ?? 'unversioned',
        size_bytes: screenResult.content.length,
        screening: { status: 'passed', screened_at: new Date().toISOString() },
        checksum_sha256: screenResult.checksum,
        ...(tokenEstimate !== undefined && { token_estimate: tokenEstimate }),
      }) as PassedAttachmentRecord);

      logger.info('Linear attachment downloaded, screened, and stored', {
        linear_workspace_id: ctx.linearWorkspaceId,
        attachment_filename: upload.displayName,
        s3_key: s3Key,
      });
    }
  } catch (err) {
    // Fail-closed: a mid-batch failure must not orphan objects already uploaded.
    await deleteS3Objects(ctx.s3Client, ctx.bucketName, uploadedKeys);
    throw err;
  }

  return records;
}

/** Does `content` start with the given magic-byte signature? */
function startsWith(content: Buffer, magic: readonly number[]): boolean {
  if (content.length < magic.length) return false;
  return magic.every((byte, i) => content[i] === byte);
}

/**
 * Resolve the MIME type of a downloaded upload, in descending order of trust:
 *   1. the response content-type, if it is itself a platform-allowed type;
 *   2. the filename extension (covers generic `application/octet-stream`
 *      responses — common for Linear file links to PDFs/logs/CSVs);
 *   3. a recognised binary magic-byte signature (PNG/JPEG/PDF).
 * Returns '' if none applies (caller silently skips the upload). Text types are
 * never sniffed from bytes — they rely on the extension in step 2.
 */
function inferMime(contentType: string, filename: string, content: Buffer): string {
  if (contentType && (isAllowedMimeType(contentType, 'image') || isAllowedMimeType(contentType, 'file'))) {
    return contentType;
  }
  const byExt = EXTENSION_TO_MIME[extensionOf(filename)];
  if (byExt) return byExt;
  if (startsWith(content, PNG_MAGIC)) return 'image/png';
  if (startsWith(content, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(content, PDF_MAGIC)) return 'application/pdf';
  return '';
}

/**
 * Best-effort deletion of S3 objects by key. Never throws — cleanup failure is
 * logged and left to the bucket's 90-day lifecycle. Mirrors
 * `jira-attachments.deleteS3Objects`.
 */
async function deleteS3Objects(s3Client: S3Client, bucketName: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const result = await s3Client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }));
    if (result.Errors && result.Errors.length > 0) {
      logger.error('Partial cleanup of Linear attachment objects — some remain', {
        failed_keys: result.Errors.map((e) => e.Key),
      });
    }
  } catch (err) {
    logger.error('Cleanup of Linear attachment objects failed (90-day lifecycle is backstop)', {
      keys,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Delete previously-stored pre-screened Linear attachment objects (for the
 *  processor to call when createTaskCore rejects the task after upload). */
export async function cleanupPreScreenedAttachments(
  s3Client: S3Client,
  bucketName: string,
  records: readonly PassedAttachmentRecord[],
): Promise<void> {
  await deleteS3Objects(s3Client, bucketName, records.map((r) => r.s3_key).filter((k): k is string => Boolean(k)));
}
