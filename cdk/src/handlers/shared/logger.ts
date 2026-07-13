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

/** Structured logger surface: the three level methods plus `child`. */
export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /**
   * Return a logger that merges `context` (e.g. the correlation envelope
   * `{ task_id, user_id, repo }`) into every line, so per-call sites don't
   * repeat it. Per-call `data` wins on key collision.
   */
  child(context: Record<string, unknown>): Logger;
}

/**
 * Minimal structured logger that writes JSON to stdout/stderr.
 * Uses process.stdout.write / process.stderr.write to avoid the
 * `no-console` eslint rule. CloudWatch captures both streams.
 *
 * @param context - persistent fields merged into every line (see `child`).
 */
// Closure over a context obj, not Powertools — no child-of-child depth or
// sampling needed, just a persistent correlation envelope.
function makeLogger(context: Record<string, unknown> = {}): Logger {
  const write = (stream: NodeJS.WriteStream, level: string, message: string, data?: Record<string, unknown>): void => {
    stream.write(JSON.stringify({ level, message, ...context, ...data }) + '\n');
  };
  return {
    info(message, data) {
      write(process.stdout, 'INFO', message, data);
    },
    warn(message, data) {
      write(process.stdout, 'WARN', message, data);
    },
    error(message, data) {
      write(process.stderr, 'ERROR', message, data);
    },
    child(childContext) {
      return makeLogger({ ...context, ...childContext });
    },
  };
}

export const logger: Logger = makeLogger();
