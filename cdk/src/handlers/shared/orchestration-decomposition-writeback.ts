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
 * #299 Mode B — write an approved decomposition plan back to Linear (B5).
 *
 * This is the only NET-NEW Linear *write* surface in Mode B: it creates real
 * sub-issues under the parent and the ``blockedBy`` relations between them, so a
 * human sees (and can edit) the same graph the executor runs. After write-back,
 * the caller (B6) seeds the #247 executor from the returned {@link SubIssueNode}
 * list (which carries the REAL Linear ids) via ``declarativeGraphSource`` —
 * authoritative + avoids re-fetching just-created issues under eventual
 * consistency.
 *
 * **Idempotent + resumable** (the #299 B5 requirement). Linear ``issueCreate``
 * has no native idempotency key, so:
 *  - Before creating, we fetch the parent's CURRENT children and match by exact
 *    title. A planned node whose title already exists is REUSED (its id), not
 *    re-created — so a retry after a partial write-back (3 of 5 created, then a
 *    throttle) does not double-create.
 *  - Relations are created only when the equivalent ``blocks`` edge does not
 *    already exist (read from the children's ``inverseRelations``), so re-runs
 *    don't pile up duplicate edges.
 * (The approve-comment redelivery dedup is a separate, complementary guard in
 * B6 via ``claimCommentAck``; this module is self-idempotent regardless.)
 *
 * The GraphQL transport is injected ({@link GraphqlFn}) so the create/reuse/edge
 * logic is unit-testable without a live Linear call. {@link linearGraphqlFn} is
 * the production transport (mirrors ``linear-feedback.ts``).
 */

import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';
import type { PlannedSubIssue } from './orchestration-decomposition-types';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 8000;
const RELATION_TYPE_BLOCKS = 'blocks';
const CONNECTION_PAGE_SIZE = 100;

/** Fetch the parent's team id (issueCreate needs a team) + first page of children. */
const PARENT_STATE_QUERY = `
query ParentState($issueId: String!, $first: Int!) {
  issue(id: $issueId) {
    id
    team { id }
    children(first: $first) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        inverseRelations(first: $first) {
          nodes { type issue { id } }
        }
      }
    }
  }
}
`.trim();

/** Subsequent pages of the parent's children (cursor-paginated). */
const PARENT_CHILDREN_PAGE_QUERY = `
query ParentChildrenPage($issueId: String!, $first: Int!, $after: String!) {
  issue(id: $issueId) {
    children(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        inverseRelations(first: $first) {
          nodes { type issue { id } }
        }
      }
    }
  }
}
`.trim();

interface ChildrenConnection {
  readonly pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  readonly nodes?: RawChild[];
}

/**
 * Fetch ALL of the parent's existing children, following ``pageInfo`` cursors.
 * The reuse-by-title dedup (and edge-already-exists check) must see every child,
 * not just the first 100 — otherwise a resumed write-back on a parent with 100+
 * children re-creates duplicates. ``firstConnection`` is the page already fetched
 * by PARENT_STATE_QUERY (so we don't re-query it). Stops on any page failure
 * (returns what it has — best-effort, mirrors the module's never-throw contract).
 */
async function fetchAllChildren(
  graphql: GraphqlFn,
  parentIssueId: string,
  firstConnection: ChildrenConnection | undefined,
): Promise<RawChild[]> {
  const all: RawChild[] = [...(firstConnection?.nodes ?? [])];
  let cursor = firstConnection?.pageInfo?.hasNextPage ? firstConnection.pageInfo.endCursor : undefined;
  while (cursor) {
    const data = await graphql(PARENT_CHILDREN_PAGE_QUERY, {
      issueId: parentIssueId, first: CONNECTION_PAGE_SIZE, after: cursor,
    });
    const conn = (data?.issue as { children?: ChildrenConnection } | undefined)?.children;
    if (!conn) break; // page failure → stop with what we have (never throw)
    all.push(...(conn.nodes ?? []));
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor ?? undefined : undefined;
  }
  return all;
}

const ISSUE_CREATE_MUTATION = `
mutation CreateSubIssue($teamId: String!, $parentId: String!, $title: String!, $description: String!) {
  issueCreate(input: { teamId: $teamId, parentId: $parentId, title: $title, description: $description }) {
    success
    issue { id identifier }
  }
}
`.trim();

// NOTE: ``type`` is the ``IssueRelationType`` ENUM (values: blocks, duplicate,
// related, similar), NOT a String — declaring it ``String!`` makes Linear
// reject the mutation with a 400 (live-caught in B7). The enum value is passed
// as a variable (``RELATION_TYPE_BLOCKS = 'blocks'``), which Linear coerces to
// the enum once the param type is correct.
const ISSUE_RELATION_CREATE_MUTATION = `
mutation CreateBlockingRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
    success
  }
}
`.trim();

/**
 * Injected GraphQL transport: run a query+variables against Linear and return
 * ``data`` (or null on any failure — non-2xx, GraphQL errors, timeout). Mirrors
 * ``linear-feedback.ts``'s ``graphqlData``.
 */
export type GraphqlFn = (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

export type WriteBackResult =
  | {
    readonly kind: 'ok';
    /** Created/reused sub-issues with REAL Linear ids + intra-graph depends_on. */
    readonly children: readonly SubIssueNode[];
    /** How many were freshly created vs. reused from a prior (partial) run. */
    readonly created: number;
    readonly reused: number;
  }
  | { readonly kind: 'error'; readonly message: string };

interface RawChild {
  readonly id?: string;
  readonly identifier?: string;
  readonly title?: string;
  readonly inverseRelations?: { readonly nodes?: { type?: string; issue?: { id?: string } | null }[] } | null;
}

/**
 * Materialise an approved plan as Linear sub-issues + ``blockedBy`` edges under
 * ``parentIssueId``. Returns the created/reused nodes (with real Linear ids) for
 * the executor to seed, or an error the caller surfaces. Never throws.
 */
export async function writeBackPlan(params: {
  readonly graphql: GraphqlFn;
  readonly parentIssueId: string;
  readonly nodes: readonly PlannedSubIssue[];
}): Promise<WriteBackResult> {
  const { graphql, parentIssueId, nodes } = params;
  if (nodes.length === 0) return { kind: 'error', message: 'No sub-issues to create.' };

  // ── 1. Read parent team + existing children (for idempotent reuse) ──
  const stateData = await graphql(PARENT_STATE_QUERY, { issueId: parentIssueId, first: CONNECTION_PAGE_SIZE });
  const issue = stateData?.issue as
    | { team?: { id?: string }; children?: ChildrenConnection }
    | undefined
    | null;
  const teamId = issue?.team?.id;
  if (!teamId) {
    return { kind: 'error', message: 'Could not resolve the parent issue\'s team for sub-issue creation.' };
  }
  // Follow pagination so reuse-by-title sees ALL children (not just first 100).
  const existingChildren = await fetchAllChildren(graphql, parentIssueId, issue?.children);
  // Title → existing child (for create-skip). Exact match; planner titles are
  // distinct within a plan. First occurrence wins if Linear has dup titles.
  const byTitle = new Map<string, RawChild>();
  for (const c of existingChildren) {
    if (c.title && c.id && !byTitle.has(c.title)) byTitle.set(c.title, c);
  }

  // ── 2. Create (or reuse) one issue per planned node ─────────────────
  const linearIdByIndex: (string | undefined)[] = new Array(nodes.length).fill(undefined);
  const identifierByIndex: (string | undefined)[] = new Array(nodes.length).fill(undefined);
  let created = 0;
  let reused = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const existing = byTitle.get(node.title);
    if (existing?.id) {
      linearIdByIndex[i] = existing.id;
      identifierByIndex[i] = existing.identifier;
      reused++;
      continue;
    }
    const createData = await graphql(ISSUE_CREATE_MUTATION, {
      teamId,
      parentId: parentIssueId,
      title: node.title,
      description: node.description,
    });
    const result = createData?.issueCreate as { success?: boolean; issue?: { id?: string; identifier?: string } } | undefined;
    if (!result?.success || !result.issue?.id) {
      logger.error('Mode B write-back: issueCreate failed', { parent_issue_id: parentIssueId, title: node.title, index: i });
      // Partial state is fine: created issues are reused by title on a retry.
      return { kind: 'error', message: `Failed to create sub-issue "${node.title}". Re-approving will resume.` };
    }
    linearIdByIndex[i] = result.issue.id;
    identifierByIndex[i] = result.issue.identifier;
    created++;
  }

  // ── 3. Create the blockedBy edges (idempotent vs. existing relations) ─
  // For "node i depends_on j": predecessor j BLOCKS node i, i.e. a relation
  // (issueId: j, relatedIssueId: i, type: 'blocks'). discovery reads i's
  // inverseRelations(blocks) and maps the related issue (j) to a depends_on.
  // Build the set of edges already present so a re-run doesn't duplicate them.
  const existingEdges = collectExistingBlockingEdges(existingChildren);
  for (let i = 0; i < nodes.length; i++) {
    const childId = linearIdByIndex[i]!;
    for (const predIndex of nodes[i].depends_on) {
      const predId = linearIdByIndex[predIndex];
      if (!predId) continue; // defensive — validateDag already ruled out OOR
      if (existingEdges.has(edgeKey(predId, childId))) continue; // already present
      const relData = await graphql(ISSUE_RELATION_CREATE_MUTATION, {
        issueId: predId,
        relatedIssueId: childId,
        type: RELATION_TYPE_BLOCKS,
      });
      const ok = (relData?.issueRelationCreate as { success?: boolean } | undefined)?.success;
      if (!ok) {
        // A failed edge would let a dependent start before its predecessor —
        // unsafe to seed. Surface; a re-approve recreates only the missing edge.
        logger.error('Mode B write-back: issueRelationCreate failed', {
          parent_issue_id: parentIssueId, pred_index: predIndex, child_index: i,
        });
        return { kind: 'error', message: 'Failed to set a dependency between sub-issues. Re-approving will resume.' };
      }
      existingEdges.add(edgeKey(predId, childId));
    }
  }

  // ── 4. Shape the result as SubIssueNode[] (real ids) for the executor ─
  const children: SubIssueNode[] = nodes.map((node, i) => ({
    id: linearIdByIndex[i]!,
    ...(identifierByIndex[i] !== undefined && { identifier: identifierByIndex[i] }),
    title: node.title,
    depends_on: node.depends_on.map((j) => linearIdByIndex[j]!),
  }));

  logger.info('Mode B write-back complete', { parent_issue_id: parentIssueId, created, reused, total: nodes.length });
  return { kind: 'ok', children, created, reused };
}

/** Collect existing ``A blocks B`` edges from children's inverseRelations. */
function collectExistingBlockingEdges(children: readonly RawChild[]): Set<string> {
  const edges = new Set<string>();
  for (const child of children) {
    if (!child.id) continue;
    for (const rel of child.inverseRelations?.nodes ?? []) {
      if (rel.type === RELATION_TYPE_BLOCKS && rel.issue?.id) {
        // rel: issue (rel.issue.id) blocks child (child.id).
        edges.add(edgeKey(rel.issue.id, child.id));
      }
    }
  }
  return edges;
}

/** Directed edge key "blocker→blocked". */
function edgeKey(blockerId: string, blockedId: string): string {
  return `${blockerId}->${blockedId}`;
}

/**
 * Production {@link GraphqlFn}: POST a query to Linear, Bearer-authenticated,
 * with a timeout. Returns ``data`` or null on any failure (mirrors
 * ``linear-feedback.ts``'s ``graphqlData`` — write-back failures are surfaced as
 * a resumable error by the caller, never thrown).
 */
/** Max retry attempts on a throttle/transient (429 / 5xx) before giving up. */
const MAX_RETRIES = 3;
/** Base backoff (ms) when no Retry-After header is given; doubles per attempt. */
const RETRY_BASE_MS = 500;
/** Cap any single backoff (ms) so a hostile Retry-After can't stall the Lambda. */
const RETRY_MAX_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function linearGraphqlFn(accessToken: string): GraphqlFn {
  return async (query, variables) => {
    // Bounded retry on 429 / 5xx. A single transient throttle previously aborted
    // the WHOLE write-back (N creates + edges) and dumped the user to manual
    // re-approve; honoring Retry-After (capped) and backing off keeps a burst
    // from breaking a multi-sub-issue plan. Non-retryable failures (4xx other
    // than 429, GraphQL errors, parse/timeout) still return null immediately.
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const resp = await fetch(LINEAR_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const retryable = resp.status === 429 || resp.status >= 500;
          if (retryable && attempt < MAX_RETRIES) {
            const retryAfter = Number(resp.headers.get('retry-after'));
            const backoff = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, RETRY_MAX_MS)
              : Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
            logger.warn('Mode B write-back throttled/transient — backing off', {
              status: resp.status, attempt: attempt + 1, backoff_ms: backoff,
            });
            clearTimeout(timer);
            await sleep(backoff);
            continue;
          }
          logger.warn('Mode B write-back GraphQL non-2xx', { status: resp.status, attempt: attempt + 1 });
          return null;
        }
        const body = (await resp.json()) as { data?: Record<string, unknown>; errors?: unknown };
        if (body.errors) {
          logger.warn('Mode B write-back GraphQL errors', { errors: body.errors });
          return null;
        }
        return body.data ?? null;
      } catch (err) {
        logger.warn('Mode B write-back request failed', {
          error: err instanceof Error ? err.message : String(err), attempt: attempt + 1,
        });
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
