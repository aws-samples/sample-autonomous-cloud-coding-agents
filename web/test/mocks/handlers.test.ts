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

import { describe, expect, it } from 'vitest';
import { TEST_API_BASE } from '../helpers/server';

/** The mock API must reject what the real API rejects, or mock mode hides bugs. */
describe('mock API handlers', () => {
  it('rejects requests without a token like the Cognito authorizer', async () => {
    const res = await fetch(`${TEST_API_BASE}/tasks`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it.each(['0', '101', 'abc'])('rejects limit=%s', async (limit) => {
    const res = await fetch(`${TEST_API_BASE}/tasks?limit=${limit}`, { headers: { Authorization: 't' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 404 for events of an unknown task', async () => {
    const res = await fetch(`${TEST_API_BASE}/tasks/nope/events`, { headers: { Authorization: 't' } });
    expect(res.status).toBe(404);
  });
});
