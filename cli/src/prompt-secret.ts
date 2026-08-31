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

/** Buffered bytes not yet split into a line (non-TTY piped stdin). */
let pipedBuffer = '';
/** Lines read from stdin, not yet consumed by a `promptSecret` call. */
const pipedLineQueue: string[] = [];
/** Pending `promptSecret` calls waiting for the next line. */
const pipedLineWaiters: Array<(line: string) => void> = [];
let pipedListenerAttached = false;
let pipedEnded = false;

function deliverPipedLine(line: string): void {
  const waiter = pipedLineWaiters.shift();
  if (waiter) {
    waiter(line);
  } else {
    pipedLineQueue.push(line);
  }
}

function drainPipedBuffer(): void {
  let newlineIdx = pipedBuffer.indexOf('\n');
  while (newlineIdx >= 0) {
    const line = pipedBuffer.slice(0, newlineIdx).replace(/\r$/, '');
    pipedBuffer = pipedBuffer.slice(newlineIdx + 1);
    deliverPipedLine(line);
    newlineIdx = pipedBuffer.indexOf('\n');
  }
}

function ensurePipedListener(): void {
  if (pipedListenerAttached || process.stdin.isTTY) {
    return;
  }
  pipedListenerAttached = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pipedBuffer += chunk;
    drainPipedBuffer();
  });
  process.stdin.on('end', () => {
    pipedEnded = true;
    if (pipedBuffer.length > 0) {
      deliverPipedLine(pipedBuffer.replace(/\r$/, ''));
      pipedBuffer = '';
    }
    while (pipedLineWaiters.length > 0) {
      deliverPipedLine('');
    }
  });
  process.stdin.on('error', () => {
    pipedEnded = true;
    while (pipedLineWaiters.length > 0) {
      deliverPipedLine('');
    }
  });
}

function readPipedLine(): Promise<string> {
  ensurePipedListener();
  drainPipedBuffer();
  if (pipedLineQueue.length > 0) {
    return Promise.resolve(pipedLineQueue.shift()!.trim());
  }
  if (pipedEnded) {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    pipedLineWaiters.push(resolve);
  });
}

/** Test-only reset so each case gets a fresh piped-stdin reader. */
export function __resetPipedSecretStateForTest(): void {
  pipedBuffer = '';
  pipedLineQueue.length = 0;
  pipedLineWaiters.length = 0;
  pipedListenerAttached = false;
  pipedEnded = false;
}

/** Masked stdin prompt for secrets (TTY) or piped stdin (non-TTY, one line per call). */
export function promptSecret(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(label);

    if (!process.stdin.isTTY) {
      readPipedLine().then((line) => resolve(line.trim())).catch(reject);
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const char of str) {
        if (char === '\n' || char === '\r') {
          cleanup();
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        } else if (char === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Cancelled.'));
          return;
        } else if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else {
          value += char;
          process.stderr.write('*');
        }
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}
