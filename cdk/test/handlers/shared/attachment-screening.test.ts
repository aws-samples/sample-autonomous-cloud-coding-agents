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
  screenImage,
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

describe('assertImageUploadBytes', () => {
  test('rejects non-PNG bytes for image/png', () => {
    expect(() => assertImageUploadBytes(Buffer.from('not a png'), 'image/png', 'x.png'))
      .toThrow(AttachmentScreeningError);
  });
});

describe('screenImage', () => {
  const config = {
    bedrockClient: mockBedrockPass(),
    guardrailId: 'test-guardrail',
    guardrailVersion: '1',
  };

  test('sanitizes a large real-world PNG (architecture diagram fixture)', async () => {
    if (!fs.existsSync(ARCHITECTURE_PNG)) {
      return;
    }
    const content = fs.readFileSync(ARCHITECTURE_PNG);
    const result = await screenImage(
      content,
      'image/png',
      'autonomous-engine-architecture.png',
      config,
    );

    expect(result.contentType).toBe('image/png');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThanOrEqual(content.length);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.content).not.toEqual(content);
  });

  test('rejects oversized dimensions before guardrail', async () => {
    const send = jest.fn();
    const client = { send } as unknown as BedrockRuntimeClient;
    const sharp = await import('sharp');
    const oversized = await sharp.default({
      create: {
        width: 8001,
        height: 10,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    await expect(
      screenImage(oversized, 'image/png', 'huge.png', {
        bedrockClient: client,
        guardrailId: 'g',
        guardrailVersion: '1',
      }),
    ).rejects.toThrow(AttachmentScreeningError);

    expect(send).not.toHaveBeenCalled();
  });
});
