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

/** Total wall-clock budget for the whole context fetch (ms). Small — this runs
 *  inline before the planner's Bedrock calls and must not eat their budget. */
const REPO_CONTEXT_TIMEOUT_MS = 8000;

/** README excerpt cap (chars). Enough to convey what the repo is; not the whole file. */
const README_MAX_CHARS = 3000;

/** Cap on tree entries DISPLAYED in the prompt (recursive). Filenames are cheap;
 *  keep enough to reveal structure (separable subsystems) without flooding it. */
const MAX_TREE_ENTRIES = 120;

/** Hard ceiling on tree paths SCANNED for doc discovery — larger than the
 *  display cap so a nested docs/ dir is still reachable, but bounded so a giant
 *  monorepo can't produce an unbounded array. */
const MAX_TREE_SCAN_ENTRIES = 2000;

/**
 * Overview docs (ROADMAP / architecture / feature docs) are what actually
 * convey a repo's *separable capabilities* — a top-level file listing rarely
 * does (measured on ABCA-492: README+tree didn't move the decline-biased
 * assessor; an enumerating ROADMAP did). Fetch up to this many, each capped.
 */
const MAX_OVERVIEW_DOCS = 3;
const OVERVIEW_DOC_MAX_CHARS = 2500;

/**
 * Basename patterns (no directory assumptions — matched against the recursive
 * tree, so this is derived from the repo, not a hardcoded path map) for docs
 * that tend to enumerate a project's capabilities/roadmap. Ranked: earlier =
 * more likely to list separable units. Kept as *patterns*, not exact paths, so
 * any repo layout that names these surfaces them. Only ``.md`` files.
 */
const OVERVIEW_DOC_PATTERNS: readonly RegExp[] = [
  /(^|\/)roadmap\.md$/i,
  /(^|\/)(architecture|design)\.md$/i,
  /(^|\/)features?\.md$/i,
  /(^|\/)overview\.md$/i,
  /(^|\/)(developer[_-]?guide|dev[_-]?guide)\.md$/i,
];

/** Overall cap on the assembled context block (chars) — a final belt-and-suspenders. */
const CONTEXT_MAX_CHARS = 12000;

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

    // README + recursive tree first (the tree drives doc discovery). Fixed
    // two-element array (not input-derived), so parallelism is bounded.
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [readme, fullTree] = await Promise.all([
      fetchReadme(repo, headers, controller.signal),
      fetchRepoTree(repo, headers, controller.signal),
    ]);

    // Overview docs are what actually convey separable capabilities. Select them
    // from the FULL tree (derived, not hardcoded paths) BEFORE truncating the
    // displayed listing — else a doc in a nested dir (docs/guides/ROADMAP.md)
    // that sorts past the display cap would be missed. Then fetch their contents.
    const docPaths = selectOverviewDocs(fullTree);
    const docs = await fetchOverviewDocs(repo, docPaths, headers, controller.signal);

    // The displayed structure is capped separately (filenames are cheap but the
    // prompt must stay bounded); doc discovery already saw the full tree above.
    const shownTree = fullTree.slice(0, MAX_TREE_ENTRIES);

    const parts: string[] = [];
    if (readme) parts.push(`README (excerpt):\n${readme}`);
    for (const d of docs) parts.push(`${d.path} (excerpt):\n${d.text}`);
    if (shownTree.length > 0) {
      const suffix = fullTree.length > shownTree.length ? ` of ${fullTree.length}` : '';
      parts.push(`Repository structure (${shownTree.length}${suffix} paths):\n${shownTree.join('\n')}`);
    }
    if (parts.length === 0) return undefined;

    const block = parts.join('\n\n').slice(0, CONTEXT_MAX_CHARS);
    logger.info('Fetched repo context for decomposition planner', {
      repo,
      readme_chars: readme?.length ?? 0,
      tree_entries: shownTree.length,
      tree_total: fullTree.length,
      overview_docs: docs.map((d) => d.path),
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
 * Fetch the repo's file tree (RECURSIVE) on the default branch and return the
 * blob/dir paths, capped at {@link MAX_TREE_ENTRIES}. Recursive (vs top-level
 * only) so the planner sees separable subsystems and so {@link selectOverviewDocs}
 * can find docs in nested dirs (docs/guides/ROADMAP.md, etc.). Returns [] on
 * failure.
 */
async function fetchRepoTree(
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
      `${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers, signal },
    );
    if (!treeResp.ok) return [];
    const body = (await treeResp.json()) as GitHubTreeResponse;
    // Return the full path list (capped at a generous hard ceiling so doc
    // discovery can see nested docs); the CALLER caps the DISPLAYED subset at
    // MAX_TREE_ENTRIES. Keeps a huge monorepo from producing an unbounded array.
    return (body.tree ?? [])
      .map((t) => (t.type === 'tree' ? `${t.path}/` : t.path))
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, MAX_TREE_SCAN_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * From the (recursive) tree paths, pick the overview docs most likely to
 * enumerate the repo's separable capabilities. Ranked by {@link OVERVIEW_DOC_PATTERNS}
 * (earlier pattern = higher priority), capped at {@link MAX_OVERVIEW_DOCS}.
 * Pure — no I/O, unit-testable. Derived entirely from the tree (no hardcoded
 * paths), so it adapts to whatever layout a repo uses.
 */
export function selectOverviewDocs(treePaths: readonly string[]): string[] {
  const files = treePaths.filter((p) => !p.endsWith('/'));
  const picked: string[] = [];
  for (const pattern of OVERVIEW_DOC_PATTERNS) {
    // Prefer the shallowest match for each pattern (a top-level ROADMAP.md
    // beats a deeply-nested one) so we get the canonical overview.
    const matches = files
      .filter((f) => pattern.test(f) && !picked.includes(f))
      .sort((a, b) => a.split('/').length - b.split('/').length);
    if (matches.length > 0) picked.push(matches[0]);
    if (picked.length >= MAX_OVERVIEW_DOCS) break;
  }
  return picked.slice(0, MAX_OVERVIEW_DOCS);
}

/** Fetch the contents of the selected overview docs (each capped). Best-effort
 *  per-file; a failed fetch is simply omitted. */
async function fetchOverviewDocs(
  repo: string,
  paths: readonly string[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  // Sequential (not Promise.all) — at most MAX_OVERVIEW_DOCS files, and it keeps
  // us well under the shared deadline without unbounded fan-out.
  for (const path of paths) {
    try {
      const resp = await fetch(
        `${GITHUB_API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        { headers, signal },
      );
      if (!resp.ok) continue;
      const body = (await resp.json()) as GitHubReadmeResponse;
      if (!body.content) continue;
      const decoded = body.encoding === 'base64'
        ? Buffer.from(body.content, 'base64').toString('utf-8')
        : body.content;
      const text = decoded.trim().slice(0, OVERVIEW_DOC_MAX_CHARS);
      if (text) out.push({ path, text });
    } catch {
      // omit this doc; keep whatever else we gathered
      continue;
    }
  }
  return out;
}
