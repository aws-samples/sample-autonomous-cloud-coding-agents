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

import { ApiClient } from '../../src/api-client';
import { makeWebhookCommand } from '../../src/commands/webhook';

jest.mock('../../src/api-client');

describe('webhook command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockCreateWebhook = jest.fn();
  const mockListWebhooks = jest.fn();
  const mockRevokeWebhook = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockCreateWebhook.mockReset();
    mockListWebhooks.mockReset();
    mockRevokeWebhook.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      getTaskEvents: jest.fn(),
      createWebhook: mockCreateWebhook,
      listWebhooks: mockListWebhooks,
      revokeWebhook: mockRevokeWebhook,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('webhook create', () => {
    test('creates a webhook and shows detail with secret', async () => {
      mockCreateWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        name: 'My CI',
        secret: 'whsec_abc123',
        created_at: '2026-01-01T00:00:00Z',
      });

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'create', '--name', 'My CI']);

      expect(mockCreateWebhook).toHaveBeenCalledWith({ name: 'My CI' });
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('wh-1');
      expect(output).toContain('whsec_abc123');
      expect(output).toContain('store securely');
    });

    test('outputs JSON when --output json', async () => {
      const webhookData = {
        webhook_id: 'wh-1',
        name: 'My CI',
        secret: 'whsec_abc123',
        created_at: '2026-01-01T00:00:00Z',
      };
      mockCreateWebhook.mockResolvedValue(webhookData);

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'create', '--name', 'My CI', '--output', 'json']);

      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(webhookData, null, 2));
    });
  });

  describe('webhook list', () => {
    test('lists webhooks with default options', async () => {
      mockListWebhooks.mockResolvedValue({
        data: [{
          webhook_id: 'wh-1',
          name: 'My CI',
          status: 'active',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          revoked_at: null,
        }],
        pagination: { next_token: null, has_more: false },
      });

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'list']);

      expect(mockListWebhooks).toHaveBeenCalledWith({
        includeRevoked: undefined,
        limit: undefined,
      });
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('wh-1');
      expect(output).toContain('active');
    });

    test('passes filter options', async () => {
      mockListWebhooks.mockResolvedValue({
        data: [],
        pagination: { next_token: null, has_more: false },
      });

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'list', '--include-revoked', '--limit', '5']);

      expect(mockListWebhooks).toHaveBeenCalledWith({
        includeRevoked: true,
        limit: 5,
      });
    });

    test('shows pagination hint when has_more', async () => {
      mockListWebhooks.mockResolvedValue({
        data: [],
        pagination: { next_token: 'tok', has_more: true },
      });

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'list']);

      const calls = consoleSpy.mock.calls.map(c => c[0]);
      expect(calls.some((c: string) => c.includes('More results available'))).toBe(true);
    });

    test('outputs JSON when --output json', async () => {
      const response = {
        data: [],
        pagination: { next_token: null, has_more: false },
      };
      mockListWebhooks.mockResolvedValue(response);

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'list', '--output', 'json']);

      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(response, null, 2));
    });
  });

  describe('webhook revoke', () => {
    test('revokes a webhook and shows detail', async () => {
      mockRevokeWebhook.mockResolvedValue({
        webhook_id: 'wh-1',
        name: 'My CI',
        status: 'revoked',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        revoked_at: '2026-01-01T01:00:00Z',
      });

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'revoke', 'wh-1']);

      expect(mockRevokeWebhook).toHaveBeenCalledWith('wh-1');
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('wh-1');
      expect(output).toContain('revoked');
      // Confirmation message
      const calls = consoleSpy.mock.calls.map(c => c[0]);
      expect(calls.some((c: string) => c.includes('revoked'))).toBe(true);
    });

    test('outputs JSON when --output json', async () => {
      const webhookData = {
        webhook_id: 'wh-1',
        name: 'My CI',
        status: 'revoked',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        revoked_at: '2026-01-01T01:00:00Z',
      };
      mockRevokeWebhook.mockResolvedValue(webhookData);

      const cmd = makeWebhookCommand();
      await cmd.parseAsync(['node', 'test', 'revoke', 'wh-1', '--output', 'json']);

      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(webhookData, null, 2));
    });
  });
});
