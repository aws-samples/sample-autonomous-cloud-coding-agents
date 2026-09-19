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

/** Transport limits fit inside a durable Lambda's 60-second invocation budget. */
export const CONTINUATION_IO_TIMEOUT_MS = 10_000;
export const CONTINUATION_RETIREMENT_TIMEOUT_MS = 40_000;
export const CONTINUATION_STOP_TIMEOUT_MS = 25_000;
export const CONTINUATION_POLL_INTERVAL_MS = 30_000;
export const CONTINUATION_TRANSITION_POLL_SECONDS = 5;
export const CONTINUATION_RETRY_POLL_SECONDS = 30;
export const CONTINUATION_START_ATTEMPTS = 4;
