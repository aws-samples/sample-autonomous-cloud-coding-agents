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

import * as crypto from 'crypto';
import {
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';
import { validateDag } from './orchestration-dag';
import { resolveEpicTip } from './orchestration-epic-tip';
import { computeLeaves, isIntegrationNode } from './orchestration-integration-node';
import type { AttachmentRecord } from './types';

/**
 * Orchestration-local lifecycle marker on each sub-issue row.
 * - ``ready``: no predecessors / all predecessors succeeded — releasable.
 * - ``blocked``: waiting on predecessors.
 * - ``releasing``: TRANSIENT, claimed for release, between the atomic
 *   blocked|ready→releasing claim and the task creation. Never terminal.
 * - ``released``: child task created.
 * - ``skipped``: a predecessor failed; this child will never start.
 */
export type ChildStatus =
  | 'ready'
  | 'blocked'
  | 'releasing'
  | 'released'
  | 'succeeded'
  | 'failed'
  | 'skipped';

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
   * The released child task's head branch. Persisted on the
   * release flip so a DEPENDENT child can stack on / merge it. Absent
   * until released.
   */
  readonly child_branch_name?: string;
  /** Human-facing id for display, when the surface has one (e.g. ``ENG-42``). */
  readonly display_id?: string;
  /** Sub-issue title, used to build the child task description. */
  readonly title?: string;
  /**
   * Opaque, adapter-owned values copied onto the released task's
   * ``channel_metadata``. The orchestration engine persists these without
   * interpreting them; release-owned keys overwrite collisions.
   */
  readonly channel_metadata?: Readonly<Record<string, string>>;
  /**
   * Sub-issue scope/description, when the graph source supplied one. Persisted at
   * seed so the coding agent's task_description carries the per-piece scope (e.g.
   * a promised filename), not the title alone. Absent when the graph was read
   * from sub-issues a human already wrote, since that path fetches titles only.
   */
  readonly description?: string;
  /**
   * This sub-issue's OWN screened attachments (distinct from the parent epic's,
   * which ride on the meta row's release_context). Hydrated + stored at seed
   * and merged with the inherited parent records when the child is released.
   * `passed` AttachmentRecords; absent when the sub-issue has no own attachments.
   */
  readonly pre_screened_attachments?: readonly AttachmentRecord[];
  /**
   * Why the last attempt to start this child was refused (a deterministic create
   * failure — guardrail/content-policy block, validation error, budget, repo not
   * onboarded). No task exists for that attempt, so the panel shows this string
   * on the child's ❌, a "why + how to fix" line instead of a bare ❌. The row can
   * still carry the ``child_task_id`` of an EARLIER run (a retry keeps it). The
   * release that starts a task removes the reason, so it is absent for the
   * normal case (a released child's reason comes from its task record).
   */
  readonly failure_reason?: string;
  /**
   * The task whose failed verdict the reconciler could not put on the child's
   * issue: its try to move the issue back and to replace its reaction did not
   * land. The next record of that task tries again, also when it is written
   * long after the task ended. Step 1b of ``reconcileTerminalChild`` says when
   * a try counts as landed and when the mark is removed. Keyed by the task, so
   * a mark that an earlier run of the child left means nothing for its next
   * task, and a release does not remove it.
   */
  readonly unsettled_task_id?: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** TTL epoch (seconds) for eventual cleanup. */
  readonly ttl?: number;
}

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
 * release downstream children WITHOUT re-resolving auth.
 */
export interface OrchestrationReleaseContext {
  /** Platform user the children are attributed to (parent's submitter). */
  readonly platform_user_id: string;
  /**
   * The trigger channel that seeded this orchestration. Threaded onto child
   * tasks (createTaskCore channelSource) and used by the reconciler to
   * dispatch the parent rollup to the right plane. Defaults to ``'linear'``
   * when absent.
   */
  readonly channel_source?: string;
  /** Linear OAuth secret ARN for the agent's outbound Linear GraphQL
   *  (reactions/state via linear_reactions.py — there is no Linear MCP). */
  readonly linear_oauth_secret_arn?: string;
  readonly linear_workspace_slug?: string;
  /** AgentCore credential-provider name for vault-onboarded workspaces (RFC #249
   *  Phase 1), so sub-issue children can mint their own Linear token via the
   *  vault. Workspace id rides the existing credentials_ref stamp on release.
   *  Absent ⇒ Secrets-Manager path. */
  readonly linear_provider_name?: string;
  readonly linear_vault_user_id?: string;
  readonly linear_project_id?: string;
  /** Jira parent workflow destination overrides captured from the project map. */
  readonly jira_status_on_start?: string;
  readonly jira_status_on_pr?: string;
  /**
   * The project's resolved trigger label (the project mapping's ``label_filter``),
   * persisted at SEED time. Used for the epic panel's retry hint.
   * Absent on rows seeded before this field existed → the panel falls back to the
   * platform default.
   */
  readonly trigger_label?: string;
  /**
   * The parent epic's own title and body, captured at seed time and given to
   * EVERY child as shared context. Absent on rows seeded before this field
   * existed.
   */
  readonly parent_context?: {
    readonly title?: string;
    readonly description?: string;
  };
  /**
   * Parent-issue attachments, screened + stored ONCE at seed time, so every
   * child inherits them. These are `passed`
   * AttachmentRecords (S3 keys, not bytes); each released child references the
   * same S3 objects read-only via createTaskCore's preScreenedAttachments seam.
   * The PARENT owns the objects' lifecycle — children never delete them.
   */
  readonly pre_screened_attachments?: readonly AttachmentRecord[];
}

const PARENT_CONTEXT_MAX_CHARS = 4000;

/** What ends a parent-context text that was cut, at seed or at release. */
export const PARENT_CONTEXT_TRUNCATED = '\n… [truncated]';

function clampParentContext(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PARENT_CONTEXT_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PARENT_CONTEXT_MAX_CHARS)}${PARENT_CONTEXT_TRUNCATED}`;
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

const ORCH_ID_HASH_HEX_LENGTH = 32;

/**
 * Deterministically derive the ``orchestration_id`` from the parent issue ref.
 * Same parent → same id, which is what makes webhook replay idempotent. Prefixed
 * + hashed so the id is opaque and fixed-length regardless of the ref format.
 *
 * NOT tenant-scoped: the ref alone is hashed, with no credentials/workspace
 * component. The seed path REFUSES a collision it detects. See
 * {@link seedOrchestration}.
 */
export function deriveOrchestrationId(parentIssueRef: string): string {
  const hash = crypto.createHash('sha256').update(parentIssueRef).digest('hex').slice(0, ORCH_ID_HASH_HEX_LENGTH);
  return `orch_${hash}`;
}

function readRenamed(item: Record<string, unknown>, current: string, legacy: string): string | undefined {
  const value = item[current] ?? item[legacy];
  return value === undefined || value === null ? undefined : String(value);
}

function dualWrite<C extends string, L extends string>(
  current: C,
  legacy: L,
  value: string,
): Record<C | L, string> {
  return { [current]: value, [legacy]: value } as Record<C | L, string>;
}

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
    return []; // nosemgrep: ts-silent-success-masking -- a corrupt stored JSON blob is PERMANENT, not transient: failing closed here would make every later read of this epic throw, so an epic mid-flight could never settle and no retry could ever clear it. The attachments are advisory context for the children; the warning above is the operator's signal
  }
}

const DDB_BATCH_WRITE_MAX_ITEMS = 25;

const BATCH_WRITE_ATTEMPTS = 5;

const BATCH_WRITE_BACKOFF_MS = 100;

/**
 * DynamoDB answers a throttled BatchWriteItem with 200 and the puts that were
 * not made, in ``UnprocessedItems``; nothing sends them again. Within ONE
 * request it can store any of its rows and hand the others back.
 */
async function putRows(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += DDB_BATCH_WRITE_MAX_ITEMS) {
    let pending: NonNullable<BatchWriteCommandInput['RequestItems']>[string] = rows
      .slice(i, i + DDB_BATCH_WRITE_MAX_ITEMS)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 1; pending.length > 0; attempt += 1) {
      if (attempt > BATCH_WRITE_ATTEMPTS) {
        throw new Error(
          `${pending.length} orchestration row(s) were not written: `
          + `DynamoDB left them unprocessed ${BATCH_WRITE_ATTEMPTS} times`,
        );
      }
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_WRITE_BACKOFF_MS * 2 ** (attempt - 2)));
      }
      const result = await ddb.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
      pending = result.UnprocessedItems?.[tableName] ?? [];
    }
  }
}

const PARENT_META_SK = '#meta';

/**
 * An existing orchestration's id is held by a DIFFERENT parent issue or tenant.
 * Not a transient persistence failure: a collision will recur on every attempt.
 */
export class OrchestrationIdCollisionError extends Error {
  constructor(public readonly orchestrationId: string) {
    super(`Orchestration id ${orchestrationId} is already held by a different parent issue or tenant`);
    this.name = 'OrchestrationIdCollisionError';
  }
}

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
 * Refuses to adopt an existing orchestration that belongs to a DIFFERENT tenant:
 * throws {@link OrchestrationIdCollisionError}.
 */
export async function seedOrchestration(
  params: SeedOrchestrationParams,
): Promise<SeedOrchestrationResult> {
  const { ddb, tableName, parentIssueRef, credentialsRef, repo, children, now, ttl, releaseContext } = params;
  const orchestrationId = deriveOrchestrationId(parentIssueRef);

  const existing = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: PARENT_META_SK },
  }));
  if (existing.Item) {
    const owner = toMetaOwner(existing.Item);
    const collides = (owner.credentialsRef !== undefined && owner.credentialsRef !== credentialsRef)
      || (owner.parentIssueRef !== undefined && owner.parentIssueRef !== parentIssueRef);
    if (collides) {
      logger.error('Orchestration id collision across tenants — refusing to seed', {
        orchestration_id: orchestrationId,
        parent_issue_ref: parentIssueRef,
        existing_parent_issue_ref: owner.parentIssueRef,
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
    ...dualWrite('parent_issue_ref', 'parent_linear_issue_id', parentIssueRef),
    ...dualWrite('credentials_ref', 'linear_workspace_id', credentialsRef),
    repo,
    depends_on: c.depends_on,
    child_status: c.depends_on.length === 0 ? 'ready' : 'blocked',
    ...(c.identifier !== undefined && dualWrite('display_id', 'linear_identifier', c.identifier)),
    ...(c.title !== undefined && { title: c.title }),
    ...(c.description !== undefined && c.description !== '' && { description: c.description }),
    ...(c.channel_metadata !== undefined && { channel_metadata: c.channel_metadata }),
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
    ...(releaseContext.linear_provider_name !== undefined && {
      linear_provider_name: releaseContext.linear_provider_name,
    }),
    ...(releaseContext.linear_vault_user_id !== undefined && {
      linear_vault_user_id: releaseContext.linear_vault_user_id,
    }),
    ...(releaseContext.linear_project_id !== undefined && {
      linear_project_id: releaseContext.linear_project_id,
    }),
    ...(releaseContext.jira_status_on_start !== undefined && {
      jira_status_on_start: releaseContext.jira_status_on_start,
    }),
    ...(releaseContext.jira_status_on_pr !== undefined && {
      jira_status_on_pr: releaseContext.jira_status_on_pr,
    }),
    ...(releaseContext.trigger_label !== undefined && {
      trigger_label: releaseContext.trigger_label,
    }),
    ...(releaseContext.parent_context?.title !== undefined && {
      parent_context_title: clampParentContext(releaseContext.parent_context.title),
    }),
    ...(releaseContext.parent_context?.description !== undefined && {
      parent_context_description: clampParentContext(releaseContext.parent_context.description),
    }),
    ...(releaseContext.pre_screened_attachments && releaseContext.pre_screened_attachments.length > 0 && {
      pre_screened_attachments_json: JSON.stringify(releaseContext.pre_screened_attachments),
    }),
    created_at: now,
    updated_at: now,
    ...(ttl !== undefined && { ttl }),
  };

  await putRows(ddb, tableName, childRows.map((r) => ({ ...r })));
  await ddb.send(new PutCommand({ TableName: tableName, Item: metaRow }));
  const rowsWritten = childRows.length + 1;

  logger.info('Orchestration seeded', {
    orchestration_id: orchestrationId,
    parent_issue_ref: parentIssueRef,
    child_count: children.length,
    rows_written: rowsWritten,
  });

  return { orchestrationId, rowsWritten, alreadyExisted: false };
}

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

const UNSTARTED: readonly ChildStatus[] = ['blocked', 'ready', 'failed', 'skipped'];

/**
 * Store the title and description that the graph has NOW for each existing
 * child that will be started from its row: one that waits, was skipped or
 * failed. A child that is running or has succeeded is not written.
 *
 * Each write is conditional on the row still being in one of those statuses,
 * which the store checks at the moment of the write: a row claimed for release
 * since it was read here keeps its text. ``updated_at`` is left alone:
 * it is the stamp of the row's last status change, which the sweep and the
 * retry's once-only key compare.
 */
export async function refreshUnstartedText(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  existing: readonly OrchestrationChildRow[],
  graph: readonly SubIssueNode[],
): Promise<void> {
  const nodeById = new Map(graph.map((n) => [n.id, n]));
  for (const row of existing) {
    const node = nodeById.get(row.sub_issue_id);
    if (!node || !UNSTARTED.includes(row.child_status)) continue;
    const description = node.description || undefined;
    if (node.title === row.title && description === row.description) continue;

    const set: string[] = [];
    const remove: string[] = [];
    const values: Record<string, string> = Object.fromEntries(UNSTARTED.map((s) => [`:${s}`, s]));
    for (const [name, value] of [['title', node.title], ['description', description]] as const) {
      if (value === undefined) {
        remove.push(`#${name}`);
      } else {
        set.push(`#${name} = :${name}`);
        values[`:${name}`] = value;
      }
    }
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { orchestration_id: row.orchestration_id, sub_issue_id: row.sub_issue_id },
        UpdateExpression: [
          ...(set.length > 0 ? [`SET ${set.join(', ')}`] : []),
          ...(remove.length > 0 ? [`REMOVE ${remove.join(', ')}`] : []),
        ].join(' '),
        ConditionExpression: `child_status IN (${UNSTARTED.map((s) => `:${s}`).join(', ')})`,
        ExpressionAttributeNames: { '#title': 'title', '#description': 'description' },
        ExpressionAttributeValues: values,
      }));
    } catch (err) {
      if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
}

/**
 * Extend an ALREADY-SEEDED orchestration with sub-issues added to the Linear
 * epic after the first seed.
 *
 * Diffs the freshly-fetched ``graph`` against the persisted children:
 *  - existing nodes keep their status/branch/task/edges (we never re-seed or
 *    reset a node that already ran); a node that is not running and has not
 *    succeeded gets the title and description the graph has for it now (see
 *    {@link refreshUnstartedText}),
 *  - genuinely-new nodes are validated (the augmented graph must stay acyclic),
 *    then added as ``ready`` (deps all already succeeded, or no deps) or
 *    ``blocked``,
 *  - the meta ``child_count`` is bumped.
 *
 * Idempotent: re-running with no new nodes and no changed text is a no-op
 * (empty result). A cycle introduced by the new edges rejects WITHOUT writing
 * anything.
 *
 * @param graph the full current sub-issue node set, already augmented with the
 *   synthetic integration node if the graph fans out, from the same source the
 *   seed used. A new integration node is kept only if the STORED edges still
 *   leave more than one leaf, and then depends on those leaves.
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
    return { orchestrationId, addedSubIssueIds: [], releasableSubIssueIds: [] };
  }

  const existingIds = new Set(snapshot.children.map((c) => c.sub_issue_id));
  const newNodes = graph.filter((n) => !existingIds.has(n.id));
  if (newNodes.length === 0) {
    await refreshUnstartedText(ddb, tableName, snapshot.children, graph);
    return { orchestrationId, addedSubIssueIds: [], releasableSubIssueIds: [] };
  }

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
  await refreshUnstartedText(ddb, tableName, snapshot.children, graph);

  const epicTip = resolveEpicTip(snapshot.children);
  const withImplicitDeps = newNodes.filter((n) => !isIntegrationNode(n.id)).map((n) => ({
    node: n,
    depends_on: n.depends_on.length > 0 ? n.depends_on : epicTip,
  }));

  const integration = newNodes.find((n) => isIntegrationNode(n.id));
  if (integration) {
    const leaves = computeLeaves([
      ...snapshot.children.map((c) => ({ id: c.sub_issue_id, depends_on: c.depends_on })),
      ...withImplicitDeps.map(({ node, depends_on }) => ({ id: node.id, depends_on })),
    ]);
    if (leaves.length > 1) withImplicitDeps.push({ node: integration, depends_on: leaves });
  }
  if (withImplicitDeps.length === 0) {
    return { orchestrationId, addedSubIssueIds: [], releasableSubIssueIds: [] };
  }

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
      ...(n.channel_metadata !== undefined && { channel_metadata: n.channel_metadata }),
      created_at: now,
      updated_at: now,
      ...(ttl !== undefined && { ttl }),
    };
  });

  await putRows(ddb, tableName, newRows.map((r) => ({ ...r })));
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
 * Claim the right to post the parent rollup comment exactly once.
 *
 * Conditionally stamps ``rollup_posted_at`` on the parent-meta row. The
 * first caller wins (returns true → post the comment); a racing/repeat
 * caller loses the conditional write (returns false → skip).
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
 * parent state: removes the ``rollup_posted_at`` stamp so {@link claimRollup}
 * can win again. Unconditional REMOVE (idempotent — a no-op when already
 * absent).
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
 * Persist a sub-issue's OWN screened attachments on its child row, distinct
 * from the parent epic's. Written as a native list. Conditional on the child
 * row existing so a racing TTL reap can't resurrect it.
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
 * REDELIVERY doesn't re-post. Linear redelivers
 * a comment webhook when the handler exceeds its ~5s ack window.
 * Keyed on the orchestration + the triggering comment id, so
 * the FIRST delivery wins and every redelivery is a no-op. The marker carries a
 * TTL (the table's ``ttl`` attribute) so these rows self-expire.
 * Returns true only for the first caller.
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
      // ``ttl`` is a DynamoDB reserved keyword → must be aliased via ExpressionAttributeNames.
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
   * Comment id of the live status block. The reconciler edits this comment in
   * place; when absent it posts a fresh comment and stamps that id.
   */
  readonly status_comment_id?: string;
  /**
   * The ``@bgagent retry`` comment that re-ran this epic, if one did.
   *
   * Recorded so the epic's next settle can move that comment's marker off the
   * receipt 👀 to the actual outcome. Cleared once
   * settled, so a later settle can't re-swap a marker on an old comment.
   */
  readonly retry_comment_id?: string;
  /** When the epic was seeded, extended or re-opened last (the meta row's own stamp). */
  readonly updated_at?: string;
}

/** Stamp the live status-block comment id on the parent-meta row. Not conditional. */
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
 * orchestration id has no rows (e.g. TTL-reaped).
 *
 * Paginates: a DynamoDB Query returns at most one 1MB page, so this follows
 * ``LastEvaluatedKey`` to read all rows.
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
    const hasRealChild = items.some((i) => !String(i.sub_issue_id).includes('#'));
    const detail = { orchestration_id: orchestrationId, row_count: items.length };
    if (hasRealChild) logger.warn('Orchestration child rows present but the meta row is missing', detail);
    else logger.info('No orchestration for this issue — only dedup markers exist', detail);
    return null;
  }

  const children = items
    .filter((i) => i.sub_issue_id !== PARENT_META_SK && !String(i.sub_issue_id).includes('#'))
    .map(toChildRow);

  const preScreened = parsePreScreenedAttachments(metaItem.pre_screened_attachments_json, orchestrationId);

  const meta: OrchestrationMeta = {
    orchestration_id: orchestrationId,
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
      ...(metaItem.linear_provider_name !== undefined && {
        linear_provider_name: metaItem.linear_provider_name as string,
      }),
      ...(metaItem.linear_vault_user_id !== undefined && {
        linear_vault_user_id: metaItem.linear_vault_user_id as string,
      }),
      ...(metaItem.linear_project_id !== undefined && {
        linear_project_id: metaItem.linear_project_id as string,
      }),
      ...(metaItem.jira_status_on_start !== undefined && {
        jira_status_on_start: metaItem.jira_status_on_start as string,
      }),
      ...(metaItem.jira_status_on_pr !== undefined && {
        jira_status_on_pr: metaItem.jira_status_on_pr as string,
      }),
      ...(metaItem.trigger_label !== undefined && {
        trigger_label: metaItem.trigger_label as string,
      }),
      ...((metaItem.parent_context_title !== undefined
        || metaItem.parent_context_description !== undefined) && {
        parent_context: {
          ...(metaItem.parent_context_title !== undefined && {
            title: metaItem.parent_context_title as string,
          }),
          ...(metaItem.parent_context_description !== undefined && {
            description: metaItem.parent_context_description as string,
          }),
        },
      }),
      ...(preScreened.length > 0 && { pre_screened_attachments: preScreened }),
    },
    ...(metaItem.retry_comment_id !== undefined && {
      retry_comment_id: metaItem.retry_comment_id as string,
    }),
    ...(metaItem.status_comment_id !== undefined && {
      status_comment_id: metaItem.status_comment_id as string,
    }),
    ...(metaItem.updated_at !== undefined && { updated_at: metaItem.updated_at as string }),
  };

  return { meta, children };
}

/**
 * Resolve a released child by its head branch, via the ChildBranchIndex GSI.
 * Maps a branch name back to the child row (which carries
 * ``orchestration_id`` + ``sub_issue_id``).
 *
 * Returns the child row, or null if no released child owns that branch. The
 * GSI is sparse — only released children carry ``child_branch_name``.
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
  return item ? toChildRow(item) : null;
}
