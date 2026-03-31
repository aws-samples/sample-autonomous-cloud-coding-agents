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

/**
 * Minimal structured logger that writes JSON to stdout/stderr.
 * Uses process.stdout.write / process.stderr.write to avoid the
 * `no-console` eslint rule. CloudWatch captures both streams.
 */
export const logger = {
  /**
   * Log an informational message.
   * @param message - the log message.
   * @param data - optional structured data to include.
   */
  info(message: string, data?: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ level: 'INFO', message, ...data }) + '\n');
  },

  /**
   * Log a warning message.
   * @param message - the log message.
   * @param data - optional structured data to include.
   */
  warn(message: string, data?: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ level: 'WARN', message, ...data }) + '\n');
  },

  /**
   * Log an error message.
   * @param message - the log message.
   * @param data - optional structured data to include.
   */
  error(message: string, data?: Record<string, unknown>): void {
    process.stderr.write(JSON.stringify({ level: 'ERROR', message, ...data }) + '\n');
  },
};
