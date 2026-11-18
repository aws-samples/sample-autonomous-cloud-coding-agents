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
import { PassThrough } from 'stream';
import { __resetPipedSecretStateForTest, promptLine, promptSecret } from '../../src/prompt-secret';

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

/** Put `stdin` in the place of process.stdin and collect what the prompts write to stderr. */
function replaceStdin(stdin: object): { written: () => string; restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    written: () => stderrSpy.mock.calls.map(([text]) => String(text)).join(''),
    restore: () => {
      stderrSpy.mockRestore();
      if (original) Object.defineProperty(process, 'stdin', original);
    },
  };
}

describe('promptLine (non-TTY / piped stdin)', () => {
  let stdin: PassThrough;
  let io: ReturnType<typeof replaceStdin>;

  beforeEach(() => {
    stdin = new PassThrough();
    io = replaceStdin(stdin);
  });

  afterEach(() => io.restore());

  test('resolves the trimmed line', async () => {
    const answer = promptLine('Client ID');
    stdin.write('  cid-1  \n');
    await expect(answer).resolves.toBe('cid-1');
    expect(io.written()).toBe('Client ID: ');
  });

  test('resolves the default on an empty line, and shows it in the prompt', async () => {
    const answer = promptLine('Client ID', 'cid-0');
    stdin.write('\n');
    await expect(answer).resolves.toBe('cid-0');
    expect(io.written()).toBe('Client ID [cid-0]: ');
  });

  test('resolves an empty string on an empty line without a default', async () => {
    const answer = promptLine('Continue? [Y/n]');
    stdin.write('\n');
    await expect(answer).resolves.toBe('');
  });

  test('rejects when the input ends without a line: no answer is not Enter', async () => {
    // `linear link` and `remove-workspace` read their confirmation here. Resolving the default
    // or an empty string at end of input would let them go on unconfirmed.
    const answer = promptLine('Continue? [Y/n]', 'y');
    stdin.end();
    await expect(answer).rejects.toThrow('No input provided.');
  });
});

describe('prompts on a terminal (raw mode)', () => {
  const CTRL_C = '\u0003';
  const DELETE = '\u007f';
  let tty: EventEmitter & { isTTY: boolean; setRawMode: jest.Mock; resume: jest.Mock; pause: jest.Mock };
  let io: ReturnType<typeof replaceStdin>;

  beforeEach(() => {
    tty = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: jest.fn(), resume: jest.fn(), pause: jest.fn() });
    io = replaceStdin(tty);
  });

  afterEach(() => io.restore());

  /** Each argument arrives as one 'data' event, the way a key press or a paste does. */
  const type = (...keys: string[]): void => keys.forEach((key) => { tty.emit('data', Buffer.from(key)); });

  test('promptSecret echoes a star for each character and resolves the line on Enter', async () => {
    const answer = promptSecret('Token: ');
    type('s3', 'cret', '\r');
    await expect(answer).resolves.toBe('s3cret');
    expect(io.written()).toBe('Token: ******\n');
  });

  test('promptLine echoes what is typed', async () => {
    const answer = promptLine('Client ID');
    type('cid', '-1', '\n');
    await expect(answer).resolves.toBe('cid-1');
    expect(io.written()).toBe('Client ID: cid-1\n');
  });

  test('promptLine resolves the default on Enter alone', async () => {
    const answer = promptLine('Client ID', 'cid-0');
    type('\r');
    await expect(answer).resolves.toBe('cid-0');
    expect(io.written()).toBe('Client ID [cid-0]: \n');
  });

  test('the delete key takes back the last character, and nothing from an empty line', async () => {
    const answer = promptLine('Slug');
    type(DELETE, 'acmf', DELETE, 'e', '\r');
    await expect(answer).resolves.toBe('acme');
    expect(io.written()).toBe('Slug: acmf\b \be\n');
  });

  test.each([
    ['promptSecret', () => promptSecret('Token: ')],
    ['promptLine', () => promptLine('Slug')],
  ])('%s rejects on Ctrl-C', async (_name, ask) => {
    const answer = ask();
    type('ab', CTRL_C);
    await expect(answer).rejects.toThrow('Cancelled.');
  });

  test('a prompt leaves the terminal as it found it, so that the next prompt can read', async () => {
    const first = promptLine('Client ID');
    type('cid-1', '\r');
    await first;
    expect(tty.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(tty.listenerCount('data')).toBe(0);

    const second = promptSecret('Client Secret: ');
    type('s3cret', '\r');
    await expect(second).resolves.toBe('s3cret');
  });
});
