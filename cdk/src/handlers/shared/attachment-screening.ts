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
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Bedrock Guardrail image filter max side (docs: 8000x8000). */
export const MAX_IMAGE_DIMENSION_PX = 8000;

/* eslint-disable @typescript-eslint/no-magic-numbers -- file format magic-byte signatures */
const PNG_FILE_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_FILE_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
/* eslint-enable @typescript-eslint/no-magic-numbers */

const PNG_IHDR_TYPE_OFFSET = 12;
const PNG_IHDR_TYPE_LENGTH = 4;
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const PNG_MIN_IHDR_LENGTH = 24;

/** JPEGs above this size (MiB) must have readable dimensions (fail-closed otherwise). */
const JPEG_DIMENSION_VERIFY_SIZE_THRESHOLD_MB = 5;
const JPEG_DIMENSION_VERIFY_SIZE_THRESHOLD_BYTES = JPEG_DIMENSION_VERIFY_SIZE_THRESHOLD_MB * 1024 * 1024;

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
 * Only PNG and JPEG are accepted. Raw bytes are passed directly to Bedrock
 * (no re-encoding or metadata stripping required).
 *
 * @returns ScreenedAttachment with original content and checksum.
 * @throws AttachmentScreeningError for unsupported formats or corrupt files.
 */
export async function screenImage(
  content: Buffer,
  contentType: string,
  filename: string,
  config: ScreeningConfig,
): Promise<ScreenedAttachment> {
  assertSupportedImageFormat(contentType, filename);
  assertImageUploadBytes(content, contentType, filename);
  assertImageDimensionsWithinLimits(content, contentType, filename);

  const screeningFormat: 'png' | 'jpeg' = contentType === 'image/jpeg' ? 'jpeg' : 'png';

  // Screen through Bedrock Guardrail with retry
  const result = await retryWithBackoff(
    () => config.bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: config.guardrailId,
      guardrailVersion: config.guardrailVersion,
      source: 'INPUT',
      content: [{
        image: {
          format: screeningFormat,
          source: { bytes: content },
        },
      }],
    })),
    { maxRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS, context: `image_screening:${filename}` },
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

/**
 * pdf-parse v2 is built on pdfjs, which references browser DOM globals
 * (`DOMMatrix`/`ImageData`/`Path2D`) that don't exist in the Node Lambda runtime.
 * For TEXT extraction (our only use) these are never actually invoked — pdfjs only
 * touches them on its optional canvas RENDER path. But if they're merely *undefined*,
 * pdfjs tries to load the native `@napi-rs/canvas` binding to supply them, which
 * fails on Lambda (the cross-platform native binary isn't bundled) and cascades to
 * `DOMMatrix is not defined` → PDF screening unavailable (ABCA-745, live-caught).
 *
 * Defining them as inert no-op stubs makes pdfjs skip the native-canvas load path
 * entirely and extract text headless — no native binary, host-independent. Verified:
 * `getText` returns the full text with canvas absent + these three stubs present.
 * Idempotent + non-clobbering (only fills genuinely-missing globals).
 */
function ensurePdfDomGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === 'undefined') g.DOMMatrix = class { /* inert stub — text extraction never calls it */ };
  if (typeof g.ImageData === 'undefined') g.ImageData = class { /* inert stub */ };
  if (typeof g.Path2D === 'undefined') g.Path2D = class { /* inert stub */ };
}

async function extractPdfText(content: Buffer, filename: string): Promise<string> {
  // pdf-parse v2 (^2.4.5) exposes a `PDFParse` CLASS — `new PDFParse({ data }).getText()` —
  // NOT the v1 callable default export. Three things made this fail before (ABCA-745):
  // (1) the code called the v1 `pdfParseFn(buf)` shape (undefined on v2); (2) the
  // webhook processors esbuild-bundled pdf-parse instead of shipping it via `nodeModules`,
  // mangling its pdfjs/native deps; and (3) pdfjs tried to load the native
  // `@napi-rs/canvas` binding for its DOM globals — absent on Lambda — instead of just
  // extracting text. `ensurePdfDomGlobals` fixes (3); the bundling change fixes (2).
  ensurePdfDomGlobals();
  let PDFParse;
  try {
    // Destructure the class from the dynamic import and let TS infer its type from
    // the value — a cross-mode `typeof import('pdf-parse').PDFParse` annotation trips
    // the ESM-vs-CJS dual-`.d.ts` hazard under moduleResolution:nodenext.
    ({ PDFParse } = await import(/* webpackIgnore: true */ 'pdf-parse'));
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
  // A TypedArray is preferred (pdf-parse transfers ownership to its worker, lowering
  // main-thread memory). Slice to the exact PDF bytes so a pooled Buffer's backing
  // ArrayBuffer isn't handed over wholesale.
  const parser = new PDFParse({ data: new Uint8Array(content.buffer, content.byteOffset, content.byteLength) });
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('PDF extraction timed out')), PDF_EXTRACT_TIMEOUT_MS);
    });

    // `first: N` parses only pages 1..N (the v2 page-cap knob). We cap pages +
    // extracted-text bytes to bound cost/DoS — BUT the caller stores the WHOLE PDF
    // and feeds it to the agent, so screening only a prefix while delivering the
    // rest is a bypass (review #1 HIGH: injection on page 51 of a 51-page PDF).
    // Fail CLOSED when the document exceeds what we can screen: reject rather than
    // deliver unscreened pages. `result.total` is the PDF's full page count.
    const result = await Promise.race([
      parser.getText({ first: PDF_MAX_PAGES }),
      timeoutPromise,
    ]);

    const totalPages = typeof result.total === 'number' ? result.total : undefined;
    if (totalPages !== undefined && totalPages > PDF_MAX_PAGES) {
      throw new AttachmentScreeningError(
        `PDF "${filename}" has ${totalPages} pages, over the ${PDF_MAX_PAGES}-page limit ABCA can fully ` +
        'screen. Split it or attach only the relevant pages so the whole document can be checked.',
      );
    }
    const text: string = result.text ?? '';
    if (Buffer.byteLength(text, 'utf-8') > PDF_MAX_TEXT_BYTES) {
      // The screened pages produced more text than we screen — we'd be delivering
      // bytes we didn't fully check. Fail closed rather than truncate-and-pass.
      throw new AttachmentScreeningError(
        `PDF "${filename}" contains more text than ABCA can fully screen (over ${PDF_MAX_TEXT_BYTES} bytes). ` +
        'Attach a smaller document so its full contents can be checked.',
      );
    }
    return text;
  } catch (err) {
    // Our own over-limit / no-text rejections are already user-facing — don't
    // re-wrap them as "corrupt PDF".
    if (err instanceof AttachmentScreeningError) throw err;
    // A DEPLOYMENT bug and a genuinely-bad PDF both land here, and they look
    // nothing alike to an operator. pdf-parse mangled by esbuild (a Lambda that
    // reaches this path but lacks `nodeModules: ['pdf-parse']`) throws with a
    // pdfjs/DOM signature — `DOMMatrix is not defined`, `Cannot find native
    // binding`, `@napi-rs/canvas`. Detect that and log a LOUD, actionable
    // diagnostic (with the fix) so it's not misread as "user's PDF is corrupt" —
    // that misdiagnosis is exactly what cost a full debug loop (ABCA-745 +
    // decompose-seed 2026-07-22). The user-facing message stays generic.
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeBundlingBug = /DOMMatrix|ImageData|Path2D|napi-rs\/canvas|Cannot find native binding|pdfjs/i.test(msg);
    if (looksLikeBundlingBug) {
      logger.error(
        'PDF extraction hit a pdfjs/native-binding error — this is almost certainly a BUNDLING bug, ' +
        'not a bad PDF: the Lambda screens PDFs but was esbuild-bundled without `nodeModules: [\'pdf-parse\']`. ' +
        'Add the attachment-screening bundling carve-out to this function\'s construct (see the ' +
        '//:check:pdf-parse-bundling guard).',
        { error: msg, filename, metric_type: 'pdf_parse_bundling_error' },
      );
    }
    throw new AttachmentScreeningError(
      `PDF "${filename}" could not be processed. It may be corrupt or use unsupported features. ` +
      'Try exporting to a simpler PDF format.',
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId!);
    // Release the pdfjs worker/document (v2 holds native + worker handles).
    await parser.destroy().catch(() => { /* best-effort teardown */ });
  }
}

// ---------------------------------------------------------------------------
// Image validation helpers (pure buffer parsing — no native dependencies)
// ---------------------------------------------------------------------------

/**
 * Reject GIF and WebP — only PNG and JPEG are supported for image screening.
 */
function assertSupportedImageFormat(contentType: string, filename: string): void {
  if (contentType === 'image/gif' || contentType === 'image/webp') {
    throw new AttachmentScreeningError(
      `Image "${filename}" uses ${contentType} format which is not supported for image attachments. ` +
      'Please convert to PNG or JPEG before uploading.',
    );
  }
}

/**
 * Reject empty or obviously corrupt uploads by checking magic bytes.
 */
export function assertImageUploadBytes(
  content: Buffer,
  contentType: string,
  filename: string,
): void {
  if (content.length === 0) {
    throw new AttachmentScreeningError(
      `Image "${filename}" upload is empty. Ensure the upload completed and try again.`,
    );
  }

  if (contentType === 'image/png') {
    if (
      content.length < PNG_FILE_SIGNATURE.length
      || !content.subarray(0, PNG_FILE_SIGNATURE.length).equals(PNG_FILE_SIGNATURE)
    ) {
      throw new AttachmentScreeningError(
        `Image "${filename}" upload is not a valid PNG file. ` +
        'The upload may be incomplete or corrupted — please try submitting again.',
      );
    }
    return;
  }

  if (contentType === 'image/jpeg') {
    if (
      content.length < JPEG_FILE_SIGNATURE.length
      || !content.subarray(0, JPEG_FILE_SIGNATURE.length).equals(JPEG_FILE_SIGNATURE)
    ) {
      throw new AttachmentScreeningError(
        `Image "${filename}" upload is not a valid JPEG file. ` +
        'The upload may be incomplete or corrupted — please try submitting again.',
      );
    }
  }
}

/** Read width/height from the PNG IHDR chunk (bytes 16–23). */
export function readPngDimensions(content: Buffer): { width: number; height: number } | undefined {
  if (content.length < PNG_MIN_IHDR_LENGTH) {
    return undefined;
  }
  if (!content.subarray(0, PNG_FILE_SIGNATURE.length).equals(PNG_FILE_SIGNATURE)) {
    return undefined;
  }
  if (content.toString('ascii', PNG_IHDR_TYPE_OFFSET, PNG_IHDR_TYPE_OFFSET + PNG_IHDR_TYPE_LENGTH) !== 'IHDR') {
    return undefined;
  }
  return { width: content.readUInt32BE(PNG_IHDR_WIDTH_OFFSET), height: content.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET) };
}

/**
 * Read width/height from a JPEG buffer by scanning SOF markers.
 * SOF0 (0xFFC0), SOF1 (0xFFC1), SOF2 (0xFFC2) contain dimensions.
 */
export function readJpegDimensions(content: Buffer): { width: number; height: number } | undefined {
  /* eslint-disable @typescript-eslint/no-magic-numbers -- JPEG SOF marker scan */
  if (content.length < 4) return undefined;
  if (content[0] !== 0xff || content[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset < content.length - 1) {
    if (content[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = content[offset + 1];
    // SOF0, SOF1, SOF2 markers
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (offset + 9 > content.length) return undefined;
      const height = content.readUInt16BE(offset + 5);
      const width = content.readUInt16BE(offset + 7);
      return { width, height };
    }
    // Skip non-SOF markers
    if (marker === 0xd9 || marker === 0xda) {
      // End of image or start of scan — stop searching
      return undefined;
    }
    if (offset + 3 >= content.length) return undefined;
    const segmentLength = content.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  /* eslint-enable @typescript-eslint/no-magic-numbers */
  return undefined;
}

function assertImageDimensionsWithinLimits(
  content: Buffer,
  contentType: string,
  filename: string,
): void {
  let dims: { width: number; height: number } | undefined;

  if (contentType === 'image/png') {
    dims = readPngDimensions(content);
    if (!dims) {
      throw new AttachmentScreeningError(
        `Image "${filename}" upload is not a valid PNG file (missing IHDR). ` +
        'The upload may be incomplete or corrupted — please try submitting again.',
      );
    }
  } else if (contentType === 'image/jpeg') {
    dims = readJpegDimensions(content);
    if (!dims) {
      // Fail-closed for large JPEGs where dimensions cannot be verified (> 5 MB).
      // Smaller files are allowed through to Bedrock which will reject if oversized.
      if (content.length > JPEG_DIMENSION_VERIFY_SIZE_THRESHOLD_BYTES) {
        throw new AttachmentScreeningError(
          `Image "${filename}" is ${(content.length / (1024 * 1024)).toFixed(1)} MB and its dimensions ` +
          'could not be verified. Please use a standard JPEG encoder or convert to PNG.',
        );
      }
      logger.warn('Could not parse JPEG dimensions — relying on Bedrock validation', {
        filename,
        size_bytes: content.length,
      });
      return;
    }
  } else {
    return;
  }

  if (dims.width > MAX_IMAGE_DIMENSION_PX || dims.height > MAX_IMAGE_DIMENSION_PX) {
    throw new AttachmentScreeningError(
      `Image "${filename}" is ${dims.width}x${dims.height}px; maximum allowed dimension is ` +
      `${MAX_IMAGE_DIMENSION_PX}px. Please resize the image before uploading.`,
    );
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
