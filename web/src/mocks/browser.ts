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

import { setupWorker } from 'msw/browser';
import type { RuntimeConfig } from '../app/config/runtime-config';
import { buildFixtures } from './fixtures';
import { createHandlers } from './handlers';

export { createMockAuthAdapter } from './auth';

const MOCK_API_BASE = `${window.location.origin}/mock-api/v1`;

export const MOCK_RUNTIME_CONFIG: RuntimeConfig = {
  apiBaseUrl: MOCK_API_BASE,
  region: 'us-east-1',
  auth: { mode: 'mock' },
};

/** Intercepts API calls in the browser with a service worker; everything else passes through. */
export async function startMockBackend(): Promise<void> {
  const worker = setupWorker(...createHandlers(MOCK_API_BASE, buildFixtures(new Date()), { latencyMs: 250 }));
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
}
