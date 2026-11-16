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

import {
  getProviderOps,
  GitHubProviderOps,
  BitbucketProviderOps,
} from '../../../src/handlers/shared/git-provider';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getProviderOps factory
// ---------------------------------------------------------------------------

describe('getProviderOps', () => {
  test('returns GitHubProviderOps by default', () => {
    const ops = getProviderOps();
    expect(ops).toBeInstanceOf(GitHubProviderOps);
    expect(ops.type).toBe('github');
  });

  test('returns GitHubProviderOps for "github"', () => {
    const ops = getProviderOps('github');
    expect(ops).toBeInstanceOf(GitHubProviderOps);
  });

  test('returns BitbucketProviderOps for "bitbucket"', () => {
    const ops = getProviderOps('bitbucket');
    expect(ops).toBeInstanceOf(BitbucketProviderOps);
    expect(ops.type).toBe('bitbucket');
  });
});

// ---------------------------------------------------------------------------
// GitHubProviderOps
// ---------------------------------------------------------------------------

describe('GitHubProviderOps', () => {
  const ops = new GitHubProviderOps();

  describe('checkReachability', () => {
    test('returns ok:true when API responds 200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      const result = await ops.checkReachability('ghp_token');
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/rate_limit',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'token ghp_token' }),
        }),
      );
    });

    test('returns ok:false when API responds 401', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const result = await ops.checkReachability('bad_token');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
    });

    test('returns ok:false with detail on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await ops.checkReachability('ghp_token');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('ECONNREFUSED');
    });
  });

  describe('checkRepoAccess', () => {
    test('returns ok:true with pushAccess when permissions.push is true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ permissions: { push: true } }),
      });
      const result = await ops.checkRepoAccess('owner/repo', 'ghp_token');
      expect(result.ok).toBe(true);
      expect(result.pushAccess).toBe(true);
      expect(result.permission).toBe('write');
    });

    test('returns ok:true with pushAccess:false when permissions.push is false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ permissions: { push: false } }),
      });
      const result = await ops.checkRepoAccess('owner/repo', 'ghp_token');
      expect(result.ok).toBe(true);
      expect(result.pushAccess).toBe(false);
      expect(result.permission).toBe('read');
    });

    test('returns ok:false on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await ops.checkRepoAccess('owner/repo', 'ghp_token');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    });

    test('returns ok:false with detail on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const result = await ops.checkRepoAccess('owner/repo', 'ghp_token');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('timeout');
    });
  });

  describe('checkPrAccessible', () => {
    test('returns ok:true when PR is open', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'open' }),
      });
      const result = await ops.checkPrAccessible('owner/repo', 42, 'ghp_token');
      expect(result.ok).toBe(true);
      expect(result.state).toBe('open');
    });

    test('returns ok:false when PR is closed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'closed' }),
      });
      const result = await ops.checkPrAccessible('owner/repo', 42, 'ghp_token');
      expect(result.ok).toBe(false);
      expect(result.state).toBe('closed');
    });

    test('returns ok:false on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await ops.checkPrAccessible('owner/repo', 42, 'ghp_token');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    });
  });

  describe('fetchViewerPermission', () => {
    test('returns permission string on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { viewerPermission: 'ADMIN' } } }),
      });
      const result = await ops.fetchViewerPermission('owner/repo', 'ghp_token');
      expect(result).toBe('ADMIN');
    });

    test('returns undefined for invalid repo format', async () => {
      const result = await ops.fetchViewerPermission('noslash', 'ghp_token');
      expect(result).toBeUndefined();
    });

    test('returns undefined on API failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const result = await ops.fetchViewerPermission('owner/repo', 'ghp_token');
      expect(result).toBeUndefined();
    });

    test('returns undefined on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network'));
      const result = await ops.fetchViewerPermission('owner/repo', 'ghp_token');
      expect(result).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// BitbucketProviderOps
// ---------------------------------------------------------------------------

describe('BitbucketProviderOps', () => {
  const ops = new BitbucketProviderOps();

  describe('checkReachability', () => {
    test('returns ok:true when API responds 200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
      const result = await ops.checkReachability('bb_token');
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.bitbucket.org/2.0/user',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer bb_token' }),
        }),
      );
    });

    test('returns ok:false when API responds 401', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const result = await ops.checkReachability('bad_token');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
    });

    test('returns ok:false with detail on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await ops.checkReachability('bb_token');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('ECONNREFUSED');
    });
  });

  describe('checkRepoAccess', () => {
    test('returns ok:true with pushAccess when permission includes write', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // repo check
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ values: [{ permission: 'write' }] }),
        }); // permissions check
      const result = await ops.checkRepoAccess('workspace/repo', 'bb_token');
      expect(result.ok).toBe(true);
      expect(result.pushAccess).toBe(true);
      expect(result.permission).toBe('write');
    });

    test('returns ok:true with pushAccess when permission includes admin', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ values: [{ permission: 'admin' }] }),
        });
      const result = await ops.checkRepoAccess('workspace/repo', 'bb_token');
      expect(result.ok).toBe(true);
      expect(result.pushAccess).toBe(true);
    });

    test('returns ok:true with pushAccess:false when permission is read only', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ values: [{ permission: 'read' }] }),
        });
      const result = await ops.checkRepoAccess('workspace/repo', 'bb_token');
      expect(result.ok).toBe(true);
      expect(result.pushAccess).toBe(false);
      expect(result.permission).toBe('read');
    });

    test('defaults pushAccess to true when permissions endpoint fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 403 });
      const result = await ops.checkRepoAccess('workspace/repo', 'bb_token');
      expect(result.ok).toBe(true);
      expect(result.pushAccess).toBe(true);
    });

    test('returns ok:false on repo 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await ops.checkRepoAccess('workspace/repo', 'bb_token');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    });

    test('returns ok:false with detail on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const result = await ops.checkRepoAccess('workspace/repo', 'bb_token');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('timeout');
    });
  });

  describe('checkPrAccessible', () => {
    test('returns ok:true when PR state is OPEN (case-insensitive)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'OPEN' }),
      });
      const result = await ops.checkPrAccessible('workspace/repo', 1, 'bb_token');
      expect(result.ok).toBe(true);
      expect(result.state).toBe('open');
    });

    test('returns ok:false when PR state is MERGED', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'MERGED' }),
      });
      const result = await ops.checkPrAccessible('workspace/repo', 1, 'bb_token');
      expect(result.ok).toBe(false);
      expect(result.state).toBe('merged');
    });

    test('returns ok:false on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await ops.checkPrAccessible('workspace/repo', 1, 'bb_token');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    });

    test('returns ok:false with detail on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await ops.checkPrAccessible('workspace/repo', 1, 'bb_token');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('ECONNREFUSED');
    });
  });

  describe('fetchViewerPermission', () => {
    test('always returns undefined (no GraphQL on Bitbucket)', async () => {
      const result = await ops.fetchViewerPermission('workspace/repo', 'bb_token');
      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
