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

    const apiKey = (id: string) => ({
      key_id: id,
      name: 'CI',
      scopes: ['webhooks:manage'],
      status: 'active',
      expires_at: null,
      created_at: 'c',
      updated_at: 'u',
      revoked_at: null,
    });

    test('follows next_token when a page holds fewer keys than asked for', async () => {
      mockList
        .mockResolvedValueOnce({ data: [], pagination: { next_token: 'T1', has_more: true } })
        .mockResolvedValueOnce({ data: [apiKey('k-0')], pagination: { next_token: null, has_more: false } });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'list']);

      expect(mockList).toHaveBeenCalledTimes(2);
      expect(mockList).toHaveBeenLastCalledWith({ includeRevoked: undefined, limit: 20, nextToken: 'T1' });
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(calls[0]).toContain('k-0');
      expect(calls.some((c) => c.includes('More results available'))).toBe(false);
    });

    test('stops at --limit, asking each further page only for the keys still missing', async () => {
      mockList
        .mockResolvedValueOnce({ data: [apiKey('k-1')], pagination: { next_token: 'T1', has_more: true } })
        .mockResolvedValueOnce({ data: [apiKey('k-2'), apiKey('k-3')], pagination: { next_token: 'T2', has_more: true } });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'list', '--limit', '3', '--output', 'json']);

      expect(mockList).toHaveBeenCalledTimes(2);
      expect(mockList).toHaveBeenLastCalledWith({ includeRevoked: undefined, limit: 2, nextToken: 'T1' });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({
        data: [apiKey('k-1'), apiKey('k-2'), apiKey('k-3')],
        pagination: { next_token: 'T2', has_more: true },
      }, null, 2));
    });

    test('stops after 100 requests when every page is empty and promises more', async () => {
      mockList.mockResolvedValue({ data: [], pagination: { next_token: 'tok', has_more: true } });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'list']);

      expect(mockList).toHaveBeenCalledTimes(100);
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('More results available'))).toBe(true);
    });

    test('gives every further request --include-revoked and the token of the page before it', async () => {
      mockList
        .mockResolvedValueOnce({ data: [apiKey('k-1')], pagination: { next_token: 'T1', has_more: true } })
        .mockResolvedValueOnce({ data: [apiKey('k-2')], pagination: { next_token: 'T2', has_more: true } })
        .mockResolvedValueOnce({ data: [apiKey('k-3')], pagination: { next_token: null, has_more: false } });

      const cmd = makeApiKeyCommand();
      await cmd.parseAsync(['node', 'test', 'list', '--include-revoked', '--limit', '3']);

      expect(mockList.mock.calls).toEqual([
        [{ includeRevoked: true, limit: 3 }],
        [{ includeRevoked: true, limit: 2, nextToken: 'T1' }],
        [{ includeRevoked: true, limit: 1, nextToken: 'T2' }],
      ]);
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
