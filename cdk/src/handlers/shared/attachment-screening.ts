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
import { ApplyGuardrailCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import sharp from 'sharp';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScreeningConfig {
  readonly guardrailId: string;
  readonly guardrailVersion: string;
  readonly bedrockClient: BedrockRuntimeClient;
}

export type ScreeningOutcome =
  | { readonly status: 'passed' }
  | { readonly status: 'blocked'; readonly categories: [string, ...string[]] };

export interface ScreenedAttachment {
  readonly content: Buffer;
  readonly contentType: string;
  readonly checksum: string;
  readonly screening: ScreeningOutcome;
}

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

/**
 * Retry with exponential backoff for transient Bedrock errors.
 * Non-retryable errors (4xx except 429, validation errors) propagate immediately.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs: number; context: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const statusCode = err?.$metadata?.httpStatusCode ?? err?.statusCode;
      const isRetryable = RETRYABLE_STATUS_CODES.has(statusCode);
      if (!isRetryable || attempt === opts.maxRetries) {
        if (isRetryable && attempt === opts.maxRetries) {
          logger.error('All retries exhausted for Bedrock screening', {
            context: opts.context,
            total_attempts: attempt + 1,
            status_code: statusCode,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      logger.warn('Retrying after transient error', {
        context: opts.context,
        attempt: attempt + 1,
        max_retries: opts.maxRetries,
        status_code: statusCode,
        delay_ms: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Image screening
// ---------------------------------------------------------------------------

/**
 * Screen an image attachment through the Bedrock Guardrail.
 *
 * Flow: validate → convert GIF/WebP to PNG (Bedrock only accepts png|jpeg) →
 * screen → strip EXIF / re-encode on pass.
 *
 * @returns ScreenedAttachment with cleaned content (EXIF-stripped, re-encoded) and checksum.
 * @throws Error on sharp failure or guardrail unavailability (fail-closed).
 */
export async function screenImage(
  content: Buffer,
  contentType: string,
  filename: string,
  config: ScreeningConfig,
): Promise<ScreenedAttachment> {
  // Convert GIF/WebP to PNG before screening (Bedrock only accepts png | jpeg)
  let screeningBuffer: Buffer;
  let screeningFormat: 'png' | 'jpeg';

  if (contentType === 'image/jpeg') {
    screeningBuffer = content;
    screeningFormat = 'jpeg';
  } else if (contentType === 'image/gif' || contentType === 'image/webp') {
    // GIF/WebP → PNG. For animated GIFs, extract first frame only.
    try {
      screeningBuffer = await sharp(content, { animated: false }).png().toBuffer();
    } catch (convErr) {
      throw new AttachmentScreeningError(
        `Image "${filename}" could not be converted from ${contentType} for screening. ` +
        'The file may be corrupt. Please re-export or use a PNG/JPEG format.',
        { cause: convErr },
      );
    }
    screeningFormat = 'png';

    // Post-conversion size check: PNG expansion of compressed GIF/WebP can exceed limit.
    if (screeningBuffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new AttachmentScreeningError(
        `Image "${filename}" is ${contentType} and its PNG conversion for screening ` +
        `exceeds the ${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB limit ` +
        `(${(screeningBuffer.length / (1024 * 1024)).toFixed(1)} MB after conversion). ` +
        'Please convert to JPEG or reduce image dimensions before uploading.',
      );
    }
  } else {
    // PNG: use as-is
    screeningBuffer = content;
    screeningFormat = 'png';
  }

  // Screen through Bedrock Guardrail with retry
  const result = await retryWithBackoff(
    () => config.bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: config.guardrailId,
      guardrailVersion: config.guardrailVersion,
      source: 'INPUT',
      content: [{
        image: {
          format: screeningFormat,
          source: { bytes: screeningBuffer },
        },
      }],
    })),
    { maxRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS, context: `image_screening:${filename}` },
  );

  if (result.action === 'GUARDRAIL_INTERVENED') {
    const categories = extractBlockedCategories(result.assessments);
    return {
      content: screeningBuffer,
      contentType,
      checksum: computeSha256(screeningBuffer),
      screening: { status: 'blocked', categories },
    };
  }

  // Screening passed — strip EXIF and re-encode.
  // Note: NOT calling .withMetadata() — sharp strips all metadata by default
  // when withMetadata is omitted. Calling .withMetadata({}) would opt INTO
  // metadata preservation, which is the opposite of what we want.
  let cleanedContent: Buffer;
  try {
    cleanedContent = await sharp(content)
      .rotate() // Apply EXIF orientation before stripping
      .toBuffer();
  } catch (sharpErr) {
    throw new AttachmentScreeningError(
      `Image "${filename}" could not be processed for security sanitization. ` +
      'Please re-export the image in a standard format and try again.',
      { cause: sharpErr },
    );
  }

  const checksum = computeSha256(cleanedContent);
  return {
    content: cleanedContent,
    contentType,
    checksum,
    screening: { status: 'passed' },
  };
}

// ---------------------------------------------------------------------------
// Text/file screening
// ---------------------------------------------------------------------------

/**
 * Screen a text-based file attachment through the Bedrock Guardrail.
 * Supports plain text, CSV, Markdown, JSON, and log files directly.
 * PDFs have their text extracted first.
 *
 * @returns ScreenedAttachment with the original content (text files are not re-encoded).
 * @throws Error on guardrail unavailability (fail-closed).
 */
export async function screenTextFile(
  content: Buffer,
  contentType: string,
  filename: string,
  config: ScreeningConfig,
): Promise<ScreenedAttachment> {
  let textToScreen: string;

  if (contentType === 'application/pdf') {
    textToScreen = await extractPdfText(content, filename);
    if (textToScreen.trim().length === 0) {
      throw new AttachmentScreeningError(
        `PDF "${filename}" contains no extractable text (it may be image-only or encrypted). ` +
        'Please use an OCR tool to add a text layer, or convert to an image attachment.',
      );
    }
  } else {
    textToScreen = content.toString('utf-8');
  }

  // Screen through Bedrock Guardrail with retry
  const result = await retryWithBackoff(
    () => config.bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: config.guardrailId,
      guardrailVersion: config.guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text: textToScreen } }],
    })),
    { maxRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS, context: `text_screening:${filename}` },
  );

  const checksum = computeSha256(content);

  if (result.action === 'GUARDRAIL_INTERVENED') {
    const categories = extractBlockedCategories(result.assessments);
    return {
      content,
      contentType,
      checksum,
      screening: { status: 'blocked', categories },
    };
  }

  return {
    content,
    contentType,
    checksum,
    screening: { status: 'passed' },
  };
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

const PDF_MAX_PAGES = 50;
const PDF_MAX_TEXT_BYTES = 1024 * 1024; // 1 MB extracted text cap
const PDF_EXTRACT_TIMEOUT_MS = 15_000;

async function extractPdfText(content: Buffer, filename: string): Promise<string> {
  // Dynamic import — pdf-parse is only used for PDF attachments.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfParseFn: (data: Buffer, options?: { max?: number }) => Promise<{ text: string }>;
  try {
    // pdf-parse uses a default export; handle both CJS and ESM module shapes.
    const mod = await import(/* webpackIgnore: true */ 'pdf-parse');
    pdfParseFn = (mod as any).default ?? mod;
  } catch (importErr) {
    logger.error('pdf-parse module could not be imported — PDF screening unavailable', {
      error: importErr instanceof Error ? importErr.message : String(importErr),
      metric_type: 'pdf_parse_import_failure',
    });
    throw new AttachmentScreeningError(
      `PDF processing is unavailable. Cannot screen "${filename}".`,
      { cause: importErr },
    );
  }

  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('PDF extraction timed out')), PDF_EXTRACT_TIMEOUT_MS);
    });

    const result = await Promise.race([
      pdfParseFn(content, { max: PDF_MAX_PAGES }),
      timeoutPromise,
    ]);

    let text: string = result.text ?? '';
    if (Buffer.byteLength(text, 'utf-8') > PDF_MAX_TEXT_BYTES) {
      text = text.slice(0, PDF_MAX_TEXT_BYTES);
    }
    return text;
  } catch (err) {
    throw new AttachmentScreeningError(
      `PDF "${filename}" could not be processed. It may be corrupt or use unsupported features. ` +
      'Try exporting to a simpler PDF format.',
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId!);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function extractBlockedCategories(
  assessments: any[] | undefined,
): [string, ...string[]] {
  const categories: string[] = [];
  if (assessments) {
    for (const assessment of assessments) {
      // Extract topic/content/word/sensitive-info policy categories
      for (const policyResult of Object.values(assessment) as any[]) {
        if (Array.isArray(policyResult?.topics)) {
          for (const t of policyResult.topics) {
            if (t.name) categories.push(t.name);
          }
        }
        if (Array.isArray(policyResult?.filters)) {
          for (const f of policyResult.filters) {
            if (f.type) categories.push(f.type);
          }
        }
        if (Array.isArray(policyResult?.managedWordLists)) {
          for (const w of policyResult.managedWordLists) {
            if (w.match) categories.push(`word:${w.match}`);
          }
        }
        if (Array.isArray(policyResult?.piiEntities)) {
          for (const p of policyResult.piiEntities) {
            if (p.type) categories.push(`pii:${p.type}`);
          }
        }
      }
    }
  }
  if (categories.length === 0) {
    logger.warn('Could not extract specific categories from guardrail assessment — using generic fallback', {
      has_assessments: !!assessments,
      assessment_count: assessments?.length ?? 0,
      assessment_keys: assessments?.[0] ? Object.keys(assessments[0]) : [],
    });
    categories.push('content_policy_violation');
  }
  return categories as [string, ...string[]];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class AttachmentScreeningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AttachmentScreeningError';
  }
}
