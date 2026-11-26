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

function withPipedStdin(
  chunks: string[],
  run: () => Promise<void>,
): Promise<void> {
  const fake = new EventEmitter() as EventEmitter & {
    isTTY?: boolean;
    setEncoding: jest.Mock;
    resume: jest.Mock;
    pause: jest.Mock;
  };
  fake.isTTY = false;
  fake.setEncoding = jest.fn();
  fake.resume = jest.fn();
  fake.pause = jest.fn();

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

beforeEach(() => {
  __resetPipedSecretStateForTest();
});

describe('promptSecret (non-TTY / piped stdin)', () => {
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

  // When stderr is a terminal, readline echoes the piped line after the label.
  test('resolves the trimmed line', async () => {
    const answer = promptLine('Client ID');
    stdin.write('  cid-1  \n');
    await expect(answer).resolves.toBe('cid-1');
    expect(io.written()).toMatch(/^Client ID: /);
  });

  test('resolves the default on an empty line, and shows it in the prompt', async () => {
    const answer = promptLine('Client ID', 'cid-0');
    stdin.write('\n');
    await expect(answer).resolves.toBe('cid-0');
    expect(io.written()).toMatch(/^Client ID \[cid-0\]: /);
  });

  test('resolves an empty string on an empty line without a default', async () => {
    const answer = promptLine('Continue? [Y/n]');
    stdin.write('\n');
    await expect(answer).resolves.toBe('');
  });

  test('rejects when the input ends without a line: no answer is not Enter', async () => {
    const answer = promptLine('Continue? [Y/n]', 'y');
    stdin.end();
    await expect(answer).rejects.toThrow('No input provided.');
  });
});

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function outcome(prompt: Promise<string>): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('never settles'), 250);
    void prompt
      .then((line) => `line ${JSON.stringify(line)}`, (err: Error) => `error: ${err.message}`)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
  });
}

// A Node stream emits 'end' only once it is read.
async function closePipe(stdin: PassThrough): Promise<void> {
  stdin.end();
  await tick();
  stdin.read(0);
  await tick();
}

describe('a visible and a secret prompt on one piped input', () => {
  let stdin: PassThrough;
  let io: ReturnType<typeof replaceStdin>;

  beforeEach(() => {
    stdin = new PassThrough();
    io = replaceStdin(stdin);
  });

  afterEach(() => io.restore());

  const ask = (kind: string): Promise<string> => (kind === 'V' ? promptLine('Visible') : promptSecret('Secret: '));

  describe.each([
    ['VS', '`jira setup` with its options: the site choice, the signing secret'],
    ['VSV', '`linear add-workspace`: the client id, the signing secret, the member pick'],
    ['VV', '`linear setup` with its options: the pasted value, the member pick'],
    ['SSSV', '`linear setup`: three secrets, the member pick'],
    ['SSVS', '`jira setup`: the client id and secret, the site choice, the signing secret'],
    ['SSVSSV', '`slack setup` when its first round is refused: two secrets and the client id, twice'],
  ])('the prompts %s (%s)', (order) => {
    const kinds = [...order];
    const answers = kinds.map((_, i) => `answer-${i + 1}`);
    const expected = answers.map((answer) => `line ${JSON.stringify(answer)}`);

    test('each get their own line when all answers come in one write', async () => {
      stdin.write(answers.map((answer) => `${answer}\n`).join(''));

      const outcomes: string[] = [];
      for (const kind of kinds) {
        outcomes.push(await outcome(ask(kind)));
      }

      expect(outcomes).toEqual(expected);
    });

    test('each get their own line when each answer is written while its prompt waits', async () => {
      const outcomes: string[] = [];
      for (const [i, kind] of kinds.entries()) {
        const result = outcome(ask(kind));
        await tick();
        stdin.write(`${answers[i]}\n`);
        outcomes.push(await result);
      }

      expect(outcomes).toEqual(expected);
    });
  });

  describe('when the input ends', () => {
    test('a secret prompt after a visible one answers with no value, as at every end of input, when the pipe closes while it waits', async () => {
      stdin.write('cid-1\n');
      expect(await outcome(promptLine('Client ID'))).toBe('line "cid-1"');

      const secret = outcome(promptSecret('Secret: '));
      await tick();
      stdin.end();

      expect(await secret).toBe('line ""');
    });

    test('a secret prompt after a visible one answers with no value when the pipe was closed between the two', async () => {
      stdin.write('cid-1\n');
      expect(await outcome(promptLine('Client ID'))).toBe('line "cid-1"');
      await closePipe(stdin);

      expect(await outcome(promptSecret('Secret: '))).toBe('line ""');
    });

    test('a visible prompt rejects when a secret prompt has read the input to its end (`slack setup` without input)', async () => {
      stdin.end('s3cret\n');
      expect(await outcome(promptSecret('Secret: '))).toBe('line "s3cret"');
      await tick();

      expect(await outcome(promptLine('Client ID'))).toBe('error: No input provided.');
    });

    test('a second visible prompt rejects when the pipe was closed after the first (the member pick of `linear setup`)', async () => {
      stdin.write('code=abc&state=xyz\n');
      expect(await outcome(promptLine('Paste the value shown on that page'))).toBe('line "code=abc&state=xyz"');
      await closePipe(stdin);

      expect(await outcome(promptLine('Which one is you? [1-2]'))).toBe('error: No input provided.');
    });

    test.each([
      ['a secret prompt answers with no value', () => promptSecret('Secret: '), 'line ""'],
      ['a visible prompt rejects', () => promptLine('Client ID', 'cid-0'), 'error: No input provided.'],
    ])('%s when reading stdin fails while it waits', async (_what, prompt, expected) => {
      const waiting = outcome(prompt());
      await tick();
      stdin.destroy(new Error('read EIO'));

      expect(await waiting).toBe(expected);
    });
  });

  test('reads no further than the answers that were asked for: an input without end stays in the pipe', async () => {
    stdin.write('y\n');
    expect(await outcome(promptLine('Continue? [Y/n]'))).toBe('line "y"');

    stdin.write('y\n'.repeat(1000));
    await tick();
    expect(stdin.readableLength).toBe(2000);

    expect(await outcome(promptSecret('Secret: '))).toBe('line "y"');
  });

  describe('after another reader of stdin (a readline that was closed)', () => {
    test('a prompt reads on from a stdin that was left paused', async () => {
      // A listener put on a paused Node stream does not start it again.
      stdin.pause();
      stdin.write('s3cret\n');

      expect(await outcome(promptSecret('Secret: '))).toBe('line "s3cret"');
    });

    test.each([
      ['a secret prompt answers with no value', () => promptSecret('Secret: '), 'line ""'],
      ['a visible prompt rejects', () => promptLine('Client ID'), 'error: No input provided.'],
    ])('%s when stdin was read to its end before', async (_what, prompt, expected) => {
      // A Node stream emits 'end' once: a listener that comes later is not told.
      await closePipe(stdin);
      expect(stdin.readableEnded).toBe(true);

      expect(await outcome(prompt())).toBe(expected);
    });
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
