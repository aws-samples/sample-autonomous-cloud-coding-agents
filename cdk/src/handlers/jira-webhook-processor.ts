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
import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { ScreeningConfig } from './shared/attachment-screening';
import {
  buildIterationInstruction,
  parseCommentTrigger,
} from './shared/comment-trigger';
import { createTaskCore } from './shared/create-task-core';
import { renderMaturingReply } from './shared/iteration-reply';
import { extractDescriptionMarkdown } from './shared/jira-adf';
import {
  cleanupPreScreenedAttachments,
  downloadScreenAndStoreJiraAttachments,
  fetchRecentHumanComments,
  JiraAttachmentError,
  type RenderedComment,
} from './shared/jira-attachments';
import { reportIssueFailure } from './shared/jira-feedback';
import { resolveJiraOauthToken } from './shared/jira-oauth-resolver';
import type { JiraSubIssueNode } from './shared/jira-subissue-fetch';
import {
  prNumberFromTask,
  resolveTaskByJiraIssue,
  type JiraIssueTask,
} from './shared/jira-task-by-issue';
import { resolveSoleActiveJiraTenant } from './shared/jira-tenant-registry';
import type { SubIssueNode } from './shared/linear-subissue-fetch';
import { logger } from './shared/logger';
import { makeJiraChannel } from './shared/orchestration-channel-jira';
import { parseRetryIntent } from './shared/orchestration-comment-trigger';
import { discoverOrchestration } from './shared/orchestration-discovery';
import { jiraGraphSource } from './shared/orchestration-graph-source';
import { computeEpicRetryPlan } from './shared/orchestration-reconcile';
import {
  applyTerminalCreateFailures,
  readConcurrencyBudget,
  releaseReadyChildren,
} from './shared/orchestration-release';
import { upsertEpicPanel } from './shared/orchestration-rollup';
import {
  claimCommentAck,
  clearRollupClaim,
  deriveOrchestrationId,
  loadOrchestration,
  setStatusCommentId,
  type OrchestrationReleaseContext,
} from './shared/orchestration-store';
import type { Attachment, PassedAttachmentRecord } from './shared/types';
import { makeClient, makeDocClient } from './shared/ua';
import { MAX_TASK_DESCRIPTION_LENGTH } from './shared/validation';
import { CODING_WORKFLOW_ID } from './shared/workflows';

const ddb = makeDocClient();

const PROJECT_MAPPING_TABLE = process.env.JIRA_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.JIRA_USER_MAPPING_TABLE_NAME!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME;
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
const DEFAULT_LABEL_FILTER = 'bgagent';
const COMMENT_ACK_TTL_SECONDS = 86_400;

/** Max length of the idempotency key (matches validation's IDEMPOTENCY_KEY_PATTERN). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

// Attachment enrichment (#577). The processor downloads Jira `media` file
// attachments, screens them through the Bedrock Guardrail, and uploads the
// cleaned bytes to S3 before creating the task. All three must be configured;
// when they aren't, an issue carrying supported file attachments is rejected
// (fail-closed) rather than silently dropping them.
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const s3Client = ATTACHMENTS_BUCKET ? makeClient(S3Client) : undefined;
const bedrockClient = GUARDRAIL_ID && GUARDRAIL_VERSION ? makeClient(BedrockRuntimeClient) : undefined;
const screeningConfig: ScreeningConfig | undefined =
  bedrockClient && GUARDRAIL_ID && GUARDRAIL_VERSION
    ? { bedrockClient, guardrailId: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION }
    : undefined;

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
  readonly webhookEvent: 'jira:issue_created' | 'jira:issue_updated' | 'comment_created' | string;
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
      /** Jira `media` file attachments. Shape validated in jira-attachments.ts. */
      readonly attachment?: unknown[];
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
  readonly comment?: {
    readonly id?: string;
    readonly body?: unknown;
    readonly author?: {
      readonly accountId?: string;
      readonly accountType?: string;
      readonly displayName?: string;
    };
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

  const isIssueEvent =
    payload.webhookEvent === 'jira:issue_created'
    || payload.webhookEvent === 'jira:issue_updated';
  const isCommentEvent = payload.webhookEvent === 'comment_created';
  if (!isIssueEvent && !isCommentEvent) {
    logger.info('Jira processor skipping unsupported event', { webhookEvent: payload.webhookEvent });
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
  //   bind the delivery to the sole active tenant; `resolveSoleActiveJiraTenant`
  //   returns undefined (→ drop) when zero or multiple tenants are active, so
  //   a stack-wide secret can never steer an event at a chosen tenant.
  let cloudId: string | undefined;
  if (event.verified_via_stack_wide) {
    cloudId = await resolveSoleActiveJiraTenant(ddb, WORKSPACE_REGISTRY_TABLE);
    if (payload.cloudId && payload.cloudId !== cloudId) {
      logger.warn('Ignoring body cloudId on stack-wide-verified webhook; binding to sole active tenant', {
        body_cloud_id: payload.cloudId,
        bound_cloud_id: cloudId,
        issue_key: issue.key,
      });
    }
  } else {
    cloudId = payload.cloudId
      ?? (await resolveSoleActiveJiraTenant(ddb, WORKSPACE_REGISTRY_TABLE));
  }

  if (isCommentEvent) {
    if (!cloudId) {
      logger.warn('Jira comment webhook missing cloudId and no sole active tenant', {
        issue_key: issue.key,
      });
      return;
    }
    const commentProjectKey = issue.fields?.project?.key;
    if (
      commentProjectKey
      && !await getActiveProjectMapping(cloudId, commentProjectKey, issue.key)
    ) {
      return;
    }
    await handleCommentTrigger(payload, issue, cloudId, commentProjectKey);
    return;
  }

  const projectKey = issue.fields?.project?.key;
  if (!projectKey) {
    logger.info('Jira issue has no project.key — skipping (cannot route to a repo)', {
      issue_key: issue.key,
    });
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

  const mapping = await getActiveProjectMapping(cloudId, projectKey, issue.key);
  if (!mapping) {
    return;
  }
  const repo = mapping.repo as string;
  const labelFilter = (mapping.label_filter as string | undefined) ?? DEFAULT_LABEL_FILTER;

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

  const actorAccountId = payload.user?.accountId;
  const reporterAccountId = issue.fields?.reporter?.accountId;
  const creatorAccountId = issue.fields?.creator?.accountId;
  const accountId = actorAccountId ?? reporterAccountId ?? creatorAccountId;
  const accountSource = actorAccountId
    ? 'webhook_user'
    : reporterAccountId
      ? 'issue_reporter'
      : creatorAccountId
        ? 'issue_creator'
        : undefined;
  if (!accountId) {
    logger.warn('Jira webhook missing user.accountId — cannot attribute task', {
      issue_key: issue.key,
      jira_cloud_id: cloudId,
      jira_actor_account_id: actorAccountId,
      jira_reporter_account_id: reporterAccountId,
      jira_creator_account_id: creatorAccountId,
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
      jira_account_source: accountSource,
      jira_actor_account_id: actorAccountId,
      jira_reporter_account_id: reporterAccountId,
      jira_creator_account_id: creatorAccountId,
      jira_identity_lookup_key: `${cloudId}#${accountId}`,
      issue_key: issue.key,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      `❌ The Jira user for this trigger isn't linked to a platform user (accountId: \`${accountId}\`). `
      + `Ask an admin to run \`bgagent jira invite-user ${cloudId} ${accountId}\`, then redeem the generated link code.`,
    );
    return;
  }

  // Convert the ADF description to markdown once and reuse it for both the
  // task body and image-attachment extraction.
  const descriptionMarkdown = extractDescriptionMarkdown(issue.fields?.description);

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
  const statusOnStart = mapping.status_on_start as string | undefined;
  const statusOnPr = mapping.status_on_pr as string | undefined;
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
  let resolvedJira: Awaited<ReturnType<typeof resolveJiraOauthToken>> = null;
  if (WORKSPACE_REGISTRY_TABLE) {
    const resolved = await resolveJiraOauthToken(cloudId, WORKSPACE_REGISTRY_TABLE);
    if (!resolved) {
      logger.warn('Jira tenant not resolvable from registry — dropping event', {
        jira_cloud_id: cloudId,
        issue_key: issue.key,
      });
      return;
    }
    resolvedJira = resolved;
    channelMetadata.jira_oauth_secret_arn = resolved.oauthSecretArn;
    channelMetadata.jira_site_url = resolved.siteUrl;
  }

  let orchestrationChildren: readonly SubIssueNode[] | undefined;
  let existingOrchestration = false;
  if (ORCHESTRATION_TABLE && resolvedJira) {
    // Re-read an existing orchestration's authored graph so genuinely-new Jira
    // subtasks can be appended. The flag also prevents parent attachments from
    // being uploaded again below: the meta row already pins the first seed's S3
    // versions, and replacing them would eventually expire those pinned objects.
    const existing = await loadOrchestration(
      ddb,
      ORCHESTRATION_TABLE,
      deriveOrchestrationId(issue.key),
    );
    existingOrchestration = existing !== null;

    const graphResult = await jiraGraphSource(
      resolvedJira.accessToken,
      cloudId,
      issue.key,
    )();
    if (graphResult.kind === 'error') {
      await safeReportIssueFailure(
        issue.key,
        cloudId,
        `❌ ABCA couldn't read this issue's Jira subtasks: ${graphResult.message}`,
      );
      return;
    }
    if (graphResult.kind === 'no_children' && existingOrchestration) {
      logger.info('Jira orchestration re-trigger has no current subtasks — no-op', {
        issue_key: issue.key,
      });
      return;
    }
    if (graphResult.kind === 'ok') {
      const routed = await routeJiraOrchestrationChildren({
        cloudId,
        parentProjectKey: projectKey,
        parentMapping: mapping,
        parentRepo: repo,
        children: graphResult.children as readonly JiraSubIssueNode[],
        oauthSecretArn: resolvedJira.oauthSecretArn,
        siteUrl: resolvedJira.siteUrl,
      });
      if (!routed.ok) {
        await safeReportIssueFailure(issue.key, cloudId, `❌ ${routed.message}`);
        return;
      }
      orchestrationChildren = routed.children;
    }
  }

  // Embedded HTTPS image URLs from the description (unchanged, #577 preserves).
  const urlAttachments = extractImageUrlAttachments(descriptionMarkdown);

  // Mint the task ID up front so pre-screened attachment S3 keys match the
  // eventual task record (createTaskCore honors context.taskId, #577).
  const taskId = ulid();

  // Context enrichment (#577). Both need the workspace registry to resolve an
  // OAuth token. Comments are fail-open (advisory); attachments are
  // fail-closed (a selected-but-unscreenable attachment rejects the task).
  let comments: RenderedComment[] = [];
  let preScreenedAttachments: PassedAttachmentRecord[] = [];
  if (WORKSPACE_REGISTRY_TABLE && !existingOrchestration) {
    const tenantCtx = { cloudId, registryTableName: WORKSPACE_REGISTRY_TABLE };

    // Recent human comments — advisory context, never gate task creation.
    const fetchedComments = await fetchRecentHumanComments(tenantCtx, issue.key);
    // Fail-OPEN on comment content policy: comments are third-party text the
    // reporter didn't write, so a policy-tripping comment must not fail the
    // reporter's task. Screen the rendered comment section on its own and drop
    // it (not the task) if the guardrail intervenes. (createTaskCore separately
    // screens the description, which the reporter authored.)
    comments = await screenCommentsOrDrop(fetchedComments, issue.key, cloudId);

    const rawAttachments = issue.fields?.attachment;
    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      if (!s3Client || !ATTACHMENTS_BUCKET || !screeningConfig) {
        // Fail-closed: the issue has attachments but the processor can't
        // screen/store them. Don't silently drop selected context — reject
        // with a clear comment so the operator can fix configuration.
        logger.error('Jira issue has attachments but screening/storage is not configured (fail-closed)', {
          issue_key: issue.key,
          jira_cloud_id: cloudId,
          has_bucket: Boolean(ATTACHMENTS_BUCKET),
          has_guardrail: Boolean(screeningConfig),
        });
        await safeReportIssueFailure(
          issue.key,
          cloudId,
          '❌ This Jira issue has file attachments, but ABCA attachment screening is not configured. Contact your ABCA admin.',
        );
        return;
      }
      // Combined cap: URL image attachments already consume slots.
      const remainingSlots = 10 - urlAttachments.length;
      try {
        preScreenedAttachments = await downloadScreenAndStoreJiraAttachments(
          rawAttachments,
          remainingSlots,
          { ...tenantCtx, s3Client, bucketName: ATTACHMENTS_BUCKET, screeningConfig, userId: platformUserId, taskId },
        );
      } catch (err) {
        if (err instanceof JiraAttachmentError) {
          logger.warn('Rejecting Jira task: attachment could not be safely processed', {
            issue_key: issue.key,
            jira_cloud_id: cloudId,
            error: err.message,
          });
          await safeReportIssueFailure(
            issue.key,
            cloudId,
            `❌ ABCA couldn't safely process an attachment on this issue: ${err.message} Remove or fix the attachment and re-apply the trigger label.`,
          );
          return;
        }
        throw err;
      }
    }
  }

  const taskDescription = buildTaskDescription(issue, descriptionMarkdown, comments);

  if (ORCHESTRATION_TABLE && orchestrationChildren) {
    const releaseContext: OrchestrationReleaseContext = {
      platform_user_id: platformUserId,
      channel_source: 'jira',
      trigger_label: (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase(),
      ...(statusOnStart && { jira_status_on_start: statusOnStart }),
      ...(statusOnPr && { jira_status_on_pr: statusOnPr }),
      parent_context: {
        ...(issue.fields?.summary && { title: issue.fields.summary }),
        ...(descriptionMarkdown && { description: descriptionMarkdown }),
      },
      ...(preScreenedAttachments.length > 0 && {
        pre_screened_attachments: preScreenedAttachments,
      }),
    };
    const discovery = await discoverOrchestration({
      ddb,
      tableName: ORCHESTRATION_TABLE,
      parentIssueRef: issue.key,
      credentialsRef: cloudId,
      repo,
      now: new Date().toISOString(),
      releaseContext,
      graphSource: async () => ({ kind: 'ok', children: orchestrationChildren }),
    });

    if (discovery.kind === 'rejected' || discovery.kind === 'error') {
      if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
        await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
      }
      await safeReportIssueFailure(
        issue.key,
        cloudId,
        `❌ ABCA couldn't create this Jira orchestration: ${discovery.message}`,
      );
      return;
    }

    // A concurrent replay can win between the preflight read and the seed
    // condition. The shared discovery path returns that race as an empty extend;
    // any attachment objects uploaded by this invocation are duplicates.
    if (discovery.kind === 'seeded' && discovery.alreadyExisted) {
      if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
        await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
      }
      return;
    }

    if (discovery.kind === 'seeded') {
      const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (snapshot) {
        const now = new Date().toISOString();
        const budget = USER_CONCURRENCY_TABLE
          ? await readConcurrencyBudget(
            ddb,
            USER_CONCURRENCY_TABLE,
            snapshot.meta.release_context.platform_user_id,
            MAX_CONCURRENT,
          )
          : undefined;
        const results = await releaseReadyChildren(
          ddb,
          ORCHESTRATION_TABLE,
          snapshot.children,
          snapshot.meta.release_context,
          createTaskCore,
          now,
          snapshot.children,
          'main',
          budget,
        );
        await applyTerminalCreateFailures(
          ddb,
          ORCHESTRATION_TABLE,
          discovery.orchestrationId,
          snapshot.children,
          results,
          now,
        );

        if (WORKSPACE_REGISTRY_TABLE) {
          try {
            const fresh = await loadOrchestration(
              ddb,
              ORCHESTRATION_TABLE,
              discovery.orchestrationId,
            );
            if (fresh) {
              const commentId = await upsertEpicPanel({
                channel: makeJiraChannel(WORKSPACE_REGISTRY_TABLE),
                parent: {
                  issueId: issue.key,
                  credentialsRef: cloudId,
                  stateOverrides: {
                    ...(statusOnStart && { started: statusOnStart }),
                    ...(statusOnPr && { inReview: statusOnPr }),
                  },
                },
                children: fresh.children,
                labelFilter,
              });
              if (commentId) {
                await setStatusCommentId(
                  ddb,
                  ORCHESTRATION_TABLE,
                  discovery.orchestrationId,
                  commentId,
                );
              }
            }
          } catch (err) {
            logger.warn('Failed to post Jira orchestration panel at seed (non-fatal)', {
              issue_key: issue.key,
              orchestration_id: discovery.orchestrationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      logger.info('Jira orchestration seeded — parent task suppressed', {
        issue_key: issue.key,
        orchestration_id: discovery.orchestrationId,
        child_count: discovery.childCount,
      });
      return;
    }
    if (discovery.kind === 'extended') {
      if (discovery.addedSubIssueIds.length === 0) {
        logger.info('Jira orchestration re-trigger added no new subtasks', {
          issue_key: issue.key,
          orchestration_id: discovery.orchestrationId,
        });
        return;
      }

      const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (snapshot) {
        const releasableRows = snapshot.children.filter(
          (child) => discovery.releasableSubIssueIds.includes(child.sub_issue_id)
            && child.child_status === 'ready',
        );
        let panelSnapshot = snapshot;
        if (releasableRows.length > 0) {
          const now = new Date().toISOString();
          const results = await releaseReadyChildren(
            ddb,
            ORCHESTRATION_TABLE,
            releasableRows,
            snapshot.meta.release_context,
            createTaskCore,
            now,
            snapshot.children,
          );
          await applyTerminalCreateFailures(
            ddb,
            ORCHESTRATION_TABLE,
            discovery.orchestrationId,
            snapshot.children,
            results,
            now,
          );
          panelSnapshot = await loadOrchestration(
            ddb,
            ORCHESTRATION_TABLE,
            discovery.orchestrationId,
          ) ?? snapshot;
        }

        if (WORKSPACE_REGISTRY_TABLE) {
          try {
            // Unlike seed, extension already has a durable snapshot. Refresh the
            // panel from it even if a post-release read is temporarily unavailable.
            const commentId = await upsertEpicPanel({
              channel: makeJiraChannel(WORKSPACE_REGISTRY_TABLE),
              parent: {
                issueId: issue.key,
                credentialsRef: cloudId,
                stateOverrides: {
                  ...(panelSnapshot.meta.release_context.jira_status_on_start && {
                    started: panelSnapshot.meta.release_context.jira_status_on_start,
                  }),
                  ...(panelSnapshot.meta.release_context.jira_status_on_pr && {
                    inReview: panelSnapshot.meta.release_context.jira_status_on_pr,
                  }),
                },
              },
              ...(panelSnapshot.meta.status_comment_id && {
                statusCommentId: panelSnapshot.meta.status_comment_id,
              }),
              children: panelSnapshot.children,
              inProgress: true,
              labelFilter,
            });
            if (commentId && !panelSnapshot.meta.status_comment_id) {
              await setStatusCommentId(
                ddb,
                ORCHESTRATION_TABLE,
                discovery.orchestrationId,
                commentId,
              );
            }
          } catch (err) {
            logger.warn('Failed to refresh Jira orchestration panel on extend (non-fatal)', {
              issue_key: issue.key,
              orchestration_id: discovery.orchestrationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      logger.info('Jira orchestration extended with new subtasks', {
        issue_key: issue.key,
        orchestration_id: discovery.orchestrationId,
        added_count: discovery.addedSubIssueIds.length,
        releasable_count: discovery.releasableSubIssueIds.length,
      });
      return;
    }
  }

  const requestId = crypto.randomUUID();
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      // Explicit coding workflow: a label-triggered Jira task always targets a
      // mapped repo, so it must not fall through the resolution ladder to the
      // repo-less default/agent-v1 (which never commits or opens a PR). #546
      workflow_ref: CODING_WORKFLOW_ID,
      ...(urlAttachments.length > 0 && { attachments: urlAttachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'jira',
      channelMetadata,
      taskId,
      // Deterministic key so an async re-delivery of the same trigger event
      // dedupes instead of minting a second task (and re-downloading every
      // attachment). Keyed on issue + webhook timestamp, matching the
      // receiver's dedup key shape.
      idempotencyKey: buildIdempotencyKey(issue.key, payload.timestamp),
      ...(preScreenedAttachments.length > 0 && { preScreenedAttachments }),
    },
    requestId,
  );

  if (result.statusCode === 200) {
    // Idempotent replay: this is a duplicate delivery of the same trigger event
    // (createTaskCore matched the deterministic idempotency key to an existing
    // task). Not a failure — but the attachments we re-downloaded and uploaded
    // this round are keyed on a fresh taskId the replayed task doesn't
    // reference, so delete them rather than orphan them. No ❌ comment.
    logger.info('Jira-triggered task was an idempotent replay (duplicate delivery)', {
      issue_key: issue.key,
      request_id: requestId,
    });
    if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
      await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
    }
    return;
  }

  if (result.statusCode !== 201) {
    logger.warn('Jira-triggered task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_key: issue.key,
    });
    // Don't orphan the attachment objects we uploaded before this call failed —
    // createTaskCore only rolls back its own inline uploads, not ours.
    if (preScreenedAttachments.length > 0 && s3Client && ATTACHMENTS_BUCKET) {
      await cleanupPreScreenedAttachments(s3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
    }
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
 * Handle `comment_created` independently of the label-trigger path.
 *
 * When Jira supplies project.key, the caller establishes that its mapping is
 * active. Otherwise the prior task supplies the project key and this handler
 * revalidates that mapping before producing feedback or creating a task.
 * Comments do not require the trigger label to remain present.
 */
async function handleCommentTrigger(
  payload: JiraIssueEvent,
  issue: NonNullable<JiraIssueEvent['issue']>,
  cloudId: string,
  verifiedProjectKey?: string,
): Promise<void> {
  const comment = payload.comment;
  if (!comment?.id) {
    logger.warn('Jira comment payload missing comment.id', { issue_key: issue.key });
    return;
  }

  // Native app users are never human reviewers. ABCA's own 3LO comments are
  // attributed to the authorizing Atlassian user, so parseCommentTrigger also
  // rejects ABCA's stable rendered prefixes to prevent self-trigger loops.
  if (comment.author?.accountType?.toLowerCase() === 'app') {
    logger.info('Ignoring Jira app-authored comment', {
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }

  const commentBody = extractDescriptionMarkdown(comment.body);
  const trigger = parseCommentTrigger(commentBody);
  if (!trigger.triggered) {
    logger.info('Jira comment has no @bgagent trigger', {
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }

  let linkedCommentAuthor: string | null | undefined;
  if (parseRetryIntent(trigger.instruction)) {
    linkedCommentAuthor = comment.author?.accountId
      ? await lookupPlatformUser(cloudId, comment.author.accountId)
      : null;
    if (!linkedCommentAuthor) {
      logger.warn('Jira epic retry refused: commenter has no linked platform user', {
        jira_cloud_id: cloudId,
        jira_account_id: comment.author?.accountId,
        issue_key: issue.key,
        comment_id: comment.id,
      });
      await safeReportIssueFailure(
        issue.key,
        cloudId,
        'I can only retry an orchestration for a linked ABCA user. '
          + 'Link your Jira account first, then comment `@bgagent retry` again.',
      );
      return;
    }
    if (await handleJiraEpicRetry(issue.key, cloudId, comment.id)) {
      return;
    }
  }

  const priorTask = await resolveTaskByJiraIssue(
    ddb,
    TASK_TABLE,
    cloudId,
    issue.key,
  );
  if (!verifiedProjectKey) {
    const priorProjectKey = priorTask?.channel_metadata?.jira_project_key;
    if (!priorProjectKey) {
      logger.info(
        'Jira comment issue has no project.key or prior project metadata — skipping silently',
        { issue_key: issue.key },
      );
      return;
    }
    if (!await getActiveProjectMapping(cloudId, priorProjectKey, issue.key)) {
      return;
    }
    logger.warn('Jira comment issue has no project.key — routing via active prior task project', {
      issue_key: issue.key,
      project_key: priorProjectKey,
    });
  }
  const prNumber = priorTask ? prNumberFromTask(priorTask) : null;
  if (!priorTask || prNumber === null) {
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ I couldn't find an ABCA pull request for this Jira issue. Run the issue with the configured ABCA trigger label first, then retry this comment.",
    );
    return;
  }
  if (!priorTask.repo) {
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      "❌ I found the earlier ABCA task, but it has no repository recorded, so I can't update its pull request.",
    );
    return;
  }

  linkedCommentAuthor ??= comment.author?.accountId
    ? await lookupPlatformUser(cloudId, comment.author.accountId)
    : null;
  const platformUserId = linkedCommentAuthor ?? priorTask.user_id;
  if (!platformUserId) {
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      '❌ I found the pull request, but neither the comment author nor the original task has a linked ABCA user.',
    );
    return;
  }

  if (!WORKSPACE_REGISTRY_TABLE) {
    logger.warn('Cannot run Jira comment iteration: workspace registry is not configured', {
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }
  const resolved = await resolveJiraOauthToken(cloudId, WORKSPACE_REGISTRY_TABLE);
  if (!resolved) {
    logger.warn('Cannot run Jira comment iteration: tenant OAuth is unavailable', {
      jira_cloud_id: cloudId,
      issue_key: issue.key,
      comment_id: comment.id,
    });
    return;
  }

  const channelMetadata = buildIterationChannelMetadata(
    priorTask,
    issue,
    cloudId,
    comment.id,
    resolved.oauthSecretArn,
    resolved.siteUrl,
  );
  const idempotencyKey = buildCommentIdempotencyKey(cloudId, issue.key, comment.id);
  const requestId = crypto.randomUUID();
  const taskId = ulid();
  const result = await createTaskCore(
    {
      repo: priorTask.repo,
      workflow_ref: 'coding/pr-iteration-v1',
      pr_number: prNumber,
      task_description: buildIterationInstruction(trigger),
    },
    {
      userId: platformUserId,
      channelSource: 'jira',
      channelMetadata,
      idempotencyKey,
      taskId,
    },
    requestId,
  );

  if (result.statusCode === 200) {
    logger.info('Jira comment iteration was an idempotent replay', {
      issue_key: issue.key,
      comment_id: comment.id,
      prior_task_id: priorTask.task_id,
    });
    return;
  }

  if (result.statusCode !== 201) {
    logger.warn('Jira comment iteration task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_key: issue.key,
      comment_id: comment.id,
    });
    await safeReportIssueFailure(
      issue.key,
      cloudId,
      buildCreateTaskFailureMessage(
        result.statusCode,
        result.body,
        'Please add a new `@bgagent` comment in a few minutes.',
      ),
    );
    return;
  }

  try {
    const reply = await makeJiraChannel(WORKSPACE_REGISTRY_TABLE).postComment(
      { issueId: issue.key, credentialsRef: cloudId },
      renderMaturingReply({ state: 'on_it' }),
    );
    if (reply?.commentId) {
      await ddb.send(new UpdateCommand({
        TableName: TASK_TABLE,
        Key: { task_id: taskId },
        UpdateExpression: 'SET channel_metadata.iteration_reply_comment_id = :comment_id',
        ConditionExpression: 'attribute_exists(task_id)',
        ExpressionAttributeValues: { ':comment_id': reply.commentId },
      }));
    }
  } catch (err) {
    logger.warn('Jira iteration acknowledgement failed (non-fatal)', {
      task_id: taskId,
      issue_key: issue.key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('Jira comment-triggered PR iteration task created', {
    task_id: taskId,
    issue_key: issue.key,
    comment_id: comment.id,
    prior_task_id: priorTask.task_id,
    repo: priorTask.repo,
    pr_number: prNumber,
    attributed_to_linked_comment_author: Boolean(linkedCommentAuthor),
    request_id: requestId,
  });
}

/**
 * Retry a terminal Jira parent orchestration without requiring the parent to
 * have its own task or PR. Successful children remain untouched; only failed
 * and transitively skipped nodes are reset and released.
 */
async function handleJiraEpicRetry(
  parentIssueKey: string,
  cloudId: string,
  commentId: string,
): Promise<boolean> {
  if (!ORCHESTRATION_TABLE) return false;
  const orchestrationId = deriveOrchestrationId(parentIssueKey);
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot || snapshot.meta.parent_issue_ref !== parentIssueKey) return false;

  const now = new Date().toISOString();
  const claimed = await claimCommentAck(
    ddb,
    ORCHESTRATION_TABLE,
    orchestrationId,
    `retry:${commentId}`,
    now,
    Math.floor(Date.now() / 1000) + COMMENT_ACK_TTL_SECONDS,
  );
  if (!claimed) return true;

  const plan = computeEpicRetryPlan(snapshot.children);
  if (plan.statusUpdates.length === 0) {
    const allSucceeded = plan.succeededCount === snapshot.children.length
      && snapshot.children.length > 0;
    await safeReportIssueFailure(
      parentIssueKey,
      cloudId,
      allSucceeded
        ? "👋 Everything in this orchestration already succeeded — there's nothing to retry."
        : "👋 This orchestration is still running — nothing has failed yet, so there's nothing to retry.",
    );
    return true;
  }

  const previousStatus = new Map(
    snapshot.children.map((child) => [child.sub_issue_id, child.child_status]),
  );
  for (const update of plan.statusUpdates) {
    const prior = previousStatus.get(update.sub_issue_id);
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :next, updated_at = :now',
        ConditionExpression: 'child_status = :prior',
        ExpressionAttributeValues: {
          ':next': update.child_status,
          ':prior': prior,
          ':now': now,
        },
      }));
    } catch (err) {
      logger.warn('Jira epic retry child reset lost a race; continuing best-effort', {
        orchestration_id: orchestrationId,
        sub_issue_id: update.sub_issue_id,
        prior_status: prior,
        next_status: update.child_status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  const reset = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!reset) return true;
  const ready = reset.children.filter(
    (child) => plan.toRelease.includes(child.sub_issue_id)
      && child.child_status === 'ready',
  );
  const budget = USER_CONCURRENCY_TABLE
    ? await readConcurrencyBudget(
      ddb,
      USER_CONCURRENCY_TABLE,
      reset.meta.release_context.platform_user_id,
      MAX_CONCURRENT,
    )
    : undefined;
  const releaseResults = await releaseReadyChildren(
    ddb,
    ORCHESTRATION_TABLE,
    ready,
    reset.meta.release_context,
    createTaskCore,
    now,
    reset.children,
    'main',
    budget,
    true,
  );
  await applyTerminalCreateFailures(
    ddb,
    ORCHESTRATION_TABLE,
    orchestrationId,
    reset.children,
    releaseResults,
    now,
  );

  await safeReportIssueFailure(
    parentIssueKey,
    cloudId,
    `🔄 Retrying ${plan.failedCount} failed and ${plan.skippedCount} skipped sub-issue(s); `
      + `${plan.succeededCount} successful sub-issue(s) are unchanged.`,
  );
  if (WORKSPACE_REGISTRY_TABLE) {
    const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
    if (refreshed) {
      const panelId = await upsertEpicPanel({
        channel: makeJiraChannel(WORKSPACE_REGISTRY_TABLE),
        parent: {
          issueId: parentIssueKey,
          credentialsRef: cloudId,
          stateOverrides: {
            ...(refreshed.meta.release_context.jira_status_on_start && {
              started: refreshed.meta.release_context.jira_status_on_start,
            }),
            ...(refreshed.meta.release_context.jira_status_on_pr && {
              inReview: refreshed.meta.release_context.jira_status_on_pr,
            }),
          },
        },
        children: refreshed.children,
        statusCommentId: refreshed.meta.status_comment_id,
        inProgress: true,
        labelFilter: refreshed.meta.release_context.trigger_label,
      });
      if (panelId) {
        await setStatusCommentId(ddb, ORCHESTRATION_TABLE, orchestrationId, panelId);
      }
    }
  }
  logger.info('Jira epic retry released failed/skipped graph', {
    orchestration_id: orchestrationId,
    parent_issue_key: parentIssueKey,
    failed: plan.failedCount,
    skipped: plan.skippedCount,
    succeeded: plan.succeededCount,
  });
  return true;
}

function buildIterationChannelMetadata(
  priorTask: JiraIssueTask,
  issue: NonNullable<JiraIssueEvent['issue']>,
  cloudId: string,
  commentId: string,
  oauthSecretArn: string,
  siteUrl: string,
): Record<string, string> {
  const previous = priorTask.channel_metadata ?? {};
  const metadata: Record<string, string> = {
    jira_cloud_id: cloudId,
    jira_issue_id: issue.id,
    jira_issue_key: issue.key,
    jira_oauth_secret_arn: oauthSecretArn,
    jira_site_url: siteUrl,
    jira_trigger_comment_id: commentId,
    jira_prior_task_id: priorTask.task_id,
    trigger_comment_id: commentId,
    trigger_comment_issue_id: issue.key,
  };

  const projectKey = issue.fields?.project?.key ?? previous.jira_project_key;
  if (projectKey) metadata.jira_project_key = projectKey;
  if (previous.jira_status_on_start) {
    metadata.jira_status_on_start = previous.jira_status_on_start;
  }
  if (previous.jira_status_on_pr) {
    metadata.jira_status_on_pr = previous.jira_status_on_pr;
  }
  if (previous.orchestration_id && previous.orchestration_sub_issue_id) {
    metadata.orchestration_id = previous.orchestration_id;
    metadata.orchestration_sub_issue_id = previous.orchestration_sub_issue_id;
    metadata.orchestration_iteration = 'true';
  }
  return metadata;
}

type ProjectMapping = Readonly<Record<string, unknown>>;

async function routeJiraOrchestrationChildren(params: {
  readonly cloudId: string;
  readonly parentProjectKey: string;
  readonly parentMapping: ProjectMapping;
  readonly parentRepo: string;
  readonly children: readonly JiraSubIssueNode[];
  readonly oauthSecretArn: string;
  readonly siteUrl: string;
}): Promise<
  | { readonly ok: true; readonly children: readonly SubIssueNode[] }
  | { readonly ok: false; readonly message: string }
> {
  const mappings = new Map<string, ProjectMapping>([
    [params.parentProjectKey, params.parentMapping],
  ]);
  for (const projectKey of new Set(params.children.map((child) => child.project_key))) {
    if (mappings.has(projectKey)) continue;
    const result = await ddb.send(new GetCommand({
      TableName: PROJECT_MAPPING_TABLE,
      Key: { jira_project_identity: `${params.cloudId}#${projectKey}` },
    }));
    if (result.Item) mappings.set(projectKey, result.Item);
  }

  for (const child of params.children) {
    const childMapping = mappings.get(child.project_key);
    if (!childMapping || childMapping.status !== 'active' || typeof childMapping.repo !== 'string') {
      return {
        ok: false,
        message: `${child.identifier ?? child.id} belongs to Jira project ${child.project_key}, `
          + 'which is not actively mapped to an ABCA repository. Map that project and re-apply the trigger label.',
      };
    }
    if (childMapping.repo !== params.parentRepo) {
      return {
        ok: false,
        message: `${child.identifier ?? child.id} maps to ${childMapping.repo}, but the parent maps to `
          + `${params.parentRepo}. All executable Jira subtasks must map to the same repository.`,
      };
    }
  }

  return {
    ok: true,
    children: params.children.map((child) => {
      const childMapping = mappings.get(child.project_key)!;
      return {
        ...child,
        channel_metadata: {
          jira_cloud_id: params.cloudId,
          jira_project_key: child.project_key,
          jira_issue_id: child.issue_id,
          jira_issue_key: child.identifier ?? child.id,
          jira_oauth_secret_arn: params.oauthSecretArn,
          jira_site_url: params.siteUrl,
          ...(typeof childMapping.status_on_start === 'string' && {
            jira_status_on_start: childMapping.status_on_start,
          }),
          ...(typeof childMapping.status_on_pr === 'string' && {
            jira_status_on_pr: childMapping.status_on_pr,
          }),
        },
      };
    }),
  };
}

function buildCommentIdempotencyKey(
  cloudId: string,
  issueKey: string,
  commentId: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${cloudId}\0${issueKey}\0${commentId}`)
    .digest('hex');
  return `jira-iterate-${digest}`;
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
function buildCreateTaskFailureMessage(
  statusCode: number,
  rawBody: string,
  retryHint = 'Please re-apply the trigger label in a few minutes.',
): string {
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
    return `❌ ABCA is temporarily unavailable (status ${statusCode}). ${retryHint}`;
  }
  if (detail) {
    return `❌ ABCA couldn't create this task (status ${statusCode}): ${detail}`;
  }
  return `❌ ABCA couldn't create this task (status ${statusCode}). Check the ABCA admin logs for details.`;
}

function buildTaskDescription(
  issue: NonNullable<JiraIssueEvent['issue']>,
  descriptionMarkdown: string,
  comments: readonly RenderedComment[] = [],
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
  const core = parts.join('\n');

  // Fold recent human comments in (oldest-first, already rendered to markdown)
  // under a clear heading so the agent can tell them from the description
  // (#577). Comments are ADVISORY and must stay fail-open: they must never grow
  // the description past MAX_TASK_DESCRIPTION_LENGTH and turn createTaskCore's
  // length check into a hard rejection. Only append what fits the remaining
  // budget (reserving a small margin), truncating the section if needed.
  if (comments.length === 0) return core;
  const commentSection = renderCommentSection(comments);
  const separator = '\n';
  const budget = MAX_TASK_DESCRIPTION_LENGTH - core.length - separator.length;
  if (budget <= 0) return core; // description already fills the budget — drop comments
  const fitted = commentSection.length <= budget
    ? commentSection
    : truncateCommentSection(commentSection, budget);
  return fitted ? core + separator + fitted : core;
}

/** Notice appended when the comment section is truncated to fit the budget. */
const COMMENT_TRUNCATION_NOTICE = '\n\n_(recent comments truncated)_';

function renderCommentSection(comments: readonly RenderedComment[]): string {
  const lines: string[] = ['', '## Recent comments'];
  for (const c of comments) {
    lines.push('');
    const attribution = c.createdAt ? `**${c.author}** (${c.createdAt}):` : `**${c.author}**:`;
    lines.push(attribution);
    lines.push(c.markdown);
  }
  return lines.join('\n');
}

/**
 * Trim a rendered comment section to at most `budget` characters, leaving room
 * for a truncation notice. Returns '' if even the heading + notice can't fit,
 * so the caller cleanly drops the section.
 */
function truncateCommentSection(section: string, budget: number): string {
  const room = budget - COMMENT_TRUNCATION_NOTICE.length;
  if (room <= 0) return '';
  return section.slice(0, room) + COMMENT_TRUNCATION_NOTICE;
}

/**
 * Screen the rendered comment block through the Bedrock Guardrail on its own,
 * so third-party comment content that trips the policy is DROPPED (fail-open)
 * rather than gating the reporter's task. Returns the comments unchanged when
 * they pass, and `[]` when the guardrail intervenes or is unavailable — the
 * task still proceeds with the reporter-authored summary/description (which
 * createTaskCore screens separately). This keeps the comment-enrichment
 * contract fail-open end to end (issue #577 review, item 4).
 */
async function screenCommentsOrDrop(
  comments: RenderedComment[],
  issueKey: string,
  cloudId: string,
): Promise<RenderedComment[]> {
  if (comments.length === 0) return comments;
  if (!bedrockClient || !GUARDRAIL_ID || !GUARDRAIL_VERSION) {
    // No guardrail configured — drop unscreened third-party text rather than
    // route it, unscreened, into the agent context.
    logger.warn('Dropping Jira comments: guardrail not configured to screen them', {
      issue_key: issueKey,
      jira_cloud_id: cloudId,
    });
    return [];
  }
  const text = renderCommentSection(comments);
  try {
    const result = await bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));
    if (result.action === 'GUARDRAIL_INTERVENED') {
      logger.warn('Dropping Jira comments: blocked by content policy (task still proceeds)', {
        issue_key: issueKey,
        jira_cloud_id: cloudId,
      });
      return [];
    }
    return comments;
  } catch (err) {
    // Fail-open on a screening outage too — comments are advisory.
    logger.warn('Dropping Jira comments: screening unavailable (task still proceeds)', {
      issue_key: issueKey,
      jira_cloud_id: cloudId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Deterministic idempotency key for a trigger event: `<issueKey>#<timestamp>`,
 * sanitized to the allowed key charset (`[A-Za-z0-9_-]{1,128}`). A webhook
 * re-delivery of the same event yields the same key so createTaskCore dedupes
 * instead of creating a duplicate task (and re-downloading attachments). Falls
 * back to undefined if we can't form a stable key, preserving prior behavior.
 */
function buildIdempotencyKey(issueKey: string, timestamp: number | undefined): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  const raw = `jira-${issueKey}-${timestamp}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  return sanitized || undefined;
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
    ConsistentRead: true,
  }));
  const platformUserId = result.Item?.platform_user_id;
  if (
    result.Item?.status !== 'active'
    || typeof platformUserId !== 'string'
    || !platformUserId
  ) {
    return null;
  }
  return platformUserId;
}

async function getActiveProjectMapping(
  cloudId: string,
  projectKey: string,
  issueKey: string,
): Promise<Record<string, unknown> | null> {
  const projectIdentity = `${cloudId}#${projectKey}`;
  const mapping = await ddb.send(new GetCommand({
    TableName: PROJECT_MAPPING_TABLE,
    Key: { jira_project_identity: projectIdentity },
    ConsistentRead: true,
  }));
  if (!mapping.Item || mapping.Item.status !== 'active') {
    // Jira admin-console webhooks fire site-wide. An unmapped project has not
    // opted into ABCA, so it must remain a true no-op for every event type.
    logger.info('Jira project is not onboarded or is removed — skipping silently', {
      jira_project_identity: projectIdentity,
      issue_key: issueKey,
    });
    return null;
  }
  return mapping.Item;
}
