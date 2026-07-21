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
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createTaskCore } from './shared/create-task-core';
import { reportIssueFailure } from './shared/jira-feedback';
import { resolveJiraOauthToken } from './shared/jira-oauth-resolver';
import { logger } from './shared/logger';
import type { Attachment } from './shared/types';
import { CODING_WORKFLOW_ID } from './shared/workflows';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PROJECT_MAPPING_TABLE = process.env.JIRA_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.JIRA_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
const DEFAULT_LABEL_FILTER = 'bgagent';

/** Deepest markdown heading level (`######`) ADF heading nodes are clamped to. */
const MAX_MARKDOWN_HEADING_LEVEL = 6;

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
 * Safe single-tenant fallback for `cloudId`.
 *
 * Webhooks created through the Jira **Settings → System → Webhooks** UI do
 * not include a top-level `cloudId` in their payload (only app/OAuth-
 * registered dynamic webhooks do). Without `cloudId` the processor can't
 * resolve the tenant. For the common single-tenant install we recover by
 * reading the workspace registry: if **exactly one** `active` tenant is
 * registered, that must be the sender, so we use it.
 *
 * This deliberately does NOT guess when multiple active tenants exist —
 * doing so could mis-route an event from site B to site A's repo/user.
 * In that case we return `undefined` and the caller drops the event, so
 * the multi-tenant design is preserved: a multi-tenant operator must use a
 * webhook that carries its own `cloudId`.
 */
async function resolveSoleTenantCloudId(): Promise<string | undefined> {
  if (!WORKSPACE_REGISTRY_TABLE) return undefined;
  // Full-table Scan: the workspace registry holds one row per OAuth-installed
  // tenant and is expected to stay small (tens of rows at most), so a Scan is
  // cheap. The >1-active-tenant short-circuit below caps the work regardless.
  // If this table ever grows large, add a GSI on `status` and Query it.
  let activeCloudIds: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: WORKSPACE_REGISTRY_TABLE,
      ProjectionExpression: 'jira_cloud_id, #s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of page.Items ?? []) {
      if (item.status === 'active' && typeof item.jira_cloud_id === 'string') {
        activeCloudIds.push(item.jira_cloud_id);
      }
    }
    lastKey = page.LastEvaluatedKey;
    // Short-circuit: once we've seen more than one active tenant the
    // fallback is ambiguous, so stop scanning.
    if (activeCloudIds.length > 1) break;
  } while (lastKey);

  if (activeCloudIds.length === 1) return activeCloudIds[0];
  logger.warn('Cannot infer cloudId: registry does not have exactly one active tenant', {
    active_tenant_count: activeCloudIds.length,
  });
  return undefined;
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
  /**
   * True when the receiver verified this delivery against the stack-wide
   * fallback secret rather than a per-tenant signing secret. The stack-wide
   * secret is not bound to any `cloudId`, so a body-supplied `cloudId` on
   * such a delivery is untrusted — the processor ignores it and binds the
   * event to the sole active tenant instead (dropping when that's ambiguous).
   * Absent/false means the signature was per-tenant, so `payload.cloudId`
   * is trustworthy for routing.
   */
  readonly verified_via_stack_wide?: boolean;
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
 *   agent uses to address the originating issue via the Jira REST v3 API
 *   (`jira_reactions.py`; see ADR-015 for why outbound is REST, not MCP).
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

  // Resolve the tenant `cloudId`, honoring the signature's trust boundary:
  //
  // - Per-tenant signature (`verified_via_stack_wide` false/absent): the
  //   sender proved knowledge of *this* tenant's secret, so the body-supplied
  //   `payload.cloudId` is trustworthy. Fall back to the sole-active-tenant
  //   lookup only when the body omits it (Settings-UI webhooks).
  // - Stack-wide fallback signature: the secret is not bound to any tenant,
  //   so a body-supplied `cloudId` is attacker-controllable. We IGNORE it and
  //   bind the delivery to the sole active tenant; `resolveSoleTenantCloudId`
  //   returns undefined (→ drop) when zero or multiple tenants are active, so
  //   a stack-wide secret can never steer an event at a chosen tenant.
  let cloudId: string | undefined;
  if (event.verified_via_stack_wide) {
    cloudId = await resolveSoleTenantCloudId();
    if (payload.cloudId && payload.cloudId !== cloudId) {
      logger.warn('Ignoring body cloudId on stack-wide-verified webhook; binding to sole active tenant', {
        body_cloud_id: payload.cloudId,
        bound_cloud_id: cloudId,
        issue_key: issue.key,
      });
    }
  } else {
    cloudId = payload.cloudId ?? (await resolveSoleTenantCloudId());
  }
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
    // No cloudId in the payload AND the single-tenant fallback couldn't
    // resolve one (zero or multiple active tenants). Without it we can't
    // look up the project mapping (composite PK is `{cloudId}#{projectKey}`)
    // or post feedback. Log and drop.
    logger.warn('Jira webhook missing cloudId and no sole active tenant — cannot resolve tenant', {
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
      `❌ This Jira project isn't onboarded to ABCA. An admin can onboard it with \`bgagent jira map ${cloudId} ${projectKey} --repo <owner>/<repo>\` (add \`--label <trigger>\` to change the trigger label).`,
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

  // Convert the ADF description to markdown once and reuse it for both the
  // task body and image-attachment extraction.
  const descriptionMarkdown = extractDescriptionMarkdown(issue.fields?.description);
  const taskDescription = buildTaskDescription(issue, descriptionMarkdown);

  const channelMetadata: Record<string, string> = {
    jira_cloud_id: cloudId,
    jira_project_key: projectKey,
    jira_issue_id: issue.id,
    jira_issue_key: issue.key,
  };

  // Optional per-project workflow-transition overrides (issue #572). When an
  // admin configured `bgagent jira map ... --status-on-start/--status-on-pr`,
  // stamp them so the agent's best-effort transition helpers prefer these
  // status names over the built-in statusCategory / "In Review" heuristics.
  const statusOnStart = mapping.Item.status_on_start as string | undefined;
  const statusOnPr = mapping.Item.status_on_pr as string | undefined;
  if (statusOnStart) {
    channelMetadata.jira_status_on_start = statusOnStart;
  }
  if (statusOnPr) {
    channelMetadata.jira_status_on_pr = statusOnPr;
  }

  // Stash the resolved OAuth secret ARN on the task so the agent runtime
  // doesn't have to re-do the registry lookup. Also blocks tasks from
  // tenants that only verified via the stack-wide fallback (workspace
  // unknown to the registry) — we'd burn agent quota with no resolvable
  // Jira OAuth token for the outbound REST progress comments.
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

  const attachments = extractImageUrlAttachments(descriptionMarkdown);

  const requestId = crypto.randomUUID();
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      // Explicit coding workflow: a label-triggered Jira task always targets a
      // mapped repo, so it must not fall through the resolution ladder to the
      // repo-less default/agent-v1 (which never commits or opens a PR). #546
      workflow_ref: CODING_WORKFLOW_ID,
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

function buildTaskDescription(
  issue: NonNullable<JiraIssueEvent['issue']>,
  descriptionMarkdown: string,
): string {
  const parts: string[] = [];
  const summary = issue.fields?.summary?.trim();
  if (summary) {
    parts.push(`${issue.key}: ${summary}`);
  } else {
    parts.push(issue.key);
  }
  if (descriptionMarkdown.trim()) {
    parts.push('');
    parts.push(descriptionMarkdown.trim());
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
  readonly attrs?: {
    readonly level?: number;
    /** `media` node: `"external"` carries a direct `url`; `"file"`/`"link"`
     *  carry an attachment `id` that needs a Jira API call to resolve. */
    readonly type?: string;
    readonly url?: string;
    readonly alt?: string;
  };
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
      const prefix = '#'.repeat(Math.max(1, Math.min(MAX_MARKDOWN_HEADING_LEVEL, level)));
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
    case 'mediaSingle':
    case 'mediaGroup':
      // Container nodes — descend to the `media` children below.
      (node.content ?? []).forEach((c) => walkAdf(c, out, depth));
      return;
    case 'media': {
      // Jira embeds images as `media` nodes (not markdown image text). Only
      // `external` media carry a directly-usable URL; `file`/`link` media
      // reference an attachment `id` that needs a Jira API round-trip to
      // resolve — out of scope for this minimal converter, so we skip those.
      const url = node.attrs?.url;
      if (node.attrs?.type === 'external' && typeof url === 'string' && url.startsWith('https://')) {
        const alt = node.attrs?.alt ?? '';
        out.push(`![${alt}](${url})`);
        out.push('');
      }
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
