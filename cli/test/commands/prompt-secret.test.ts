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
import { promptSecret } from '../../src/prompt-secret';

/**
 * Stub stdin as a non-TTY readable stream. promptSecret accumulates `data`
 * chunks and resolves the trimmed buffer on `end` — the path scripted/piped
 * operators hit (e.g. `echo $PAT | bgagent github set-token`).
 */
function withPipedStdin(chunks: string[], run: () => Promise<void>): Promise<void> {
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

  // Emit after promptSecret has subscribed its listeners.
  setImmediate(() => {
    for (const c of chunks) fake.emit('data', c);
    fake.emit('end');
  });
  return done;
}

describe('promptSecret (non-TTY / piped stdin)', () => {
  test('resolves the trimmed piped value', async () => {
    await withPipedStdin(['ghp_secret_token\n'], async () => {
      await expect(promptSecret('Token: ')).resolves.toBe('ghp_secret_token');
    });
  });

  test('concatenates multiple chunks', async () => {
    await withPipedStdin(['ghp_', 'multi', 'part\n'], async () => {
      await expect(promptSecret('Token: ')).resolves.toBe('ghp_multipart');
    });
  });

  test('resolves empty string for an empty pipe (caller enforces non-empty)', async () => {
    await withPipedStdin([''], async () => {
      await expect(promptSecret('Token: ')).resolves.toBe('');
    });
  });
});
