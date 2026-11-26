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
 * act.
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
  }));
  if (!result.Item || result.Item.status === 'pending') return null;
  return (result.Item.platform_user_id as string) ?? null;
}

/**
 * Outcome of resolving a Linear project to its ABCA repo mapping for a delivery
 * from ``workspaceId``.
 *
 *  - ``mapped`` — an active mapping. ``ownerVerified`` is ``false`` for a row
 *    written before the owning workspace was recorded.
 *  - ``foreign`` — the mapping belongs to ANOTHER workspace.
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

const SESSION_TASK_POINTER_TTL_SECONDS = 600;
const sessionTaskPointerKey = (issueId: string) => `agent-session-task#${issueId}`;

/**
 * Record, in the webhook dedup table, the task an agent session started for
 * ``issueId``, for {@link readSessionTaskPointer}.
 *
 * Callers write it only for a task that EXISTS (a create that returned 201, or
 * the task an idempotent replay resolved to).
 *
 * Best-effort: a failed write is logged, never thrown.
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
 * expire.
 */
const AGENT_SESSION_EVIDENCE_TTL_DAYS = 14;
export const AGENT_SESSION_EVIDENCE_TTL_MS = AGENT_SESSION_EVIDENCE_TTL_DAYS * 24 * 60 * 60 * 1000;
const AGENT_SESSION_MARKER_REFRESH_MS = 24 * 60 * 60 * 1000;
const AGENT_SESSION_CACHE_MINUTES = 5;
const AGENT_SESSION_CACHE_MS = AGENT_SESSION_CACHE_MINUTES * 60 * 1000;

const sessionWorkspacesSeen = new Map<string, number>();

function cachedAsDelivering(workspaceId: string, nowMs: number): boolean {
  const checkedAt = sessionWorkspacesSeen.get(workspaceId);
  return checkedAt !== undefined && nowMs - checkedAt < AGENT_SESSION_CACHE_MS;
}

/**
 * Note on the workspace's registry row that it delivered an
 * ``AgentSessionEvent``; {@link workspaceDeliversAgentSessions} reads it.
 *
 * The write goes through only when the marker is absent or older than a day.
 * Never throws.
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
 * failure) keeps the comment trigger answering.
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
    return false;
  }
}

export function resetSessionWorkspaceCacheForTests(): void {
  sessionWorkspacesSeen.clear();
}
