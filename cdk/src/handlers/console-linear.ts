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

import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { extractUserId } from './shared/gateway';
import {
  addIssueLabel,
  type ConsoleLinearIssue,
  consumeStartClaim,
  findTriggerLabelId,
  getIssueForStart,
  LinearApiError,
  listOpenProjectIssues,
  writeStartClaim,
} from './shared/linear-console';
import { resolveLinearOauthToken } from './shared/linear-oauth-resolver';
import { lookupTaskByLinearIssue } from './shared/linear-task-by-issue';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { makeDocClient } from './shared/ua';
import { isValidRepo } from './shared/validation';

/**
 * Console-only Linear routes (operator console stack):
 *
 *  - GET  /repos/{repo_id}/linear-issues        open issues of the Linear projects mapped to a repo
 *  - POST /linear-issues/{issue_id}/start       hand an issue to the agent by adding its trigger label
 *
 * "Start" adds the label rather than creating a task directly, so everything downstream is
 * the normal Linear flow: the webhook creates the task and the agent comments on the issue.
 * Tokens are resolved server-side and never returned. Titles and status only, no bodies.
 */

const ddb = makeDocClient();
const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME;
const REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
const DEDUP_TABLE = process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME;
const TASK_TABLE = process.env.TASK_TABLE_NAME;
const DEFAULT_LABEL = 'bgagent';

interface Mapping {
  readonly linear_project_id: string;
  readonly repo: string;
  readonly label_filter?: string;
  readonly linear_workspace_id?: string;
}

/** What the agent is doing with an issue, from the caller's point of view. */
export type AgentState =
  | { readonly kind: 'available' }
  /** Labeled, but no task yet (just started, or the webhook is still on its way). */
  | { readonly kind: 'starting' }
  | { readonly kind: 'task'; readonly task_id: string | null; readonly status: string | null; readonly pr_url: string | null; readonly mine: boolean };

export interface ConsoleLinearIssueWithAgent extends ConsoleLinearIssue {
  readonly agent: AgentState;
}

const triggerLabel = (m: Mapping) => (m.label_filter || DEFAULT_LABEL).trim();

async function mappingsForRepo(repo: string): Promise<Mapping[]> {
  // The mapping table is a handful of rows (one per onboarded project), so a filtered
  // scan is cheaper than an index that every write would have to maintain.
  const items: Mapping[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: PROJECT_MAPPING_TABLE,
      FilterExpression: '#repo = :repo AND #status = :active',
      ExpressionAttributeNames: { '#repo': 'repo', '#status': 'status' },
      ExpressionAttributeValues: { ':repo': repo, ':active': 'active' },
      ExclusiveStartKey: startKey,
    }));
    items.push(...((res.Items ?? []) as Mapping[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function agentState(issue: ConsoleLinearIssue, label: string, userId: string): Promise<AgentState> {
  if (!issue.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return { kind: 'available' };
  if (!TASK_TABLE) return { kind: 'starting' };
  const found = await lookupTaskByLinearIssue(ddb, TASK_TABLE, issue.id);
  if (found.kind !== 'found') return { kind: 'starting' };
  const mine = found.task.user_id === userId;
  // Someone else's task: say it is being worked on, without linking into their task.
  return {
    kind: 'task',
    task_id: mine ? found.task.task_id : null,
    status: found.task.status ?? null,
    pr_url: found.task.pr_url ?? null,
    mine,
  };
}

async function tokenFor(workspaceId: string | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  const resolved = await resolveLinearOauthToken(workspaceId, REGISTRY_TABLE!);
  return resolved?.accessToken ?? null;
}

async function listIssues(event: APIGatewayProxyEvent, userId: string, requestId: string): Promise<APIGatewayProxyResult> {
  const repo = decodeURIComponent(event.pathParameters?.repo_id ?? '');
  if (!isValidRepo(repo)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'repo_id must be in owner/repo format.', requestId);
  }
  const projects = [];
  for (const mapping of await mappingsForRepo(repo)) {
    const label = triggerLabel(mapping);
    const base = { project_id: mapping.linear_project_id, trigger_label: label };
    const token = await tokenFor(mapping.linear_workspace_id);
    if (!token) {
      projects.push({ ...base, problem: 'ABCA cannot reach this Linear workspace. Re-run `bgagent linear setup` to re-authorize it.', issues: [] });
      continue;
    }
    try {
      const issues = await listOpenProjectIssues(token, mapping.linear_project_id);
      const withAgent: ConsoleLinearIssueWithAgent[] = [];
      // Sequential on purpose: only issues already carrying the label need a task lookup,
      // which is usually a handful, and one Query at a time keeps DynamoDB use predictable.
      for (const i of issues) withAgent.push({ ...i, agent: await agentState(i, label, userId) });
      projects.push({ ...base, issues: withAgent });
    } catch (err) {
      logger.warn('Linear issue list failed', { linear_project_id: mapping.linear_project_id, request_id: requestId, error: String(err) });
      projects.push({ ...base, problem: err instanceof LinearApiError ? err.message : 'Could not load issues from Linear.', issues: [] });
    }
  }
  return successResponse(200, { repo, projects }, requestId);
}

async function startIssue(event: APIGatewayProxyEvent, userId: string, requestId: string): Promise<APIGatewayProxyResult> {
  const issueId = event.pathParameters?.issue_id ?? '';
  let projectId: unknown;
  try {
    projectId = (JSON.parse(event.body ?? '{}') as { project_id?: unknown }).project_id;
  } catch {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Body must be JSON: { "project_id": "<uuid>" }.', requestId);
  }
  if (!/^[0-9a-f-]{36}$/i.test(issueId) || typeof projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'issue_id and project_id must be Linear UUIDs.', requestId);
  }
  const mapping = (await ddb.send(new GetCommand({ TableName: PROJECT_MAPPING_TABLE, Key: { linear_project_id: projectId } }))).Item as
    (Mapping & { status?: string }) | undefined;
  if (!mapping || mapping.status !== 'active') {
    return errorResponse(422, ErrorCode.REPO_NOT_ONBOARDED, 'This Linear project is not connected to a repository.', requestId);
  }
  const token = await tokenFor(mapping.linear_workspace_id);
  if (!token || !mapping.linear_workspace_id) {
    return errorResponse(503, ErrorCode.SERVICE_UNAVAILABLE, 'ABCA cannot reach this Linear workspace. Re-run `bgagent linear setup` to re-authorize it.', requestId);
  }
  const label = triggerLabel(mapping);
  try {
    const issue = await getIssueForStart(token, issueId);
    // The issue must really belong to the mapped project: the body names the project,
    // so this is what stops an issue from another project being steered at this repo.
    if (!issue || issue.projectId !== projectId) {
      return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'That issue is not in this Linear project.', requestId);
    }
    if (issue.labels.some((l) => l.name.toLowerCase() === label.toLowerCase())) {
      return errorResponse(409, ErrorCode.DUPLICATE_TASK, `${issue.identifier} is already handed to the agent.`, requestId);
    }
    const labelId = await findTriggerLabelId(token, issue.teamId, label);
    if (!labelId) {
      return errorResponse(422, ErrorCode.VALIDATION_ERROR, `Linear has no "${label}" label yet. Create it in Linear (Settings → Labels), then try again.`, requestId);
    }
    // Claim first: the label's webhook can arrive before addIssueLabel even returns.
    await writeStartClaim(ddb, DEDUP_TABLE!, { issueId: issue.id, workspaceId: mapping.linear_workspace_id, platformUserId: userId });
    try {
      await addIssueLabel(token, issue.id, labelId);
    } catch (err) {
      await consumeStartClaim(ddb, DEDUP_TABLE!, issue.id, mapping.linear_workspace_id).catch(() => null);
      throw err;
    }
    logger.info('Console started a Linear issue', { issue_id: issue.id, identifier: issue.identifier, user_id: userId, request_id: requestId });
    return successResponse(202, { issue_id: issue.id, identifier: issue.identifier, repo: mapping.repo }, requestId);
  } catch (err) {
    logger.warn('Console start failed', { issue_id: issueId, request_id: requestId, error: String(err) });
    const message = err instanceof LinearApiError ? err.message : 'Could not start the issue.';
    return err instanceof LinearApiError
      ? errorResponse(503, ErrorCode.SERVICE_UNAVAILABLE, message, requestId)
      : errorResponse(500, ErrorCode.INTERNAL_ERROR, message, requestId);
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();
  try {
    const userId = extractUserId(event);
    if (!userId) return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    if (!PROJECT_MAPPING_TABLE || !REGISTRY_TABLE || !DEDUP_TABLE) {
      logger.error('console-linear is missing its table configuration', { request_id: requestId });
      return errorResponse(503, ErrorCode.SERVICE_UNAVAILABLE, 'Linear is not configured on this deployment.', requestId);
    }
    if (event.httpMethod === 'GET' && event.resource === '/repos/{repo_id}/linear-issues') return await listIssues(event, userId, requestId);
    if (event.httpMethod === 'POST' && event.resource === '/linear-issues/{issue_id}/start') return await startIssue(event, userId, requestId);
    return errorResponse(404, ErrorCode.VALIDATION_ERROR, 'Unknown route.', requestId);
  } catch (err) {
    logger.error('console-linear failed', { request_id: requestId, error: err instanceof Error ? err.message : String(err) });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong talking to Linear.', requestId);
  }
}
