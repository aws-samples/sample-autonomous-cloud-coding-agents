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

/** Generic CLI error with a user-facing message.
 *
 * ``exitCode`` defaults to 1. Pass a different code when the failure class
 * must be script-distinguishable. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly requestId: string;

  constructor(statusCode: number, errorCode: string, message: string, requestId: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.requestId = requestId;
  }
}

/**
 * Map an {@link ApiError} to a user-facing {@link CliError}. ``cases`` supplies
 * the command-specific messages (keyed by HTTP status). A status with no case
 * (and not 401) surfaces the server message verbatim.
 */
export function mapApiError(
  err: ApiError,
  cases: Partial<Record<number, (err: ApiError) => string>>,
): CliError {
  const handler = cases[err.statusCode];
  if (handler) return new CliError(handler(err));
  if (err.statusCode === 401) {
    return new CliError(
      `Not authenticated (${err.errorCode}). Run \`bgagent login\` to re-authenticate.`,
    );
  }
  return new CliError(err.message);
}
