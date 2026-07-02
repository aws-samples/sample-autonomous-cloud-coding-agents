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

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import {
  clearRepoContextTokenCache,
  fetchRepoContextForPlanner,
  resolveGitHubTokenForContext,
  selectOverviewDocs,
} from '../../../src/handlers/shared/orchestration-repo-context';

const realFetch = global.fetch;

/** Base64-encode a README body the way the GitHub contents API returns it. */
function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/**
 * Build a fetch stub that answers the three GitHub endpoints the module hits:
 * /readme, /repos/{repo} (default_branch), /git/trees/{branch}. Any URL not
 * provided resolves to a 404.
 */
function githubFetchStub(opts: {
  readme?: { ok: boolean; content?: string };
  repo?: { ok: boolean; branch?: string };
  tree?: { ok: boolean; entries?: { path: string; type: string }[] };
  /** contents responses keyed by path (for overview-doc fetches). */
  docs?: Record<string, string>;
}): jest.Mock {
  return jest.fn(async (url: string) => {
    if (url.endsWith('/readme')) {
      const r = opts.readme;
      if (!r?.ok) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: b64(r.content ?? '') }) };
    }
    if (/\/git\/trees\//.test(url)) {
      const t = opts.tree;
      if (!t?.ok) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ tree: t.entries ?? [] }) };
    }
    const contentsMatch = url.match(/\/contents\/(.+)$/);
    if (contentsMatch) {
      const path = decodeURIComponent(contentsMatch[1]);
      const body = opts.docs?.[path];
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: b64(body) }) };
    }
    // /repos/{owner}/{repo}
    const rp = opts.repo;
    if (!rp?.ok) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ default_branch: rp.branch ?? 'main' }) };
  });
}

beforeEach(() => {
  mockSecretsSend.mockReset();
  clearRepoContextTokenCache();
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('resolveGitHubTokenForContext', () => {
  test('returns undefined when no ARN is given (no SDK call)', async () => {
    expect(await resolveGitHubTokenForContext(undefined)).toBeUndefined();
    expect(mockSecretsSend).not.toHaveBeenCalled();
  });

  test('resolves + caches the token per ARN (second call hits cache, not the SDK)', async () => {
    mockSecretsSend.mockResolvedValue({ SecretString: 'ghp_abc' });
    expect(await resolveGitHubTokenForContext('arn:sm:tok')).toBe('ghp_abc');
    expect(await resolveGitHubTokenForContext('arn:sm:tok')).toBe('ghp_abc');
    expect(mockSecretsSend).toHaveBeenCalledTimes(1); // cached second time
  });

  test('returns undefined (never throws) on an empty secret or SDK error', async () => {
    mockSecretsSend.mockResolvedValueOnce({ SecretString: '  ' });
    expect(await resolveGitHubTokenForContext('arn:sm:empty')).toBeUndefined();
    clearRepoContextTokenCache();
    mockSecretsSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await resolveGitHubTokenForContext('arn:sm:denied')).toBeUndefined();
  });
});

describe('fetchRepoContextForPlanner', () => {
  test('assembles README excerpt + top-level tree into one block', async () => {
    global.fetch = githubFetchStub({
      readme: { ok: true, content: 'ABCA is a Slack+Linear coding agent platform.' },
      repo: { ok: true, branch: 'main' },
      tree: {
        ok: true,
        entries: [
          { path: 'cdk', type: 'tree' },
          { path: 'cli', type: 'tree' },
          { path: 'agent', type: 'tree' },
          { path: 'README.md', type: 'blob' },
        ],
      },
    }) as unknown as typeof fetch;

    const ctx = await fetchRepoContextForPlanner('acme/repo', 'ghp_token');
    expect(ctx).toContain('ABCA is a Slack+Linear coding agent platform.');
    expect(ctx).toContain('cdk/'); // dirs get a trailing slash
    expect(ctx).toContain('README.md'); // files do not
    expect(ctx).toMatch(/Repository structure/);
  });

  test('sends the Authorization header only when a token is provided', async () => {
    const stub = githubFetchStub({ readme: { ok: true, content: 'x' }, repo: { ok: true }, tree: { ok: true, entries: [] } });
    global.fetch = stub as unknown as typeof fetch;
    await fetchRepoContextForPlanner('acme/repo', 'ghp_secret');
    const headers = stub.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('token ghp_secret');

    stub.mockClear();
    await fetchRepoContextForPlanner('acme/repo', undefined);
    const anon = stub.mock.calls[0][1].headers as Record<string, string>;
    expect(anon.Authorization).toBeUndefined();
  });

  test('returns undefined for a malformed repo (no owner/name) without calling fetch', async () => {
    const stub = jest.fn();
    global.fetch = stub as unknown as typeof fetch;
    expect(await fetchRepoContextForPlanner('not-a-repo', 't')).toBeUndefined();
    expect(stub).not.toHaveBeenCalled();
  });

  test('best-effort: returns undefined when BOTH README and tree fail (never throws)', async () => {
    global.fetch = githubFetchStub({ readme: { ok: false }, repo: { ok: false } }) as unknown as typeof fetch;
    expect(await fetchRepoContextForPlanner('acme/repo', 't')).toBeUndefined();
  });

  test('still returns tree-only context when the README 404s', async () => {
    global.fetch = githubFetchStub({
      readme: { ok: false },
      repo: { ok: true, branch: 'develop' },
      tree: { ok: true, entries: [{ path: 'src', type: 'tree' }] },
    }) as unknown as typeof fetch;
    const ctx = await fetchRepoContextForPlanner('acme/repo', 't');
    expect(ctx).toContain('src/');
    expect(ctx).not.toContain('README');
  });

  test('a fetch rejection is swallowed → undefined (planner falls back)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    expect(await fetchRepoContextForPlanner('acme/repo', 't')).toBeUndefined();
  });

  test('caps the DISPLAYED tree while still scanning deeper for docs (ABCA-492)', async () => {
    // 200 files + a nested ROADMAP.md that sorts past the display cap. The doc
    // must still be discovered (scan sees the full tree) even though the shown
    // listing is capped.
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, type: 'blob' }));
    const entries = [...many, { path: 'docs/guides/ROADMAP.md', type: 'blob' }];
    global.fetch = githubFetchStub({
      readme: { ok: false },
      repo: { ok: true },
      tree: { ok: true, entries },
      docs: { 'docs/guides/ROADMAP.md': 'Backlog: F1 threads, F2 mapping, F3 reactions' },
    }) as unknown as typeof fetch;
    const ctx = await fetchRepoContextForPlanner('acme/repo', 't');
    const listed = (ctx ?? '').split('\n').filter((l) => /^src\/f\d+\.ts$/.test(l)).length;
    expect(listed).toBeLessThanOrEqual(120); // display cap
    // ...but the deep ROADMAP was still found + its contents fetched
    expect(ctx).toContain('docs/guides/ROADMAP.md (excerpt)');
    expect(ctx).toContain('F1 threads, F2 mapping');
  });

  test('fetches overview docs discovered in the tree (ROADMAP/architecture)', async () => {
    global.fetch = githubFetchStub({
      readme: { ok: true, content: 'platform' },
      repo: { ok: true },
      tree: {
        ok: true,
        entries: [
          { path: 'docs/guides/ROADMAP.md', type: 'blob' },
          { path: 'docs/design/ARCHITECTURE.md', type: 'blob' },
          { path: 'src/index.ts', type: 'blob' },
        ],
      },
      docs: {
        'docs/guides/ROADMAP.md': 'ROADMAP: capability A, capability B, capability C',
        'docs/design/ARCHITECTURE.md': 'ARCH: three services',
      },
    }) as unknown as typeof fetch;
    const ctx = await fetchRepoContextForPlanner('acme/repo', 't');
    expect(ctx).toContain('capability A, capability B');
    expect(ctx).toContain('ARCH: three services');
  });
});

describe('selectOverviewDocs (pure)', () => {
  test('picks ROADMAP / architecture / features docs, ranked, capped at 3', () => {
    const tree = [
      'src/', 'src/a.ts',
      'docs/guides/ROADMAP.md',
      'docs/design/ARCHITECTURE.md',
      'FEATURES.md',
      'docs/OVERVIEW.md',
      'README.md', // not an overview pattern here (README fetched separately)
    ];
    const picked = selectOverviewDocs(tree);
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(picked[0]).toBe('docs/guides/ROADMAP.md'); // roadmap ranks first
    expect(picked).toContain('docs/design/ARCHITECTURE.md');
  });

  test('prefers the shallowest match for a pattern', () => {
    const tree = ['deep/nested/dir/ROADMAP.md', 'ROADMAP.md'];
    expect(selectOverviewDocs(tree)[0]).toBe('ROADMAP.md');
  });

  test('returns [] when no overview docs are present (dirs + code only)', () => {
    expect(selectOverviewDocs(['src/', 'src/a.ts', 'package.json'])).toEqual([]);
  });

  test('ignores directories (trailing slash), matches only files', () => {
    // a dir literally named "roadmap.md/" (pathological) must not be picked
    expect(selectOverviewDocs(['roadmap.md/', 'roadmap.md/child.ts'])).toEqual([]);
  });
});
