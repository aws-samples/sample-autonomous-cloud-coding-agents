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
 * Jira context enrichment at task-admission time (issue #577). The headless
 * agent cannot fetch it itself: the Atlassian Remote MCP only supports
 * interactive OAuth (#580, ADR-015).
 */

import { PutObjectCommand, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { extractDescriptionMarkdown } from './jira-adf';
import { resolveJiraOauthToken } from './jira-oauth-resolver';
import { logger } from './logger';
import { isBotAuthoredComment } from './orchestration-comment-trigger';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from './storage-names';
import { createAttachmentRecord, type PassedAttachmentRecord } from './types';
import { isAllowedMimeType, isValidFilename, validateMagicBytes, MAX_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_TASK } from './validation';

const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Atlassian cross-region REST gateway base. The per-tenant OAuth token is
 * minted with `audience=api.atlassian.com`, so it is only valid against this
 * gateway host scoped by `{cloudId}` — NOT against the raw `*.atlassian.net`
 * site host (which 401s such a token).
 */
const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

const ATTACHMENT_FETCH_TIMEOUT_MS = 10_000;

const COMMENT_FETCH_TIMEOUT_MS = 5_000;

const DEFAULT_MAX_COMMENTS = 10;

const COMMENT_PAGE_SIZE = 100;

export interface JiraTenantContext {
  /** Atlassian tenant identifier (`cloudId`) — registry key. */
  readonly cloudId: string;
  readonly registryTableName: string;
}

export interface JiraAttachmentStorage {
  readonly s3Client: S3Client;
  readonly bucketName: string;
  readonly screeningConfig: ScreeningConfig;
  /** Platform user the task is attributed to — part of the S3 key. */
  readonly userId: string;
  /** Task ID minted by the caller — part of the S3 key. */
  readonly taskId: string;
}

/**
 * Thrown when a Jira attachment that was SELECTED for inclusion cannot be
 * safely fetched, validated, or screened. The caller treats this as a
 * fail-closed signal: reject the whole task rather than let the agent run
 * with missing or unscreened context. (Attachments filtered out *before*
 * download — unsupported MIME, oversized — are silently skipped instead, and
 * never raise this.)
 */
export class JiraAttachmentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JiraAttachmentError';
  }
}

interface RawJiraAttachment {
  readonly id?: string | number;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly content?: string;
}

interface SelectedAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly isImage: boolean;
}

const MIME_FALLBACK_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'text/x-log': 'log',
};

function safeFilename(rawFilename: string, mimeType: string, index: number): string {
  const sanitized = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (isValidFilename(sanitized)) return sanitized;
  const ext = MIME_FALLBACK_EXTENSION[mimeType] ?? 'bin';
  return `attachment_${index}.${ext}`;
}

function selectAttachments(
  raw: readonly RawJiraAttachment[],
  remainingSlots: number,
): { selected: SelectedAttachment[]; skipped: number } {
  const selected: SelectedAttachment[] = [];
  let skipped = 0;
  let runningTotal = 0;
  const slotCap = Math.max(0, Math.min(remainingSlots, MAX_ATTACHMENTS_PER_TASK));

  let index = 0;
  for (const att of raw) {
    if (selected.length >= slotCap) {
      skipped++;
      continue;
    }
    const id = att.id !== undefined && att.id !== null ? String(att.id) : '';
    const rawFilename = typeof att.filename === 'string' ? att.filename : '';
    const mimeType = typeof att.mimeType === 'string' ? att.mimeType : '';
    const size = typeof att.size === 'number' ? att.size : 0;
    if (!id || !rawFilename || !mimeType) {
      skipped++;
      continue;
    }
    if (!SAFE_ATTACHMENT_ID.test(id)) {
      skipped++;
      continue;
    }
    const isImage = mimeType.startsWith('image/');
    const attachmentType = isImage ? 'image' : 'file';
    if (!isAllowedMimeType(mimeType, attachmentType)) {
      skipped++;
      continue;
    }
    if (size > MAX_ATTACHMENT_SIZE_BYTES) {
      skipped++;
      continue;
    }
    if (runningTotal + size > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
      skipped++;
      continue;
    }
    runningTotal += size;
    selected.push({ id, filename: safeFilename(rawFilename, mimeType, index++), mimeType, size, isImage });
  }

  return { selected, skipped };
}

async function fetchAttachmentBytes(
  accessToken: string,
  cloudId: string,
  attachmentId: string,
): Promise<
  | { readonly kind: 'ok'; readonly content: Buffer }
  | { readonly kind: 'auth' }
  | { readonly kind: 'error'; readonly message: string; readonly tooLarge?: boolean }
> {
  const url =
    `${JIRA_API_BASE}/${encodeURIComponent(cloudId)}` +
    `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // The attachment-content endpoint returns the file's own content type
        // and responds 406 Not Acceptable to `Accept: application/octet-stream`.
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
        return { kind: 'error', message: 'exceeds size limit', tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
    return { kind: 'ok', content: Buffer.concat(chunks) };
  } catch (err) {
    logger.warn('Jira attachment download: request failed', {
      jira_cloud_id: cloudId,
      attachment_id: attachmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'the request failed or timed out' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch, screen, and store the selected Jira `media` attachments, returning
 * `passed` AttachmentRecords for `createTaskCore` to persist verbatim.
 *
 * @param rawAttachments  `issue.fields.attachment` (unknown/untrusted shape).
 * @param remainingSlots  attachment slots still free after URL image
 *                        extraction (so the combined total respects the
 *                        per-task cap of 10).
 * @param ctx             tenant context + S3/screening storage deps.
 * @throws JiraAttachmentError if a SELECTED attachment cannot be safely
 *         fetched, validated, or screened (fail-closed — reject the task).
 */
export async function downloadScreenAndStoreJiraAttachments(
  rawAttachments: unknown,
  remainingSlots: number,
  ctx: JiraTenantContext & JiraAttachmentStorage,
): Promise<PassedAttachmentRecord[]> {
  const raw = Array.isArray(rawAttachments) ? (rawAttachments as RawJiraAttachment[]) : [];
  if (raw.length === 0 || remainingSlots <= 0) return [];

  const { selected, skipped } = selectAttachments(raw, remainingSlots);
  if (skipped > 0) {
    logger.info('Skipped unsupported/oversized/over-cap Jira attachments', {
      jira_cloud_id: ctx.cloudId,
      skipped,
      selected: selected.length,
      total: raw.length,
    });
  }
  if (selected.length === 0) return [];

  let token = await resolveJiraOauthToken(ctx.cloudId, ctx.registryTableName);
  if (!token) {
    throw new JiraAttachmentError(
      'Could not resolve a Jira OAuth token to download issue attachments.',
    );
  }

  const records: PassedAttachmentRecord[] = [];
  const uploadedKeys: string[] = [];
  let totalBytes = 0;

  try {
    for (const att of selected) {
      let outcome = await fetchAttachmentBytes(token.accessToken, ctx.cloudId, att.id);

      if (outcome.kind === 'auth') {
        logger.info('Jira attachment download got auth rejection — forcing token refresh and retrying once', {
          jira_cloud_id: ctx.cloudId,
          attachment_filename: att.filename,
        });
        const refreshed = await resolveJiraOauthToken(ctx.cloudId, ctx.registryTableName, { forceRefresh: true });
        if (!refreshed || refreshed.accessToken === token.accessToken) {
          throw new JiraAttachmentError(
            `Attachment '${att.filename}' could not be downloaded: Jira rejected the credential.`,
          );
        }
        token = refreshed;
        outcome = await fetchAttachmentBytes(token.accessToken, ctx.cloudId, att.id);
      }

      if (outcome.kind === 'auth') {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' could not be downloaded: Jira rejected the credential.`,
        );
      }
      if (outcome.kind === 'error') {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' could not be downloaded (${outcome.message}).`,
        );
      }

      const content = outcome.content;

      totalBytes += content.length;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
        throw new JiraAttachmentError(
          `Issue attachments exceed the total size limit of ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES} bytes.`,
        );
      }

      if (content.length === 0) {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' is empty (0 bytes).`,
        );
      }

      if (!validateMagicBytes(content, att.mimeType)) {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' content does not match its declared type '${att.mimeType}'.`,
        );
      }

      let screenResult;
      try {
        screenResult = att.isImage
          ? await screenImage(content, att.mimeType, att.filename, ctx.screeningConfig)
          : await screenTextFile(content, att.mimeType, att.filename, ctx.screeningConfig);
      } catch (err) {
        if (err instanceof AttachmentScreeningError) {
          throw new JiraAttachmentError(
            `Attachment '${att.filename}' was blocked by content screening: ${err.message}`,
            { cause: err },
          );
        }
        logger.error('Screening call failed for Jira attachment', {
          jira_cloud_id: ctx.cloudId,
          attachment_filename: att.filename,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' could not be screened: the content screening service is unavailable.`,
          { cause: err },
        );
      }

      if (screenResult.screening.status === 'blocked') {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' was blocked by content policy: ${screenResult.screening.categories.join(', ')}`,
        );
      }

      const attachmentId = att.id;
      const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${ctx.userId}/${ctx.taskId}/${attachmentId}/${att.filename}`;
      let putResult;
      try {
        putResult = await ctx.s3Client.send(new PutObjectCommand({
          Bucket: ctx.bucketName,
          Key: s3Key,
          Body: screenResult.content,
          ContentType: att.mimeType,
        }));
      } catch (s3Err) {
        logger.error('S3 upload failed for Jira attachment', {
          jira_cloud_id: ctx.cloudId,
          attachment_filename: att.filename,
          s3_key: s3Key,
          error: s3Err instanceof Error ? s3Err.message : String(s3Err),
          metric_type: 'jira_attachment_upload_failure',
        });
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' could not be stored.`,
          { cause: s3Err },
        );
      }
      uploadedKeys.push(s3Key);

      const tokenEstimate = att.isImage
        ? estimateImageTokensFromBuffer(screenResult.content, att.mimeType)
        : undefined;

      records.push(createAttachmentRecord({
        attachment_id: attachmentId,
        type: att.isImage ? 'image' : 'file',
        content_type: att.mimeType,
        filename: att.filename,
        s3_key: s3Key,
        s3_version_id: putResult.VersionId ?? 'unversioned',
        size_bytes: screenResult.content.length,
        screening: { status: 'passed', screened_at: new Date().toISOString() },
        checksum_sha256: screenResult.checksum,
        ...(tokenEstimate !== undefined && { token_estimate: tokenEstimate }),
      }) as PassedAttachmentRecord);

      logger.info('Jira attachment downloaded, screened, and stored', {
        jira_cloud_id: ctx.cloudId,
        attachment_filename: att.filename,
        s3_key: s3Key,
      });
    }
  } catch (err) {
    await deleteS3Objects(ctx.s3Client, ctx.bucketName, uploadedKeys);
    throw err;
  }

  return records;
}

async function deleteS3Objects(s3Client: S3Client, bucketName: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const result = await s3Client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }));
    if (result.Errors && result.Errors.length > 0) {
      logger.error('Partial cleanup of Jira attachment objects — some remain', {
        failed_keys: result.Errors.map((e) => e.Key),
      });
    }
  } catch (err) {
    logger.error('Cleanup of Jira attachment objects failed (90-day lifecycle is backstop)', {
      keys,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Best-effort deletion of previously-stored pre-screened Jira attachment objects. Never throws. */
export async function cleanupPreScreenedAttachments(
  s3Client: S3Client,
  bucketName: string,
  records: readonly PassedAttachmentRecord[],
): Promise<void> {
  await deleteS3Objects(s3Client, bucketName, records.map((r) => r.s3_key).filter((k): k is string => Boolean(k)));
}

export interface RenderedComment {
  readonly author: string;
  readonly createdAt: string;
  readonly markdown: string;
}

interface RawJiraComment {
  readonly author?: {
    readonly displayName?: string;
    readonly accountType?: string;
  };
  readonly body?: unknown;
  readonly created?: string;
}

interface JiraCommentPage {
  readonly comments?: RawJiraComment[];
}

/**
 * Fetch the most recent human-authored comments on an issue and render them to
 * markdown, oldest-first. Best-effort / fail-open: any failure (auth, REST
 * error, malformed body) logs a WARN and returns `[]`.
 *
 * "Human" = author `accountType === 'atlassian'` and a text that does not
 * start with one of ABCA's own comment markers. Atlassian marks app/bot
 * authors with `accountType: 'app'`. What ABCA posts through OAuth belongs to
 * the setup user, so those comments are told by their marker
 * ({@link isBotAuthoredComment}).
 */
export async function fetchRecentHumanComments(
  ctx: JiraTenantContext,
  issueIdOrKey: string,
  maxComments: number = DEFAULT_MAX_COMMENTS,
): Promise<RenderedComment[]> {
  try {
    const token = await resolveJiraOauthToken(ctx.cloudId, ctx.registryTableName);
    if (!token) {
      logger.warn('Skipping Jira comment fetch: could not resolve OAuth token', {
        jira_cloud_id: ctx.cloudId,
        issue_id_or_key: issueIdOrKey,
      });
      return [];
    }

    const url =
      `${JIRA_API_BASE}/${encodeURIComponent(ctx.cloudId)}` +
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment` +
      `?orderBy=-created&maxResults=${COMMENT_PAGE_SIZE}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMENT_FETCH_TIMEOUT_MS);
    let page: JiraCommentPage;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!resp.ok) {
        logger.warn('Jira comment fetch non-2xx (proceeding without comments)', {
          jira_cloud_id: ctx.cloudId,
          issue_id_or_key: issueIdOrKey,
          status: resp.status,
        });
        return [];
      }
      page = (await resp.json()) as JiraCommentPage;
    } finally {
      clearTimeout(timer);
    }

    const comments = Array.isArray(page.comments) ? page.comments : [];
    const rendered: RenderedComment[] = [];
    for (const c of comments) {
      if (rendered.length >= maxComments) break;
      if (c.author?.accountType !== 'atlassian') continue;
      const markdown = extractDescriptionMarkdown(c.body);
      if (!markdown.trim() || isBotAuthoredComment(markdown)) continue;
      rendered.push({
        author: c.author?.displayName?.trim() || 'Unknown',
        createdAt: typeof c.created === 'string' ? c.created : '',
        markdown: markdown.trim(),
      });
    }

    rendered.reverse();
    if (rendered.length > 0) {
      logger.info('Fetched recent human Jira comments for task context', {
        jira_cloud_id: ctx.cloudId,
        issue_id_or_key: issueIdOrKey,
        count: rendered.length,
      });
    }
    return rendered;
  } catch (err) {
    logger.warn('Jira comment fetch failed (proceeding without comments)', {
      jira_cloud_id: ctx.cloudId,
      issue_id_or_key: issueIdOrKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- issue #577 mandates comments are advisory: on any fetch failure the task proceeds without them (fail-open), warning logged above
  }
}
