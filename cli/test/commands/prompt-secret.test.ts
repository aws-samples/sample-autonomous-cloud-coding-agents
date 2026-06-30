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

import { EventEmitter } from 'events';
import { __resetPipedSecretStateForTest, promptSecret } from '../../src/prompt-secret';

/**
 * Stub stdin as a non-TTY readable stream. Each `promptSecret` call reads one
 * line (up to `\n`); leftover bytes stay on the stream for chained prompts.
 */
function withPipedStdin(
  chunks: string[],
  run: () => Promise<void>,
): Promise<void> {
  const fake = new EventEmitter() as EventEmitter & {
    isTTY?: boolean;
    setEncoding: jest.Mock;
  };
  fake.isTTY = false;
  fake.setEncoding = jest.fn();

  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

  const done = run().finally(() => {
    stderrSpy.mockRestore();
    if (original) Object.defineProperty(process, 'stdin', original);
  });

  setImmediate(() => {
    for (const c of chunks) fake.emit('data', c);
    fake.emit('end');
  });
  return done;
}

describe('promptSecret (non-TTY / piped stdin)', () => {
  beforeEach(() => {
    __resetPipedSecretStateForTest();
  });

  test('resolves the trimmed piped value', async () => {
    await withPipedStdin(['ghp_secret_token\n'], async () => {
      await expect(promptSecret('Token: ')).resolves.toBe('ghp_secret_token');
    });
  });

  test('concatenates chunks until the first newline', async () => {
    await withPipedStdin(['ghp_', 'multi', 'part\n'], async () => {
      await expect(promptSecret('Token: ')).resolves.toBe('ghp_multipart');
    });
  });

  test('resolves empty string when the pipe closes without a line', async () => {
    await withPipedStdin([''], async () => {
      await expect(promptSecret('Token: ')).resolves.toBe('');
    });
  });

  test('supports chained prompts (one line per call)', async () => {
    await withPipedStdin(['signing-secret\nclient-secret\n'], async () => {
      await expect(promptSecret('Signing Secret: ')).resolves.toBe('signing-secret');
      await expect(promptSecret('Client Secret:  ')).resolves.toBe('client-secret');
    });
  });
});
