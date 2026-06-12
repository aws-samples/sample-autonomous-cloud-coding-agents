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
 * Fetch a Linear parent issue's sub-issue dependency graph (issue #247,
 * Mode A — PR A2). Reads ``children`` (sub-issues) and, per child, its
 * ``inverseRelations`` of type ``blocks`` (the issues that block it) to
 * build ``depends_on`` edges, then hands the result to
 * ``orchestration-dag.ts::validateDag``.
 *
 * Direct GraphQL against Linear, Bearer-authenticated with the
 * per-workspace OAuth token resolved by ``resolveLinearOauthToken``.
 * Mirrors the request shape proven in ``linear-feedback.ts``.
 *
 * Unlike the best-effort feedback path, discovery is load-bearing: a
 * fetch failure must be distinguishable from "this issue genuinely has
 * no sub-issues" so the caller (the webhook processor) can decide
 * whether to fall back to a single task or surface an error. Hence the
 * discriminated ``FetchSubIssueGraphResult`` rather than a bare array.
 */

import type { DagNode } from './orchestration-dag';
import { logger } from './logger';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const REQUEST_TIMEOUT_MS = 8000;

/** Linear `IssueRelation.type` value meaning "source blocks target". */
const RELATION_TYPE_BLOCKS = 'blocks';

/**
 * Page size for the children / relations connections. Bounded by
 * ``max_sub_issues`` policy downstream; a parent with more children
 * than this is over-cap and will be rejected before execution, so a
 * single page is sufficient for the MVP (no cursor pagination).
 */
const CONNECTION_PAGE_SIZE = 100;

/**
 * GraphQL: fetch a parent issue's children and each child's blockers.
 *
 * For child C, ``inverseRelations`` of type ``blocks`` are relations
 * whose *source* issue blocks C — i.e. C's predecessors. We take the
 * related issue id from each as a ``depends_on`` edge.
 */
const SUB_ISSUE_GRAPH_QUERY = `
query SubIssueGraph($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
    id
    identifier
    children(first: $first) {
      nodes {
        id
        identifier
        title
        inverseRelations(first: $first) {
          nodes {
            type
            issue { id }
          }
        }
      }
    }
  }
}
`.trim();

/** One sub-issue plus the metadata the orchestration row needs. */
export interface SubIssueNode extends DagNode {
  /** Linear sub-issue UUID (same as ``id``). */
  readonly id: string;
  /** Human-readable identifier (e.g. ``ENG-42``) for comments/logs. */
  readonly identifier?: string;
  /** Sub-issue title for the task description. */
  readonly title?: string;
  /** Sub-issue ids that block this one (intra-epic predecessors). */
  readonly depends_on: readonly string[];
}

export type FetchSubIssueGraphResult =
  | { readonly kind: 'ok'; readonly parentIssueId: string; readonly children: readonly SubIssueNode[] }
  | { readonly kind: 'no_children'; readonly parentIssueId: string }
  | { readonly kind: 'error'; readonly message: string };

interface RawRelationNode {
  readonly type?: string;
  readonly issue?: { readonly id?: string } | null;
}

interface RawChildNode {
  readonly id?: string;
  readonly identifier?: string;
  readonly title?: string;
  readonly inverseRelations?: { readonly nodes?: readonly RawRelationNode[] } | null;
}

interface RawSubIssueGraph {
  readonly data?: {
    readonly issue?: {
      readonly id?: string;
      readonly children?: { readonly nodes?: readonly RawChildNode[] } | null;
    } | null;
  };
  readonly errors?: unknown;
}

export interface FetchSubIssueGraphOptions {
  /** Override fetch for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Fetch + shape a parent issue's sub-issue dependency graph.
 *
 * Returns:
 * - ``ok``          — at least one child; ``children`` carry ``depends_on``
 *   edges restricted to siblings within this child set (edges pointing
 *   outside the set are dropped here and surface as a dangling-edge
 *   rejection only if the caller chooses to keep them; we keep them so
 *   ``validateDag`` can flag a genuinely malformed graph).
 * - ``no_children`` — the issue exists but has no sub-issues (caller
 *   falls back to a single task).
 * - ``error``       — network / auth / GraphQL failure (caller surfaces
 *   a retryable error; does NOT silently treat as "no children").
 *
 * Never throws.
 */
export async function fetchSubIssueGraph(
  accessToken: string,
  parentIssueId: string,
  options: FetchSubIssueGraphOptions = {},
): Promise<FetchSubIssueGraphResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let raw: RawSubIssueGraph;
  try {
    const resp = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: SUB_ISSUE_GRAPH_QUERY,
        variables: { issueId: parentIssueId, first: CONNECTION_PAGE_SIZE },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('Linear sub-issue fetch non-2xx', { status: resp.status, parent_issue_id: parentIssueId });
      return { kind: 'error', message: `Linear API returned status ${resp.status}.` };
    }
    raw = (await resp.json()) as RawSubIssueGraph;
  } catch (err) {
    logger.warn('Linear sub-issue fetch failed', {
      parent_issue_id: parentIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'Could not reach the Linear API to read sub-issues.' };
  } finally {
    clearTimeout(timer);
  }

  if (raw.errors) {
    logger.warn('Linear sub-issue fetch GraphQL errors', { parent_issue_id: parentIssueId, errors: raw.errors });
    return { kind: 'error', message: 'Linear API reported an error reading sub-issues.' };
  }

  const issue = raw.data?.issue;
  if (!issue || !issue.id) {
    return { kind: 'error', message: 'Linear issue not found or not accessible with the workspace token.' };
  }

  const childNodes = issue.children?.nodes ?? [];
  if (childNodes.length === 0) {
    return { kind: 'no_children', parentIssueId: issue.id };
  }

  // Restrict depends_on edges to ids that are themselves children of
  // this parent — a "blocks" relation pointing at an issue outside the
  // epic is not an intra-epic ordering constraint. (validateDag also
  // guards dangling edges, but filtering here keeps the persisted graph
  // clean and the dangling check meaningful for genuinely malformed
  // intra-epic references only.)
  const childIds = new Set(
    childNodes.map((c) => c.id).filter((id): id is string => typeof id === 'string'),
  );

  const children: SubIssueNode[] = [];
  for (const c of childNodes) {
    if (!c.id) continue;
    const blockers = (c.inverseRelations?.nodes ?? [])
      .filter((r) => r.type === RELATION_TYPE_BLOCKS)
      .map((r) => r.issue?.id)
      .filter((id): id is string => typeof id === 'string' && id !== c.id && childIds.has(id));
    children.push({
      id: c.id,
      ...(c.identifier !== undefined && { identifier: c.identifier }),
      ...(c.title !== undefined && { title: c.title }),
      // Dedup edges (Linear can surface a relation from both directions).
      depends_on: [...new Set(blockers)],
    });
  }

  return { kind: 'ok', parentIssueId: issue.id, children };
}

/** GraphQL: an issue's parent id (for the A6 comment trigger — sub-issue → parent). */
const ISSUE_PARENT_QUERY = `
query IssueParent($issueId: String!) {
  issue(id: $issueId) { id parent { id } }
}`;

/**
 * Fetch a sub-issue's parent issue id (#247 A6 comment trigger). A Linear
 * comment names the issue it is on (the sub-issue); to find its orchestration
 * we need the PARENT (orchestration_id is derived from the parent). Returns the
 * parent id, or null when the issue has no parent (a top-level issue — not part
 * of any orchestration) or on any fetch/auth/GraphQL failure. Never throws.
 */
export async function fetchIssueParentId(
  accessToken: string,
  issueId: string,
  options: FetchSubIssueGraphOptions = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ISSUE_PARENT_QUERY, variables: { issueId } }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('Linear issue-parent fetch non-2xx', { status: resp.status, issue_id: issueId });
      return null;
    }
    const raw = (await resp.json()) as { data?: { issue?: { parent?: { id?: string } } }; errors?: unknown };
    if (raw.errors) {
      logger.warn('Linear issue-parent fetch GraphQL errors', { issue_id: issueId, errors: raw.errors });
      return null;
    }
    return raw.data?.issue?.parent?.id ?? null;
  } catch (err) {
    logger.warn('Linear issue-parent fetch failed', {
      issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
