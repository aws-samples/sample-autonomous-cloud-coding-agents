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

import * as fs from 'fs';
import * as path from 'path';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  assertImageUploadBytes,
  AttachmentScreeningError,
  readJpegDimensions,
  readPngDimensions,
  screenImage,
  screenTextFile,
} from '../../../src/handlers/shared/attachment-screening';

const ARCHITECTURE_PNG = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'cli',
  'autonomous-engine-architecture.png',
);

function mockBedrockPass(): BedrockRuntimeClient {
  return {
    send: jest.fn().mockResolvedValue({
      action: 'NONE',
      outputs: [],
      assessments: [],
    }),
  } as unknown as BedrockRuntimeClient;
}

function mockBedrockBlock(): BedrockRuntimeClient {
  return {
    send: jest.fn().mockResolvedValue({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [],
      assessments: [{ contentPolicy: { filters: [{ type: 'SEXUAL' }] } }],
    }),
  } as unknown as BedrockRuntimeClient;
}

// Minimal valid PNG: 1x1 pixel with valid IHDR (CRC is not checked by our parser)
function minimalPng(): Buffer {
  // PNG signature + IHDR chunk (length=13, "IHDR", width=1, height=1, bit_depth=8, color_type=2, zeros for rest + dummy CRC)
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length = 13
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x02, 0x00, 0x00, 0x00, // bit_depth=8, color_type=2(RGB), compression, filter, interlace
    0x00, 0x00, 0x00, 0x00, // CRC (dummy — not validated by dimension parser)
  ]);
}

// Minimal valid JPEG with SOF0 (dimensions 100x50)
function minimalJpeg(width = 100, height = 50): Buffer {
  // SOI + APP0 marker (minimal) + SOF0 with dimensions + EOI
  const soi = Buffer.from([0xff, 0xd8]);
  // SOF0 marker
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(8, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1; // num components
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, eoi]);
}

describe('assertImageUploadBytes', () => {
  test('rejects non-PNG bytes for image/png', () => {
    expect(() => assertImageUploadBytes(Buffer.from('not a png'), 'image/png', 'x.png'))
      .toThrow(AttachmentScreeningError);
  });

  test('rejects non-JPEG bytes for image/jpeg', () => {
    expect(() => assertImageUploadBytes(Buffer.from('not a jpeg'), 'image/jpeg', 'x.jpg'))
      .toThrow(AttachmentScreeningError);
  });

  test('rejects empty buffer', () => {
    expect(() => assertImageUploadBytes(Buffer.alloc(0), 'image/png', 'empty.png'))
      .toThrow(AttachmentScreeningError);
  });

  test('accepts valid PNG signature', () => {
    const png = minimalPng();
    expect(() => assertImageUploadBytes(png, 'image/png', 'valid.png')).not.toThrow();
  });

  test('accepts valid JPEG signature', () => {
    const jpeg = minimalJpeg();
    expect(() => assertImageUploadBytes(jpeg, 'image/jpeg', 'valid.jpg')).not.toThrow();
  });
});

describe('readPngDimensions', () => {
  test('reads IHDR from architecture diagram fixture', () => {
    if (!fs.existsSync(ARCHITECTURE_PNG)) {
      return;
    }
    const content = fs.readFileSync(ARCHITECTURE_PNG);
    expect(readPngDimensions(content)).toEqual({ width: 3454, height: 1442 });
  });

  test('reads dimensions from minimal PNG', () => {
    const png = minimalPng();
    expect(readPngDimensions(png)).toEqual({ width: 1, height: 1 });
  });

  test('returns undefined when IHDR chunk is missing', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(readPngDimensions(Buffer.concat([sig, Buffer.from('FAKE')]))).toBeUndefined();
  });

  test('returns undefined for too-short buffer', () => {
    expect(readPngDimensions(Buffer.alloc(10))).toBeUndefined();
  });
});

describe('readJpegDimensions', () => {
  test('reads dimensions from SOF0 marker', () => {
    const jpeg = minimalJpeg(800, 600);
    expect(readJpegDimensions(jpeg)).toEqual({ width: 800, height: 600 });
  });

  test('returns undefined for non-JPEG data', () => {
    expect(readJpegDimensions(Buffer.from('not jpeg'))).toBeUndefined();
  });

  test('returns undefined for too-short buffer', () => {
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8]))).toBeUndefined();
  });
});

describe('screenImage', () => {
  const config = {
    bedrockClient: mockBedrockPass(),
    guardrailId: 'test-guardrail',
    guardrailVersion: '1',
  };

  test('passes raw PNG to Bedrock and returns original content', async () => {
    if (!fs.existsSync(ARCHITECTURE_PNG)) {
      return;
    }
    const content = fs.readFileSync(ARCHITECTURE_PNG);
    const result = await screenImage(content, 'image/png', 'test.png', config);

    expect(result.contentType).toBe('image/png');
    // No re-encoding — content is passed through as-is
    expect(result.content).toBe(content);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.screening.status).toBe('passed');
  });

  test('passes raw JPEG to Bedrock', async () => {
    const jpeg = minimalJpeg();
    const result = await screenImage(jpeg, 'image/jpeg', 'test.jpg', config);

    expect(result.contentType).toBe('image/jpeg');
    expect(result.content).toBe(jpeg);
    expect(result.screening.status).toBe('passed');
  });

  test('rejects GIF format', async () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    await expect(
      screenImage(gif, 'image/gif', 'anim.gif', config),
    ).rejects.toThrow(AttachmentScreeningError);
  });

  test('rejects WebP format', async () => {
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    await expect(
      screenImage(webp, 'image/webp', 'photo.webp', config),
    ).rejects.toThrow(AttachmentScreeningError);
  });

  test('rejects oversized PNG dimensions before guardrail call', async () => {
    // Build a PNG with IHDR declaring 9000x100 dimensions
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrLen = Buffer.alloc(4);
    ihdrLen.writeUInt32BE(13, 0);
    const ihdrType = Buffer.from('IHDR');
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(9000, 0); // width > 8000
    ihdrData.writeUInt32BE(100, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const crcBuf = Buffer.alloc(4);
    const oversized = Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crcBuf]);

    const send = jest.fn();
    const client = { send } as unknown as BedrockRuntimeClient;

    await expect(
      screenImage(oversized, 'image/png', 'huge.png', {
        bedrockClient: client,
        guardrailId: 'g',
        guardrailVersion: '1',
      }),
    ).rejects.toThrow(AttachmentScreeningError);

    // Bedrock should never be called for oversized images
    expect(send).not.toHaveBeenCalled();
  });

  test('returns blocked status when guardrail intervenes', async () => {
    const png = minimalPng();
    const blockConfig = {
      bedrockClient: mockBedrockBlock(),
      guardrailId: 'test-guardrail',
      guardrailVersion: '1',
    };

    const result = await screenImage(png, 'image/png', 'blocked.png', blockConfig);
    expect(result.screening.status).toBe('blocked');
    if (result.screening.status === 'blocked') {
      expect(result.screening.categories).toContain('SEXUAL');
    }
  });

  test('retries on 429 status and eventually succeeds', async () => {
    const png = minimalPng();
    const send = jest.fn()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 429 }, message: 'throttled' })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 429 }, message: 'throttled' })
      .mockResolvedValueOnce({ action: 'NONE', outputs: [], assessments: [] });

    const retryConfig = {
      bedrockClient: { send } as unknown as BedrockRuntimeClient,
      guardrailId: 'g',
      guardrailVersion: '1',
    };

    const result = await screenImage(png, 'image/png', 'retry.png', retryConfig);
    expect(result.screening.status).toBe('passed');
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('throws after exhausting retries on persistent 500', async () => {
    const png = minimalPng();
    const error = { $metadata: { httpStatusCode: 500 }, message: 'internal error' };
    const send = jest.fn().mockRejectedValue(error);

    const retryConfig = {
      bedrockClient: { send } as unknown as BedrockRuntimeClient,
      guardrailId: 'g',
      guardrailVersion: '1',
    };

    await expect(screenImage(png, 'image/png', 'fail.png', retryConfig)).rejects.toBeDefined();
    // 1 initial + 3 retries = 4 attempts
    expect(send).toHaveBeenCalledTimes(4);
  });

  test('does not retry non-retryable errors (e.g., 400)', async () => {
    const png = minimalPng();
    const error = { $metadata: { httpStatusCode: 400 }, message: 'bad request' };
    const send = jest.fn().mockRejectedValue(error);

    const retryConfig = {
      bedrockClient: { send } as unknown as BedrockRuntimeClient,
      guardrailId: 'g',
      guardrailVersion: '1',
    };

    await expect(screenImage(png, 'image/png', 'bad.png', retryConfig)).rejects.toBeDefined();
    // Should not retry — only 1 attempt
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('rejects large JPEG with unparseable dimensions (fail-closed)', async () => {
    // 6 MB JPEG-like buffer with valid signature but no SOF marker
    const largeJpeg = Buffer.alloc(6 * 1024 * 1024);
    largeJpeg[0] = 0xff;
    largeJpeg[1] = 0xd8;
    largeJpeg[2] = 0xff;

    const send = jest.fn();
    const retryConfig = {
      bedrockClient: { send } as unknown as BedrockRuntimeClient,
      guardrailId: 'g',
      guardrailVersion: '1',
    };

    await expect(
      screenImage(largeJpeg, 'image/jpeg', 'obfuscated.jpg', retryConfig),
    ).rejects.toThrow('dimensions could not be verified');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('screenTextFile', () => {
  test('screens plain text content', async () => {
    const config = {
      bedrockClient: mockBedrockPass(),
      guardrailId: 'test-guardrail',
      guardrailVersion: '1',
    };

    const content = Buffer.from('Hello, this is a test file with some content.');
    const result = await screenTextFile(content, 'text/plain', 'test.txt', config);

    expect(result.screening.status).toBe('passed');
    expect(result.content).toBe(content);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('screens CSV content', async () => {
    const config = {
      bedrockClient: mockBedrockPass(),
      guardrailId: 'test-guardrail',
      guardrailVersion: '1',
    };

    const content = Buffer.from('name,age\nAlice,30\nBob,25');
    const result = await screenTextFile(content, 'text/csv', 'data.csv', config);
    expect(result.screening.status).toBe('passed');
  });

  test('returns blocked status for text that triggers guardrail', async () => {
    const config = {
      bedrockClient: mockBedrockBlock(),
      guardrailId: 'test-guardrail',
      guardrailVersion: '1',
    };

    const content = Buffer.from('This content triggers the guardrail');
    const result = await screenTextFile(content, 'text/plain', 'bad.txt', config);
    expect(result.screening.status).toBe('blocked');
    if (result.screening.status === 'blocked') {
      expect(result.screening.categories.length).toBeGreaterThan(0);
    }
  });

  test('throws for PDF with no extractable text', async () => {
    // Mock pdf-parse to return empty text
    jest.mock('pdf-parse', () => ({
      __esModule: true,
      default: jest.fn().mockResolvedValue({ text: '' }),
    }), { virtual: true });

    const config = {
      bedrockClient: mockBedrockPass(),
      guardrailId: 'test-guardrail',
      guardrailVersion: '1',
    };

    // A minimal PDF-like buffer (pdf-parse is mocked so content doesn't matter)
    const content = Buffer.from('%PDF-1.4 empty');

    await expect(
      screenTextFile(content, 'application/pdf', 'empty.pdf', config),
    ).rejects.toThrow(/no extractable text/);
  });

  test('retries on transient Bedrock errors for text screening', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 }, message: 'service unavailable' })
      .mockResolvedValueOnce({ action: 'NONE', outputs: [], assessments: [] });

    const config = {
      bedrockClient: { send } as unknown as BedrockRuntimeClient,
      guardrailId: 'g',
      guardrailVersion: '1',
    };

    const content = Buffer.from('retry test');
    const result = await screenTextFile(content, 'text/plain', 'retry.txt', config);
    expect(result.screening.status).toBe('passed');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
