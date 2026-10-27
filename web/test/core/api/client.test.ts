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

import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../../../src/core/api/client';
import { MOCK_IDS } from '../../../src/mocks/fixtures';
import { TEST_API_BASE } from '../../helpers/server';

const client = createApiClient({ baseUrl: `${TEST_API_BASE}/`, getToken: async () => 'id-token' });

describe('createApiClient against the mock API contract', () => {
  it('lists tasks newest first and follows pagination tokens', async () => {
    const first = await client.listTasks({ limit: 4 });
    expect(first.data).toHaveLength(4);
    expect(first.pagination.has_more).toBe(true);
    const second = await client.listTasks({ limit: 4, nextToken: first.pagination.next_token ?? undefined });
    expect(second.data[0].task_id).not.toBe(first.data[0].task_id);
    const created = [...first.data, ...second.data].map((t) => t.created_at);
    expect(created).toEqual([...created].sort().reverse());
  });

  it('filters by status', async () => {
    const res = await client.listTasks({ status: ['FAILED', 'TIMED_OUT'] });
    expect(res.data.map((t) => t.status).sort()).toEqual(['FAILED', 'FAILED', 'TIMED_OUT']);
  });

  it('unwraps the detail envelope', async () => {
    const task = await client.getTask(MOCK_IDS.failed);
    expect(task.error_classification?.title).toBe('Budget exceeded');
  });

  it('returns events newest first when desc is set', async () => {
    const res = await client.listTaskEvents(MOCK_IDS.running, { desc: true });
    const times = res.data.map((e) => e.timestamp);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('raises ApiError with the envelope code and request id', async () => {
    const error = await client.getTask('does-not-exist').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'TASK_NOT_FOUND', requestId: 'mock-request' });
  });
});

describe('createApiClient request shape', () => {
  it('sends the raw ID token in Authorization, like the CLI', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: { pending: [] } }));
    await createApiClient({ baseUrl: 'https://api.example/v1', getToken: async () => 'tok', fetchImpl }).listPending();
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/v1/pending', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'tok' }),
    }));
  });

  it('classifies non-JSON errors, such as an edge or WAF page, by status', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Forbidden</html>', { status: 403 }));
    const error = await createApiClient({ baseUrl: 'https://api.example/v1', getToken: async () => 'tok', fetchImpl })
      .listPending()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, code: 'HTTP_ERROR' });
  });

  it('explains a request the browser could not send (offline or blocked by CORS)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await createApiClient({ baseUrl: 'https://api.example/v1', getToken: async () => 'tok', fetchImpl })
      .createTask({ repo: 'a/b', task_description: 'x' }, 'key-1')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: expect.stringMatching(/Could not reach the ABCA API/) });
  });

  it('sends JSON bodies and the idempotency key on create', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: { task_id: 't1' } }, { status: 201 }));
    await createApiClient({ baseUrl: 'https://api.example/v1', getToken: async () => 'tok', fetchImpl })
      .createTask({ repo: 'a/b', issue_number: 3 }, 'key-1');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/v1/tasks', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ repo: 'a/b', issue_number: 3 }),
      headers: expect.objectContaining({ 'Idempotency-Key': 'key-1', 'Content-Type': 'application/json' }),
    }));
  });

  it('rejects a 2xx response that is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const error = await createApiClient({ baseUrl: 'https://api.example/v1', getToken: async () => 'tok', fetchImpl })
      .listPending()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
