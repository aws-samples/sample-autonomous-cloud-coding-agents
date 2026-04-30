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

import { ApiClient } from '../src/api-client';
import { ApiError } from '../src/errors';

// Mock auth
jest.mock('../src/auth', () => ({
  getAuthToken: jest.fn().mockResolvedValue('mock-token'),
}));

// Mock config
jest.mock('../src/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    api_url: 'https://api.example.com',
    region: 'us-east-1',
    user_pool_id: 'pool-id',
    client_id: 'client-id',
  }),
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient();
    mockFetch.mockReset();
  });

  describe('createTask', () => {
    test('sends POST and returns task detail', async () => {
      const taskDetail = { task_id: 'abc', status: 'SUBMITTED', repo: 'owner/repo' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: taskDetail }),
      });

      const result = await client.createTask({ repo: 'owner/repo', issue_number: 1 });
      expect(result).toEqual(taskDetail);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tasks',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('sends idempotency key header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { task_id: 'abc' } }),
      });

      await client.createTask({ repo: 'owner/repo', task_description: 'test' }, 'my-key');
      const call = mockFetch.mock.calls[0];
      expect(call[1].headers['Idempotency-Key']).toBe('my-key');
    });
  });

  describe('listTasks', () => {
    test('sends GET with query params', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      const result = await client.listTasks({ status: 'RUNNING', limit: 5 });
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('status=RUNNING'),
        expect.anything(),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=5'),
        expect.anything(),
      );
    });
  });

  describe('getTask', () => {
    test('sends GET with task ID', async () => {
      const taskDetail = { task_id: 'abc' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: taskDetail }),
      });

      const result = await client.getTask('abc');
      expect(result).toEqual(taskDetail);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tasks/abc',
        expect.anything(),
      );
    });
  });

  describe('cancelTask', () => {
    test('sends DELETE', async () => {
      const cancelResponse = { task_id: 'abc', status: 'CANCELLED', cancelled_at: '2026-01-01T00:00:00Z' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: cancelResponse }),
      });

      const result = await client.cancelTask('abc');
      expect(result).toEqual(cancelResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tasks/abc',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getTaskEvents', () => {
    test('sends GET to events endpoint', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      const result = await client.getTaskEvents('abc', { limit: 10 });
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tasks/abc/events'),
        expect.anything(),
      );
    });

    test('passes ?after= when provided', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      await client.getTaskEvents('abc', { after: ulid });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/tasks/abc/events');
      expect(url).toContain(`after=${ulid}`);
      // Must not silently send next_token when only after was provided.
      expect(url).not.toContain('next_token=');
    });

    test('existing next_token path is preserved', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      await client.getTaskEvents('abc', { nextToken: 'opaque-token', limit: 25 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('next_token=opaque-token');
      expect(url).toContain('limit=25');
      expect(url).not.toContain('after=');
    });

    test('passes ?desc=1 when desc=true is provided', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      await client.getTaskEvents('abc', { limit: 20, desc: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('desc=1');
      expect(url).toContain('limit=20');
      // ``desc: false`` MUST NOT leak as ``desc=0`` or ``desc=false`` —
      // the server treats anything truthy-looking as opt-in.
    });

    test('omits desc when desc is falsy or absent', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      await client.getTaskEvents('abc', { limit: 5, desc: false });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain('desc=');
    });

    test('both after and nextToken are sent verbatim to the server', async () => {
      // The client does not arbitrate — the server prefers ``after`` and logs
      // a warning. This test just locks in the transport behaviour.
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      await client.getTaskEvents('abc', {
        after: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        nextToken: 'opaque',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('after=01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(url).toContain('next_token=opaque');
    });
  });

  describe('catchUpEvents', () => {
    test('returns first page when server says no more', async () => {
      const events = [
        { event_id: '01ARZ3NDEKTSV4RRFFQ69G5FB0', event_type: 'agent_turn', timestamp: 't1', metadata: {} },
        { event_id: '01ARZ3NDEKTSV4RRFFQ69G5FB1', event_type: 'agent_turn', timestamp: 't2', metadata: {} },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: events,
          pagination: { next_token: null, has_more: false },
        }),
      });

      const result = await client.catchUpEvents('abc', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(result).toEqual(events);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('after=01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    test('paginates internally across multiple next_token hops', async () => {
      const pageA = [
        { event_id: 'E1', event_type: 'agent_turn', timestamp: 't1', metadata: {} },
      ];
      const pageB = [
        { event_id: 'E2', event_type: 'agent_turn', timestamp: 't2', metadata: {} },
      ];
      const pageC = [
        { event_id: 'E3', event_type: 'agent_turn', timestamp: 't3', metadata: {} },
      ];

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: pageA, pagination: { next_token: 'tok-1', has_more: true } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: pageB, pagination: { next_token: 'tok-2', has_more: true } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: pageC, pagination: { next_token: null, has_more: false } }),
        });

      const result = await client.catchUpEvents('abc', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(result.map(e => e.event_id)).toEqual(['E1', 'E2', 'E3']);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // First call: uses after
      const url1 = mockFetch.mock.calls[0][0] as string;
      expect(url1).toContain('after=01ARZ3NDEKTSV4RRFFQ69G5FAV');
      // Second and third: use next_token (no after)
      const url2 = mockFetch.mock.calls[1][0] as string;
      expect(url2).toContain('next_token=tok-1');
      expect(url2).not.toContain('after=');
      const url3 = mockFetch.mock.calls[2][0] as string;
      expect(url3).toContain('next_token=tok-2');
      expect(url3).not.toContain('after=');
    });

    test('returns empty array when server reports no events after cursor', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [],
          pagination: { next_token: null, has_more: false },
        }),
      });

      const result = await client.catchUpEvents('abc', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(result).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStatusSnapshot', () => {
    test('runs getTask and getTaskEvents(desc=1) in parallel and returns both', async () => {
      const taskDetail = { task_id: 'abc', status: 'RUNNING' };
      const events = [
        { event_id: 'E2', event_type: 'agent_tool_call', timestamp: 't2', metadata: { tool_name: 'Bash' } },
        { event_id: 'E1', event_type: 'agent_turn', timestamp: 't1', metadata: { turn: 3 } },
      ];
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: taskDetail }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: events, pagination: { next_token: null, has_more: false } }),
        });

      const result = await client.getStatusSnapshot('abc');

      expect(result.task).toEqual(taskDetail);
      expect(result.recentEvents).toEqual(events);

      // Two HTTP calls; the events call must carry ``desc=1`` and a bounded limit.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map(c => c[0] as string);
      expect(urls.some(u => u === 'https://api.example.com/tasks/abc')).toBe(true);
      const eventsUrl = urls.find(u => u.includes('/events'));
      expect(eventsUrl).toBeDefined();
      expect(eventsUrl).toContain('desc=1');
      expect(eventsUrl).toContain('limit=20');
    });

    test('surfaces a getTask failure from the parallel pair', async () => {
      // Regression guard against a future refactor to ``Promise.allSettled``
      // that would silently render a broken snapshot. The current contract
      // is fail-fast: if either leg errors, the CLI surfaces the error.
      mockFetch
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [], pagination: { next_token: null, has_more: false } }),
        });

      await expect(client.getStatusSnapshot('abc')).rejects.toThrow('network down');
    });

    test('honors a custom recentEventLimit', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { task_id: 'abc' } }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [], pagination: { next_token: null, has_more: false } }),
        });

      await client.getStatusSnapshot('abc', 5);

      const eventsUrl = mockFetch.mock.calls.map(c => c[0] as string).find(u => u.includes('/events'));
      expect(eventsUrl).toContain('limit=5');
    });
  });

  describe('createWebhook', () => {
    test('sends POST and returns webhook response', async () => {
      const webhookResponse = { webhook_id: 'wh-1', name: 'My CI', secret: 'sec-123', created_at: '2026-01-01T00:00:00Z' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: webhookResponse }),
      });

      const result = await client.createWebhook({ name: 'My CI' });
      expect(result).toEqual(webhookResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/webhooks',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('listWebhooks', () => {
    test('sends GET with query params', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      const result = await client.listWebhooks({ includeRevoked: true, limit: 10 });
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('include_revoked=true'),
        expect.anything(),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.anything(),
      );
    });

    test('sends GET without query params when no options', async () => {
      const response = { data: [], pagination: { next_token: null, has_more: false } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => response,
      });

      await client.listWebhooks();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/webhooks',
        expect.anything(),
      );
    });
  });

  describe('revokeWebhook', () => {
    test('sends DELETE and returns webhook detail', async () => {
      const webhookDetail = {
        webhook_id: 'wh-1',
        name: 'My CI',
        status: 'revoked',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        revoked_at: '2026-01-01T01:00:00Z',
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: webhookDetail }),
      });

      const result = await client.revokeWebhook('wh-1');
      expect(result).toEqual(webhookDetail);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/webhooks/wh-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('error handling', () => {
    test('throws ApiError on error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({
          error: { code: 'TASK_NOT_FOUND', message: 'Task not found', request_id: 'req-1' },
        }),
      });

      await expect(client.getTask('bad-id')).rejects.toThrow(ApiError);
    });

    test('includes login hint on 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          error: { code: 'UNAUTHORIZED', message: 'Unauthorized', request_id: 'req-1' },
        }),
      });

      await expect(client.getTask('abc')).rejects.toThrow('bgagent login');
    });

    test('throws CliError on non-JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => { throw new SyntaxError('Unexpected token'); },
      });

      await expect(client.getTask('abc')).rejects.toThrow('non-JSON response');
    });
  });
});
