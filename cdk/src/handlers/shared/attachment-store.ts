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
 * What a tracker attachment goes through once its bytes are downloaded, and the
 * cleanup of a batch: shared by `linear-attachments.ts` and `jira-attachments.ts`.
 *
 * Tests: cdk/test/handlers/shared/attachment-store.test.ts, and through the two
 * callers in their suites and in attachment-store-failure.test.ts
 */

import { DeleteObjectsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { AttachmentScreeningError, screenImage, screenTextFile, type ScreeningConfig } from './attachment-screening';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from './storage-names';
import { createAttachmentRecord, type PassedAttachmentRecord } from './types';
import { validateMagicBytes } from './validation';

/**
 * Check the bytes of one downloaded attachment against its type, screen them
 * through the Bedrock Guardrail (an image visually, a file as text), store them
 * and return the `passed` record for `createTaskCore`. Fail-closed: every
 * refusal is thrown through `fail`, so that each caller keeps the error class
 * its webhook processor answers on the issue.
 *
 * `displayName` is for people: the messages, the log lines and the screening
 * call, which never uses it as a path. The S3 key and the record use
 * `filename`, which must be path-safe: the agent writes the attachment to disk
 * under it.
 *
 * The key goes onto `uploadedKeys`, the caller's list, as soon as the object is
 * stored: the caller deletes that list when anything after the put throws.
 */
export async function screenAndStore(input: {
  /** The tracker's name as the log texts spell it: 'Linear' or 'Jira'. */
  surface: string;
  content: Buffer;
  mimeType: string;
  attachmentId: string;
  filename: string;
  displayName: string;
  store: { s3Client: S3Client; bucketName: string; screeningConfig: ScreeningConfig; userId: string; taskId: string };
  uploadedKeys: string[];
  /** The log field that names the tenant. */
  logFields: Record<string, unknown>;
  fail: (message: string, cause?: unknown) => Error;
}): Promise<PassedAttachmentRecord> {
  const { surface, content, mimeType, displayName, store, fail } = input;
  const logFields = { ...input.logFields, attachment_filename: displayName };
  const isImage = mimeType.startsWith('image/');

  // Blocks a masquerading or polyglot payload. A text type has no signature:
  // validateMagicBytes checks for valid, null-free UTF-8 instead.
  if (!validateMagicBytes(content, mimeType)) {
    throw fail(`Attachment '${displayName}' content does not match its declared type '${mimeType}'.`);
  }

  let screenResult;
  try {
    screenResult = isImage
      ? await screenImage(content, mimeType, displayName, store.screeningConfig)
      : await screenTextFile(content, mimeType, displayName, store.screeningConfig);
  } catch (err) {
    if (err instanceof AttachmentScreeningError) {
      throw fail(`Attachment '${displayName}' was blocked by content screening: ${err.message}`, err);
    }
    // Not a verdict on the file: the screening call itself failed (throttled,
    // denied). The SDK's text can name the role and the account, and the
    // failure's message is posted on the issue, so it stays in the log.
    logger.error(`Screening call failed for ${surface} attachment`, {
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    });
    throw fail(`Attachment '${displayName}' could not be screened: the content screening service is unavailable.`, err);
  }
  if (screenResult.screening.status === 'blocked') {
    throw fail(`Attachment '${displayName}' was blocked by content policy: ${screenResult.screening.categories.join(', ')}`);
  }

  // The key layout of the inline and URL paths, so that downstream hydration and authorization are uniform.
  const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${store.userId}/${store.taskId}/${input.attachmentId}/${input.filename}`;
  let putResult;
  try {
    putResult = await store.s3Client.send(new PutObjectCommand({
      Bucket: store.bucketName,
      Key: s3Key,
      Body: screenResult.content,
      ContentType: mimeType,
    }));
  } catch (s3Err) {
    logger.error(`S3 upload failed for ${surface} attachment`, {
      ...logFields,
      s3_key: s3Key,
      error: s3Err instanceof Error ? s3Err.message : String(s3Err),
      // linear_attachment_upload_failure, jira_attachment_upload_failure
      metric_type: `${surface.toLowerCase()}_attachment_upload_failure`,
    });
    throw fail(`Attachment '${displayName}' could not be stored.`, s3Err);
  }
  input.uploadedKeys.push(s3Key);

  // Only an image carries a token estimate: a file is not fed to the model as vision tokens.
  const tokenEstimate = isImage ? estimateImageTokensFromBuffer(screenResult.content, mimeType) : undefined;
  const record = createAttachmentRecord({
    attachment_id: input.attachmentId,
    type: isImage ? 'image' : 'file',
    content_type: mimeType,
    filename: input.filename,
    s3_key: s3Key,
    s3_version_id: putResult.VersionId ?? 'unversioned',
    size_bytes: screenResult.content.length,
    screening: { status: 'passed', screened_at: new Date().toISOString() },
    checksum_sha256: screenResult.checksum,
    ...(tokenEstimate !== undefined && { token_estimate: tokenEstimate }),
  }) as PassedAttachmentRecord;

  logger.info(`${surface} attachment downloaded, screened, and stored`, { ...logFields, s3_key: s3Key });
  return record;
}

/**
 * Best-effort deletion of stored attachment objects by key. Never throws: a
 * failed cleanup is logged and left to the bucket's 90-day lifecycle.
 */
export async function deleteStoredObjects(s3Client: S3Client, bucketName: string, keys: readonly string[], surface: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    const result = await s3Client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }));
    if (result.Errors && result.Errors.length > 0) {
      logger.error(`Partial cleanup of ${surface} attachment objects — some remain`, {
        failed_keys: result.Errors.map((e) => e.Key),
      });
    }
  } catch (err) {
    logger.error(`Cleanup of ${surface} attachment objects failed (90-day lifecycle is backstop)`, {
      keys,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
