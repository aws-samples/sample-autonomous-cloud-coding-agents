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
 * Authenticated Jira context enrichment at task-admission time (issue #577).
 *
 * The webhook processor calls these helpers after Jira OAuth is resolved to
 * pull the same practical context a Linear-origin task can use, which the
 * headless agent cannot fetch itself (the Atlassian Remote MCP only supports
 * interactive OAuth — see the parent tracker #580 and ADR-015):
 *
 *   - `downloadScreenAndStoreJiraAttachments` — resolve Jira `media` file
 *     attachments through the REST API (NOT the unauthenticated `content`
 *     URL), run each through the existing Bedrock Guardrail screening
 *     pipeline, upload the cleaned bytes to S3, and return `passed`
 *     AttachmentRecords for `createTaskCore` to persist verbatim. Fail-closed:
 *     a selected attachment that cannot be safely fetched/screened throws
 *     {@link JiraAttachmentError} so the caller rejects the whole task.
 *   - `fetchRecentHumanComments` — fetch recent human-authored comments and
 *     render them to markdown. Fail-open: any failure yields an empty list so
 *     the task still proceeds.
 *
 * Both reuse the auth + refresh-and-retry-once pattern established by
 * `jira-feedback.ts` and the screen → upload → record pattern established by
 * `resolve-url-attachments.ts`.
 *
 * Tests: cdk/test/handlers/shared/jira-attachments.test.ts
 */

import { PutObjectCommand, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { extractDescriptionMarkdown } from './jira-adf';
import { resolveJiraOauthToken } from './jira-oauth-resolver';
import { logger } from './logger';
import { createAttachmentRecord, type PassedAttachmentRecord } from './types';
import { isAllowedMimeType, isValidFilename, validateMagicBytes, MAX_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_TASK } from './validation';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from '../../constructs/attachments-bucket';

/**
 * Safe Jira attachment id: digits/letters/`-`/`_` only. Jira attachment ids are
 * numeric, but the payload is (in principle) attacker-shaped, and the id
 * becomes both an S3 key segment and the agent-side on-disk directory name
 * (`attachments_dir / attachment_id`). Reject anything that could traverse.
 */
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Atlassian cross-region REST gateway base. The per-tenant OAuth token is
 * minted with `audience=api.atlassian.com`, so it is only valid against this
 * gateway host scoped by `{cloudId}` — NOT against the raw `*.atlassian.net`
 * site host (which 401s such a token). Matches `jira-feedback.ts` and
 * `agent/src/jira_reactions.py`.
 */
const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';

/** Per-request timeout for the binary attachment download. */
const ATTACHMENT_FETCH_TIMEOUT_MS = 10_000;

/** Per-request timeout for the (small, JSON) comment fetch. */
const COMMENT_FETCH_TIMEOUT_MS = 5_000;

/** Default cap on recent comments folded into the task context. */
export const DEFAULT_MAX_COMMENTS = 10;

/**
 * Tenant-scoped context for a Jira REST call, resolved once per task by the
 * caller and threaded through so the OAuth resolver runs once, not per API
 * call. Mirrors {@link import('./jira-feedback').JiraFeedbackContext}.
 */
export interface JiraTenantContext {
  /** Atlassian tenant identifier (`cloudId`) — registry key. */
  readonly cloudId: string;
  /** Name of JiraWorkspaceRegistryTable, from CDK stack output. */
  readonly registryTableName: string;
}

/** S3 + screening dependencies for the attachment download path. */
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

/**
 * Subset of a Jira `issue.fields.attachment[]` entry we depend on. Extra
 * fields are tolerated.
 */
interface RawJiraAttachment {
  readonly id?: string | number;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly content?: string;
}

/** A candidate attachment that passed the pre-download filter. */
interface SelectedAttachment {
  readonly id: string;
  /** Sanitized, path-traversal-safe filename (see {@link safeFilename}). */
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly isImage: boolean;
}

/** File extension to fall back to when a filename can't be made safe. */
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

/**
 * Produce a path-traversal-safe filename for a Jira attachment. Jira filenames
 * are arbitrary user uploads (spaces, parens, unicode), and the value becomes
 * an S3 key segment AND the agent-side on-disk filename, so an unsanitized
 * `../../evil` would be an arbitrary-write primitive. Mirror the URL path
 * (`validation.filenameFromUrl`): replace unsafe characters, then fall back to
 * a generated name keyed on the MIME type if the result still isn't valid.
 * Never rejects — a legitimate attachment with an awkward name keeps its bytes
 * under a safe name rather than being dropped.
 */
function safeFilename(rawFilename: string, mimeType: string, index: number): string {
  const sanitized = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (isValidFilename(sanitized)) return sanitized;
  const ext = MIME_FALLBACK_EXTENSION[mimeType] ?? 'bin';
  return `attachment_${index}.${ext}`;
}

/**
 * Filter raw Jira attachments down to the set we'll fetch, enforcing the same
 * limits the wire path enforces:
 *   - supported MIME types only (PNG/JPEG images; text/csv/md/json/pdf/log)
 *   - per-file size <= MAX_ATTACHMENT_SIZE_BYTES (10 MB)
 *   - combined count (with slots already used by URL image attachments) <=
 *     MAX_ATTACHMENTS_PER_TASK (10)
 *   - running total size <= MAX_TOTAL_ATTACHMENT_SIZE_BYTES (50 MB)
 *
 * Unsupported / oversized / over-cap attachments are DROPPED (logged), not
 * errored: they simply never reach the agent, satisfying the fail-closed
 * contract without failing the task. The download step (which can error) only
 * ever sees this filtered, safe-by-metadata list.
 */
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
    // The id becomes an S3 key segment AND the agent's on-disk directory name.
    // A Jira id is numeric, but the payload is attacker-shaped in principle, so
    // reject anything that isn't a safe token (path traversal / injection).
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

/**
 * GET the raw bytes of one attachment through the gateway attachment-content
 * endpoint, enforcing the size cap while reading. The 3LO token is only valid
 * against the gateway base (see {@link JIRA_API_BASE}); the raw site-host
 * `content` URL in the webhook payload would 401 this token, so we address the
 * attachment by id instead. Returns the outcome kind so the caller can force a
 * token refresh on a 401/403.
 */
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
    // `redirect: 'follow'` (the default) lets the gateway hand off to the
    // backing media store; the Authorization header is dropped on cross-origin
    // redirects by fetch, which is the desired behaviour — the redirect target
    // carries its own short-lived signed URL.
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // The attachment-content endpoint returns the file's own content type
        // (image/jpeg, application/pdf, …) and responds 406 Not Acceptable to a
        // narrow `Accept: application/octet-stream`. Accept anything so the
        // gateway can serve the real media type.
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
    // Enforce the size cap while reading so a mislabeled/huge body can't blow
    // the Lambda's memory. `size` metadata was already checked, but the body
    // is authoritative.
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
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
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

  // Resolve the token once for the batch; refresh reactively on a 401/403.
  let token = await resolveJiraOauthToken(ctx.cloudId, ctx.registryTableName);
  if (!token) {
    throw new JiraAttachmentError(
      'Could not resolve a Jira OAuth token to download issue attachments.',
    );
  }

  const records: PassedAttachmentRecord[] = [];
  // Keys uploaded so far this batch. On any failure we delete them so a
  // partially-successful batch doesn't orphan objects in S3 (the caller's
  // `cleanupOrphanedAttachments` only tracks inline uploads, not these).
  const uploadedKeys: string[] = [];
  // Running total of REAL downloaded bytes. selectAttachments enforces the
  // total against attacker-declared `size`, which can under-report; enforce
  // the real total here so a batch that lies about sizes can't blow past the
  // documented 50 MB ceiling.
  let totalBytes = 0;

  try {
    for (const att of selected) {
      let outcome = await fetchAttachmentBytes(token.accessToken, ctx.cloudId, att.id);

      // Reactive refresh-and-retry-once on auth rejection, mirroring
      // jira-feedback.postCommentWithResult: the stored token may be dead
      // despite a not-yet-reached expiry (server-side revocation).
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

      // Enforce the total-size ceiling on real bytes (declared sizes can lie).
      totalBytes += content.length;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
        throw new JiraAttachmentError(
          `Issue attachments exceed the total size limit of ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES} bytes.`,
        );
      }

      // Reject an empty body. A 0-byte file (a common user mistake) would pass
      // magic-byte + screening but trip createAttachmentRecord's size guard
      // with a plain Error — outside the fail-closed conversion — so surface it
      // as a JiraAttachmentError here to keep the reject-with-comment contract.
      if (content.length === 0) {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' is empty (0 bytes).`,
        );
      }

      // The declared metadata MIME already passed the allowlist; confirm the
      // bytes actually match it (blocks a masquerading/polyglot payload).
      if (!validateMagicBytes(content, att.mimeType)) {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' content does not match its declared type '${att.mimeType}'.`,
        );
      }

      // Screen through the same Bedrock Guardrail pipeline as inline/URL
      // attachments. Any block or screening failure is fail-closed.
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
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' could not be screened: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (screenResult.screening.status === 'blocked') {
        throw new JiraAttachmentError(
          `Attachment '${att.filename}' was blocked by content policy: ${screenResult.screening.categories.join(', ')}`,
        );
      }

      // Upload the cleaned bytes under the same key layout as the inline/URL
      // paths so downstream hydration/authorization is uniform.
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
    // Fail-closed: a mid-batch failure must not orphan the objects already
    // uploaded this batch. Best-effort delete (the 90-day lifecycle is the
    // backstop) before re-throwing so the caller still rejects the task.
    await deleteS3Objects(ctx.s3Client, ctx.bucketName, uploadedKeys);
    throw err;
  }

  return records;
}

/**
 * Best-effort deletion of S3 objects by key. Never throws — cleanup failure is
 * logged and left to the bucket's lifecycle policy. Mirrors
 * `create-task-core.cleanupOrphanedAttachments`.
 */
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

/** Delete previously-stored pre-screened Jira attachment objects (exported for
 *  the processor to call when createTaskCore rejects the task after upload). */
export async function cleanupPreScreenedAttachments(
  s3Client: S3Client,
  bucketName: string,
  records: readonly PassedAttachmentRecord[],
): Promise<void> {
  await deleteS3Objects(s3Client, bucketName, records.map((r) => r.s3_key).filter((k): k is string => Boolean(k)));
}

/** A rendered issue comment folded into the task context. */
export interface RenderedComment {
  readonly author: string;
  readonly createdAt: string;
  readonly markdown: string;
}

/** Subset of a Jira comment object we depend on. Extra fields tolerated. */
interface RawJiraComment {
  readonly author?: {
    readonly displayName?: string;
    readonly accountType?: string;
  };
  readonly body?: unknown; // ADF document
  readonly created?: string;
}

interface JiraCommentPage {
  readonly comments?: RawJiraComment[];
}

/**
 * Fetch the most recent human-authored comments on an issue and render them to
 * markdown, oldest-first. Best-effort / fail-open: any failure (auth, REST
 * error, malformed body) logs a WARN and returns `[]` so the task still
 * proceeds — comments are advisory context, not a gate.
 *
 * "Human" = author `accountType === 'atlassian'`. Atlassian marks app/bot
 * authors with `accountType: 'app'`, so this drops ABCA's own REST-posted
 * progress/failure comments (and other bots) without needing to know the app's
 * own accountId.
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

    // Newest-first so `maxResults` keeps the most recent; we reverse to
    // oldest-first for rendering.
    const url =
      `${JIRA_API_BASE}/${encodeURIComponent(ctx.cloudId)}` +
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment` +
      `?orderBy=-created&maxResults=${encodeURIComponent(String(maxComments))}`;
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
      // Human authors only. Missing accountType is treated as non-human
      // (conservative: better to omit an ambiguous author than surface a bot).
      if (c.author?.accountType !== 'atlassian') continue;
      const markdown = extractDescriptionMarkdown(c.body);
      if (!markdown.trim()) continue;
      rendered.push({
        author: c.author?.displayName?.trim() || 'Unknown',
        createdAt: typeof c.created === 'string' ? c.created : '',
        markdown: markdown.trim(),
      });
    }

    // API returned newest-first; render oldest-first so the thread reads
    // naturally.
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
