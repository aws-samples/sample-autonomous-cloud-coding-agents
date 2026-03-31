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
