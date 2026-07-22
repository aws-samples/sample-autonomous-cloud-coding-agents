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
import { makeApiKeyCommand } from '../../src/commands/api-key';

jest.mock('../../src/api-client');

describe('api-key command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockCreate = jest.fn();
  const mockList = jest.fn();
  const mockRevoke = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockCreate.mockReset();
    mockList.mockReset();
    mockRevoke.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createApiKey: mockCreate,
      listApiKeys: mockList,
      revokeApiKey: mockRevoke,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('api-key create', () => {
    test('creates a key with the default scope and shows the one-time key', async () => {
      mockCreate.mockResolvedValue({
        key_id: 'k-1',
        name: 'CI',
        key: 'bgak_k-1_secret', // gitleaks:allow -- fabricated test fixture, not a real credential
        scopes: ['webhooks:manage'],
        expires_at: null,
        created_at: '2026-01-01T00:00:00Z',
      });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'create', '--name', 'CI']);

      expect(mockCreate).toHaveBeenCalledWith({ name: 'CI' });
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('k-1');
      expect(output).toContain('bgak_k-1_secret');
      expect(output).toContain('shown only once');
    });

    test('parses --scopes into an array', async () => {
      mockCreate.mockResolvedValue({
        key_id: 'k-1', name: 'ops', key: 'bgak_x', scopes: ['tasks:read'], expires_at: null, created_at: 'x',
      });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'create', '--name', 'ops', '--scopes', 'webhooks:manage,tasks:read']);

      expect(mockCreate).toHaveBeenCalledWith({
        name: 'ops',
        scopes: ['webhooks:manage', 'tasks:read'],
      });
    });

    test('rejects an unknown scope before calling the API', async () => {
      const cmd = makeApiKeyCommand();
      await expect(
        cmd.parseAsync(['node', 'test', 'create', '--name', 'x', '--scopes', 'bogus']),
      ).rejects.toThrow(/Unknown scope/);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('passes --expires-at through', async () => {
      mockCreate.mockResolvedValue({
        key_id: 'k', name: 'x', key: 'bgak_x', scopes: ['webhooks:manage'], expires_at: '2027-01-01T00:00:00Z', created_at: 'x',
      });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'create', '--name', 'x', '--expires-at', '2027-01-01T00:00:00Z']);

      expect(mockCreate).toHaveBeenCalledWith({ name: 'x', expires_at: '2027-01-01T00:00:00Z' });
    });
  });

  describe('api-key list', () => {
    test('lists keys and passes filters', async () => {
      mockList.mockResolvedValue({
        data: [{
          key_id: 'k-1',
          name: 'CI',
          scopes: ['webhooks:manage'],
          status: 'active',
          expires_at: null,
          created_at: 'c',
          updated_at: 'u',
          revoked_at: null,
        }],
        pagination: { next_token: null, has_more: false },
      });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'list', '--include-revoked', '--limit', '5']);

      expect(mockList).toHaveBeenCalledWith({ includeRevoked: true, limit: 5 });
      expect(consoleSpy.mock.calls[0][0]).toContain('k-1');
    });
  });

  describe('api-key revoke', () => {
    test('revokes a key and confirms', async () => {
      mockRevoke.mockResolvedValue({
        key_id: 'k-1',
        name: 'CI',
        scopes: ['webhooks:manage'],
        status: 'revoked',
        expires_at: null,
        created_at: 'c',
        updated_at: 'u',
        revoked_at: 'r',
      });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'revoke', 'k-1']);

      expect(mockRevoke).toHaveBeenCalledWith('k-1');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('revoked'))).toBe(true);
    });
  });
});
