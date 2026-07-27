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
 * Persistence for the orchestration DAG (issue #247, Mode A — PR A2).
 * Writes one row per sub-issue to ``OrchestrationTable`` (PK
 * ``orchestration_id``, SK ``sub_issue_id``) after the graph has been
 * fetched (``linear-subissue-fetch``) and validated
 * (``orchestration-dag``).
 *
 * Idempotency (AC: idempotent on webhook replay): the
 * ``orchestration_id`` is *derived deterministically* from the parent
 * Linear issue id (not random), and rows are written with a
 * ``attribute_not_exists`` condition on first write. A replay of the
 * same parent trigger therefore re-derives the same id and the
 * conditional writes no-op instead of duplicating children. The
 * reconciler (A3) owns child-status transitions; this module only seeds
 * the initial ``blocked`` / ``ready`` rows.
 */

import * as crypto from 'crypto';
import {
  type DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';
import { validateDag } from './orchestration-dag';
import { resolveEpicTip } from './orchestration-epic-tip';
import type { AttachmentRecord } from './types';

/** Orchestration-local lifecycle marker on each sub-issue row. */
export type ChildStatus =
  | 'ready' // no predecessors / all predecessors succeeded — releasable
  | 'blocked' // waiting on predecessors
  | 'releasing' // TRANSIENT (flip-then-create, review #3): claimed for release —
  // the winner is between the atomic blocked|ready→releasing claim and the
  // createTaskCore that follows. Never terminal; a crash mid-release leaves the
  // row here and the sweep/rollback recovers it back to ready.
  | 'released' // child task created
  | 'succeeded'
  | 'failed'
  | 'skipped'; // a predecessor failed; this child will never start

/** One persisted sub-issue row. */
export interface OrchestrationChildRow {
  readonly orchestration_id: string;
  readonly sub_issue_id: string;
  /** The epic this child belongs to, as the surface identifies it. */
  readonly parent_issue_ref: string;
  /** Opaque credentials handle for the surface (a workspace/tenant id that keys
   *  a token registry). The engine never interprets it. */
  readonly credentials_ref: string;
  readonly repo: string;
  readonly depends_on: readonly string[];
  readonly child_status: ChildStatus;
  /**
   * The ABCA ``task_id`` created for this child once released. Stamped by
   * ``releaseChild`` alongside the ``child_status → released`` flip;
   * absent until the child is released. The ``ChildTaskIndex`` GSI is
   * keyed on this so the reconciler resolves a terminal task back to its
   * orchestration row.
   */
  readonly child_task_id?: string;
  /**
   * The released child task's head branch (#247 A4). Persisted on the
   * release flip so a DEPENDENT child can stack on / merge it. Absent
   * until released.
   */
  readonly child_branch_name?: string;
  /** Human-facing id for display, when the surface has one (e.g. ``ENG-42``). */
  readonly display_id?: string;
  /** Sub-issue title, used to build the child task description. */
  readonly title?: string;
  /**
   * Sub-issue scope/description (PM-4). The Mode-B planner's rich per-piece
   * scope — persisted at seed so the coding agent's task_description carries
   * what the reviewer approved (e.g. a promised filename), not the title alone.
   * Absent on the Mode-A path (existing sub-issue graph fetched by title only).
   */
  readonly description?: string;
  /**
   * This sub-issue's OWN screened attachments (distinct from the parent epic's,
   * which ride on the meta row's release_context). A human-authored Mode-A
   * sub-issue can carry a file attached to IT specifically (a mockup for just
   * that piece); hydrated + stored at seed and merged with the inherited parent
   * records when the child is released. JSON-encoded `passed` AttachmentRecords;
   * absent when the sub-issue has no own attachments (the common case).
   */
  readonly pre_screened_attachments?: readonly AttachmentRecord[];
  /**
   * F9 (DE-stress 2026-07-24): a terminal failure reason recorded when the
   * child could NOT be turned into a task at all (a deterministic create
   * failure — guardrail/content-policy block, validation error) so it never
   * got a ``child_task_id``. The panel's failure-reason resolver falls back to
   * this string when there's no task to read an ``error_message`` from, so the
   * child's ❌ carries a "why + how to fix" line instead of a bare ❌. Absent
   * for the normal case (a released child's reason comes from its task record).
   */
  readonly failure_reason?: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** TTL epoch (seconds) for eventual cleanup. */
  readonly ttl?: number;
}

/**
 * Marshal one persisted item into a child row, reading the renamed attributes
 * through {@link readRenamed} so a row written before the rename still loads.
 *
 * This is deliberately EXPLICIT rather than a cast. The previous
 * ``item as unknown as OrchestrationChildRow`` made the compiler report success
 * while the underlying attribute names were whatever the writer happened to use —
 * so renaming a field on the interface would have silently yielded ``undefined``
 * for every existing row, with nothing in the type system or a new-shaped test
 * fixture to catch it.
 *
 * Attributes that were never renamed are passed through as-is.
 */
function toChildRow(item: Record<string, unknown>): OrchestrationChildRow {
  const parentIssueId = readRenamed(item, 'parent_issue_ref', 'parent_linear_issue_id') ?? '';
  const credentialsRef = readRenamed(item, 'credentials_ref', 'linear_workspace_id') ?? '';
  const displayId = readRenamed(item, 'display_id', 'linear_identifier');
  return {
    ...(item as unknown as OrchestrationChildRow),
    parent_issue_ref: parentIssueId,
    credentials_ref: credentialsRef,
    ...(displayId !== undefined && { display_id: displayId }),
  };
}

/**
 * Release context persisted on the parent-meta row so the reconciler can
 * release downstream children WITHOUT re-resolving auth (the webhook
 * already resolved the platform user + Linear OAuth at seed time). The
 * reconciler runs off the TaskTable stream and has no Linear webhook
 * payload to re-derive these from.
 */
export interface OrchestrationReleaseContext {
  /** Platform user the children are attributed to (parent's submitter). */
  readonly platform_user_id: string;
  /**
   * The trigger channel that seeded this orchestration. Threaded onto child
   * tasks (createTaskCore channelSource) and used by the reconciler to
   * dispatch the parent rollup to the right plane. Defaults to ``'linear'``
   * when absent (back-compat: orchestrations seeded before this field
   * existed, and the only wired trigger today). #247 trigger-agnostic seam:
   * a future GitHub/Slack/Jira trigger seeds with its own source and the
   * release + rollup paths follow it without code changes here.
   */
  readonly channel_source?: string;
  /** Linear OAuth secret ARN for the agent's outbound Linear GraphQL
   *  (reactions/state via linear_reactions.py — there is no Linear MCP). */
  readonly linear_oauth_secret_arn?: string;
  readonly linear_workspace_slug?: string;
  readonly linear_project_id?: string;
  /**
   * Parent-issue attachments, screened + stored ONCE at seed time, so every
   * child inherits them (finding #1 — the parent's attached spec must reach the
   * agents that write code, not just the blind planner). These are `passed`
   * AttachmentRecords (S3 keys, not bytes); each released child references the
   * same S3 objects read-only via createTaskCore's preScreenedAttachments seam.
   * The PARENT owns the objects' lifecycle — children never delete them.
   */
  readonly pre_screened_attachments?: readonly AttachmentRecord[];
}

export interface SeedOrchestrationParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly parentIssueRef: string;
  readonly credentialsRef: string;
  readonly repo: string;
  readonly children: readonly SubIssueNode[];
  /** ISO timestamp for created_at/updated_at (injected for testability). */
  readonly now: string;
  /** Optional TTL epoch seconds. */
  readonly ttl?: number;
  /** Release context stamped on the meta row for the reconciler. */
  readonly releaseContext: OrchestrationReleaseContext;
}

export interface SeedOrchestrationResult {
  readonly orchestrationId: string;
  readonly rowsWritten: number;
  /** True when an existing orchestration was found (replay) — no new rows. */
  readonly alreadyExisted: boolean;
}

/** Hex chars of the sha256 kept for the orchestration id (128 bits — ample to
 *  avoid accidental collisions between distinct parent refs). */
const ORCH_ID_HASH_HEX_LENGTH = 32;

/**
 * Deterministically derive the ``orchestration_id`` from the parent issue ref.
 * Same parent → same id, which is what makes webhook replay idempotent. Prefixed
 * + hashed so the id is opaque and fixed-length regardless of the ref format.
 *
 * NOT tenant-scoped: the ref alone is hashed, with no credentials/workspace
 * component. That is safe for the refs in use today (Linear issue ids are
 * workspace-unique UUIDs, so two tenants cannot produce the same one), but it is
 * a property of those refs rather than of this function — a surface keying on a
 * per-project ref like ``PROJ-42`` would have two tenants land on one id.
 *
 * Deliberately left as-is rather than mixing the tenant in: this id is a
 * persisted partition key, so changing the derivation would orphan every
 * in-flight epic's rows (the reconciler would re-derive a different id and find
 * nothing, stranding the epic silently — the exact failure mode this codebase
 * has been fixing). Instead the seed path REFUSES a collision it detects, so a
 * surface with non-unique refs fails loudly at onboarding rather than letting two
 * tenants share one graph. See {@link seedOrchestration}.
 */
export function deriveOrchestrationId(parentIssueRef: string): string {
  const hash = crypto.createHash('sha256').update(parentIssueRef).digest('hex').slice(0, ORCH_ID_HASH_HEX_LENGTH);
  return `orch_${hash}`;
}

/**
 * Read a persisted attribute that has been RENAMED, tolerating both spellings.
 *
 * Rows already in the table carry the old attribute name, and they outlive the
 * deploy that renames it — an epic mid-flight when the rename ships must still
 * settle. So every read prefers the new name and falls back to the legacy one,
 * and writes emit BOTH for a transition period (see ``dualWrite``) so a rollback
 * to the previous code also keeps working.
 *
 * Returns undefined when neither is present, so a caller can distinguish
 * "absent" from "empty string".
 */
function readRenamed(item: Record<string, unknown>, current: string, legacy: string): string | undefined {
  const value = item[current] ?? item[legacy];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Emit a renamed attribute under BOTH names on write. Costs a duplicated small
 * string per row and buys a reversible deploy: code running either spelling can
 * read a row written by the other. Drop the legacy half only once no deployed
 * code reads it and no in-flight rows predate the rename.
 */
function dualWrite<C extends string, L extends string>(
  current: C,
  legacy: L,
  value: string,
): Record<C | L, string> {
  return { [current]: value, [legacy]: value } as Record<C | L, string>;
}

/**
 * Parse the meta row's ``pre_screened_attachments_json`` back into records.
 * Best-effort: a malformed/absent value yields ``[]`` (children just run without
 * the parent attachments rather than the whole epic failing to release).
 */
function parsePreScreenedAttachments(raw: unknown, orchestrationId: string): AttachmentRecord[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AttachmentRecord[]) : [];
  } catch (err) {
    logger.warn('Orchestration meta pre_screened_attachments_json unparseable — releasing children without them', {
      orchestration_id: orchestrationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** DynamoDB BatchWriteItem hard limit: at most 25 put/delete requests per call. */
const DDB_BATCH_WRITE_MAX_ITEMS = 25;

/** Marker SK for the parent-meta row (sorts before any UUID sub_issue_id). */
const PARENT_META_SK = '#meta';

/**
 * An existing orchestration's id is held by a DIFFERENT parent issue or tenant.
 *
 * Its own class so the caller can tell it from a transient persistence failure:
 * a write that failed is worth retrying, whereas a collision will recur on every
 * attempt and needs the ref scheme changed, so telling the user to re-trigger
 * would send them round a loop that cannot succeed.
 */
export class OrchestrationIdCollisionError extends Error {
  constructor(public readonly orchestrationId: string) {
    super(`Orchestration id ${orchestrationId} is already held by a different parent issue or tenant`);
    this.name = 'OrchestrationIdCollisionError';
  }
}

/**
 * Who an existing orchestration belongs to, read from its meta row under either
 * the neutral or the legacy attribute names. Used to tell a genuine replay from
 * an id collision.
 *
 * A row missing these (written by code that predates them) reads as undefined,
 * which deliberately does NOT trip the collision check — refusing to reconcile a
 * legacy in-flight epic would be a worse failure than the collision this guards
 * against, which cannot occur for the refs in use today.
 */
function toMetaOwner(item: Record<string, unknown>): {
  parentIssueRef: string | undefined;
  credentialsRef: string | undefined;
} {
  return {
    parentIssueRef: readRenamed(item, 'parent_issue_ref', 'parent_linear_issue_id'),
    credentialsRef: readRenamed(item, 'credentials_ref', 'linear_workspace_id'),
  };
}

/**
 * Seed ``OrchestrationTable`` with one row per sub-issue plus a parent
 * meta row. Idempotent: if the parent meta row already exists (replay),
 * returns ``alreadyExisted: true`` and writes nothing.
 *
 * Initial ``child_status``: ``ready`` when ``depends_on`` is empty
 * (a root — the reconciler releases these immediately), else
 * ``blocked``.
 *
 * Refuses to adopt an existing orchestration that belongs to a DIFFERENT tenant
 * (see {@link deriveOrchestrationId} for why the id itself isn't tenant-scoped).
 */
export async function seedOrchestration(
  params: SeedOrchestrationParams,
): Promise<SeedOrchestrationResult> {
  const { ddb, tableName, parentIssueRef, credentialsRef, repo, children, now, ttl, releaseContext } = params;
  const orchestrationId = deriveOrchestrationId(parentIssueRef);

  // Idempotency gate: a prior run for this parent already seeded rows.
  const existing = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
  }));
  if (existing.Item) {
    // The id is derived from the parent ref alone, so two tenants whose refs
    // collide would derive the SAME id — and this replay gate would hand the
    // second one the first one's graph: their epic would show the other tenant's
    // children, and releases would run against the other tenant's repo under the
    // other tenant's credentials. Cannot happen with the workspace-unique UUIDs
    // in use today, but it must not degrade quietly if a surface with per-project
    // refs is onboarded, so compare the identity the meta row already records.
    const owner = toMetaOwner(existing.Item);
    // Only a row that RECORDS a conflicting owner is a collision. An absent value
    // (a row written before these attributes existed) is unknown, not different —
    // treating it as a collision would refuse to reconcile a legacy in-flight
    // epic, a worse and far likelier failure than the one being guarded against.
    const collides = (owner.credentialsRef !== undefined && owner.credentialsRef !== credentialsRef)
      || (owner.parentIssueRef !== undefined && owner.parentIssueRef !== parentIssueRef);
    if (collides) {
      logger.error('Orchestration id collision across tenants — refusing to seed', {
        orchestration_id: orchestrationId,
        parent_issue_ref: parentIssueRef,
        existing_parent_issue_ref: owner.parentIssueRef,
        // Ids, never credentials themselves.
        credentials_ref: credentialsRef,
        existing_credentials_ref: owner.credentialsRef,
      });
      throw new OrchestrationIdCollisionError(orchestrationId);
    }
    logger.info('Orchestration already seeded — skipping (idempotent replay)', {
      orchestration_id: orchestrationId,
      parent_issue_ref: parentIssueRef,
    });
    return { orchestrationId, rowsWritten: 0, alreadyExisted: true };
  }

  const childRows: OrchestrationChildRow[] = children.map((c) => ({
    orchestration_id: orchestrationId,
    sub_issue_id: c.id,
    // Renamed attributes are written under both spellings — see dualWrite.
    ...dualWrite('parent_issue_ref', 'parent_linear_issue_id', parentIssueRef),
    ...dualWrite('credentials_ref', 'linear_workspace_id', credentialsRef),
    repo,
    depends_on: c.depends_on,
    child_status: c.depends_on.length === 0 ? 'ready' : 'blocked',
    ...(c.identifier !== undefined && dualWrite('display_id', 'linear_identifier', c.identifier)),
    ...(c.title !== undefined && { title: c.title }),
    ...(c.description !== undefined && c.description !== '' && { description: c.description }),
    created_at: now,
    updated_at: now,
    ...(ttl !== undefined && { ttl }),
  }));

  const metaRow = {
    orchestration_id: orchestrationId,
    sub_issue_id: PARENT_META_SK,
    ...dualWrite('parent_issue_ref', 'parent_linear_issue_id', parentIssueRef),
    ...dualWrite('credentials_ref', 'linear_workspace_id', credentialsRef),
    repo,
    child_count: children.length,
    // Release context for the reconciler (downstream releases run off the
    // TaskTable stream with no Linear webhook payload to re-derive these).
    platform_user_id: releaseContext.platform_user_id,
    ...(releaseContext.channel_source !== undefined && {
      channel_source: releaseContext.channel_source,
    }),
    ...(releaseContext.linear_oauth_secret_arn !== undefined && {
      linear_oauth_secret_arn: releaseContext.linear_oauth_secret_arn,
    }),
    ...(releaseContext.linear_workspace_slug !== undefined && {
      linear_workspace_slug: releaseContext.linear_workspace_slug,
    }),
    ...(releaseContext.linear_project_id !== undefined && {
      linear_project_id: releaseContext.linear_project_id,
    }),
    // Parent attachments (finding #1) — stored as a JSON string so the nested
    // AttachmentRecord[] round-trips cleanly through the Document client without
    // per-field marshalling. Omitted when the parent had none.
    ...(releaseContext.pre_screened_attachments && releaseContext.pre_screened_attachments.length > 0 && {
      pre_screened_attachments_json: JSON.stringify(releaseContext.pre_screened_attachments),
    }),
    created_at: now,
    updated_at: now,
    ...(ttl !== undefined && { ttl }),
  };

  // BatchWrite in chunks of 25 (DDB limit). The meta row goes last so a
  // partial failure can't leave a meta row claiming a fully-seeded
  // orchestration when child rows are missing — a replay re-derives the
  // same id, sees no meta row, and re-seeds.
  const allRows: Array<Record<string, unknown>> = [
    ...childRows.map((r) => ({ ...r })),
    { ...metaRow },
  ];
  let rowsWritten = 0;
  for (let i = 0; i < allRows.length; i += DDB_BATCH_WRITE_MAX_ITEMS) {
    const chunk = allRows.slice(i, i + DDB_BATCH_WRITE_MAX_ITEMS);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })),
      },
    }));
    rowsWritten += chunk.length;
  }

  logger.info('Orchestration seeded', {
    orchestration_id: orchestrationId,
    parent_issue_ref: parentIssueRef,
    child_count: children.length,
    rows_written: rowsWritten,
  });

  return { orchestrationId, rowsWritten, alreadyExisted: false };
}

/** Result of extending an already-seeded orchestration (#247 orchestration-extend). */
export interface ExtendOrchestrationResult {
  readonly orchestrationId: string;
  /** Sub-issue ids newly ADDED to the DAG by this extend (empty if nothing new). */
  readonly addedSubIssueIds: readonly string[];
  /**
   * Subset of ``addedSubIssueIds`` that are immediately releasable — their
   * predecessors are all already ``succeeded`` (or they're new roots). The
   * caller releases these now; the rest are ``blocked`` and the reconciler
   * releases them as predecessors finish, exactly like seed-time children.
   */
  readonly releasableSubIssueIds: readonly string[];
  /** Why an extend was rejected (cycle introduced by the new edges), if any. */
  readonly rejected?: { readonly reason: string; readonly message: string };
}

/**
 * Extend an ALREADY-SEEDED orchestration with sub-issues added to the Linear
 * epic after the first seed (#247 orchestration-extend). The seed path is
 * idempotent (frozen at first seed) so a graph can't grow on its own; this is
 * the additive counterpart, invoked when a labeled parent that already has an
 * orchestration is re-triggered.
 *
 * Diffs the freshly-fetched ``graph`` against the persisted children:
 *  - existing nodes are LEFT UNTOUCHED (their status/branch/task are preserved
 *    — we never re-seed or reset a node that already ran),
 *  - genuinely-new nodes are validated (the augmented graph must stay acyclic),
 *    then added as ``ready`` (deps all already succeeded, or no deps) or
 *    ``blocked``,
 *  - the meta ``child_count`` is bumped.
 *
 * Idempotent: re-running with no new nodes is a no-op (empty result). A cycle
 * introduced by the new edges rejects WITHOUT writing anything.
 *
 * @param graph the full current sub-issue node set (post-#16 augmentation),
 *   from the same source the seed used.
 */
export async function extendOrchestration(params: {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly parentIssueRef: string;
  readonly credentialsRef: string;
  readonly repo: string;
  readonly graph: readonly SubIssueNode[];
  readonly now: string;
  readonly ttl?: number;
}): Promise<ExtendOrchestrationResult> {
  const { ddb, tableName, parentIssueRef, credentialsRef, repo, graph, now, ttl } = params;
  const orchestrationId = deriveOrchestrationId(parentIssueRef);

  const snapshot = await loadOrchestration(ddb, tableName, orchestrationId);
  if (!snapshot) {
    // No existing orchestration — caller should have seeded, not extended.
    return { orchestrationId, addedSubIssueIds: [], releasableSubIssueIds: [] };
  }

  const existingIds = new Set(snapshot.children.map((c) => c.sub_issue_id));
  const newNodes = graph.filter((n) => !existingIds.has(n.id));
  if (newNodes.length === 0) {
    return { orchestrationId, addedSubIssueIds: [], releasableSubIssueIds: [] };
  }

  // Validate the AUGMENTED graph (existing + new) — adding nodes/edges must not
  // introduce a cycle or a dangling edge. Reject without writing if it does.
  const validation = validateDag(graph.map((n) => ({ id: n.id, depends_on: n.depends_on })));
  if (!validation.ok) {
    logger.warn('Orchestration extend rejected — augmented graph invalid', {
      orchestration_id: orchestrationId, reason: validation.reason,
    });
    return {
      orchestrationId,
      addedSubIssueIds: [],
      releasableSubIssueIds: [],
      rejected: { reason: validation.reason, message: validation.message },
    };
  }

  // #247 UX.4: a new node with NO declared dependency must NOT branch off bare
  // main — it inherits the epic's accumulated unmerged work by stacking on the
  // epic TIP (the existing leaf frontier). We inject that as a synthetic
  // ``depends_on`` so the existing A4 gating + base-branch stacking treat it
  // like any other dependent; "fall back to main only when merged" is handled
  // downstream by the agent's base-fetch fallback. Nodes that DECLARED a
  // dependency keep their explicit edges (user intent wins over the tip).
  const epicTip = resolveEpicTip(snapshot.children);
  const withImplicitDeps = newNodes.map((n) => ({
    node: n,
    // Only unconstrained new nodes inherit the tip; and never self-depend
    // (the tip is computed from EXISTING nodes, so a new id can't appear).
    depends_on: n.depends_on.length > 0 ? n.depends_on : epicTip,
  }));

  // A node is immediately releasable iff every predecessor is already
  // ``succeeded`` (or it has none). Predecessors may be existing (check their
  // persisted status) or other new nodes (not succeeded yet → blocked).
  const succeeded = new Set(
    snapshot.children.filter((c) => c.child_status === 'succeeded').map((c) => c.sub_issue_id),
  );
  const releasable = new Set<string>();
  const newRows: OrchestrationChildRow[] = withImplicitDeps.map(({ node: n, depends_on }) => {
    const allDepsSucceeded = depends_on.every((d) => succeeded.has(d));
    if (allDepsSucceeded) releasable.add(n.id);
    return {
      orchestration_id: orchestrationId,
      sub_issue_id: n.id,
      ...dualWrite('parent_issue_ref', 'parent_linear_issue_id', parentIssueRef),
      ...dualWrite('credentials_ref', 'linear_workspace_id', credentialsRef),
      repo,
      depends_on,
      child_status: allDepsSucceeded ? 'ready' : 'blocked',
      ...(n.identifier !== undefined && dualWrite('display_id', 'linear_identifier', n.identifier)),
      ...(n.title !== undefined && { title: n.title }),
      ...(n.description !== undefined && n.description !== '' && { description: n.description }),
      created_at: now,
      updated_at: now,
      ...(ttl !== undefined && { ttl }),
    };
  });

  // Persist new child rows (chunks of 25), then bump meta child_count.
  for (let i = 0; i < newRows.length; i += DDB_BATCH_WRITE_MAX_ITEMS) {
    const chunk = newRows.slice(i, i + DDB_BATCH_WRITE_MAX_ITEMS);
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })) },
    }));
  }
  // Bump child_count AND clear rollup_posted_at: if this epic had ALREADY
  // reached all-terminal and posted its rollup, adding a node re-opens it.
  // Clearing the claim lets the reconciler re-settle the parent state to
  // complete (re-claim) once the new node finishes — without this, a
  // post-completion addition would leave the epic stuck "in progress" forever
  // (#247 UX.4 concurrency: mid-flight additions to a finished epic).
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
    UpdateExpression: 'SET child_count = :n, updated_at = :now REMOVE rollup_posted_at',
    ExpressionAttributeValues: { ':n': snapshot.children.length + newRows.length, ':now': now },
  }));

  logger.info('Orchestration extended', {
    orchestration_id: orchestrationId,
    parent_issue_ref: parentIssueRef,
    added: newRows.length,
    releasable: releasable.size,
    added_ids: newRows.map((r) => r.sub_issue_id),
  });

  return {
    orchestrationId,
    addedSubIssueIds: newRows.map((r) => r.sub_issue_id),
    releasableSubIssueIds: [...releasable],
  };
}

/**
 * Claim the right to post the parent rollup comment exactly once (#247
 * A5). The orchestration can reach "all children terminal" on more than
 * one TaskTable-stream event (the last child's record often gets two
 * MODIFYs — e.g. status→COMPLETED then pr_url/build_passed written — both
 * observing all-terminal), which without a guard posts the rollup twice.
 *
 * Conditionally stamps ``rollup_posted_at`` on the parent-meta row. The
 * first caller wins (returns true → post the comment); a racing/repeat
 * caller loses the conditional write (returns false → skip). Mirrors the
 * release-flip idempotency pattern.
 */
export async function claimRollup(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  now: string,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
      UpdateExpression: 'SET rollup_posted_at = :now',
      ConditionExpression: 'attribute_not_exists(rollup_posted_at)',
      ExpressionAttributeValues: { ':now': now },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Release the once-only rollup claim so a RE-COMPLETING epic can re-settle its
 * parent state (#247 — stress-caught). When an already-completed epic re-opens
 * (a cascade/iteration revives it), the ``rollup_posted_at`` stamp from the
 * FIRST completion would otherwise make {@link claimRollup} fail forever — so
 * the panel body re-settles to ✅ but the parent reaction/state never re-mirror
 * (stuck on 👀/In Progress). ``extendOrchestration`` already clears it on the
 * extend path; the cascade re-open path must too. Best-effort; unconditional
 * REMOVE (idempotent — a no-op when already absent).
 */
export async function clearRollupClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  now: string,
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
    UpdateExpression: 'SET updated_at = :now REMOVE rollup_posted_at',
    ExpressionAttributeValues: { ':now': now },
  }));
}

/**
 * Persist a sub-issue's OWN screened attachments on its child row (finding: a
 * Mode-A human-authored sub-issue can carry a file attached to IT, distinct from
 * the parent epic's). Written as a native list (createTaskCore's records are
 * plain JSON objects; DynamoDB stores nested lists/maps directly, so
 * ``loadOrchestration``'s row cast reads them back as ``AttachmentRecord[]`` with
 * no bespoke parse). Conditional on the child row existing so a racing TTL reap
 * can't resurrect it. Best-effort at the call site — a child's own attachment is
 * enrichment on top of the load-bearing inherited parent spec.
 */
export async function setChildOwnAttachments(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  subIssueId: string,
  records: readonly AttachmentRecord[],
  now: string,
): Promise<void> {
  if (records.length === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: subIssueId },
    UpdateExpression: 'SET pre_screened_attachments = :recs, updated_at = :now',
    ConditionExpression: 'attribute_exists(sub_issue_id)',
    ExpressionAttributeValues: { ':recs': records, ':now': now },
  }));
}

/**
 * Claim the one-time "I responded to this comment" marker so a webhook
 * REDELIVERY doesn't re-post (#247 UX.20 — live-caught spam). Linear redelivers
 * a comment webhook when the handler exceeds its ~5s ack window; without a
 * claim, the parent-epic disambiguation reply re-posted on every redelivery
 * (50+ duplicates). Keyed on the orchestration + the triggering comment id, so
 * the FIRST delivery wins and every redelivery is a no-op. The marker carries a
 * TTL (the table's ``ttl`` attribute) so these rows self-expire — they're only
 * needed for the redelivery window. Returns true only for the first caller.
 *
 * @param ttlEpochSeconds absolute epoch-seconds expiry for the marker row.
 */
export async function claimCommentAck(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  commentId: string,
  now: string,
  ttlEpochSeconds: number,
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { orchestration_id: orchestrationId, sub_issue_id: `ack#${commentId}` },
      // attribute_not_exists on the PK is the standard "create-once" guard —
      // a replay finds the row present and the condition fails. ``ttl`` is a
      // DynamoDB reserved keyword → must be aliased via ExpressionAttributeNames.
      UpdateExpression: 'SET acked_at = :now, #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(orchestration_id)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': now, ':ttl': ttlEpochSeconds },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Sort-key of the parent-meta row. Exported so the reconciler can
 *  separate it from child rows after a Query. */
export const ORCHESTRATION_META_SK = PARENT_META_SK;

/** Parsed parent-meta row, including the reconciler's release context. */
export interface OrchestrationMeta {
  readonly orchestration_id: string;
  readonly parent_issue_ref: string;
  readonly credentials_ref: string;
  readonly repo: string;
  readonly child_count: number;
  readonly release_context: OrchestrationReleaseContext;
  /**
   * Linear comment id of the live status block (#247 #3), stamped at seed.
   * The reconciler edits this comment in place on each child transition and
   * one last time with the final rollup. Absent if the seed-time create
   * failed (best-effort) — the reconciler then falls back to a fresh
   * comment for the final rollup.
   */
  readonly status_comment_id?: string;
  /**
   * The ``@bgagent retry`` comment that re-ran this epic, if one did.
   *
   * Recorded so the epic's next settle can move that comment's marker off the
   * receipt 👀 to the actual outcome. The retry path acks the comment and then
   * hands off to the reconciler, which is driven by task events and so has no
   * other way to learn which comment asked for the run — which left the one view
   * the user is watching stuck on "looking at it" indefinitely (observed live
   * 2026-07-26). Cleared once settled, so a later settle can't re-swap a marker on
   * an old comment.
   */
  readonly retry_comment_id?: string;
}

/**
 * Stamp the live status-block comment id on the parent-meta row (#247 #3).
 * Called once at seed after the comment is created. Best-effort; a failure
 * just means the reconciler can't edit-in-place and posts a fresh final
 * rollup instead. Not conditional — the single seed path is the only writer.
 */
export async function setStatusCommentId(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  commentId: string,
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
    UpdateExpression: 'SET status_comment_id = :cid',
    ExpressionAttributeValues: { ':cid': commentId },
  }));
}

/**
 * Record (or clear) the ``@bgagent retry`` comment awaiting an outcome marker.
 *
 * Pass a comment id when a retry starts; pass undefined once its marker has been
 * settled, so the next settle of the same epic doesn't re-swap a stale comment.
 * Best-effort like the panel-id write: failing to record it costs a marker
 * update, never the retry itself.
 */
export async function setRetryCommentId(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
  commentId: string | undefined,
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
    ...(commentId === undefined
      ? { UpdateExpression: 'REMOVE retry_comment_id' }
      : {
        UpdateExpression: 'SET retry_comment_id = :cid',
        ExpressionAttributeValues: { ':cid': commentId },
      }),
  }));
}

/** All rows for one orchestration: the meta row + every child row. */
export interface OrchestrationSnapshot {
  readonly meta: OrchestrationMeta;
  readonly children: readonly OrchestrationChildRow[];
}

/**
 * Load every row for an orchestration (meta + children). Returns null when the
 * orchestration id has no rows (e.g. TTL-reaped). The reconciler calls this after
 * resolving a terminal child's orchestration via the ChildTaskIndex GSI.
 *
 * Paginates: a DynamoDB Query returns at most one 1MB page, so a large epic
 * (many children + accumulated ``ack#`` marker rows) would otherwise silently
 * truncate — dropping children from the completion check / panel and stranding
 * the epic. Follows ``LastEvaluatedKey`` to read all rows (mirrors
 * ``findOrchestrationIds``'s Scan pagination).
 */
export async function loadOrchestration(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  orchestrationId: string,
): Promise<OrchestrationSnapshot | null> {
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res: import('@aws-sdk/lib-dynamodb').QueryCommandOutput = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'orchestration_id = :oid',
      ExpressionAttributeValues: { ':oid': orchestrationId },
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    }));
    items.push(...((res.Items ?? []) as Array<Record<string, unknown>>));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  if (items.length === 0) return null;

  const metaItem = items.find((i) => i.sub_issue_id === PARENT_META_SK);
  if (!metaItem) {
    // A non-epic issue accumulates dedup MARKER rows (``ack#…``) under the same
    // derived id without ever being seeded, so "rows but no meta" is the normal
    // shape there, not a broken orchestration — a plain `@bgagent` on any
    // never-decomposed issue reaches this. Only warn when a REAL child row is
    // present, which is the genuinely inconsistent case; otherwise this cried wolf
    // on a healthy path and taught readers to ignore the log.
    const hasRealChild = items.some((i) => !String(i.sub_issue_id).includes('#'));
    const detail = { orchestration_id: orchestrationId, row_count: items.length };
    if (hasRealChild) logger.warn('Orchestration child rows present but the meta row is missing', detail);
    else logger.info('No orchestration for this issue — only dedup markers exist', detail);
    return null;
  }

  const children = items
    // Exclude the meta row AND non-child marker rows (e.g. ``ack#<commentId>``
    // dedup markers) — only real sub-issue rows are children. A real child SK is
    // an issue id or the ``…__integration`` synthetic id; markers use a
    // ``<kind>#`` prefix that no real SK has.
    .filter((i) => i.sub_issue_id !== PARENT_META_SK && !String(i.sub_issue_id).includes('#'))
    .map(toChildRow);

  const preScreened = parsePreScreenedAttachments(metaItem.pre_screened_attachments_json, orchestrationId);

  const meta: OrchestrationMeta = {
    orchestration_id: orchestrationId,
    // Renamed attributes — read either spelling so a pre-rename epic still settles.
    parent_issue_ref: readRenamed(metaItem, 'parent_issue_ref', 'parent_linear_issue_id') ?? '',
    credentials_ref: readRenamed(metaItem, 'credentials_ref', 'linear_workspace_id') ?? '',
    repo: metaItem.repo as string,
    child_count: (metaItem.child_count as number) ?? children.length,
    release_context: {
      platform_user_id: metaItem.platform_user_id as string,
      ...(metaItem.channel_source !== undefined && {
        channel_source: metaItem.channel_source as string,
      }),
      ...(metaItem.linear_oauth_secret_arn !== undefined && {
        linear_oauth_secret_arn: metaItem.linear_oauth_secret_arn as string,
      }),
      ...(metaItem.linear_workspace_slug !== undefined && {
        linear_workspace_slug: metaItem.linear_workspace_slug as string,
      }),
      ...(metaItem.linear_project_id !== undefined && {
        linear_project_id: metaItem.linear_project_id as string,
      }),
      ...(preScreened.length > 0 && { pre_screened_attachments: preScreened }),
    },
    ...(metaItem.retry_comment_id !== undefined && {
      retry_comment_id: metaItem.retry_comment_id as string,
    }),
    ...(metaItem.status_comment_id !== undefined && {
      status_comment_id: metaItem.status_comment_id as string,
    }),
  };

  return { meta, children };
}

/**
 * Resolve a released child by its head branch, via the ChildBranchIndex GSI.
 * Maps a branch name back to the child row (which carries
 * ``orchestration_id`` + ``sub_issue_id``).
 *
 * RETAINED, currently unused. This backed the original A6 GitHub
 * ``pull_request`` restack trigger, which the #247 A6 redesign replaced with
 * a Linear-comment trigger + reconciler-driven cascade (the cascade resolves
 * the changed node by sub_issue_id, not by branch). The helper + its GSI are
 * deliberately kept rather than removed: dropping a GSL is a
 * CFN-update-unfriendly stack change for zero functional gain, and a
 * branch→child lookup is a plausible future need (e.g. a branch-delete
 * cleanup path). If it stays unused long-term, remove the helper and the GSI
 * together in a dedicated migration.
 *
 * Returns the child row, or null if no released child owns that branch. The
 * GSI is sparse — only released children carry ``child_branch_name`` — so a
 * miss is the common, cheap case. ``indexName`` is injected (the CDK construct
 * owns the literal) to keep this module free of a CDK dependency.
 */
export async function findOrchestrationChildByBranch(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  indexName: string,
  branchName: string,
): Promise<OrchestrationChildRow | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: 'child_branch_name = :b',
    ExpressionAttributeValues: { ':b': branchName },
    Limit: 1,
  }));
  const item = res.Items?.[0];
  // Marshalled, not cast: a raw cast would type-check while leaving the renamed
  // attributes unread, so a row written under either naming would come back with
  // empty parent/credentials refs.
  return item ? toChildRow(item) : null;
}
