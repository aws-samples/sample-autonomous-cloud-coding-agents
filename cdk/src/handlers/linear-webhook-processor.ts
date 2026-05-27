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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createTaskCore } from './shared/create-task-core';
import { reportIssueFailure } from './shared/linear-feedback';
import {
  probeLinearIssueContext,
  renderIssueContextHint,
} from './shared/linear-issue-context-probe';
import { resolveLinearOauthToken } from './shared/linear-oauth-resolver';
import { logger } from './shared/logger';
import type { Attachment } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.LINEAR_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
const DEFAULT_LABEL_FILTER = 'abca';

/**
 * Post a Linear comment + ❌ reaction without ever propagating an error.
 *
 * Phase 2.0b-O2: feedback is workspace-scoped — the resolver looks up
 * the per-workspace OAuth token via `LinearWorkspaceRegistryTable` and
 * issues a Bearer token. If the workspace isn't registered (drop-on-the-floor
 * for unmapped orgs) the feedback path no-ops cleanly.
 *
 * Two failure modes handled here:
 * - `LINEAR_WORKSPACE_REGISTRY_TABLE_NAME` env var unset (deploy misconfig) —
 *   skip with a clear diagnostic instead of letting the resolver fail
 *   per-call.
 * - `reportIssueFailure` throws synchronously (today impossible thanks to the
 *   helper's internal `Promise.allSettled`, but a future refactor could
 *   break that contract). Catching here means a synchronous throw can't
 *   bubble up and fail the Lambda — which would trigger SQS retries on a
 *   poison message.
 */
async function safeReportIssueFailure(
  issueId: string,
  linearWorkspaceId: string | undefined,
  message: string,
): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) {
    logger.warn('Skipping Linear feedback: LINEAR_WORKSPACE_REGISTRY_TABLE_NAME not set', {
      issue_id: issueId,
    });
    return;
  }
  if (!linearWorkspaceId) {
    logger.warn('Skipping Linear feedback: webhook payload missing organizationId', {
      issue_id: issueId,
    });
    return;
  }
  try {
    await reportIssueFailure(
      { linearWorkspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
      issueId,
      message,
    );
  } catch (err) {
    logger.warn('Linear feedback failed (non-fatal)', {
      issue_id: issueId,
      linear_workspace_id: linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Shape of Linear `Issue` webhook payloads we care about. Undocumented fields are tolerated. */
interface LinearIssueEvent {
  readonly action: 'create' | 'update' | 'remove' | string;
  readonly type: 'Issue';
  readonly data: {
    readonly id: string;
    readonly identifier?: string;
    readonly title?: string;
    readonly description?: string;
    readonly projectId?: string;
    readonly teamId?: string;
    readonly labels?: Array<{ id: string; name: string }>;
    readonly labelIds?: string[];
    readonly creatorId?: string;
    readonly [key: string]: unknown;
  };
  readonly actor?: {
    readonly id?: string;
    readonly name?: string;
  };
  readonly updatedFrom?: {
    readonly labelIds?: string[];
    readonly [key: string]: unknown;
  };
  readonly organizationId?: string;
  readonly webhookTimestamp?: number;
  readonly webhookId?: string;
}

interface ProcessorEvent {
  readonly raw_body: string;
}

/**
 * Async processor for verified Linear webhooks.
 *
 * Responsibilities:
 * - Parse the `Issue` payload.
 * - Detect whether the configured trigger label was just added (create) or present on update.
 * - Resolve the Linear project → GitHub repo mapping.
 * - Resolve the Linear actor → platform user mapping.
 * - Call `createTaskCore` with `channelSource: 'linear'` and metadata the agent uses
 *   to address the originating issue via the Linear MCP.
 */
export async function handler(event: ProcessorEvent): Promise<void> {
  if (!event.raw_body) {
    logger.error('Linear webhook processor invoked without raw_body');
    return;
  }

  let payload: LinearIssueEvent;
  try {
    payload = JSON.parse(event.raw_body) as LinearIssueEvent;
  } catch (err) {
    logger.error('Linear webhook processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (payload.type !== 'Issue') {
    logger.info('Linear processor skipping non-Issue payload', { type: payload.type });
    return;
  }

  const issue = payload.data;
  const projectId = issue.projectId;

  // Resolve the per-project label override (if any) BEFORE the label gate so
  // a workspace using a non-default label name still triggers correctly. The
  // lookup runs on every Issue webhook (one extra GetItem vs. lookup-after-
  // projectId-check), which is the price of having the silent label gate
  // come first — see comment on the `shouldTrigger` block below.
  let mappingItem: Record<string, unknown> | undefined;
  if (projectId) {
    const mapping = await ddb.send(new GetCommand({
      TableName: PROJECT_MAPPING_TABLE,
      Key: { linear_project_id: projectId },
    }));
    if (mapping.Item && mapping.Item.status === 'active') {
      mappingItem = mapping.Item;
    }
  }
  const labelFilter = (mappingItem?.label_filter as string | undefined) ?? DEFAULT_LABEL_FILTER;

  // Silent kill-switch: an issue without the trigger label is not for us.
  // This MUST run before any user-facing comment path. Previously the
  // projectId-missing and not-onboarded paths ran first and posted
  // "❌ project isn't onboarded" comments on every Issue event in every
  // unmapped team — workspace webhooks fire workspace-wide, so a single
  // un-onboarded team produced dozens of comments per issue change.
  // Moving the label check first means an unlabeled issue is a true no-op:
  // no comment, no reaction, no task creation, no DDB writes.
  if (!shouldTrigger(payload, labelFilter)) {
    logger.info('Linear webhook does not match trigger criteria — skipping silently', {
      action: payload.action,
      issue_id: issue.id,
      label_filter: labelFilter,
      has_project_mapping: Boolean(mappingItem),
      current_labels: issue.labels?.map((l) => l?.name),
      updated_from_keys: Object.keys(payload.updatedFrom ?? {}),
      updated_from_label_ids: payload.updatedFrom?.labelIds,
      current_label_ids: issue.labels?.map((l) => l?.id),
    });
    return;
  }

  // From here on the issue is labeled for ABCA, so user-facing failure
  // comments are appropriate — the user explicitly asked for our attention.
  if (!projectId) {
    logger.info('Linear Issue has no projectId — skipping (cannot route to a repo)', {
      issue_id: issue.id,
    });
    await safeReportIssueFailure(
      issue.id,
      payload.organizationId,
      "❌ This Linear issue isn't in a project — ABCA needs a Linear project to route the task to a repo. Move the issue into a project and re-apply the trigger label.",
    );
    return;
  }

  if (!mappingItem) {
    logger.info('Linear project is not onboarded or is removed — skipping', {
      linear_project_id: projectId,
      issue_id: issue.id,
    });
    await safeReportIssueFailure(
      issue.id,
      payload.organizationId,
      "❌ This Linear project isn't onboarded to ABCA. An admin can onboard it with `bgagent linear onboard-project <project-uuid> --repo <owner>/<repo> --label <trigger>`.",
    );
    return;
  }
  const repo = mappingItem.repo as string;

  // Resolve the actor → platform user. Fall back to creator if the actor is missing
  // (e.g. automation that set the label). If neither resolves, we cannot attribute
  // the task to a platform user and must drop the event.
  const workspaceId = payload.organizationId ?? '';
  const actorId = payload.actor?.id ?? issue.creatorId;
  if (!workspaceId || !actorId) {
    logger.warn('Linear webhook missing organization or actor — cannot attribute task', {
      issue_id: issue.id,
      organization_id: workspaceId,
      actor_id: actorId,
    });
    await safeReportIssueFailure(
      issue.id,
      workspaceId,
      "❌ Linear webhook is missing the organization or actor field — ABCA can't attribute this task to a user. This is unusual; please report it to your ABCA admin.",
    );
    return;
  }

  const platformUserId = await lookupPlatformUser(workspaceId, actorId);
  if (!platformUserId) {
    logger.warn('Linear actor has no linked platform user — skipping task creation', {
      linear_workspace_id: workspaceId,
      linear_user_id: actorId,
      issue_id: issue.id,
    });
    await safeReportIssueFailure(
      issue.id,
      workspaceId,
      "❌ This Linear user isn't linked to a platform user. In v1 only the API-token owner can submit tasks from Linear; multi-user OAuth support is on the v3 roadmap.",
    );
    return;
  }

  const channelMetadata: Record<string, string> = {
    linear_issue_id: issue.id,
    linear_workspace_id: workspaceId,
    linear_project_id: projectId,
  };
  if (issue.identifier) {
    channelMetadata.linear_issue_identifier = issue.identifier;
  }
  if (issue.teamId) {
    channelMetadata.linear_team_id = issue.teamId;
  }

  // Phase 2.0b-O2: resolve the workspace's OAuth secret ARN ONCE here
  // and stash it on the task record. The agent runtime reads it directly
  // (no registry lookup at task-execution time). If the workspace isn't
  // onboarded the agent's outbound Linear MCP simply skips.
  let contextHint = '';
  if (WORKSPACE_REGISTRY_TABLE) {
    const resolved = await resolveLinearOauthToken(workspaceId, WORKSPACE_REGISTRY_TABLE);
    if (resolved) {
      channelMetadata.linear_oauth_secret_arn = resolved.oauthSecretArn;
      channelMetadata.linear_workspace_slug = resolved.workspaceSlug;
      // Best-effort presence probe: ask Linear once whether the issue has
      // paperclip attachments or sits in a project with documents. The agent
      // will fetch the actual content via the Linear MCP at runtime — this
      // step only flags that there's something worth fetching.
      const probe = await probeLinearIssueContext(resolved.accessToken, issue.id);
      contextHint = renderIssueContextHint(probe);
    } else {
      logger.warn('Linear workspace not in registry — agent will run without Linear MCP', {
        linear_workspace_id: workspaceId,
        issue_id: issue.id,
      });
    }
  }

  const taskDescription = buildTaskDescription(issue, contextHint);

  // Extract embedded image URLs from the issue description markdown.
  // These become URL attachments that are fetched and screened during context hydration.
  const attachments = extractImageUrlAttachments(issue.description);

  const requestId = crypto.randomUUID();
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      ...(attachments.length > 0 && { attachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'linear',
      channelMetadata,
    },
    requestId,
  );

  if (result.statusCode !== 201) {
    logger.warn('Linear-triggered task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_id: issue.id,
    });
    await safeReportIssueFailure(
      issue.id,
      workspaceId,
      buildCreateTaskFailureMessage(result.statusCode, result.body),
    );
    return;
  }

  logger.info('Linear-triggered task created', {
    issue_id: issue.id,
    linear_issue_identifier: issue.identifier,
    repo,
    request_id: requestId,
  });
}

/**
 * Decide whether a Linear Issue event should trigger a task.
 *
 * - `create` with the label already on the issue → trigger
 * - `update` where labelIds transitions to include the label (previously didn't) → trigger
 * - Everything else → no-op
 */
function shouldTrigger(payload: LinearIssueEvent, labelFilter: string): boolean {
  const current = payload.data.labels ?? [];
  const hasLabel = current.some((l) => l?.name?.toLowerCase() === labelFilter.toLowerCase());

  if (payload.action === 'create') {
    return hasLabel;
  }

  if (payload.action === 'update') {
    if (!hasLabel) return false;
    // If the event doesn't include a label change, skip — something else on the
    // issue was edited, and we shouldn't re-submit on every title/description edit.
    const updatedFrom = payload.updatedFrom ?? {};
    const labelIdsChanged = Object.prototype.hasOwnProperty.call(updatedFrom, 'labelIds');
    if (!labelIdsChanged) return false;
    // The label must have just been added, not removed. If it was present before,
    // another Linear user probably toggled a different label — avoid re-triggering.
    const previousIds = new Set((updatedFrom.labelIds as string[] | undefined) ?? []);
    const currentLabelId = current.find((l) => l?.name?.toLowerCase() === labelFilter.toLowerCase())?.id;
    if (!currentLabelId) return false;
    return !previousIds.has(currentLabelId);
  }

  return false;
}

/**
 * Translate a `createTaskCore` non-201 response into a user-facing Linear comment.
 *
 * The CDK error envelope is `{ error: { code, message, request_id } }`. We surface
 * the `message` because it's already user-readable (e.g. "Task description was
 * blocked by content policy") and add a per-status prefix so the user can tell
 * a guardrail block from a 503 from a validation error.
 *
 * Falls back to a generic message if the body fails to parse — best-effort, never throws.
 */
function buildCreateTaskFailureMessage(statusCode: number, rawBody: string): string {
  let detail = '';
  try {
    if (rawBody) {
      const parsed = JSON.parse(rawBody) as { error?: { code?: string; message?: string } };
      const message = parsed.error?.message;
      if (typeof message === 'string' && message.trim()) {
        detail = message.trim();
      }
    }
  } catch {
    // fall through to the generic message
  }

  if (statusCode === 400 && detail) {
    // Guardrail blocks and validation errors land here; the message is already
    // user-readable so just prefix it.
    return `❌ ABCA couldn't accept this task: ${detail}`;
  }
  if (statusCode === 503) {
    return `❌ ABCA is temporarily unavailable (status ${statusCode}). Please re-apply the trigger label in a few minutes.`;
  }
  if (detail) {
    return `❌ ABCA couldn't create this task (status ${statusCode}): ${detail}`;
  }
  return `❌ ABCA couldn't create this task (status ${statusCode}). Check the ABCA admin logs for details.`;
}

function buildTaskDescription(issue: LinearIssueEvent['data'], contextHint: string = ''): string {
  const parts: string[] = [];
  if (issue.identifier && issue.title) {
    parts.push(`${issue.identifier}: ${issue.title}`);
  } else if (issue.title) {
    parts.push(issue.title);
  }
  if (contextHint) {
    parts.push('');
    parts.push(contextHint);
  }
  if (issue.description && issue.description.trim()) {
    parts.push('');
    parts.push(issue.description.trim());
  }
  return parts.join('\n') || 'Linear issue';
}

/**
 * Extract image URL attachments from Linear issue description markdown.
 *
 * Scans for standard markdown image references: `![alt](url)`.
 * Only HTTPS URLs are included (security: no HTTP, no data: URIs).
 * Capped at 10 images per issue to stay within attachment limits.
 *
 * Linear-hosted upload URLs (`uploads.linear.app`) are SKIPPED because
 * they require the workspace's OAuth token to fetch — the orchestrator's
 * URL-resolver runs unauthenticated and would fail closed with 401,
 * killing the task before the agent ever starts. The agent picks these
 * up at runtime via `mcp__linear-server__extract_images` (which mints
 * fresh signed URLs) per the on-demand prompt addendum, so dropping
 * them from the pre-fetch path doesn't lose coverage — it just shifts
 * the fetch from "Lambda with no auth" to "agent with the OAuth token."
 *
 * Trade-off: Linear-hosted images skip the Bedrock Guardrail screening
 * pass that runs at task-creation time. The description text itself is
 * still screened via the input guardrail; the bytes are not. Acceptable
 * for now — the agent treats those images as untrusted input anyway.
 */
function extractImageUrlAttachments(description: string | undefined): Attachment[] {
  if (!description) return [];

  const imagePattern = /!\[[^\]]*\]\((https:\/\/[^)]+)\)/g;
  const attachments: Attachment[] = [];
  let skippedLinearUploads = 0;
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(description)) !== null) {
    if (attachments.length >= 10) break;
    const url = match[1];
    if (isLinearUploadsUrl(url)) {
      skippedLinearUploads += 1;
      continue;
    }
    attachments.push({ type: 'url', url });
  }

  if (attachments.length > 0 || skippedLinearUploads > 0) {
    logger.info('Extracted image URL attachments from Linear issue description', {
      count: attachments.length,
      skipped_linear_uploads: skippedLinearUploads,
    });
  }

  return attachments;
}

function isLinearUploadsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'uploads.linear.app' || host.endsWith('.uploads.linear.app');
  } catch {
    return false;
  }
}

async function lookupPlatformUser(workspaceId: string, userId: string): Promise<string | null> {
  const key = `${workspaceId}#${userId}`;
  const result = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { linear_identity: key },
  }));
  if (!result.Item || result.Item.status === 'pending') return null;
  return (result.Item.platform_user_id as string) ?? null;
}
