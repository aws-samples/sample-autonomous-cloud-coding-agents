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

const MAX_DELIVERY_MS = 20_000;
const EXIT_RESERVE_MS = 1_500;

/** Stop optional Jira work before the screenshot processor's deadline. */
export class JiraPreviewBudget {
  private readonly deadline: number;
  private readonly controller = new AbortController();

  constructor(private readonly remaining: () => number) {
    this.deadline = Date.now() + Math.min(MAX_DELIVERY_MS, remaining() - EXIT_RESERVE_MS);
  }

  get signal(): AbortSignal { return this.controller.signal; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const available = Math.min(this.deadline - Date.now(), this.remaining() - EXIT_RESERVE_MS);
    if (available <= 0 || this.signal.aborted) {
      this.controller.abort();
      throw new Error('Jira preview delivery budget exhausted');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound even SDK retries and OAuth resolution. Once expired, no later
      // delivery step may start; comment transports also receive the signal.
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.controller.abort();
            reject(new Error('Jira preview delivery budget exhausted'));
          }, available);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
