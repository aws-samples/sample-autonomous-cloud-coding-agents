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

const PIXELS_PER_TOKEN_DIVISOR = 750;

function estimateImageTokens(width: number, height: number): number {
  let w = width;
  let h = height;

  const maxSide = Math.max(w, h);
  if (maxSide > MAX_IMAGE_SIDE) {
    const scale = MAX_IMAGE_SIDE / maxSide;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  w = Math.ceil(w / TILE_SIZE) * TILE_SIZE;
  h = Math.ceil(h / TILE_SIZE) * TILE_SIZE;

  const rawTokens = Math.ceil((w * h) / PIXELS_PER_TOKEN_DIVISOR);
  return Math.min(Math.ceil(rawTokens * TOKEN_SAFETY_MARGIN), MAX_IMAGE_TOKENS);
}

/**
 * Estimate image tokens from a buffer by reading dimensions from its PNG or
 * JPEG header. Returns undefined if dimensions cannot be determined.
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
