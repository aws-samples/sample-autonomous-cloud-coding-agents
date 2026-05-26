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

// Image token estimation matching Anthropic's documented resize rules.

import { readPngDimensions, readJpegDimensions } from './attachment-screening';

const MAX_IMAGE_SIDE = 1568;
const MAX_IMAGE_TOKENS = 1568;
const TOKEN_SAFETY_MARGIN = 1.2;
const TILE_SIZE = 28;

/**
 * Estimate the token cost of an image given its pixel dimensions.
 * Applies Anthropic's resize-and-tile algorithm with a safety margin.
 */
export function estimateImageTokens(width: number, height: number): number {
  let w = width;
  let h = height;

  // Scale to fit MAX_IMAGE_SIDE on longest side
  const maxSide = Math.max(w, h);
  if (maxSide > MAX_IMAGE_SIDE) {
    const scale = MAX_IMAGE_SIDE / maxSide;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  // Pad to next multiple of tile size
  w = Math.ceil(w / TILE_SIZE) * TILE_SIZE;
  h = Math.ceil(h / TILE_SIZE) * TILE_SIZE;

  // Token calculation with safety margin, then capped to hard ceiling
  const rawTokens = Math.ceil((w * h) / 750);
  return Math.min(Math.ceil(rawTokens * TOKEN_SAFETY_MARGIN), MAX_IMAGE_TOKENS);
}

/**
 * Estimate image tokens from a buffer by reading dimensions from headers.
 * Uses pure buffer parsing (PNG IHDR / JPEG SOF markers) — no native deps.
 * Returns undefined if dimensions cannot be determined (non-fatal).
 */
export function estimateImageTokensFromBuffer(content: Buffer, contentType?: string): number | undefined {
  const dims = contentType === 'image/jpeg'
    ? readJpegDimensions(content)
    : readPngDimensions(content) ?? readJpegDimensions(content);

  if (dims) {
    return estimateImageTokens(dims.width, dims.height);
  }
  return undefined;
}
