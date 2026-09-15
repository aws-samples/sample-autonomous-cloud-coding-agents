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

// SPDX-License-Identifier: MIT-0

/** Control-plane diagnostics must not copy SDK messages, payloads or credentials. */
export function microvmErrorIdentity(error: unknown): { error_type: string; aws_request_id?: string } {
  const outer = error as { name?: unknown; cause?: unknown; $metadata?: { requestId?: unknown } } | undefined;
  const cause = outer?.cause as typeof outer;
  const name = cause?.name ?? outer?.name;
  const requestId = cause?.$metadata?.requestId ?? outer?.$metadata?.requestId;
  return {
    error_type: typeof name === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(name) ? name : 'Error',
    ...(typeof requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(requestId) && { aws_request_id: requestId }),
  };
}
