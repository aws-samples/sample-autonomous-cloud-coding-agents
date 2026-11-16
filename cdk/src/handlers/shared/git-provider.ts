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

import { logger } from './logger';
import type { GitProviderType } from './types';

const API_TIMEOUT_MS = 5_000;

export interface GitProviderOps {
  readonly type: GitProviderType;
  checkReachability(token: string): Promise<ReachabilityResult>;
  checkRepoAccess(repo: string, token: string): Promise<RepoAccessResult>;
  checkPrAccessible(repo: string, prNumber: number, token: string): Promise<PrAccessResult>;
  fetchViewerPermission(repo: string, token: string): Promise<string | undefined>;
}

export interface ReachabilityResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly detail?: string;
}

export interface RepoAccessResult {
  readonly ok: boolean;
  readonly permission?: string;
  readonly pushAccess?: boolean;
  readonly status?: number;
  readonly detail?: string;
}

export interface PrAccessResult {
  readonly ok: boolean;
  readonly state?: string;
  readonly status?: number;
  readonly detail?: string;
}

export class GitHubProviderOps implements GitProviderOps {
  readonly type: GitProviderType = 'github';

  async checkReachability(token: string): Promise<ReachabilityResult> {
    try {
      const resp = await fetch('https://api.github.com/rate_limit', {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('GitHub reachability check failed', { error: detail });
      return { ok: false, detail };
    }
  }

  async checkRepoAccess(repo: string, token: string): Promise<RepoAccessResult> {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return { ok: false, status: resp.status };
      }
      const body = await resp.json() as { permissions?: { push?: boolean } };
      const pushAccess = body.permissions?.push === true;
      return { ok: true, pushAccess, permission: pushAccess ? 'write' : 'read' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('GitHub repo access check failed', { repo, error: detail });
      return { ok: false, detail };
    }
  }

  async checkPrAccessible(repo: string, prNumber: number, token: string): Promise<PrAccessResult> {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return { ok: false, status: resp.status };
      }
      const pr = await resp.json() as { state?: string };
      if (pr.state !== 'open') {
        return { ok: false, state: pr.state };
      }
      return { ok: true, state: 'open' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('GitHub PR access check failed', { repo, prNumber, error: detail });
      return { ok: false, detail };
    }
  }

  async fetchViewerPermission(repo: string, token: string): Promise<string | undefined> {
    const idx = repo.indexOf('/');
    if (idx <= 0 || idx === repo.length - 1) return undefined;
    const owner = repo.slice(0, idx);
    const name = repo.slice(idx + 1);
    try {
      const resp = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          query: 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerPermission}}',
          variables: { owner, name },
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) return undefined;
      const body = await resp.json() as { data?: { repository?: { viewerPermission?: string | null } } };
      return body.data?.repository?.viewerPermission ?? undefined;
    } catch {
      return undefined; // nosemgrep: ts-silent-success-masking -- caller treats undefined as "permission unknown" and falls through to the next preflight check
    }
  }
}

export class BitbucketProviderOps implements GitProviderOps {
  readonly type: GitProviderType = 'bitbucket';

  async checkReachability(token: string): Promise<ReachabilityResult> {
    try {
      const resp = await fetch('https://api.bitbucket.org/2.0/user', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('Bitbucket reachability check failed', { error: detail });
      return { ok: false, detail };
    }
  }

  async checkRepoAccess(repo: string, token: string): Promise<RepoAccessResult> {
    try {
      const resp = await fetch(`https://api.bitbucket.org/2.0/repositories/${repo}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return { ok: false, status: resp.status };
      }
      // Check effective permissions via user-permissions endpoint
      const permResp = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${repo}/permissions-config/users`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        },
      );
      let pushAccess = true; // Default to true if we can access the repo
      if (permResp.ok) {
        const permBody = await permResp.json() as { values?: Array<{ permission?: string }> };
        const perms = permBody.values ?? [];
        pushAccess = perms.some(p => p.permission === 'write' || p.permission === 'admin');
      }
      return { ok: true, pushAccess, permission: pushAccess ? 'write' : 'read' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('Bitbucket repo access check failed', { repo, error: detail });
      return { ok: false, detail };
    }
  }

  async checkPrAccessible(repo: string, prNumber: number, token: string): Promise<PrAccessResult> {
    try {
      const resp = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${repo}/pullrequests/${prNumber}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        },
      );
      if (!resp.ok) {
        return { ok: false, status: resp.status };
      }
      const pr = await resp.json() as { state?: string };
      const state = pr.state?.toLowerCase();
      if (state !== 'open') {
        return { ok: false, state };
      }
      return { ok: true, state: 'open' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn('Bitbucket PR access check failed', { repo, prNumber, error: detail });
      return { ok: false, detail };
    }
  }

  async fetchViewerPermission(_repo: string, _token: string): Promise<string | undefined> {
    // Bitbucket does not have a GraphQL API; permission is checked via checkRepoAccess
    return undefined;
  }
}

export function getProviderOps(type: GitProviderType = 'github'): GitProviderOps {
  return type === 'bitbucket' ? new BitbucketProviderOps() : new GitHubProviderOps();
}
