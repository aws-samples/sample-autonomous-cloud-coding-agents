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
 * Record, in the webhook dedup table, the task an agent session is about to
 * start for ``issueId``. Read back strongly consistently by
 * {@link readSessionTaskPointer}, it lets a ``prompted`` / ``stop`` delivery
 * that arrives before the eventually-consistent ``LinearIssueIndex`` GSI has
 * caught up still find the task — instead of starting a second one beside it
 * or answering "nothing was running".
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

/** Workspaces this container has already marked (or seen marked) as delivering sessions. */
const sessionWorkspacesSeen = new Set<string>();

/**
 * Note on the workspace's registry row that it delivered an
 * ``AgentSessionEvent``. The deployment flag is stack-wide, but Linear's "Agent
 * session events" toggle is per app installation: this marker is the
 * per-workspace evidence that sessions really open there, and
 * {@link workspaceDeliversAgentSessions} keys the comment trigger's yield on it.
 *
 * One conditional write per container per workspace; best-effort.
 */
export async function recordWorkspaceAgentSession(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
  workspaceId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  if (sessionWorkspacesSeen.has(workspaceId)) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: registryTableName,
      Key: { linear_workspace_id: workspaceId },
      UpdateExpression: 'SET agent_sessions_seen_at = :now',
      ConditionExpression: 'attribute_exists(linear_workspace_id) AND attribute_not_exists(agent_sessions_seen_at)',
      ExpressionAttributeValues: { ':now': now },
    }));
    sessionWorkspacesSeen.add(workspaceId);
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      sessionWorkspacesSeen.add(workspaceId);
      return;
    }
    logger.warn('Could not record that this workspace delivers agent sessions', {
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether this workspace has ever delivered an ``AgentSessionEvent`` — i.e. its
 * app installation has "Agent session events" on, so an @-mention opens a
 * session. ``false`` (including on a read failure) keeps the comment trigger
 * answering, which is the safe side: a mention is never left unanswered.
 */
export async function workspaceDeliversAgentSessions(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
  workspaceId: string,
): Promise<boolean> {
  if (sessionWorkspacesSeen.has(workspaceId)) return true;
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: registryTableName,
      Key: { linear_workspace_id: workspaceId },
      ProjectionExpression: 'agent_sessions_seen_at',
      ConsistentRead: true,
    }));
    if (typeof Item?.agent_sessions_seen_at !== 'string') return false;
    sessionWorkspacesSeen.add(workspaceId);
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
