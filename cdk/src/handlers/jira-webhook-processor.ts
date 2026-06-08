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
import { reportIssueFailure } from './shared/jira-feedback';
import { resolveJiraOauthToken } from './shared/jira-oauth-resolver';
import { logger } from './shared/logger';
import type { Attachment } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PROJECT_MAPPING_TABLE = process.env.JIRA_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.JIRA_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
const DEFAULT_LABEL_FILTER = 'bgagent';

/**
 * Post a Jira comment without ever propagating an error. Mirrors the
 * Linear `safeReportIssueFailure` contract — feedback is best-effort,
 * advisory, and must never gate task-rejection logic.
 */
async function safeReportIssueFailure(
  issueIdOrKey: string,
  cloudId: string | undefined,
  message: string,
): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) {
    logger.warn('Skipping Jira feedback: JIRA_WORKSPACE_REGISTRY_TABLE_NAME not set', {
      issue_id_or_key: issueIdOrKey,
    });
    return;
  }
  if (!cloudId) {
    logger.warn('Skipping Jira feedback: webhook payload missing cloudId', {
      issue_id_or_key: issueIdOrKey,
    });
    return;
  }
  try {
    await reportIssueFailure(
      { cloudId, registryTableName: WORKSPACE_REGISTRY_TABLE },
      issueIdOrKey,
      message,
    );
  } catch (err) {
    logger.warn('Jira feedback failed (non-fatal)', {
      issue_id_or_key: issueIdOrKey,
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Subset of the Jira Cloud `jira:issue_*` webhook payload we depend on.
 * Undocumented fields are tolerated.
 */
interface JiraIssueEvent {
  readonly webhookEvent: 'jira:issue_created' | 'jira:issue_updated' | string;
  readonly timestamp?: number;
  readonly cloudId?: string;
  readonly user?: {
    readonly accountId?: string;
    readonly displayName?: string;
  };
  readonly issue?: {
    readonly id: string;
    readonly key: string;
    readonly fields?: {
      readonly summary?: string;
      readonly description?: unknown; // ADF document
      readonly labels?: string[];
      readonly creator?: { readonly accountId?: string };
      readonly reporter?: { readonly accountId?: string };
      readonly project?: {
        readonly id?: string;
        readonly key?: string;
      };
      readonly [key: string]: unknown;
    };
  };
  readonly changelog?: {
    readonly items?: Array<{
      readonly field?: string;
      readonly fieldId?: string;
      readonly fromString?: string | null;
      readonly toString?: string | null;
    }>;
  };
}

interface ProcessorEvent {
  readonly raw_body: string;
}

/**
 * Async processor for verified Jira webhooks.
 *
 * Responsibilities:
 * - Parse the issue payload.
 * - Detect whether the configured trigger label was added on creation OR
 *   added by an `issue_updated` event whose changelog shows a `labels`
 *   diff with the label newly present (Atlassian's label diff format
 *   differs from Linear's).
 * - Resolve `(cloudId, projectKey)` → repo mapping.
 * - Resolve `(cloudId, accountId)` → platform user mapping.
 * - Call `createTaskCore` with `channelSource: 'jira'` and metadata the
 *   agent uses to address the originating issue via the Jira MCP.
 */
export async function handler(event: ProcessorEvent): Promise<void> {
  if (!event.raw_body) {
    logger.error('Jira webhook processor invoked without raw_body');
    return;
  }

  let payload: JiraIssueEvent;
  try {
    payload = JSON.parse(event.raw_body) as JiraIssueEvent;
  } catch (err) {
    logger.error('Jira webhook processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (
    payload.webhookEvent !== 'jira:issue_created' &&
    payload.webhookEvent !== 'jira:issue_updated'
  ) {
    logger.info('Jira processor skipping non-issue event', { webhookEvent: payload.webhookEvent });
    return;
  }

  const issue = payload.issue;
  if (!issue || !issue.id || !issue.key) {
    logger.warn('Jira issue payload missing id or key', { webhookEvent: payload.webhookEvent });
    return;
  }

  const cloudId = payload.cloudId;
  const projectKey = issue.fields?.project?.key;
  if (!projectKey) {
    logger.info('Jira issue has no project.key — skipping (cannot route to a repo)', {
      issue_key: issue.key,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ This Jira issue isn't in a project — ABCA needs a Jira project to route the task to a repo. Move the issue into a project and re-apply the trigger label.",
    );
    return;
  }

  if (!cloudId) {
    // Without cloudId we can't resolve which tenant this issue belongs to,
    // which means we can't look up the project mapping (composite PK is
    // `{cloudId}#{projectKey}`) or post feedback. Log and drop.
    logger.warn('Jira webhook missing cloudId — cannot resolve tenant', {
      issue_key: issue.key,
      project_key: projectKey,
    });
    return;
  }

  const projectIdentity = `${cloudId}#${projectKey}`;
  const mapping = await ddb.send(new GetCommand({
    TableName: PROJECT_MAPPING_TABLE,
    Key: { jira_project_identity: projectIdentity },
  }));
  if (!mapping.Item || mapping.Item.status !== 'active') {
    logger.info('Jira project is not onboarded or is removed — skipping', {
      jira_project_identity: projectIdentity,
      issue_key: issue.key,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ This Jira project isn't onboarded to ABCA. An admin can onboard it with `bgagent jira onboard-project <projectKey> --repo <owner>/<repo> --label <trigger>`.",
    );
    return;
  }
  const repo = mapping.Item.repo as string;
  const labelFilter = (mapping.Item.label_filter as string | undefined) ?? DEFAULT_LABEL_FILTER;

  if (!shouldTrigger(payload, labelFilter)) {
    logger.info('Jira webhook does not match trigger criteria', {
      webhookEvent: payload.webhookEvent,
      issue_key: issue.key,
      label_filter: labelFilter,
      current_labels: issue.fields?.labels,
      changelog_label_items: payload.changelog?.items?.filter((i) => i?.field === 'labels'),
    });
    return;
  }

  const accountId = payload.user?.accountId
    ?? issue.fields?.reporter?.accountId
    ?? issue.fields?.creator?.accountId;
  if (!accountId) {
    logger.warn('Jira webhook missing user.accountId — cannot attribute task', {
      issue_key: issue.key,
      jira_cloud_id: cloudId,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ Jira webhook is missing the user accountId — ABCA can't attribute this task to a user. This is unusual; please report it to your ABCA admin.",
    );
    return;
  }

  const platformUserId = await lookupPlatformUser(cloudId, accountId);
  if (!platformUserId) {
    logger.warn('Jira account has no linked platform user — skipping task creation', {
      jira_cloud_id: cloudId,
      jira_account_id: accountId,
      issue_key: issue.key,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ This Jira user isn't linked to a platform user. Run `bgagent jira link <code>` from a Cognito-authenticated CLI session to complete linking.",
    );
    return;
  }

  const taskDescription = buildTaskDescription(issue);

  const channelMetadata: Record<string, string> = {
    jira_cloud_id: cloudId,
    jira_project_key: projectKey,
    jira_issue_id: issue.id,
    jira_issue_key: issue.key,
  };

  // Stash the resolved OAuth secret ARN on the task so the agent runtime
  // doesn't have to re-do the registry lookup. Also blocks tasks from
  // tenants that only verified via the stack-wide fallback (workspace
  // unknown to the registry) — we'd burn agent quota with no MCP token.
  if (WORKSPACE_REGISTRY_TABLE) {
    const resolved = await resolveJiraOauthToken(cloudId, WORKSPACE_REGISTRY_TABLE);
    if (!resolved) {
      logger.warn('Jira tenant not resolvable from registry — dropping event', {
        jira_cloud_id: cloudId,
        issue_key: issue.key,
      });
      return;
    }
    channelMetadata.jira_oauth_secret_arn = resolved.oauthSecretArn;
    channelMetadata.jira_site_url = resolved.siteUrl;
  }

  const attachments = extractImageUrlAttachments(extractDescriptionMarkdown(issue.fields?.description));

  const requestId = crypto.randomUUID();
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      ...(attachments.length > 0 && { attachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'jira',
      channelMetadata,
    },
    requestId,
  );

  if (result.statusCode !== 201) {
    logger.warn('Jira-triggered task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_key: issue.key,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      buildCreateTaskFailureMessage(result.statusCode, result.body),
    );
    return;
  }

  logger.info('Jira-triggered task created', {
    issue_key: issue.key,
    issue_id: issue.id,
    repo,
    request_id: requestId,
  });
}

/**
 * Decide whether a Jira issue event should trigger a task.
 *
 * Two trigger paths:
 * - `jira:issue_created` with the trigger label already present.
 * - `jira:issue_updated` whose `changelog.items[]` contains a labels
 *   change where the trigger label is in `toString` but NOT in
 *   `fromString` (i.e. it was newly added). Atlassian's label diff is
 *   delivered as space-separated strings, not arrays, so we tokenize.
 */
function shouldTrigger(payload: JiraIssueEvent, labelFilter: string): boolean {
  const filter = labelFilter.toLowerCase();
  const currentLabels = (payload.issue?.fields?.labels ?? []).map((l) => l.toLowerCase());
  const hasLabel = currentLabels.includes(filter);

  if (payload.webhookEvent === 'jira:issue_created') {
    return hasLabel;
  }

  if (payload.webhookEvent === 'jira:issue_updated') {
    if (!hasLabel) return false;
    const items = payload.changelog?.items ?? [];
    // Match the labels change item. Atlassian uses `field === 'labels'`
    // (or sometimes `fieldId === 'labels'`) for the labels system field.
    const labelsItem = items.find(
      (i) => i?.field === 'labels' || i?.fieldId === 'labels',
    );
    if (!labelsItem) return false;
    const previous = tokenizeLabelString(labelsItem.fromString);
    const next = tokenizeLabelString(labelsItem.toString);
    // Trigger only if the label is newly present.
    return next.includes(filter) && !previous.includes(filter);
  }

  return false;
}

/**
 * Atlassian delivers the labels-field change as a space-separated string
 * (e.g. `"bug" → "bug bgagent"`). Tokenize and lowercase for comparison.
 * Empty / null inputs return an empty list.
 */
function tokenizeLabelString(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Translate a `createTaskCore` non-201 response into a user-facing Jira
 * comment. Mirrors the Linear-side helper.
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

function buildTaskDescription(issue: NonNullable<JiraIssueEvent['issue']>): string {
  const parts: string[] = [];
  const summary = issue.fields?.summary?.trim();
  if (summary) {
    parts.push(`${issue.key}: ${summary}`);
  } else {
    parts.push(issue.key);
  }
  const description = extractDescriptionMarkdown(issue.fields?.description);
  if (description.trim()) {
    parts.push('');
    parts.push(description.trim());
  }
  return parts.join('\n');
}

/**
 * Convert a Jira ADF (Atlassian Document Format) document into best-effort
 * markdown. Intentionally minimal — extract paragraphs, headings, and
 * list items as plain text. Anything else (panels, tables, embeds) is
 * collapsed to its textual content.
 *
 * The full ADF spec has dozens of node types; rolling a complete converter
 * here would dwarf the rest of the integration and add a new dependency
 * surface. The agent gets the issue title + a coherent text rendering of
 * the description; richer rendering (tables, mentions, attachments) can
 * land in a follow-up.
 */
function extractDescriptionMarkdown(description: unknown): string {
  if (!description) return '';
  if (typeof description === 'string') return description;
  if (typeof description !== 'object') return '';

  const lines: string[] = [];
  walkAdf(description as AdfNode, lines, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface AdfNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: { readonly level?: number };
  readonly content?: AdfNode[];
}

function walkAdf(node: AdfNode | undefined, out: string[], depth: number): void {
  if (!node) return;
  switch (node.type) {
    case 'doc':
      (node.content ?? []).forEach((c) => walkAdf(c, out, depth));
      return;
    case 'paragraph': {
      const text = (node.content ?? []).map(textOf).join('');
      if (text) {
        out.push(text);
        out.push('');
      }
      return;
    }
    case 'heading': {
      const level = node.attrs?.level ?? 1;
      const prefix = '#'.repeat(Math.max(1, Math.min(6, level)));
      const text = (node.content ?? []).map(textOf).join('');
      if (text) {
        out.push(`${prefix} ${text}`);
        out.push('');
      }
      return;
    }
    case 'bulletList':
    case 'orderedList': {
      (node.content ?? []).forEach((item, idx) => {
        const itemText = (item.content ?? [])
          .flatMap((sub) => collectInlineLines(sub))
          .join(' ')
          .trim();
        if (!itemText) return;
        const bullet = node.type === 'orderedList' ? `${idx + 1}.` : '-';
        out.push(`${' '.repeat(depth * 2)}${bullet} ${itemText}`);
      });
      out.push('');
      return;
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map(textOf).join('');
      out.push('```');
      out.push(text);
      out.push('```');
      out.push('');
      return;
    }
    case 'text':
      if (node.text) out.push(node.text);
      return;
    default:
      // Unknown node — descend into its content if any so embedded text
      // (e.g. inside a panel or quote) isn't lost.
      (node.content ?? []).forEach((c) => walkAdf(c, out, depth));
  }
}

function textOf(node: AdfNode): string {
  if (node.type === 'text' && node.text) return node.text;
  if (node.content) return node.content.map(textOf).join('');
  return '';
}

function collectInlineLines(node: AdfNode): string[] {
  if (node.type === 'paragraph') {
    return [(node.content ?? []).map(textOf).join('')];
  }
  if (node.type === 'text' && node.text) {
    return [node.text];
  }
  return [];
}

/**
 * Extract image URLs from the rendered description markdown. Same limits
 * as the Linear processor: HTTPS only, capped at 10.
 */
function extractImageUrlAttachments(description: string | undefined): Attachment[] {
  if (!description) return [];

  const imagePattern = /!\[[^\]]*\]\((https:\/\/[^)]+)\)/g;
  const attachments: Attachment[] = [];
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(description)) !== null) {
    if (attachments.length >= 10) break;
    const url = match[1];
    attachments.push({ type: 'url', url });
  }

  if (attachments.length > 0) {
    logger.info('Extracted image URL attachments from Jira issue description', {
      count: attachments.length,
    });
  }

  return attachments;
}

async function lookupPlatformUser(cloudId: string, accountId: string): Promise<string | null> {
  const key = `${cloudId}#${accountId}`;
  const result = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { jira_identity: key },
  }));
  if (!result.Item || result.Item.status === 'pending') return null;
  return (result.Item.platform_user_id as string) ?? null;
}
