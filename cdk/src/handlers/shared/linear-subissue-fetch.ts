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
import { type LookupResult, LOOKUP_ABSENT, lookupFailed, lookupFound } from './lookup-result';
import type { DagNode } from './orchestration-dag';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const REQUEST_TIMEOUT_MS = 8000;

/** Linear `IssueRelation.type` value meaning "source blocks target". */
const RELATION_TYPE_BLOCKS = 'blocks';

const CONNECTION_PAGE_SIZE = 100;

/**
 * For child C, ``inverseRelations`` of type ``blocks`` are relations
 * whose *source* issue blocks C — i.e. C's predecessors.
 */
const SUB_ISSUE_GRAPH_QUERY = `
query SubIssueGraph($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
    id
    identifier
    children(first: $first) {
      pageInfo { hasNextPage }
      nodes {
        id
        identifier
        title
        description
        inverseRelations(first: $first) {
          pageInfo { hasNextPage }
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
  /** Linear sub-issue UUID. */
  readonly id: string;
  /** Human-readable identifier (e.g. ``ENG-42``) for comments/logs. */
  readonly identifier?: string;
  readonly title?: string;
  readonly description?: string;
  /**
   * Opaque, adapter-owned metadata copied onto the released child task.
   * The orchestration engine persists and forwards these string fields without
   * interpreting them.
   */
  readonly channel_metadata?: Readonly<Record<string, string>>;
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

interface RawPageInfo {
  readonly hasNextPage?: boolean;
}

interface RawChildNode {
  readonly id?: string;
  readonly identifier?: string;
  readonly title?: string;
  readonly description?: string;
  readonly inverseRelations?: { readonly pageInfo?: RawPageInfo; readonly nodes?: readonly RawRelationNode[] } | null;
}

interface RawSubIssueGraph {
  readonly data?: {
    readonly issue?: {
      readonly id?: string;
      readonly children?: { readonly pageInfo?: RawPageInfo; readonly nodes?: readonly RawChildNode[] } | null;
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
 *   edges restricted to siblings within this child set.
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

  if (issue.children?.pageInfo?.hasNextPage) {
    logger.warn('Linear sub-issue fetch truncated — parent has more children than one page', {
      parent_issue_id: issue.id, page_size: CONNECTION_PAGE_SIZE,
    });
    return {
      kind: 'error',
      message: `This epic has more than ${CONNECTION_PAGE_SIZE} sub-issues — too many for a single `
        + `orchestration. Split it into multiple epics of at most ${CONNECTION_PAGE_SIZE} sub-issues each.`,
    };
  }
  const truncatedBlockersChild = childNodes.find((c) => c.inverseRelations?.pageInfo?.hasNextPage);
  if (truncatedBlockersChild) {
    logger.warn('Linear sub-issue fetch truncated — a child has more blockers than one page', {
      parent_issue_id: issue.id, child_id: truncatedBlockersChild.id, page_size: CONNECTION_PAGE_SIZE,
    });
    return {
      kind: 'error',
      message: `A sub-issue has more than ${CONNECTION_PAGE_SIZE} blocking relations — too many to order `
        + `reliably. Reduce the cross-dependencies on sub-issue ${truncatedBlockersChild.identifier ?? truncatedBlockersChild.id}.`,
    };
  }

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
      ...(typeof c.description === 'string' && c.description.trim() !== '' && { description: c.description }),
      // Linear can surface a relation from both directions.
      depends_on: [...new Set(blockers)],
    });
  }

  return { kind: 'ok', parentIssueId: issue.id, children };
}

const ISSUE_PARENT_QUERY = `
query IssueParent($issueId: String!) {
  issue(id: $issueId) { id parent { id } }
}`;

/**
 * Fetch a sub-issue's parent issue id.
 *
 * Returns a {@link LookupResult}: ``found`` with the parent id, ``absent`` when
 * the issue genuinely has no parent (a top-level issue — not part of any
 * orchestration), or a failure when the fetch/auth/GraphQL call breaks. Never throws.
 */
export async function fetchIssueParentId(
  accessToken: string,
  issueId: string,
  options: FetchSubIssueGraphOptions = {},
): Promise<LookupResult<string>> {
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
      return lookupFailed(new Error(`Linear issue-parent fetch returned HTTP ${resp.status}`));
    }
    const raw = (await resp.json()) as { data?: { issue?: { parent?: { id?: string } } }; errors?: unknown };
    if (raw.errors) {
      logger.warn('Linear issue-parent fetch GraphQL errors', { issue_id: issueId, errors: raw.errors });
      return lookupFailed(raw.errors);
    }
    const parentId = raw.data?.issue?.parent?.id;
    return typeof parentId === 'string' ? lookupFound(parentId) : LOOKUP_ABSENT;
  } catch (err) {
    logger.warn('Linear issue-parent fetch failed', {
      issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  } finally {
    clearTimeout(timer);
  }
}
