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

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Linear helpers for the operator console: list a mapped project's open issues, and
 * hand one to the agent by adding its trigger label (so the normal webhook flow runs
 * and the agent keeps commenting on the issue).
 *
 * The label is added through ABCA's Linear app, so Linear reports the APP as the actor
 * on the resulting webhook, and the app is not linked to any ABCA user. A short-lived,
 * single-use "start claim" records which ABCA user asked; the webhook processor uses
 * it only when the actor itself has no linked user.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 8_000;
/** Long enough for Linear's webhook to arrive, short enough not to outlive the click. */
export const START_CLAIM_TTL_SECONDS = 600;
export const MAX_ISSUES_PER_PROJECT = 50;

export class LinearApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LinearApiError';
  }
}

async function linearQuery<T>(accessToken: string, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  let resp: Response;
  try {
    resp = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LinearApiError(`Linear did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) throw new LinearApiError(`Linear returned HTTP ${resp.status}`, resp.status);
  const body = (await resp.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (body.errors?.length || !body.data) {
    throw new LinearApiError(`Linear rejected the request: ${body.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
  }
  return body.data;
}

export interface ConsoleLinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  /** Workflow state, e.g. "Todo" / "In Progress", and its category. */
  readonly state: string;
  readonly state_type: string;
  readonly priority_label: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  readonly updated_at: string;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priorityLabel?: string | null;
  updatedAt: string;
  state?: { name?: string; type?: string } | null;
  labels?: { nodes?: Array<{ name?: string }> } | null;
  assignee?: { name?: string } | null;
}

function toIssue(n: IssueNode): ConsoleLinearIssue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    state: n.state?.name ?? '',
    state_type: n.state?.type ?? '',
    priority_label: n.priorityLabel ?? '',
    labels: (n.labels?.nodes ?? []).map((l) => l.name ?? '').filter(Boolean),
    assignee: n.assignee?.name ?? null,
    updated_at: n.updatedAt,
  };
}

/** Open issues (not completed or canceled) in a project, most recently updated first. */
export async function listOpenProjectIssues(accessToken: string, projectId: string, fetchImpl?: typeof fetch): Promise<ConsoleLinearIssue[]> {
  const data = await linearQuery<{ project: { issues: { nodes: IssueNode[] } } | null }>(accessToken, `
    query ConsoleProjectIssues($id: String!, $first: Int!) {
      project(id: $id) {
        issues(first: $first, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
          nodes { id identifier title url priorityLabel updatedAt state { name type } labels { nodes { name } } assignee { name } }
        }
      }
    }`, { id: projectId, first: MAX_ISSUES_PER_PROJECT }, fetchImpl);
  if (!data.project) throw new LinearApiError('Linear has no such project (it may have been deleted)', 404);
  return data.project.issues.nodes.map(toIssue);
}

export interface IssueForStart {
  readonly id: string;
  readonly identifier: string;
  readonly projectId: string | null;
  readonly teamId: string | null;
  readonly labels: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export async function getIssueForStart(accessToken: string, issueId: string, fetchImpl?: typeof fetch): Promise<IssueForStart | null> {
  const data = await linearQuery<{
    issue: {
      id: string;
      identifier: string;
      project?: { id: string } | null;
      team?: { id: string } | null;
      labels?: { nodes?: Array<{ id: string; name: string }> } | null;
    } | null;
  }>(accessToken, `
    query ConsoleIssueForStart($id: String!) {
      issue(id: $id) { id identifier project { id } team { id } labels { nodes { id name } } }
    }`, { id: issueId }, fetchImpl);
  if (!data.issue) return null;
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    projectId: data.issue.project?.id ?? null,
    teamId: data.issue.team?.id ?? null,
    labels: data.issue.labels?.nodes ?? [],
  };
}

/**
 * The trigger label usable on an issue of `teamId`: a team label of that team, else a
 * workspace-wide label. Matched case-insensitively, like the webhook processor.
 */
export async function findTriggerLabelId(accessToken: string, teamId: string | null, name: string, fetchImpl?: typeof fetch): Promise<string | null> {
  const data = await linearQuery<{ issueLabels: { nodes: Array<{ id: string; name: string; team?: { id: string } | null }> } }>(accessToken, `
    query ConsoleTriggerLabel($name: String!) {
      issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } }
    }`, { name }, fetchImpl);
  const nodes = data.issueLabels.nodes;
  return nodes.find((l) => teamId && l.team?.id === teamId)?.id ?? nodes.find((l) => !l.team)?.id ?? null;
}

export async function addIssueLabel(accessToken: string, issueId: string, labelId: string, fetchImpl?: typeof fetch): Promise<void> {
  const data = await linearQuery<{ issueAddLabel: { success: boolean } }>(accessToken, `
    mutation ConsoleAddLabel($id: String!, $labelId: String!) {
      issueAddLabel(id: $id, labelId: $labelId) { success }
    }`, { id: issueId, labelId }, fetchImpl);
  if (!data.issueAddLabel.success) throw new LinearApiError('Linear did not add the label');
}

const claimKey = (issueId: string) => `console-start#${issueId}`;

/**
 * Records that `platformUserId` asked for `issueId` to be started from the console.
 * Conditional: an unexpired claim from someone else wins, so two people pressing Start
 * at once cannot overwrite each other's attribution. Returns false when it is taken.
 */
export async function writeStartClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  claim: { readonly issueId: string; readonly workspaceId: string; readonly platformUserId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        dedup_key: claimKey(claim.issueId),
        platform_user_id: claim.platformUserId,
        linear_workspace_id: claim.workspaceId,
        ttl: nowSeconds + START_CLAIM_TTL_SECONDS,
      },
      // DynamoDB TTL deletes lazily, so an expired claim can still be in the table.
      ConditionExpression: 'attribute_not_exists(dedup_key) OR #ttl < :now OR platform_user_id = :user',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': nowSeconds, ':user': claim.platformUserId },
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/**
 * The ABCA user who asked for `issueId` to be started, or null when there is no
 * unexpired claim from this workspace. Reads without consuming: the claim is released
 * only once the task exists ({@link releaseStartClaim}), so a retried webhook delivery
 * still finds who asked.
 */
export async function readStartClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  issueId: string,
  workspaceId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { dedup_key: claimKey(issueId) }, ConsistentRead: true }));
  const item = res.Item;
  if (!item) return null;
  if (typeof item.ttl !== 'number' || item.ttl < nowSeconds) return null;
  if (item.linear_workspace_id !== workspaceId) return null;
  return typeof item.platform_user_id === 'string' ? item.platform_user_id : null;
}

/**
 * Deletes `platformUserId`'s claim on `issueId`. Ownership-aware: a claim that now
 * belongs to someone else is left alone. Returns whether a claim was deleted.
 */
export async function releaseStartClaim(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  issueId: string,
  platformUserId: string,
): Promise<boolean> {
  try {
    await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { dedup_key: claimKey(issueId) },
      ConditionExpression: 'platform_user_id = :user',
      ExpressionAttributeValues: { ':user': platformUserId },
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
