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

/**
 * ABCA-492 — best-effort repository context for the #299 Mode B decomposition
 * planner.
 *
 * The assessor (stage 1) decides decompose-vs-one-unit from the issue title +
 * description ALONE. A thin-but-big issue ("slack parity with linear", one
 * sentence) reads as one intertwined investigation, so it declines to split —
 * even though in the actual repo that request is several separable features. A
 * senior lead would know the repo; the planner does not. This fetches a small
 * amount of grounding — the README (excerpt) + the top-level file/dir tree —
 * so the assessor judges the task against what the repo actually is.
 *
 * Deliberately BOUNDED and BEST-EFFORT:
 *  - README truncated to {@link README_MAX_CHARS}; tree to {@link MAX_TREE_ENTRIES}
 *    top-level entries. The planner prompt must stay small (latency + cost).
 *  - A single {@link AbortSignal.timeout} budget across the two GitHub calls; a
 *    slow or failing GitHub never delays the planner beyond it.
 *  - Returns ``undefined`` on ANY failure (no token, private repo, 404, network,
 *    rate-limit). The planner then behaves exactly as before (title+description
 *    only). Never throws — grounding is an enhancement, not a dependency.
 */

import { logger } from './logger';

/** GitHub REST base. */
const GITHUB_API = 'https://api.github.com';

/**
 * Resolve a GitHub token from a Secrets Manager ARN, cached for the Lambda's
 * warm lifetime. Lazy-imports the SDK (mirrors bedrockInvokeModel) so the cold
 * start cost is only paid on the decomposition path. Returns undefined on any
 * failure (missing/empty secret, access denied) — the caller then fetches only
 * public context or none.
 */
let cachedToken: { arn: string; token: string } | undefined;
export async function resolveGitHubTokenForContext(
  secretArn: string | undefined,
): Promise<string | undefined> {
  if (!secretArn) return undefined;
  if (cachedToken?.arn === secretArn) return cachedToken.token;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const token = res.SecretString?.trim();
    if (!token) return undefined;
    cachedToken = { arn: secretArn, token };
    return token;
  } catch (err) {
    logger.warn('Could not resolve GitHub token for planner context (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Reset the token cache (tests). */
export function clearRepoContextTokenCache(): void {
  cachedToken = undefined;
}

/** Total wall-clock budget for the README + tree fetch (ms). Small — this runs
 *  inline before the planner's Bedrock calls and must not eat their budget. */
const REPO_CONTEXT_TIMEOUT_MS = 6000;

/** README excerpt cap (chars). Enough to convey what the repo is; not the whole file. */
const README_MAX_CHARS = 4000;

/** Cap on top-level tree entries listed (dirs + files at the repo root). */
const MAX_TREE_ENTRIES = 60;

/** Overall cap on the assembled context block (chars) — a final belt-and-suspenders. */
const CONTEXT_MAX_CHARS = 6000;

interface GitHubReadmeResponse {
  readonly content?: string;
  readonly encoding?: string;
}

interface GitHubTreeEntry {
  readonly path?: string;
  readonly type?: string;
}

interface GitHubTreeResponse {
  readonly tree?: readonly GitHubTreeEntry[];
  readonly truncated?: boolean;
}

/**
 * Fetch a compact repository-context block for the planner, or ``undefined`` if
 * it can't be assembled. ``repo`` is ``owner/name``; ``token`` is a GitHub PAT
 * (may be empty — public repos still resolve, private ones just return
 * undefined). Never throws.
 */
export async function fetchRepoContextForPlanner(
  repo: string,
  token: string | undefined,
): Promise<string | undefined> {
  if (!repo || !repo.includes('/')) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPO_CONTEXT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'abca-decomposition-planner',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `token ${token}`;

    // Fetch README + default-branch tree concurrently under one deadline. This
    // is a FIXED two-element array (not input-derived), so parallelism is bounded.
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [readme, tree] = await Promise.all([
      fetchReadme(repo, headers, controller.signal),
      fetchTopLevelTree(repo, headers, controller.signal),
    ]);

    const parts: string[] = [];
    if (readme) parts.push(`README (excerpt):\n${readme}`);
    if (tree.length > 0) parts.push(`Top-level repository structure:\n${tree.join('\n')}`);
    if (parts.length === 0) return undefined;

    const block = parts.join('\n\n').slice(0, CONTEXT_MAX_CHARS);
    logger.info('Fetched repo context for decomposition planner', {
      repo,
      readme_chars: readme?.length ?? 0,
      tree_entries: tree.length,
      block_chars: block.length,
    });
    return block;
  } catch (err) {
    // Best-effort: any failure → no context, planner falls back to
    // title+description only (its prior behaviour). Never fail the task.
    logger.warn('Repo context fetch for planner failed (non-fatal — planner proceeds without it)', {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch + decode the repo README (default branch). Returns undefined on failure. */
async function fetchReadme(
  repo: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const resp = await fetch(`${GITHUB_API}/repos/${repo}/readme`, { headers, signal });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as GitHubReadmeResponse;
    if (!body.content) return undefined;
    const decoded = body.encoding === 'base64'
      ? Buffer.from(body.content, 'base64').toString('utf-8')
      : body.content;
    return decoded.trim().slice(0, README_MAX_CHARS) || undefined;
  } catch {
    // Individual sub-fetch failure is swallowed; the caller still assembles
    // whatever else it got (or returns undefined if nothing).
    return undefined;
  }
}

/**
 * Fetch the repo's top-level entries (root dirs + files) via the git-tree API on
 * the default branch. Non-recursive so the payload stays small. Returns [] on
 * failure.
 */
async function fetchTopLevelTree(
  repo: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    // Resolve the default branch first (don't assume main/master).
    const repoResp = await fetch(`${GITHUB_API}/repos/${repo}`, { headers, signal });
    if (!repoResp.ok) return [];
    const branch = ((await repoResp.json()) as { default_branch?: string }).default_branch;
    if (!branch) return [];

    const treeResp = await fetch(
      `${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}`,
      { headers, signal },
    );
    if (!treeResp.ok) return [];
    const body = (await treeResp.json()) as GitHubTreeResponse;
    const entries = (body.tree ?? [])
      .map((t) => (t.type === 'tree' ? `${t.path}/` : t.path))
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, MAX_TREE_ENTRIES);
    return entries;
  } catch {
    return [];
  }
}
