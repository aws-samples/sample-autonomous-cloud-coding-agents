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

import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

/**
 * The vault fields a task needs so the AGENT can mint its own Linear token.
 *
 * Every channel_metadata builder must spread this. A builder that omits it hands the
 * agent no provider, so it falls back to a Secrets-Manager token a vault-managed
 * workspace does not have: no reactions and no state transitions, on work that
 * otherwise succeeded.
 *
 * Three checks guard it, because they fail for different reasons. Two source-level ones
 * (in the processor test files) catch a builder nobody exercised — one keys off the
 * object-literal form, the other off the assignment form, so a builder that writes onto
 * an existing object is covered too (#879). The behavioural one asserts the fields
 * actually reach `channel_metadata`.
 */
export function vaultMetadata(resolved: { providerName?: string; vaultUserId?: string }): Record<string, string> {
  return {
    ...(resolved.providerName && { linear_provider_name: resolved.providerName }),
    ...(resolved.vaultUserId && { linear_vault_user_id: resolved.vaultUserId }),
  };
}

/**
 * Resolve a Linear user to the linked ABCA platform user. ``null`` when the
 * user has no mapping or the link is still pending — the caller must refuse to
 * act, since an unlinked Linear actor cannot be attributed or billed.
 */
export async function lookupLinearPlatformUser(
  ddb: DynamoDBDocumentClient,
  userMappingTableName: string,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const result = await ddb.send(new GetCommand({
    TableName: userMappingTableName,
    Key: { linear_identity: `${workspaceId}#${userId}` },
    // Decisions (approval replies, a session stop) are authorized from this mapping.
    ConsistentRead: true,
  }));
  if (!result.Item || result.Item.status === 'pending') return null;
  return (result.Item.platform_user_id as string) ?? null;
}

/**
 * Outcome of resolving a Linear project to its ABCA repo mapping for a delivery
 * from ``workspaceId``. One helper for every Linear entry point (label trigger,
 * agent session) so they admit exactly the same issues.
 *
 *  - ``mapped`` — an active mapping. ``ownerVerified`` is ``false`` for a row
 *    written before the owning workspace was recorded: allowed for now (rejecting
 *    it would break working installs on deploy; ``bgagent linear onboard-project``
 *    records the owner and ``bgagent platform doctor`` reports what is left).
 *  - ``foreign`` — the mapping belongs to ANOTHER workspace. The mapping table is
 *    keyed on the project id alone and that id arrives in the request body, so
 *    without this check naming another workspace's project would steer a task at
 *    that workspace's repository.
 *  - ``none`` — no project, no row, or the row is not active.
 */
export type LinearProjectMapping =
  | { readonly kind: 'mapped'; readonly item: Record<string, unknown>; readonly ownerVerified: boolean }
  | { readonly kind: 'foreign'; readonly mappedWorkspaceId: string }
  | { readonly kind: 'none' };

export async function lookupLinearProjectMapping(
  ddb: DynamoDBDocumentClient,
  projectMappingTableName: string,
  projectId: string | null | undefined,
  workspaceId: string | undefined,
): Promise<LinearProjectMapping> {
  if (!projectId) return { kind: 'none' };
  const result = await ddb.send(new GetCommand({
    TableName: projectMappingTableName,
    Key: { linear_project_id: projectId },
  }));
  const item = result.Item;
  if (!item || item.status !== 'active') return { kind: 'none' };
  const mappedWorkspaceId = item.linear_workspace_id as string | undefined;
  if (mappedWorkspaceId && mappedWorkspaceId !== workspaceId) return { kind: 'foreign', mappedWorkspaceId };
  return { kind: 'mapped', item, ownerVerified: Boolean(mappedWorkspaceId) };
}

/**
 * How long a session → task pointer lives. It only has to outlast the
 * ``LinearIssueIndex`` GSI's propagation lag (normally well under a second);
 * ten minutes leaves room for a throttled index.
 */
const SESSION_TASK_POINTER_TTL_SECONDS = 600;
const sessionTaskPointerKey = (issueId: string) => `agent-session-task#${issueId}`;

/**
 * Record, in the webhook dedup table, the task an agent session started for
 * ``issueId``. Read back strongly consistently by
 * {@link readSessionTaskPointer}, it lets a ``prompted`` / ``stop`` delivery
 * that arrives before the eventually-consistent ``LinearIssueIndex`` GSI has
 * caught up still find the task — instead of starting a second one beside it
 * or answering "nothing was running".
 *
 * Callers write it only for a task that EXISTS (a create that returned 201, or
 * the task an idempotent replay resolved to). A pointer to an id that was
 * never created would hide the real task from exactly the lookups it serves.
 *
 * Best-effort: a failed write only reopens that sub-second window.
 */
export async function writeSessionTaskPointer(
  ddb: DynamoDBDocumentClient,
  dedupTableName: string,
  pointer: { readonly issueId: string; readonly taskId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  try {
    await ddb.send(new PutCommand({
      TableName: dedupTableName,
      Item: {
        dedup_key: sessionTaskPointerKey(pointer.issueId),
        task_id: pointer.taskId,
        ttl: nowSeconds + SESSION_TASK_POINTER_TTL_SECONDS,
      },
    }));
  } catch (err) {
    logger.warn('Could not record the agent-session task pointer (a prompt within the index lag may miss this task)', {
      linear_issue_id: pointer.issueId,
      task_id: pointer.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The task id last recorded for ``issueId`` by {@link writeSessionTaskPointer}, if unexpired. */
export async function readSessionTaskPointer(
  ddb: DynamoDBDocumentClient,
  dedupTableName: string,
  issueId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: dedupTableName,
    Key: { dedup_key: sessionTaskPointerKey(issueId) },
    ConsistentRead: true,
  }));
  // DynamoDB TTL deletes lazily, so an expired pointer can still be in the table.
  if (!Item || typeof Item.task_id !== 'string' || (typeof Item.ttl === 'number' && Item.ttl < nowSeconds)) return null;
  return Item.task_id;
}

/**
 * How long one delivered ``AgentSessionEvent`` counts as evidence that a
 * workspace's installation still has "Agent session events" on. Linear tells
 * us nothing when an admin turns the toggle off, so the evidence has to
 * expire: a marker that lasted forever would keep the comment trigger yielding
 * to sessions that no longer open, and every mention would be lost in silence.
 *
 * The cost of expiry falls on a workspace that is simply quiet for longer than
 * this: its next mention is answered by the comment trigger as well as the
 * session. That is visible and corrects itself on that same mention; a lost
 * mention is neither.
 */
const AGENT_SESSION_EVIDENCE_TTL_DAYS = 14;
export const AGENT_SESSION_EVIDENCE_TTL_MS = AGENT_SESSION_EVIDENCE_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Refresh the marker at most this often per workspace: one write a day keeps it far inside the TTL. */
const AGENT_SESSION_MARKER_REFRESH_MS = 24 * 60 * 60 * 1000;
/** How long a container trusts its own last look at a workspace's marker. */
const AGENT_SESSION_CACHE_MINUTES = 5;
const AGENT_SESSION_CACHE_MS = AGENT_SESSION_CACHE_MINUTES * 60 * 1000;

/** Per container: when each workspace's marker was last seen fresh (epoch ms of the check). */
const sessionWorkspacesSeen = new Map<string, number>();

function cachedAsDelivering(workspaceId: string, nowMs: number): boolean {
  const checkedAt = sessionWorkspacesSeen.get(workspaceId);
  return checkedAt !== undefined && nowMs - checkedAt < AGENT_SESSION_CACHE_MS;
}

/**
 * Note on the workspace's registry row that it delivered an
 * ``AgentSessionEvent``. The deployment flag is stack-wide, but Linear's "Agent
 * session events" toggle is per app installation: this timestamp is the
 * per-workspace evidence that sessions really open there, and
 * {@link workspaceDeliversAgentSessions} keys the comment trigger's yield on it
 * while it is fresh.
 *
 * Refreshed, not write-once: the write goes through when the marker is absent
 * or older than a day, so an active workspace costs one write a day. Never
 * throws — it must not delay or fail the delivery it rides on.
 */
export async function recordWorkspaceAgentSession(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  if (cachedAsDelivering(workspaceId, nowMs)) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: registryTableName,
      Key: { linear_workspace_id: workspaceId },
      UpdateExpression: 'SET agent_sessions_seen_at = :now',
      ConditionExpression: 'attribute_exists(linear_workspace_id) AND '
        + '(attribute_not_exists(agent_sessions_seen_at) OR agent_sessions_seen_at < :stale)',
      ExpressionAttributeValues: {
        ':now': new Date(nowMs).toISOString(),
        ':stale': new Date(nowMs - AGENT_SESSION_MARKER_REFRESH_MS).toISOString(),
      },
    }));
    sessionWorkspacesSeen.set(workspaceId, nowMs);
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      // Already marked within the last day (or no registry row to mark).
      sessionWorkspacesSeen.set(workspaceId, nowMs);
      return;
    }
    logger.warn('Could not record that this workspace delivers agent sessions', {
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether this workspace delivered an ``AgentSessionEvent`` recently enough to
 * trust that its app installation still has "Agent session events" on, so an
 * @-mention opens a session. ``false`` (no marker, an expired one, or a read
 * failure) keeps the comment trigger answering, which is the safe side: a
 * mention is never left unanswered.
 */
export async function workspaceDeliversAgentSessions(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (cachedAsDelivering(workspaceId, nowMs)) return true;
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: registryTableName,
      Key: { linear_workspace_id: workspaceId },
      ProjectionExpression: 'agent_sessions_seen_at',
      ConsistentRead: true,
    }));
    const seenAtMs = typeof Item?.agent_sessions_seen_at === 'string' ? Date.parse(Item.agent_sessions_seen_at) : NaN;
    if (!Number.isFinite(seenAtMs) || nowMs - seenAtMs >= AGENT_SESSION_EVIDENCE_TTL_MS) return false;
    sessionWorkspacesSeen.set(workspaceId, nowMs);
    return true;
  } catch (err) {
    logger.warn('Could not read whether this workspace delivers agent sessions — the comment trigger answers', {
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    // False keeps the comment trigger answering — the outcome that never drops a mention.
    return false;
  }
}

/** Test seam: forget which workspaces this container has seen deliver sessions. */
export function resetSessionWorkspaceCacheForTests(): void {
  sessionWorkspacesSeen.clear();
}
