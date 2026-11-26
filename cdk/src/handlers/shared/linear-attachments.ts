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

import { createHash } from 'crypto';
import * as dns from 'dns/promises';
import { PutObjectCommand, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from './storage-names';
import { createAttachmentRecord, type PassedAttachmentRecord } from './types';
import { EXTENSION_TO_MIME, isAllowedMimeType, isPrivateIp, isValidFilename, validateMagicBytes, MAX_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_TASK, SUPPORTED_ATTACHMENT_EXTENSIONS_LABEL } from './validation';

const ATTACHMENT_FETCH_TIMEOUT_MS = 10_000;

const MAX_LINEAR_UPLOADS_PER_ISSUE = 10;

const SCAN_HARD_CAP = 100;

const MAX_ATTACHMENT_ID_LENGTH = 128;

const UPLOAD_ID_DIGEST_CHARS = 10;

/* eslint-disable @typescript-eslint/no-magic-numbers -- file-format magic-byte signatures */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
/* eslint-enable @typescript-eslint/no-magic-numbers */

const MARKDOWN_LABEL_MAX_CHARS = 4096;

const SCAN_MAX_DESCRIPTION_CHARS = 65_536;
// Linear embeds uploaded images as `![alt](url)` and uploaded files as plain
// `[label](url)` links, and normalizes a file link's URL into the CommonMark
// angle-bracket form `[label](<https://…>)`.
const MARKDOWN_LINK_OR_IMAGE_PATTERN = new RegExp(
  `!?\\[([^\\]]{0,${MARKDOWN_LABEL_MAX_CHARS}})\\]\\(<?(https://[^)>]+)>?\\)`,
  'g',
);

/**
 * Thrown when a Linear attachment that was SELECTED for inclusion cannot be
 * safely fetched, validated, or screened. The caller treats this as a
 * fail-closed signal: reject the whole task rather than let the agent run with
 * missing or unscreened context.
 */
export class LinearAttachmentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LinearAttachmentError';
  }
}

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

interface SelectedUpload {
  readonly url: string;
  readonly filename: string;
  readonly id: string;
  readonly displayName: string;
}

export function isLinearUploadsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'uploads.linear.app' || host.endsWith('.uploads.linear.app');
  } catch {
    return false;
  }
}

/**
 * Linear upload URLs look like
 * `https://uploads.linear.app/<uuid>/<uuid>/<name>?signature=…`.
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
  const slug = pathname.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const digest = createHash('sha256').update(pathname).digest('hex').slice(0, UPLOAD_ID_DIGEST_CHARS);
  const stem = (slug || `upload-${index}`).slice(0, MAX_ATTACHMENT_ID_LENGTH - UPLOAD_ID_DIGEST_CHARS - 1);
  const id = `${stem}-${digest}`;
  const sanitized = lastSegment.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = isValidFilename(sanitized) ? sanitized : `linear-upload-${index}`;
  return { id, filename };
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function collectLinearUploads(description: string | undefined): SelectedUpload[] {
  if (!description) return [];
  let scanned = description;
  if (scanned.length > SCAN_MAX_DESCRIPTION_CHARS) {
    logger.warn('Issue description longer than the attachment-scan cap — tail not scanned', {
      description_chars: scanned.length, scan_cap: SCAN_MAX_DESCRIPTION_CHARS,
    });
    scanned = scanned.slice(0, SCAN_MAX_DESCRIPTION_CHARS);
  }
  const selected: SelectedUpload[] = [];
  const seenIds = new Set<string>();
  let index = 0;
  let match: RegExpExecArray | null;
  MARKDOWN_LINK_OR_IMAGE_PATTERN.lastIndex = 0;
  while ((match = MARKDOWN_LINK_OR_IMAGE_PATTERN.exec(scanned)) !== null) {
    if (selected.length >= SCAN_HARD_CAP) break;
    const label = (match[1] ?? '').trim();
    const url = match[2];
    if (!isLinearUploadsUrl(url)) continue;
    const { id, filename } = deriveUploadIdentity(url, index++);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    selected.push({ url, filename, id, displayName: label || filename });
  }
  return selected;
}

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
  try {
    const addrs = await dns.lookup(parsed.hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address) !== undefined)) {
      return { kind: 'error', message: 'host resolves to a private/reserved address' };
    }
  } catch (err) {
    logger.warn('Linear attachment download: DNS resolution failed', {
      host: parsed.hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'DNS resolution failed' };
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
      redirect: 'error',
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
    logger.warn('Linear attachment download: request failed', {
      host: parsed.hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'the request failed or timed out' };
  } finally {
    clearTimeout(timer);
  }
}

/** A native "paperclip" attachment surfaced from the issue's `attachments`
 *  connection (distinct from description-embedded markdown links). */
export interface LinearPaperclipAttachment {
  /** The attachment's URL (only `uploads.linear.app` ones are hydrated here). */
  readonly url: string;
  /** The attachment title — the original filename, used for messages + typing. */
  readonly title: string;
}

/**
 * Fetch, screen, and store the `uploads.linear.app` files an issue carries,
 * returning `passed` AttachmentRecords for `createTaskCore` to persist verbatim.
 *
 * Sources BOTH kinds of Linear attachment:
 *   - files embedded in the description as markdown `[label](uploads.linear.app/…)`;
 *   - native paperclip attachments (the `attachments` connection) passed in via
 *     `paperclipAttachments`. Only `uploads.linear.app`-hosted paperclips are hydrated; a paperclip
 *     that's an external link (GitHub, Figma, …) is left alone.
 * De-duped across both sources by upload id.
 *
 * @param description         the Linear issue description markdown (untrusted).
 * @param remainingSlots      attachment slots still free after public-URL image
 *                            extraction (so the combined total respects the
 *                            per-task cap of {@link MAX_ATTACHMENTS_PER_TASK}).
 * @param ctx                 OAuth token + S3/screening storage deps.
 * @param paperclipAttachments native paperclip attachments from the probe (optional).
 * @throws LinearAttachmentError if a SELECTED upload cannot be safely fetched,
 *         validated, or screened, or if the count overflows the budget
 *         (fail-closed — reject the task).
 */
export async function downloadScreenAndStoreLinearAttachments(
  description: string | undefined,
  remainingSlots: number,
  ctx: LinearAttachmentStorage,
  paperclipAttachments: readonly LinearPaperclipAttachment[] = [],
): Promise<PassedAttachmentRecord[]> {
  const all = collectLinearUploads(description);

  const seenIds = new Set(all.map((u) => u.id));
  let pcIndex = 0;
  for (const pc of paperclipAttachments) {
    if (all.length >= SCAN_HARD_CAP) break;
    if (!isLinearUploadsUrl(pc.url)) continue;
    const { id, filename } = deriveUploadIdentity(pc.url, pcIndex++);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    all.push({ url: pc.url, filename, id, displayName: (pc.title || '').trim() || filename });
  }

  if (all.length === 0) return [];

  const budget = Math.min(remainingSlots, MAX_LINEAR_UPLOADS_PER_ISSUE, MAX_ATTACHMENTS_PER_TASK);
  const slotsConsumedElsewhere = remainingSlots < MAX_LINEAR_UPLOADS_PER_ISSUE;
  if (all.length > budget) {
    throw new LinearAttachmentError(
      budget <= 0
        ? `This issue has ${all.length} Linear attachment(s), but the ${MAX_ATTACHMENTS_PER_TASK}-attachment ` +
          'limit is already used up by other images in the description. Remove some and re-apply the trigger label.'
        : `This issue has ${all.length} Linear attachments, over the limit of ${budget} that can be processed ` +
          `for one task${slotsConsumedElsewhere ? ' (some slots are used by other images in the description)' : ''}. ` +
          'Remove some attachments and re-apply the trigger label.',
    );
  }
  const selected = all;

  const records: PassedAttachmentRecord[] = [];
  const uploadedKeys: string[] = [];
  let totalBytes = 0;

  try {
    for (const upload of selected) {
      const outcome = await fetchUploadBytes(ctx.accessToken, upload.url);

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

      const mimeType = inferMime(outcome.contentType, upload.displayName, content);
      const isImage = mimeType.startsWith('image/');
      const attachmentType = isImage ? 'image' : 'file';
      if (!mimeType || !isAllowedMimeType(mimeType, attachmentType)) {
        logger.warn('Rejecting Linear task: unsupported attachment type', {
          linear_workspace_id: ctx.linearWorkspaceId,
          attachment_filename: upload.displayName,
          content_type: outcome.contentType || 'unknown',
          inferred_mime: mimeType || 'unknown',
        });
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' is not a supported file type ` +
          `(supported: ${SUPPORTED_ATTACHMENT_EXTENSIONS_LABEL}).`,
        );
      }
      if (!validateMagicBytes(content, mimeType)) {
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' content does not match its declared type '${mimeType}'.`,
        );
      }

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
        logger.error('Screening call failed for Linear attachment', {
          linear_workspace_id: ctx.linearWorkspaceId,
          attachment_filename: upload.displayName,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' could not be screened: the content screening service is unavailable.`,
          { cause: err },
        );
      }
      if (screenResult.screening.status === 'blocked') {
        throw new LinearAttachmentError(
          `Attachment '${upload.displayName}' was blocked by content policy: ${screenResult.screening.categories.join(', ')}`,
        );
      }

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
    await deleteS3Objects(ctx.s3Client, ctx.bucketName, uploadedKeys);
    throw err;
  }

  return records;
}

function startsWith(content: Buffer, magic: readonly number[]): boolean {
  if (content.length < magic.length) return false;
  return magic.every((byte, i) => content[i] === byte);
}

function isAllowedTextMime(mime: string): boolean {
  return (mime.startsWith('text/') || mime === 'application/json') && isAllowedMimeType(mime, 'file');
}

function inferMime(contentType: string, label: string, content: Buffer): string {
  if (startsWith(content, PNG_MAGIC)) return 'image/png';
  if (startsWith(content, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(content, PDF_MAGIC)) return 'application/pdf';
  if (contentType && isAllowedTextMime(contentType)) return contentType;
  const byExt = EXTENSION_TO_MIME[extensionOf(label)];
  if (byExt && isAllowedTextMime(byExt)) return byExt;
  return '';
}

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

export async function cleanupPreScreenedAttachments(
  s3Client: S3Client,
  bucketName: string,
  records: readonly PassedAttachmentRecord[],
): Promise<void> {
  await deleteS3Objects(s3Client, bucketName, records.map((r) => r.s3_key).filter((k): k is string => Boolean(k)));
}
