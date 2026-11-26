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
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { TERMINAL_STATUSES, type TaskStatusType } from '../constructs/task-status';
import type { ScreeningConfig } from './shared/attachment-screening';
import { APPENDED_BLOCK, buildClarifyResumeDescription, isClarifyHold } from './shared/clarify-resume';
import { createTaskCore } from './shared/create-task-core';
import { renderMaturingReply } from './shared/iteration-reply';
import { AGENT_SESSION_EVENT_TYPE, isLinearAgentSessionsEnabled, type LinearAgentSessionEvent } from './shared/linear-agent-session-event';
import { handleAgentSessionEvent } from './shared/linear-agent-session-handler';
import { cleanupPreScreenedAttachments, downloadScreenAndStoreLinearAttachments, LinearAttachmentError } from './shared/linear-attachments';
import {
  lookupLinearPlatformUser,
  lookupLinearProjectMapping,
  vaultMetadata,
  workspaceDeliversAgentSessions,
} from './shared/linear-channel-metadata';
import { readStartClaim, releaseStartClaim } from './shared/linear-console';
import {
  deleteComment,
  fetchRecentComments,
  type RenderedComment,
} from './shared/linear-feedback';
import {
  probeLinearIssueContext,
  renderIssueContextHint,
  type LinearProbeAttachment,
  type LinearProbeDocument,
} from './shared/linear-issue-context-probe';
import {
  renderEpicAlreadyCompleteNote,
  renderEpicRetryNote,
  renderLabelHelp,
  renderNoLinkedTaskNudge,
  renderTaskLookupFailedNudge,
  renderWrongMentionNudge,
} from './shared/linear-notes';
import { resolveLinearOauthToken, resolveSoleActiveLinearWorkspace } from './shared/linear-oauth-resolver';
import { fetchIssueParentId } from './shared/linear-subissue-fetch';
import { lookupTaskByLinearIssue } from './shared/linear-task-by-issue';
import { logger } from './shared/logger';
import { type LookupResult, LOOKUP_ABSENT, isLookupFailure, lookupFailed, lookupFound, lookupValueOr } from './shared/lookup-result';
import { type Channel, type IssueRef } from './shared/orchestration-channel';
import { makeLinearChannel } from './shared/orchestration-channel-linear';
import {
  buildIntegrationIterationInstruction,
  buildIterationInstruction,
  detectNearMissMention,
  parseCommentTrigger,
  parseRetryIntent,
  type CommentTrigger,
} from './shared/orchestration-comment-trigger';
import { discoverOrchestration } from './shared/orchestration-discovery';
import { linearGraphSource } from './shared/orchestration-graph-source';
import { isIntegrationNode } from './shared/orchestration-integration-node';
import {
  nodeDisplayId,
  parseParentNodeReference,
  renderParentDisambiguationReply,
  suggestClosestNode,
  looksLikeNewWork,
} from './shared/orchestration-parent-comment';
import { computeEpicRetryPlan } from './shared/orchestration-reconcile';
import { applyTerminalCreateFailures, readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { upsertEpicPanel } from './shared/orchestration-rollup';
import { claimCommentAck, clearRollupClaim, deriveOrchestrationId, loadOrchestration, refreshUnstartedText, setChildOwnAttachments, setRetryCommentId, setStatusCommentId, type OrchestrationChildRow, type OrchestrationReleaseContext } from './shared/orchestration-store';
import { prNumberFromTask, readTaskPrNumber } from './shared/task-pr-number';
import { DEFAULT_LABEL_FILTER, hasHelpLabel, HELP_SUFFIX } from './shared/trigger-label';
import type { Attachment, PassedAttachmentRecord } from './shared/types';
import { makeClient, makeDocClient } from './shared/ua';
import { MAX_ATTACHMENTS_PER_TASK, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_TASK_DESCRIPTION_LENGTH } from './shared/validation';
import { emitWebhookScreeningFailedMetric } from './shared/webhook-screening-metric';
import { CODING_WORKFLOW_ID, PR_ITERATION_WORKFLOW_ID } from './shared/workflows';

const ddb = makeDocClient();

const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.LINEAR_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
const WEBHOOK_DEDUP_TABLE = process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME;
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME;
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const attachmentsS3Client = ATTACHMENTS_BUCKET ? makeClient(S3Client) : undefined;
const attachmentsBedrockClient = GUARDRAIL_ID && GUARDRAIL_VERSION ? makeClient(BedrockRuntimeClient) : undefined;
const attachmentsScreeningConfig: ScreeningConfig | undefined =
  attachmentsBedrockClient && GUARDRAIL_ID && GUARDRAIL_VERSION
    ? { bedrockClient: attachmentsBedrockClient, guardrailId: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION }
    : undefined;
const ACK_CLAIM_TTL_SECONDS = 86_400;

const channelFor = (registryTable: string): Channel => makeLinearChannel(registryTable);
const issueRef = (issueId: string, workspaceId: string): IssueRef => ({ issueId, credentialsRef: workspaceId });

function seedFailureReasons(
  children: readonly OrchestrationChildRow[],
): { failureReasons?: Record<string, string> } {
  const reasons: Record<string, string> = {};
  for (const c of children) {
    if (c.child_status === 'failed' && c.failure_reason) reasons[c.sub_issue_id] = c.failure_reason;
  }
  return Object.keys(reasons).length > 0 ? { failureReasons: reasons } : {};
}

const LINEAR_START_COMMENT = '🤖 Starting on this issue — I\'ll open a PR and report back here when it\'s ready.';

type HydrateResult =
  | { readonly ok: true; readonly records: PassedAttachmentRecord[] }
  | { readonly ok: false; readonly message: string };

interface HydrateAttachmentsParams {
  readonly issueId: string;
  readonly uploadsText: string | undefined;
  readonly workspaceId: string;
  readonly platformUserId: string;
  readonly accessToken: string;
  readonly taskId: string;
  readonly remainingSlots: number;
  readonly paperclips: readonly LinearProbeAttachment[];
  readonly retriggerHint?: string;
}

async function hydrateLinearAttachments(params: HydrateAttachmentsParams): Promise<HydrateResult> {
  const { issueId, uploadsText, workspaceId, platformUserId, accessToken, taskId, remainingSlots, paperclips } = params;
  const retriggerHint = params.retriggerHint ?? 'Remove or fix the attachment and re-apply the trigger label.';
  const uploadsPaperclips = paperclips.filter((a) => isLinearUploadsUrl(a.url));
  const textHasUploads = Boolean(uploadsText && uploadsText.includes('uploads.linear.app'));
  if (!textHasUploads && uploadsPaperclips.length === 0) return { ok: true, records: [] };

  if (!attachmentsS3Client || !ATTACHMENTS_BUCKET || !attachmentsScreeningConfig) {
    logger.error('Linear issue has uploads.linear.app attachments but screening/storage is not configured (fail-closed)', {
      issue_id: issueId,
      linear_workspace_id: workspaceId,
      has_bucket: Boolean(ATTACHMENTS_BUCKET),
      has_guardrail: Boolean(attachmentsScreeningConfig),
    });
    return { ok: false, message: 'This Linear issue has uploaded attachments, but ABCA attachment screening is not configured. Contact your ABCA admin.' };
  }
  try {
    const records = await downloadScreenAndStoreLinearAttachments(
      uploadsText,
      remainingSlots,
      {
        s3Client: attachmentsS3Client,
        bucketName: ATTACHMENTS_BUCKET,
        screeningConfig: attachmentsScreeningConfig,
        userId: platformUserId,
        taskId,
        accessToken,
        linearWorkspaceId: workspaceId,
      },
      uploadsPaperclips,
    );
    return { ok: true, records };
  } catch (err) {
    if (err instanceof LinearAttachmentError) {
      logger.warn('Rejecting Linear task: attachment could not be safely processed', {
        issue_id: issueId, linear_workspace_id: workspaceId, error: err.message,
      });
      return { ok: false, message: `ABCA couldn't safely process an attachment: ${err.message} ${retriggerHint}` };
    }
    throw err;
  }
}

async function hydrateLinearIssueAttachments(
  issue: LinearIssueEvent['data'],
  workspaceId: string,
  platformUserId: string,
  accessToken: string,
  taskOrEpicId: string,
  remainingSlots: number,
  probedAttachments: readonly LinearProbeAttachment[],
): Promise<HydrateResult> {
  return hydrateLinearAttachments({
    issueId: issue.id,
    uploadsText: issue.description,
    workspaceId,
    platformUserId,
    accessToken,
    taskId: taskOrEpicId,
    remainingSlots,
    paperclips: probedAttachments,
  });
}

async function hydrateCommentAttachments(params: {
  readonly issueId: string;
  readonly commentBody: string | undefined;
  readonly workspaceId: string;
  readonly platformUserId: string;
  readonly accessToken: string;
  readonly taskId: string;
  readonly probeIssue: boolean;
}): Promise<HydrateResult> {
  const commentHasUploads = Boolean(params.commentBody && params.commentBody.includes('uploads.linear.app'));
  let paperclips: readonly LinearProbeAttachment[] = [];
  if (params.probeIssue) {
    const probe = await probeLinearIssueContext(params.accessToken, params.issueId);
    if (probe.ok === false) {
      return {
        ok: false,
        message: "ABCA couldn't read this issue's attachments from Linear (the API errored or timed out). "
          + 'Re-comment to retry rather than run on a spec that may be attached but unreadable.',
      };
    }
    paperclips = probe.attachments ?? [];
  }
  if (!commentHasUploads && !paperclips.some((a) => isLinearUploadsUrl(a.url))) {
    return { ok: true, records: [] };
  }
  return hydrateLinearAttachments({
    issueId: params.issueId,
    uploadsText: params.commentBody,
    workspaceId: params.workspaceId,
    platformUserId: params.platformUserId,
    accessToken: params.accessToken,
    taskId: params.taskId,
    remainingSlots: MAX_ATTACHMENTS_PER_TASK,
    paperclips,
    retriggerHint: 'Remove or fix the attachment and re-comment.',
  });
}

async function cleanupPreScreenedForComment(records: readonly PassedAttachmentRecord[]): Promise<void> {
  if (records.length === 0 || !attachmentsS3Client || !ATTACHMENTS_BUCKET) return;
  try {
    await cleanupPreScreenedAttachments(attachmentsS3Client, ATTACHMENTS_BUCKET, records);
  } catch (err) {
    logger.warn('Failed to clean up orphaned comment attachment objects (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function hydrateChildrenOwnAttachments(
  children: readonly { sub_issue_id: string; description?: string }[],
  workspaceId: string,
  platformUserId: string,
  accessToken: string,
  orchestrationId: string,
  inheritedCount: number,
): Promise<Map<string, PassedAttachmentRecord[]>> {
  const stampedByChild = new Map<string, PassedAttachmentRecord[]>();
  if (!attachmentsS3Client || !ATTACHMENTS_BUCKET || !attachmentsScreeningConfig) return stampedByChild;
  const now = new Date().toISOString();
  for (const child of children) {
    if (isIntegrationNode(child.sub_issue_id)) continue;
    let paperclips: readonly LinearProbeAttachment[] = [];
    try {
      const probe = await probeLinearIssueContext(accessToken, child.sub_issue_id);
      paperclips = probe.attachments ?? [];
    } catch (err) {
      logger.warn('Child own-attachment probe failed (skipping this child, non-fatal)', {
        orchestration_id: orchestrationId,
        sub_issue_id: child.sub_issue_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const descHasUploads = Boolean(child.description && child.description.includes('uploads.linear.app'));
    const ownPaperclips = paperclips.filter((a) => isLinearUploadsUrl(a.url));
    if (!descHasUploads && ownPaperclips.length === 0) continue;
    const ownBudget = Math.max(0, MAX_ATTACHMENTS_PER_TASK - inheritedCount);
    const keptPaperclips = ownPaperclips.slice(0, ownBudget);
    const droppedPaperclips = ownPaperclips.slice(keptPaperclips.length);
    if (droppedPaperclips.length > 0) {
      const droppedNames = droppedPaperclips.map((a) => a.title || '(untitled)').join(', ');
      await safeReportIssueFailure(
        child.sub_issue_id, workspaceId,
        `⚠️ This sub-issue has more attachments than fit the ${MAX_ATTACHMENTS_PER_TASK}-file per-task limit `
        + `once the epic's ${inheritedCount} shared file(s) are included, so these were NOT sent to the agent: `
        + `${droppedNames}. Remove some attachments (here or on the epic) and re-apply the trigger label if the agent needs them.`,
      );
      logger.warn('Child own attachments trimmed to per-task cap BEFORE upload — user notified', {
        orchestration_id: orchestrationId,
        sub_issue_id: child.sub_issue_id,
        own_paperclips: ownPaperclips.length,
        inherited: inheritedCount,
        kept: keptPaperclips.length,
      });
    }
    if (ownBudget === 0 && !descHasUploads) continue;
    try {
      const hydrated = await hydrateLinearAttachments({
        issueId: child.sub_issue_id,
        uploadsText: child.description,
        workspaceId,
        platformUserId,
        accessToken,
        taskId: `child-${child.sub_issue_id}`,
        remainingSlots: ownBudget,
        paperclips: keptPaperclips,
      });
      if (!hydrated.ok) {
        logger.warn('Child own attachment could not be screened — releasing child WITHOUT it (non-fatal)', {
          orchestration_id: orchestrationId, sub_issue_id: child.sub_issue_id, detail: hydrated.message,
        });
        continue;
      }
      if (hydrated.records.length > 0) {
        await setChildOwnAttachments(ddb, ORCHESTRATION_TABLE!, orchestrationId, child.sub_issue_id, hydrated.records, now);
        stampedByChild.set(child.sub_issue_id, hydrated.records);
      }
    } catch (err) {
      logger.warn('Child own-attachment hydrate/persist failed (non-fatal)', {
        orchestration_id: orchestrationId,
        sub_issue_id: child.sub_issue_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return stampedByChild;
}

// A DynamoDB Query is eventually consistent by default: a reload right after the write can miss the stamped attachments.
function patchChildOwnAttachments(
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>,
  stampedByChild: Map<string, PassedAttachmentRecord[]>,
): NonNullable<Awaited<ReturnType<typeof loadOrchestration>>> {
  return {
    ...snapshot,
    children: snapshot.children.map((c) => {
      const own = stampedByChild.get(c.sub_issue_id);
      return own && own.length > 0 ? { ...c, pre_screened_attachments: own } : c;
    }),
  };
}

async function postIterationAck(
  workspaceId: string,
  registryTableName: string,
  issueId: string,
  replyTargetId: string,
): Promise<LookupResult<string>> {
  try {
    const ref = await channelFor(registryTableName).upsertThreadedReply?.(
      issueRef(issueId, workspaceId),
      { commentId: replyTargetId },
      renderMaturingReply({ state: 'on_it' }),
    );
    return ref?.commentId ? lookupFound(ref.commentId) : LOOKUP_ABSENT;
  } catch (err) {
    logger.warn('Iteration ack reply failed (non-fatal)', {
      issue_id: issueId, error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }
}

interface CommentAck {
  readonly channel: Channel;
  readonly issue: IssueRef;
  readonly commentId: string;
  readonly replyTargetId: string;
  readonly replyId: string | null;
}

async function settleFailedCommentAck(ack: CommentAck, message: string): Promise<void> {
  await ack.channel.upsertThreadedReply?.(
    ack.issue, { commentId: ack.replyTargetId }, message,
    ack.replyId ? { commentId: ack.replyId } : undefined,
  );
  await ack.channel.replaceCommentReaction?.({ commentId: ack.commentId }, ack.issue, 'failed');
}

const COMMENT_BUDGET_EXHAUSTED_MESSAGE = '❌ ABCA couldn\'t start this: the monthly budget is exhausted for the user or team '
  + 'this issue\'s work is billed to. New tasks are disabled until the next UTC month.';

async function reportCommentTaskNotCreated(ack: CommentAck, statusCode: number, rawBody: string): Promise<void> {
  if (statusCode === 200) return;
  const message = statusCode === 429
    ? COMMENT_BUDGET_EXHAUSTED_MESSAGE
    : buildCreateTaskFailureMessage(statusCode, rawBody, 'Please re-comment in a few minutes.');
  await settleFailedCommentAck(ack, message);
}

const COMMENT_TASK_ERROR_MESSAGE = '❌ ABCA hit an error and couldn\'t start this. Please re-comment in a few minutes.';

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
    await channelFor(WORKSPACE_REGISTRY_TABLE).reportFailure(
      issueRef(issueId, linearWorkspaceId),
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

interface LinearCommentEvent {
  readonly action: 'create' | 'update' | 'remove' | string;
  readonly type: 'Comment';
  readonly data: {
    readonly id: string;
    readonly body?: string;
    readonly issueId?: string;
    readonly issue?: { readonly id?: string };
    readonly userId?: string;
    // On a reply, the id of the thread's root comment. Linear threads are one level deep:
    // `commentCreate` rejects a `parentId` that is itself a reply ("Parent comment must be a top level comment").
    readonly parentId?: string;
    readonly [key: string]: unknown;
  };
  readonly actor?: { readonly id?: string; readonly name?: string };
  readonly organizationId?: string;
}

interface ProcessorEvent {
  readonly raw_body: string;
  readonly verified_via_stack_wide?: boolean;
}

type BuilderResolvedToken = {
  accessToken: string;
  oauthSecretArn: string;
  workspaceSlug: string;
  providerName?: string;
  vaultUserId?: string;
};

// eslint-disable-next-line complexity -- predates the ceiling (118, down from 120 when it landed); must not grow
export async function handler(event: ProcessorEvent): Promise<void> {
  if (!event.raw_body) {
    logger.error('Linear webhook processor invoked without raw_body');
    return;
  }

  let payload: LinearIssueEvent | LinearCommentEvent;
  try {
    payload = JSON.parse(event.raw_body) as LinearIssueEvent | LinearCommentEvent;
  } catch (err) {
    logger.error('Linear webhook processor could not parse raw_body', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (event.verified_via_stack_wide) {
    const bound = await resolveSoleActiveLinearWorkspace(ddb, WORKSPACE_REGISTRY_TABLE);
    if (!bound) {
      logger.warn('Dropping stack-wide-verified Linear delivery: cannot determine the sending workspace', {
        claimed_workspace_id: payload.organizationId,
      });
      return;
    }
    if (payload.organizationId && payload.organizationId !== bound) {
      logger.warn('Ignoring body organizationId on a stack-wide-verified delivery; binding to the sole active workspace', {
        claimed_workspace_id: payload.organizationId,
        bound_workspace_id: bound,
      });
    }
    (payload as { organizationId?: string }).organizationId = bound;
  }

  if ((payload as { type?: string }).type === AGENT_SESSION_EVENT_TYPE) {
    if (!isLinearAgentSessionsEnabled()) {
      logger.warn('Agent-session delivery reached the processor with LINEAR_AGENT_SESSIONS_ENABLED off — ignoring');
      return;
    }
    await handleAgentSessionEvent(payload as LinearAgentSessionEvent);
    return;
  }

  if (payload.type === 'Comment') {
    await handleCommentTrigger(payload as LinearCommentEvent);
    return;
  }

  if ((payload as { type?: string }).type !== 'Issue') {
    logger.info('Linear processor skipping unrecognized payload', { type: (payload as { type?: string }).type });
    return;
  }

  const issue = (payload as LinearIssueEvent).data;
  const projectId = issue.projectId;

  const mapping = await lookupLinearProjectMapping(ddb, PROJECT_MAPPING_TABLE, projectId, payload.organizationId);
  if (mapping.kind === 'foreign') {
    logger.warn('Linear project is mapped to a different workspace than this webhook — dropping', {
      issue_id: issue.id,
      linear_project_id: projectId,
      event_workspace_id: payload.organizationId,
      mapped_workspace_id: mapping.mappedWorkspaceId,
    });
    return;
  }
  const mappingItem = mapping.kind === 'mapped' ? mapping.item : undefined;
  if (mapping.kind === 'mapped' && !mapping.ownerVerified) {
    logger.warn('Linear project mapping records no owning workspace — cannot verify the tenant', {
      issue_id: issue.id,
      linear_project_id: projectId,
      event_workspace_id: payload.organizationId,
    });
  }

  const labelFilter = (mappingItem?.label_filter as string | undefined) ?? DEFAULT_LABEL_FILTER;

  if (
    mappingItem
    && hasHelpLabel((issue.labels ?? []).map((l) => l?.name), labelFilter)
    && shouldTriggerHelp(payload, labelFilter)
  ) {
    await handleHelpLabel({ issue, workspaceId: payload.organizationId, labelFilter });
    return;
  }

  // A Linear workspace webhook fires on every issue change in every team of the workspace, onboarded or not.
  if (!shouldTrigger(payload, labelFilter)) {
    const abcaLabelJustAdded = labelJustPresent(payload, looksLikeAbcaTriggerLabel);
    if (abcaLabelJustAdded && (!projectId || !mappingItem)) {
      const nudgeClaimed = ORCHESTRATION_TABLE
        ? await claimCommentAck(
          ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id), `noproject-nudge#${issue.id}`,
          new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
        )
        : true;
      if (nudgeClaimed) {
        const nudge = !projectId
          ? "❌ This Linear issue isn't in a project — ABCA needs a Linear project to route the task to a "
            + 'repo. Move the issue into an onboarded project, then re-apply the label.'
          : "❌ This Linear project isn't onboarded to ABCA, so I can't route this to a repo. An admin can "
            + 'onboard it with `bgagent linear onboard-project <project-uuid> --repo <owner>/<repo> --label '
            + '<trigger>`, then re-apply the label.';
        logger.info('Linear ABCA label on a project-less/unmapped issue — nudging (was a silent drop)', {
          issue_id: issue.id, has_project: Boolean(projectId),
        });
        await safeReportIssueFailure(issue.id, payload.organizationId, nudge);
      }
      return;
    }
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

  const linkedUser = await lookupPlatformUser(workspaceId, actorId);
  const claimUser = linkedUser ? null : await readConsoleStartClaim(issue.id, workspaceId);
  const platformUserId = linkedUser ?? claimUser;
  const releaseClaim = async () => {
    if (claimUser) await releaseConsoleStartClaim(issue.id, claimUser);
  };
  if (!platformUserId) {
    logger.warn('Linear actor has no linked platform user — skipping task creation', {
      linear_workspace_id: workspaceId,
      linear_user_id: actorId,
      issue_id: issue.id,
    });
    await safeReportIssueFailure(
      issue.id,
      workspaceId,
      "❌ This Linear user isn't linked to a platform user. In v1 only the API-token owner can submit tasks from Linear; multi-user OAuth support is planned (tracked as a GitHub issue).",
    );
    return;
  }

  let channelMetadata: Record<string, string> = {
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

  let resolvedAccessToken: string | undefined;
  let contextHint = '';
  let probedAttachments: readonly LinearProbeAttachment[] = [];
  let probedDocuments: readonly LinearProbeDocument[] = [];
  let probeOk = true;
  if (WORKSPACE_REGISTRY_TABLE) {
    const resolved = await resolveLinearOauthToken(workspaceId, WORKSPACE_REGISTRY_TABLE);
    if (!resolved) {
      logger.warn('Linear workspace not resolvable from registry — dropping event', {
        linear_workspace_id: workspaceId,
        issue_id: issue.id,
      });
      return;
    }
    channelMetadata.linear_oauth_secret_arn = resolved.oauthSecretArn;
    channelMetadata.linear_workspace_slug = resolved.workspaceSlug;
    if (resolved.providerName) {
      channelMetadata = { ...channelMetadata, ...vaultMetadata(resolved) };
    }
    resolvedAccessToken = resolved.accessToken;
    const probe = await probeLinearIssueContext(resolved.accessToken, issue.id);
    contextHint = renderIssueContextHint(probe);
    probedAttachments = probe.attachments ?? [];
    probedDocuments = probe.projectDocuments ?? [];
    probeOk = probe.ok !== false;
  }

  if (ORCHESTRATION_TABLE && resolvedAccessToken) {
    const graphSource = linearGraphSource(resolvedAccessToken, issue.id);
    const graphResult = await graphSource();
    // S3 versioning makes each PUT a new version: a re-upload turns the version pinned at the first seed
    // noncurrent, and the bucket's lifecycle expires noncurrent versions.
    const alreadySeeded = graphResult.kind === 'ok'
      ? Boolean(await loadOrchestration(ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id)))
      : false;
    let epicAttachments: PassedAttachmentRecord[] = [];
    if (graphResult.kind === 'ok' && !alreadySeeded) {
      if (!probeOk) {
        await safeReportIssueFailure(
          issue.id, workspaceId,
          "❌ ABCA couldn't read this epic's attachments from Linear (the API errored or timed out). "
          + 'Re-apply the trigger label to retry rather than run the sub-issues on a possibly-missing spec.',
        );
        return;
      }
      const hydrated = await hydrateLinearIssueAttachments(
        issue, workspaceId, platformUserId, resolvedAccessToken,
        `epic-${issue.id}`, 10, probedAttachments,
      );
      if (!hydrated.ok) {
        await safeReportIssueFailure(issue.id, workspaceId, `❌ ${hydrated.message}`);
        return;
      }
      epicAttachments = hydrated.records;
    }

    const releaseContext: OrchestrationReleaseContext = {
      platform_user_id: platformUserId,
      channel_source: 'linear',
      ...(channelMetadata.linear_oauth_secret_arn && {
        linear_oauth_secret_arn: channelMetadata.linear_oauth_secret_arn,
      }),
      ...(channelMetadata.linear_workspace_slug && {
        linear_workspace_slug: channelMetadata.linear_workspace_slug,
      }),
      ...(channelMetadata.linear_provider_name && {
        linear_provider_name: channelMetadata.linear_provider_name,
      }),
      ...(channelMetadata.linear_vault_user_id && {
        linear_vault_user_id: channelMetadata.linear_vault_user_id,
      }),
      linear_project_id: projectId,
      trigger_label: (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase(),
      parent_context: {
        ...(issue.title && { title: issue.title }),
        ...(issue.description && { description: issue.description }),
      },
      ...(epicAttachments.length > 0 && { pre_screened_attachments: epicAttachments }),
    };

    const discovery = await discoverOrchestration({
      ddb,
      tableName: ORCHESTRATION_TABLE,
      parentIssueRef: issue.id,
      credentialsRef: workspaceId,
      repo,
      now: new Date().toISOString(),
      releaseContext,
      graphSource: async () => graphResult,
    });

    if (discovery.kind === 'rejected') {
      logger.info('Linear orchestration graph rejected — not creating tasks', {
        issue_id: issue.id,
        reason: discovery.reason,
      });
      await safeReportIssueFailure(issue.id, workspaceId, `❌ ${discovery.message}`);
      return;
    }
    if (discovery.kind === 'error') {
      await safeReportIssueFailure(
        issue.id,
        workspaceId,
        `❌ ABCA couldn't read this issue's sub-issues: ${discovery.message}`,
      );
      return;
    }
    if (discovery.kind === 'seeded') {
      let snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (snapshot && !discovery.alreadyExisted && resolvedAccessToken) {
        const stampedByChild = await hydrateChildrenOwnAttachments(
          snapshot.children, workspaceId, snapshot.meta.release_context.platform_user_id,
          resolvedAccessToken, discovery.orchestrationId,
          epicAttachments.length,
        );
        if (stampedByChild.size > 0) {
          snapshot = patchChildOwnAttachments(snapshot, stampedByChild);
        }
      }
      let releasedRoots = 0;
      let seedHadTerminalFailure = false;
      if (snapshot) {
        const budget = USER_CONCURRENCY_TABLE
          ? await readConcurrencyBudget(
            ddb, USER_CONCURRENCY_TABLE, snapshot.meta.release_context.platform_user_id, MAX_CONCURRENT)
          : undefined;
        const results = await releaseReadyChildren(
          ddb,
          ORCHESTRATION_TABLE,
          snapshot.children,
          snapshot.meta.release_context,
          createTaskCore,
          new Date().toISOString(),
          snapshot.children,
          'main',
          budget,
        );
        releasedRoots = results.filter((r) => r.kind === 'released').length;
        const patched = await applyTerminalCreateFailures(
          ddb, ORCHESTRATION_TABLE, discovery.orchestrationId, snapshot.children, results, new Date().toISOString(),
        );
        seedHadTerminalFailure = patched !== snapshot.children;
      }
      logger.info('Linear orchestration seeded — root children released', {
        issue_id: issue.id,
        orchestration_id: discovery.orchestrationId,
        child_count: discovery.childCount,
        root_count: discovery.rootSubIssueIds.length,
        released_roots: releasedRoots,
        already_existed: discovery.alreadyExisted,
      });
      if (WORKSPACE_REGISTRY_TABLE && !discovery.alreadyExisted) {
        try {
          const postReleaseSnapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
          if (postReleaseSnapshot) {
            const settled = seedHadTerminalFailure && postReleaseSnapshot.children.every(
              (c) => c.child_status === 'succeeded' || c.child_status === 'failed' || c.child_status === 'skipped',
            );
            const commentId = lookupValueOr(await upsertEpicPanel({
              channel: channelFor(WORKSPACE_REGISTRY_TABLE),
              parent: issueRef(issue.id, workspaceId),
              children: postReleaseSnapshot.children,
              ...seedFailureReasons(postReleaseSnapshot.children),
              inProgress: !settled,
              mirrorParentState: true,
            }), null);
            if (commentId) {
              await setStatusCommentId(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId, commentId);
            }
          }
        } catch (err) {
          logger.warn('Failed to post orchestration panel at seed (non-fatal)', {
            issue_id: issue.id,
            orchestration_id: discovery.orchestrationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await releaseClaim();
      return;
    }
    if (discovery.kind === 'extended') {
      if (discovery.addedSubIssueIds.length === 0) {
        await maybeRetryTerminalEpic(discovery.orchestrationId, issue.id, workspaceId);
        logger.info('Linear orchestration re-trigger — no new sub-issues to add', {
          issue_id: issue.id, orchestration_id: discovery.orchestrationId,
        });
        await releaseClaim();
        return;
      }
      let snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (snapshot && resolvedAccessToken) {
        const addedChildren = snapshot.children.filter(
          (c) => discovery.addedSubIssueIds.includes(c.sub_issue_id),
        );
        if (addedChildren.length > 0) {
          const inheritedCount = (snapshot.meta.release_context.pre_screened_attachments ?? []).length;
          const stampedByChild = await hydrateChildrenOwnAttachments(
            addedChildren, workspaceId, snapshot.meta.release_context.platform_user_id,
            resolvedAccessToken, discovery.orchestrationId, inheritedCount,
          );
          if (stampedByChild.size > 0) {
            snapshot = patchChildOwnAttachments(snapshot, stampedByChild);
          }
        }
      }
      let releasedAdded = 0;
      if (snapshot) {
        const releasableRows = snapshot.children.filter(
          (c) => discovery.releasableSubIssueIds.includes(c.sub_issue_id) && c.child_status === 'ready',
        );
        if (releasableRows.length > 0) {
          const budget = USER_CONCURRENCY_TABLE
            ? await readConcurrencyBudget(
              ddb, USER_CONCURRENCY_TABLE, snapshot.meta.release_context.platform_user_id, MAX_CONCURRENT)
            : undefined;
          const results = await releaseReadyChildren(
            ddb,
            ORCHESTRATION_TABLE,
            releasableRows,
            snapshot.meta.release_context,
            createTaskCore,
            new Date().toISOString(),
            snapshot.children,
            'main',
            budget,
          );
          releasedAdded = results.filter((r) => r.kind === 'released').length;
        }
      }
      logger.info('Linear orchestration extended — added sub-issues', {
        issue_id: issue.id,
        orchestration_id: discovery.orchestrationId,
        added: discovery.addedSubIssueIds.length,
        released_now: releasedAdded,
      });
      if (WORKSPACE_REGISTRY_TABLE && snapshot) {
        try {
          const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
          const children = fresh?.children ?? snapshot.children;
          const meta = (fresh ?? snapshot).meta;
          const newId = lookupValueOr(await upsertEpicPanel({
            channel: channelFor(WORKSPACE_REGISTRY_TABLE),
            parent: issueRef(issue.id, workspaceId),
            ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
            children,
            inProgress: true,
          }), null);
          if (newId && meta.status_comment_id === undefined) {
            await setStatusCommentId(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId, newId);
          }
        } catch (err) {
          logger.warn('Failed to refresh panel on extend (non-fatal)', {
            issue_id: issue.id,
            orchestration_id: discovery.orchestrationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await releaseClaim();
      return;
    }
  }

  let recentComments: RenderedComment[] = [];
  if (WORKSPACE_REGISTRY_TABLE && resolvedAccessToken) {
    const fetched = await fetchRecentComments(
      { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
      issue.id,
    );
    recentComments = await screenCommentsOrDrop(fetched, issue.id, workspaceId);
  }

  const projectDocs = await screenProjectDocsOrDrop(probedDocuments, issue.id, workspaceId);

  const taskDescription = buildTaskDescription(issue, contextHint, recentComments, projectDocs);

  const attachments = extractImageUrlAttachments(issue.description);

  const taskId = ulid();

  if (resolvedAccessToken && !probeOk) {
    await safeReportIssueFailure(
      issue.id, workspaceId,
      "❌ ABCA couldn't read this issue's attachments from Linear (the API errored or timed out). "
      + 'Re-apply the trigger label to retry — this avoids running on a spec that may be attached but unreadable.',
    );
    return;
  }

  let preScreenedAttachments: PassedAttachmentRecord[] = [];
  if (resolvedAccessToken) {
    const hydrated = await hydrateLinearIssueAttachments(
      issue, workspaceId, platformUserId, resolvedAccessToken,
      taskId, 10 - attachments.length, probedAttachments,
    );
    if (!hydrated.ok) {
      await safeReportIssueFailure(issue.id, workspaceId, `❌ ${hydrated.message}`);
      return;
    }
    preScreenedAttachments = hydrated.records;
  }

  const requestId = crypto.randomUUID();
  // Lambda re-runs an asynchronous (Event) invocation that throws, twice by default.
  const labelTriggerKey = `linear-label-${issue.id}-${(payload as LinearIssueEvent).webhookTimestamp ?? requestId}`
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      workflow_ref: CODING_WORKFLOW_ID,
      ...(attachments.length > 0 && { attachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'linear',
      channelMetadata,
      taskId,
      ...(preScreenedAttachments.length > 0 && { preScreenedAttachments }),
      idempotencyKey: labelTriggerKey,
    },
    requestId,
  );

  if (result.statusCode !== 201) {
    logger.warn('Linear-triggered task creation returned non-201', {
      status: result.statusCode,
      body: result.body,
      issue_id: issue.id,
    });
    await cleanupPreScreenedForComment(preScreenedAttachments);
    if (result.statusCode !== 200) {
      await safeReportIssueFailure(
        issue.id,
        workspaceId,
        buildCreateTaskFailureMessage(result.statusCode, result.body),
      );
    }
    return;
  }

  logger.info('Linear-triggered task created', {
    issue_id: issue.id,
    linear_issue_identifier: issue.identifier,
    repo,
    request_id: requestId,
  });
  await releaseClaim();

  if (WORKSPACE_REGISTRY_TABLE) {
    try {
      await channelFor(WORKSPACE_REGISTRY_TABLE).postComment(
        issueRef(issue.id, workspaceId),
        LINEAR_START_COMMENT,
      );
    } catch (err) {
      logger.warn('Failed to post Linear start comment (non-fatal)', {
        issue_id: issue.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type RetryOutcome = 'retried' | 'all_succeeded' | 'still_running' | 'no_orchestration';

async function maybeRetryTerminalEpic(
  orchestrationId: string,
  parentIssueId: string,
  workspaceId: string,
  opts: {
    readonly suppressAdvisoryNotes?: boolean;
    readonly retryClaimKey?: string;
  } = {},
): Promise<RetryOutcome> {
  if (!ORCHESTRATION_TABLE) return 'no_orchestration';
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot) return 'no_orchestration';
  const now = new Date().toISOString();
  const plan = computeEpicRetryPlan(
    snapshot.children.map((c) => ({
      sub_issue_id: c.sub_issue_id,
      depends_on: c.depends_on,
      child_status: c.child_status,
    })),
  );

  const channel = WORKSPACE_REGISTRY_TABLE ? channelFor(WORKSPACE_REGISTRY_TABLE) : undefined;
  const parentRef = issueRef(parentIssueId, workspaceId);

  if (plan.statusUpdates.length === 0) {
    const allSucceeded = plan.succeededCount > 0 && plan.succeededCount === snapshot.children.length;
    const outcome: RetryOutcome = allSucceeded ? 'all_succeeded' : 'still_running';
    if (opts.suppressAdvisoryNotes) return outcome;
    if (!allSucceeded) return outcome;
    if (!channel) return outcome;
    const won = await claimCommentAck(
      ddb, ORCHESTRATION_TABLE, orchestrationId, 'retrigger-note',
      now, Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
    );
    if (!won) return outcome;
    await channel.upsertComment(parentRef, renderEpicAlreadyCompleteNote());
    return outcome;
  }

  const retryFingerprint = snapshot.children
    .filter((c) => c.child_status === 'failed' || c.child_status === 'skipped')
    .map((c) => `${c.sub_issue_id}:${c.child_task_id ?? 'none'}:${c.updated_at}`)
    .sort()
    .join(',');
  const retryClaimKey = opts.retryClaimKey
    ? `retry-cmt:${opts.retryClaimKey}`
    : `retry:${hashRetryFingerprint(retryFingerprint)}`;
  const retryClaimWon = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, orchestrationId, retryClaimKey,
    now, Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
  );
  if (!retryClaimWon) {
    logger.info('Epic retry: redelivery of the same retry — skipping (already handled)', {
      orchestration_id: orchestrationId,
    });
    return 'retried';
  }

  logger.info('Epic retry: resetting failed/skipped children', {
    orchestration_id: orchestrationId,
    failed: plan.failedCount,
    skipped: plan.skippedCount,
    succeeded: plan.succeededCount,
    re_releasing: plan.toRelease.length,
  });

  for (const update of plan.statusUpdates) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: ORCHESTRATION_TABLE,
        Key: { orchestration_id: orchestrationId, sub_issue_id: update.sub_issue_id },
        UpdateExpression: 'SET child_status = :s, updated_at = :now',
        ConditionExpression: 'child_status <> :s',
        ExpressionAttributeValues: { ':s': update.child_status, ':now': now },
      }));
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  const freshChildren = fresh?.children ?? snapshot.children;
  if (plan.toRelease.length > 0) {
    const releasableRows = freshChildren
      .filter((c) => plan.toRelease.includes(c.sub_issue_id))
      .map((c) => ({ ...c, child_status: 'ready' as const }));
    if (releasableRows.length > 0) {
      const releaseCtx = (fresh ?? snapshot).meta.release_context;
      const budget = USER_CONCURRENCY_TABLE
        ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, releaseCtx.platform_user_id, MAX_CONCURRENT)
        : undefined;
      await releaseReadyChildren(
        ddb, ORCHESTRATION_TABLE, releasableRows, releaseCtx,
        createTaskCore, now, freshChildren, 'main', budget,
      );
    }
  }

  if (channel && WORKSPACE_REGISTRY_TABLE) {
    await channel.upsertComment(
      parentRef,
      renderEpicRetryNote({ failed: plan.failedCount, skipped: plan.skippedCount, succeeded: plan.succeededCount }),
    );
    try {
      const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
      const meta = (refreshed ?? fresh ?? snapshot).meta;
      const children = (refreshed ?? fresh ?? snapshot).children;
      if (meta.status_comment_id) {
        await deleteComment(
          { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
          meta.status_comment_id,
        );
      }
      const newPanelId = lookupValueOr(await upsertEpicPanel({
        channel,
        parent: parentRef,
        children,
        inProgress: true,
        mirrorParentState: true,
      }), null);
      if (newPanelId) {
        await setStatusCommentId(ddb, ORCHESTRATION_TABLE, orchestrationId, newPanelId);
      }
    } catch (err) {
      logger.warn('Epic retry: panel reposition failed (non-fatal)', {
        orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return 'retried';
}

async function handleEpicRetryIntent(args: {
  orchestrationId: string;
  parentIssueId: string;
  workspaceId: string;
  commentId: string;
  replyIssueId: string;
  replyTargetId: string;
  channel: Channel;
  children: readonly OrchestrationChildRow[];
  accessToken: string;
}): Promise<void> {
  const { orchestrationId, parentIssueId, workspaceId, commentId, replyIssueId, replyTargetId, channel, children, accessToken } = args;
  const graph = await linearGraphSource(accessToken, parentIssueId)();
  if (graph.kind === 'ok') {
    await refreshUnstartedText(ddb, ORCHESTRATION_TABLE!, children, graph.children);
  }
  const outcome = await maybeRetryTerminalEpic(
    orchestrationId, parentIssueId, workspaceId,
    { suppressAdvisoryNotes: true, retryClaimKey: commentId },
  );
  if (outcome === 'retried') {
    try {
      await setRetryCommentId(ddb, ORCHESTRATION_TABLE!, orchestrationId, commentId);
    } catch (err) {
      logger.warn('Could not record the retry comment for settling (non-fatal)', {
        orchestration_id: orchestrationId,
        comment_id: commentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('Comment trigger: retry intent → epic retry re-run', {
      orchestration_id: orchestrationId, comment_id: commentId,
    });
    return;
  }
  const replyBody = outcome === 'all_succeeded'
    ? '👋 Everything in this epic already succeeded — there\'s nothing to retry. '
      + '(To change something, name the sub-issue: `@bgagent ABCA-123: <what to change>`.)'
    : '👋 This epic is still running — nothing has failed yet, so there\'s nothing to retry. '
      + 'I\'ll update the panel as the sub-issues land.';
  const replyRef = issueRef(replyIssueId, workspaceId);
  await channel.postThreadedReply?.(replyRef, { commentId: replyTargetId }, replyBody);
  await channel.replaceCommentReaction?.({ commentId }, replyRef, 'needs_input');
  logger.info('Comment trigger: retry intent but nothing to retry', { orchestration_id: orchestrationId, outcome });
}

const RETRY_FINGERPRINT_HASH_LEN = 16;

function hashRetryFingerprint(fingerprint: string): string {
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, RETRY_FINGERPRINT_HASH_LEN);
}

async function handleNearMissMention(payload: LinearCommentEvent): Promise<void> {
  if (!ORCHESTRATION_TABLE || !WORKSPACE_REGISTRY_TABLE) return;
  const commentedIssueId = payload.data?.issueId ?? payload.data?.issue?.id;
  const workspaceId = payload.organizationId ?? '';
  const commentId = payload.data?.id;
  if (!commentedIssueId || !workspaceId || !commentId) return;

  const resolved = await resolveLinearOauthToken(workspaceId, WORKSPACE_REGISTRY_TABLE);
  if (!resolved) {
    logger.info('Near-miss mention: workspace not resolvable — ignoring', { linear_workspace_id: workspaceId });
    return;
  }

  const channel = channelFor(WORKSPACE_REGISTRY_TABLE);
  const commented = issueRef(commentedIssueId, workspaceId);
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(commentedIssueId), `wrong-mention:${commentId}`,
    new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
  );
  if (!won) {
    logger.info('Near-miss mention: redelivery already handled — skipping', { comment_id: commentId });
    return;
  }

  await channel.reactToComment?.({ commentId }, commented, 'needs_input');
  const replyTargetId = payload.data?.parentId ?? commentId;
  await channel.postThreadedReply?.(commented, { commentId: replyTargetId }, renderWrongMentionNudge());
  logger.info('Near-miss mention: nudged reviewer to @bgagent', { issue_id: commentedIssueId, comment_id: commentId });
}

function commentTargetBelongsToWorkspace(
  ownerWorkspaceId: string | undefined,
  workspaceId: string,
  issueId: string,
): boolean {
  if (ownerWorkspaceId && ownerWorkspaceId === workspaceId) return true;
  logger.warn('Comment trigger: commented issue belongs to a different workspace than this webhook — dropping', {
    linear_issue_id: issueId,
    event_workspace_id: workspaceId,
    owner_workspace_id: ownerWorkspaceId,
  });
  return false;
}

async function handleCommentTrigger(payload: LinearCommentEvent): Promise<void> {
  if (!ORCHESTRATION_TABLE || !WORKSPACE_REGISTRY_TABLE) {
    return;
  }
  const body = payload.data?.body;
  const trigger = parseCommentTrigger(body);
  if (!trigger.triggered) {
    if (detectNearMissMention(body)) {
      await handleNearMissMention(payload);
    }
    return;
  }
  const subIssueId = payload.data?.issueId ?? payload.data?.issue?.id;
  const workspaceId = payload.organizationId ?? '';
  if (!subIssueId || !workspaceId) {
    logger.info('Comment trigger: missing issueId/workspace — ignoring', { has_issue: Boolean(subIssueId) });
    return;
  }

  const resolved = await resolveLinearOauthToken(workspaceId, WORKSPACE_REGISTRY_TABLE);
  if (!resolved) {
    logger.info('Comment trigger: workspace not resolvable — ignoring', { linear_workspace_id: workspaceId });
    return;
  }

  const commentedIssueId = subIssueId;
  const commentId = payload.data.id;
  const replyTargetId = payload.data.parentId ?? commentId;

  const commenterId = payload.actor?.id;
  const commenterPlatformUserId = commenterId
    ? await lookupPlatformUser(workspaceId, commenterId)
    : null;
  if (!commenterPlatformUserId) {
    logger.warn('Comment trigger: commenter has no linked platform user — refusing to act on the trigger', {
      linear_workspace_id: workspaceId, linear_user_id: commenterId, linear_issue_id: commentedIssueId,
    });
    if (await mentionYieldsToAgentSession(workspaceId)) return;
    const channel = channelFor(WORKSPACE_REGISTRY_TABLE);
    const commented = issueRef(commentedIssueId, workspaceId);
    await channel.reactToComment?.({ commentId }, commented, 'needs_input');
    try {
      await channel.upsertThreadedReply?.(
        commented, { commentId: replyTargetId },
        '👋 I can only act on `@bgagent` requests from a linked ABCA user. Link your Linear '
          + 'account first (ask your ABCA admin / run `bgagent linear link`), then re-comment.',
      );
    } catch { /* best-effort reply */ }
    return;
  }

  const ownOrchestrationId = deriveOrchestrationId(commentedIssueId);
  const parentSnapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, ownOrchestrationId);
  if (parentSnapshot && parentSnapshot.meta.parent_issue_ref === commentedIssueId) {
    if (!commentTargetBelongsToWorkspace(parentSnapshot.meta.credentials_ref, workspaceId, commentedIssueId)) return;
    await handleParentEpicCommentTrigger({
      orchestrationId: ownOrchestrationId,
      snapshot: parentSnapshot,
      workspaceId,
      commentId,
      commentBody: body,
      replyTargetId,
      trigger,
      resolved,
      registryTableName: WORKSPACE_REGISTRY_TABLE,
    });
    return;
  }

  const parentResult = await fetchIssueParentId(resolved.accessToken, commentedIssueId);
  if (isLookupFailure(parentResult)) {
    logger.warn('Comment trigger: issue-parent lookup failed — retrying the delivery (not downgrading to standalone)', {
      issue_id: commentedIssueId,
      error: parentResult.error instanceof Error ? parentResult.error.message : String(parentResult.error),
    });
    throw parentResult.error instanceof Error
      ? parentResult.error
      : new Error(`Linear issue-parent lookup failed: ${String(parentResult.error)}`);
  }
  const parentId = lookupValueOr(parentResult, null);
  const orchestrationId = parentId ? deriveOrchestrationId(parentId) : null;
  const snapshot = orchestrationId
    ? await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId)
    : null;
  const child = snapshot?.children.find((c) => c.sub_issue_id === commentedIssueId);
  if (snapshot && !commentTargetBelongsToWorkspace(snapshot.meta.credentials_ref, workspaceId, commentedIssueId)) return;
  if (!snapshot || !child || !child.child_task_id) {
    if (await mentionYieldsToAgentSession(workspaceId)) {
      logger.info('Comment trigger: standalone mention is left to the Linear agent session — skipping', {
        linear_workspace_id: workspaceId,
        linear_issue_id: commentedIssueId,
        comment_id: commentId,
      });
      return;
    }
    await handleStandaloneCommentTrigger({
      subIssueId: commentedIssueId,
      workspaceId,
      commentId,
      commentBody: body,
      replyTargetId,
      trigger,
      resolved,
      registryTableName: WORKSPACE_REGISTRY_TABLE,
      unstartedChild: child,
    });
    return;
  }

  if (parseRetryIntent(trigger.instruction)) {
    const channel = channelFor(WORKSPACE_REGISTRY_TABLE);
    await channel.reactToComment?.({ commentId }, issueRef(commentedIssueId, workspaceId), 'started');
    await handleEpicRetryIntent({
      orchestrationId: orchestrationId!,
      parentIssueId: snapshot.meta.parent_issue_ref,
      workspaceId,
      commentId,
      replyIssueId: commentedIssueId,
      replyTargetId,
      channel,
      children: snapshot.children,
      accessToken: resolved.accessToken,
    });
    return;
  }

  await iterateOrchestrationChild({
    orchestrationId: orchestrationId!,
    snapshot,
    child,
    workspaceId,
    commentId,
    commentBody: body,
    replyTargetId,
    trigger,
    resolved,
    registryTableName: WORKSPACE_REGISTRY_TABLE,
  });
}

async function handleParentEpicCommentTrigger(args: {
  orchestrationId: string;
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>;
  workspaceId: string;
  commentId: string;
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: BuilderResolvedToken;
  registryTableName: string;
}): Promise<void> {
  const { orchestrationId, snapshot, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;
  const channel = channelFor(registryTableName);
  const parentRef = issueRef(snapshot.meta.parent_issue_ref, workspaceId);

  const ttlEpochSeconds = Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS;
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE!, orchestrationId, commentId, new Date().toISOString(), ttlEpochSeconds,
  );
  if (!won) {
    logger.info('Comment trigger (parent epic): redelivery — already handled this comment, skipping', {
      orchestration_id: orchestrationId, comment_id: commentId,
    });
    return;
  }

  await channel.reactToComment?.({ commentId }, parentRef, 'started');

  if (parseRetryIntent(trigger.instruction)) {
    await handleEpicRetryIntent({
      orchestrationId,
      parentIssueId: snapshot.meta.parent_issue_ref,
      workspaceId,
      commentId,
      replyIssueId: snapshot.meta.parent_issue_ref,
      replyTargetId,
      channel,
      children: snapshot.children,
      accessToken: resolved.accessToken,
    });
    return;
  }

  const match = parseParentNodeReference(trigger.instruction, snapshot.children);
  const target = match.reason === null ? match.matches[0] : null;

  const epicHasFailures = snapshot.children.some(
    (c) => c.child_status === 'failed' || c.child_status === 'skipped',
  );
  const triggerLabel = snapshot.meta.release_context.trigger_label || DEFAULT_LABEL_FILTER;

  if (!target) {
    const reason = match.reason === 'ambiguous' ? 'ambiguous' : 'none';
    const suggestion = reason === 'none' ? suggestClosestNode(trigger.instruction, snapshot.children) : null;
    const newWork = reason === 'none' && !suggestion && looksLikeNewWork(trigger.instruction);
    const body = renderParentDisambiguationReply(reason, snapshot.children, suggestion, newWork, epicHasFailures, triggerLabel);
    await channel.postThreadedReply?.(parentRef, { commentId: replyTargetId }, body);
    await channel.replaceCommentReaction?.({ commentId }, parentRef, 'needs_input');
    logger.info('Comment trigger (parent epic): no single sub-issue matched — asked', {
      orchestration_id: orchestrationId, reason, match_count: match.matches.length,
    });
    return;
  }

  const prNumberResult = target.child_task_id
    ? await readTaskPrNumber(ddb, process.env.TASK_TABLE_NAME!, target.child_task_id)
    : LOOKUP_ABSENT;
  if (isLookupFailure(prNumberResult)) {
    logger.warn('Comment trigger (parent epic): sub-issue PR read failed — asked the user to re-comment', {
      orchestration_id: orchestrationId,
      sub_issue_id: target.sub_issue_id,
      child_task_id: target.child_task_id,
      error: prNumberResult.error instanceof Error ? prNumberResult.error.message : String(prNumberResult.error),
    });
    await channel.postThreadedReply?.(
      parentRef, { commentId: replyTargetId },
      `⚠️ I couldn't read **${nodeDisplayId(target) ?? target.sub_issue_id}**'s pull request just now `
        + '(a transient error reading its task record), so I stopped rather than guess. Nothing was '
        + 'started. Please comment again to retry.',
    );
    await channel.replaceCommentReaction?.({ commentId }, parentRef, 'needs_input');
    return;
  }
  if (!prNumberResult.ok) {
    const status = snapshot.children.find((c) => c.sub_issue_id === target.sub_issue_id)?.child_status;
    const name = `**${nodeDisplayId(target) ?? target.title ?? target.sub_issue_id}**`;
    let body = `👋 ${name} has no pull request, so there's nothing to iterate on. `
      + 'If its run is still in progress, comment again once it has opened one.';
    if (status === 'failed') {
      body = `👋 ${name} failed before opening a PR, so there's `
        + 'nothing to iterate on yet. Reply `@bgagent retry` on this epic to re-run the failed work '
        + `(or remove and re-apply the \`${triggerLabel}\` label) — then comment again once it has a PR.`;
    } else if (status === 'skipped') {
      body = `👋 ${name} did not run, because a sub-issue it depends on failed. `
        + 'Reply `@bgagent retry` on this epic to re-run the failed work — then comment again once it has a PR.';
    } else if (!target.child_task_id) {
      body = `👋 ${name} hasn't started yet, so there's nothing to iterate on. `
        + 'It starts on its own when its turn comes; comment again once it has a pull request.';
    }
    await channel.postThreadedReply?.(parentRef, { commentId: replyTargetId }, body);
    await channel.replaceCommentReaction?.({ commentId }, parentRef, 'needs_input');
    logger.info('Comment trigger (parent epic): named sub-issue has no PR to iterate — said so', {
      orchestration_id: orchestrationId,
      sub_issue_id: target.sub_issue_id,
      child_status: status,
    });
    return;
  }
  const prNumber = prNumberResult.value;

  const childRow = snapshot.children.find((c) => c.sub_issue_id === target.sub_issue_id)!;

  await iterateOrchestrationChild({
    orchestrationId,
    snapshot,
    child: childRow,
    workspaceId,
    commentId,
    commentBody,
    replyTargetId,
    trigger,
    resolved,
    registryTableName,
    triggerCommentIssueId: snapshot.meta.parent_issue_ref,
    skipAck: true,
    prNumber,
  });
  logger.info('Comment trigger (parent epic): routed to sub-issue', {
    orchestration_id: orchestrationId, sub_issue_id: target.sub_issue_id, pr_number: prNumber,
  });
}

async function iterateOrchestrationChild(args: {
  orchestrationId: string;
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>;
  child: { sub_issue_id: string; repo: string; child_task_id?: string; child_status?: string };
  workspaceId: string;
  commentId: string;
  replyTargetId: string;
  triggerCommentIssueId?: string;
  trigger: CommentTrigger;
  commentBody: string | undefined;
  resolved: BuilderResolvedToken;
  registryTableName: string;
  skipAck?: boolean;
  prNumber?: number;
}): Promise<void> {
  const {
    orchestrationId, snapshot, child, workspaceId, commentId, commentBody, replyTargetId,
    trigger, resolved, registryTableName,
  } = args;
  const subIssueId = child.sub_issue_id;
  const triggerCommentIssueId = args.triggerCommentIssueId ?? subIssueId;
  const channel = channelFor(registryTableName);
  const commentedRef = issueRef(triggerCommentIssueId, workspaceId);

  let prNumber: number;
  if (args.prNumber !== undefined) {
    prNumber = args.prNumber;
  } else {
    const prNumberResult = child.child_task_id
      ? await readTaskPrNumber(ddb, process.env.TASK_TABLE_NAME!, child.child_task_id)
      : LOOKUP_ABSENT;
    if (!prNumberResult.ok) {
      logger.warn(
        isLookupFailure(prNumberResult)
          ? 'Comment trigger: sub-issue PR read failed — cannot iterate'
          : 'Comment trigger: sub-issue has no resolvable PR — cannot iterate',
        {
          orchestration_id: orchestrationId,
          sub_issue_id: subIssueId,
          child_task_id: child.child_task_id,
          ...(isLookupFailure(prNumberResult) && {
            error: prNumberResult.error instanceof Error ? prNumberResult.error.message : String(prNumberResult.error),
          }),
        },
      );
      let reply = '👋 This sub-issue has no pull request, so there\'s nothing to iterate on. '
        + 'If its run is still in progress, comment again once it has opened one.';
      if (isLookupFailure(prNumberResult)) {
        reply = '⚠️ I couldn\'t read this sub-issue\'s pull request just now (a transient error reading '
          + 'its task record), so I stopped rather than guess. Nothing was started. Please comment again to retry.';
      } else if (child.child_status === 'failed') {
        reply = '👋 This sub-issue failed before opening a PR, so there\'s nothing to iterate on yet. '
          + 'Reply `@bgagent retry` to re-run the failed work, then comment again once it has a PR.';
      }
      await channel.reactToComment?.({ commentId }, commentedRef, 'needs_input');
      await channel.postThreadedReply?.(commentedRef, { commentId: replyTargetId }, reply);
      return;
    }
    prNumber = prNumberResult.value;
  }

  const platformUserId = snapshot.meta.release_context.platform_user_id;

  if (!args.skipAck) {
    await channel.reactToComment?.({ commentId }, commentedRef, 'started');
  }

  const iterationReplyId = lookupValueOr(await postIterationAck(workspaceId, registryTableName, triggerCommentIssueId, replyTargetId), null);
  const ack: CommentAck = { channel, issue: commentedRef, commentId, replyTargetId, replyId: iterationReplyId };

  const idempotencyKey = `iterate_${subIssueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);

  const channelMetadata: Record<string, string> = {
    orchestration_id: orchestrationId,
    orchestration_sub_issue_id: subIssueId,
    orchestration_iteration: 'true',
    trigger_comment_id: replyTargetId,
    trigger_comment_issue_id: triggerCommentIssueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    ...vaultMetadata(resolved),
    linear_issue_id: isIntegrationNode(subIssueId) ? triggerCommentIssueId : subIssueId,
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  const iterTaskId = ulid();
  const iterHydrated = await hydrateCommentAttachments({
    issueId: subIssueId,
    commentBody,
    workspaceId,
    platformUserId,
    accessToken: resolved.accessToken,
    taskId: iterTaskId,
    probeIssue: false,
  });
  if (!iterHydrated.ok) {
    await settleFailedCommentAck(ack, `❌ ${iterHydrated.message}`);
    return;
  }

  try {
    const result = await createTaskCore(
      {
        repo: child.repo,
        workflow_ref: PR_ITERATION_WORKFLOW_ID,
        pr_number: prNumber,
        task_description: isIntegrationNode(subIssueId)
          ? buildIntegrationIterationInstruction(trigger)
          : buildIterationInstruction(trigger),
      },
      {
        userId: platformUserId,
        channelSource: 'linear',
        channelMetadata,
        idempotencyKey,
        taskId: iterTaskId,
        ...(iterHydrated.records.length > 0 && { preScreenedAttachments: iterHydrated.records }),
      },
      idempotencyKey,
    );
    if (result.statusCode !== 201) {
      await cleanupPreScreenedForComment(iterHydrated.records);
      await reportCommentTaskNotCreated(ack, result.statusCode, result.body);
    }
    logger.info('Comment trigger: iteration task created for sub-issue PR', {
      orchestration_id: orchestrationId,
      sub_issue_id: subIssueId,
      pr_number: prNumber,
      status_code: result.statusCode,
      attachments: iterHydrated.records.length,
    });
  } catch (err) {
    await cleanupPreScreenedForComment(iterHydrated.records);
    logger.error('Comment trigger: createTaskCore threw for iteration', {
      orchestration_id: orchestrationId,
      sub_issue_id: subIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleFailedCommentAck(ack, COMMENT_TASK_ERROR_MESSAGE);
  }
}

async function postStandaloneNudge(args: {
  issueId: string;
  workspaceId: string;
  commentId: string;
  registryTableName: string;
  nudge: string;
}): Promise<void> {
  const { issueId, workspaceId, commentId, registryTableName, nudge } = args;
  if (!ORCHESTRATION_TABLE) return;
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issueId), `no-task:${commentId}`,
    new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
  );
  if (!won) {
    logger.info('Standalone nudge: redelivery already handled — skipping', { comment_id: commentId });
    return;
  }
  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);
  try {
    await channel.upsertComment(target, nudge);
    await channel.replaceCommentReaction?.({ commentId }, target, 'needs_input');
  } catch (err) {
    logger.warn('Could not post the standalone nudge (non-fatal)', {
      linear_issue_id: issueId,
      comment_id: commentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function renderUnstartedSubIssueNudge(childStatus: string): string {
  return childStatus === 'failed' || childStatus === 'skipped'
    ? '👋 This sub-issue is run as part of its parent epic, and it did not run there (see the panel on '
      + 'the epic). Reply `@bgagent retry` on the epic to re-run what failed.'
    : '👋 This sub-issue is run as part of its parent epic and hasn\'t started yet. It starts on its own '
      + 'when its turn comes; comment again once it has a pull request.';
}

async function handleStandaloneCommentTrigger(args: {
  subIssueId: string;
  workspaceId: string;
  commentId: string;
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: BuilderResolvedToken;
  registryTableName: string;
  unstartedChild?: { child_status: string };
}): Promise<void> {
  const { subIssueId: issueId, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;

  const lookup = await lookupTaskByLinearIssue(ddb, process.env.TASK_TABLE_NAME!, issueId);
  if (lookup.kind !== 'found') {
    const nudge = lookup.kind === 'error'
      ? renderTaskLookupFailedNudge()
      : args.unstartedChild
        ? renderUnstartedSubIssueNudge(args.unstartedChild.child_status)
        : renderNoLinkedTaskNudge();
    await postStandaloneNudge({ issueId, workspaceId, commentId, registryTableName, nudge });
    logger.info('Comment trigger (standalone): no linked task — told the user', {
      linear_issue_id: issueId, lookup: lookup.kind,
    });
    return;
  }
  const task = lookup.task;
  if (!commentTargetBelongsToWorkspace(task.linear_workspace_id, workspaceId, issueId)) return;
  const prNumber = prNumberFromTask(task);
  if (prNumber === null || !task.repo) {
    if (await maybeResumeClarifyHold({ issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName })) {
      return;
    }
    if (await maybeStartStandaloneNewWork({
      issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName,
    })) {
      return;
    }
    logger.info('Comment trigger (standalone): PR-less task, no new-work dispatched (no repo/user or empty instruction)', {
      linear_issue_id: issueId, task_id: task.task_id, has_repo: Boolean(task.repo),
    });
    return;
  }
  if (!task.user_id) {
    logger.warn('Comment trigger (standalone): task missing user_id — cannot attribute iteration', {
      linear_issue_id: issueId, task_id: task.task_id,
    });
    return;
  }

  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);
  await channel.reactToComment?.({ commentId }, target, 'started');
  const iterationReplyId = lookupValueOr(await postIterationAck(workspaceId, registryTableName, issueId, replyTargetId), null);
  const ack: CommentAck = { channel, issue: target, commentId, replyTargetId, replyId: iterationReplyId };

  const idempotencyKey = `iterate_${issueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const channelMetadata: Record<string, string> = {
    trigger_comment_id: replyTargetId,
    linear_issue_id: issueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    ...vaultMetadata(resolved),
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  const iterTaskId = ulid();
  const iterHydrated = await hydrateCommentAttachments({
    issueId,
    commentBody,
    workspaceId,
    platformUserId: task.user_id,
    accessToken: resolved.accessToken,
    taskId: iterTaskId,
    probeIssue: false,
  });
  if (!iterHydrated.ok) {
    await settleFailedCommentAck(ack, `❌ ${iterHydrated.message}`);
    return;
  }

  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: PR_ITERATION_WORKFLOW_ID,
        pr_number: prNumber,
        task_description: buildIterationInstruction(trigger),
      },
      {
        userId: task.user_id,
        channelSource: 'linear',
        channelMetadata,
        idempotencyKey,
        taskId: iterTaskId,
        ...(iterHydrated.records.length > 0 && { preScreenedAttachments: iterHydrated.records }),
      },
      idempotencyKey,
    );
    if (result.statusCode !== 201) {
      await cleanupPreScreenedForComment(iterHydrated.records);
      await reportCommentTaskNotCreated(ack, result.statusCode, result.body);
    }
    logger.info('Comment trigger (standalone): iteration task created for issue PR', {
      linear_issue_id: issueId,
      pr_number: prNumber,
      status_code: result.statusCode,
      attachments: iterHydrated.records.length,
    });
  } catch (err) {
    await cleanupPreScreenedForComment(iterHydrated.records);
    logger.error('Comment trigger (standalone): createTaskCore threw for iteration', {
      linear_issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleFailedCommentAck(ack, COMMENT_TASK_ERROR_MESSAGE);
  }
}

async function maybeStartStandaloneNewWork(args: {
  issueId: string;
  task: { task_id: string; repo?: string; user_id?: string; status?: string };
  workspaceId: string;
  commentId: string;
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: BuilderResolvedToken;
  registryTableName: string;
}): Promise<boolean> {
  const { issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;
  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);

  if (!task.repo || !task.user_id) return false;

  if (task.status !== undefined && !TERMINAL_STATUSES.includes(task.status as TaskStatusType)) {
    await channel.reactToComment?.({ commentId }, target, 'started');
    try {
      await channel.upsertThreadedReply?.(
        target,
        { commentId: replyTargetId },
        "I'm still working on the current task for this issue — I'll pick up follow-up "
          + 'requests once it finishes. If you meant to change what I\'m doing, cancel the '
          + 'running task first, then re-comment.',
      );
    } catch (err) {
      logger.warn('Comment trigger (standalone): in-flight-task reply failed (non-fatal)', {
        linear_issue_id: issueId, error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('Comment trigger (standalone): task still in-flight — not dispatching parallel new work', {
      linear_issue_id: issueId, task_id: task.task_id, task_status: task.status,
    });
    return true;
  }

  const instruction = trigger.instruction.trim();

  if (!instruction) {
    await channel.reactToComment?.({ commentId }, target, 'started');
    try {
      await channel.upsertThreadedReply?.(
        target,
        { commentId: replyTargetId },
        '👋 This task already finished and has no open PR to iterate on. Reply with what '
          + "you'd like me to do (e.g. `@bgagent add a note to the README`) and I'll start it.",
      );
    } catch (err) {
      logger.warn('Comment trigger (standalone): bare-mention reply failed (non-fatal)', {
        linear_issue_id: issueId, error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('Comment trigger (standalone): bare mention on PR-less task — replied, no dispatch', {
      linear_issue_id: issueId, task_id: task.task_id,
    });
    return true;
  }

  await channel.reactToComment?.({ commentId }, target, 'started');
  const iterationReplyId = lookupValueOr(await postIterationAck(workspaceId, registryTableName, issueId, replyTargetId), null);
  const ack: CommentAck = { channel, issue: target, commentId, replyTargetId, replyId: iterationReplyId };

  const idempotencyKey = `newwork_${issueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const channelMetadata: Record<string, string> = {
    trigger_comment_id: replyTargetId,
    linear_issue_id: issueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    ...vaultMetadata(resolved),
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  const newTaskId = ulid();
  const newHydrated = await hydrateCommentAttachments({
    issueId,
    commentBody,
    workspaceId,
    platformUserId: task.user_id,
    accessToken: resolved.accessToken,
    taskId: newTaskId,
    probeIssue: true,
  });
  if (!newHydrated.ok) {
    await settleFailedCommentAck(ack, `❌ ${newHydrated.message}`);
    return true;
  }
  const taskDescription = await buildFollowUpDescription(task.task_id, instruction);

  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: 'coding/new-task-v1',
        task_description: taskDescription,
      },
      {
        userId: task.user_id,
        channelSource: 'linear',
        channelMetadata,
        idempotencyKey,
        taskId: newTaskId,
        ...(newHydrated.records.length > 0 && { preScreenedAttachments: newHydrated.records }),
      },
      idempotencyKey,
    );
    if (result.statusCode !== 201) {
      await cleanupPreScreenedForComment(newHydrated.records);
      await reportCommentTaskNotCreated(ack, result.statusCode, result.body);
    }
    logger.info('Comment trigger (standalone): fresh new-task dispatched from follow-up on PR-less task', {
      linear_issue_id: issueId,
      prior_task_id: task.task_id,
      status_code: result.statusCode,
      attachments: newHydrated.records.length,
    });
  } catch (err) {
    await cleanupPreScreenedForComment(newHydrated.records);
    logger.error('Comment trigger (standalone): createTaskCore threw for new-work dispatch', {
      linear_issue_id: issueId,
      prior_task_id: task.task_id,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleFailedCommentAck(ack, COMMENT_TASK_ERROR_MESSAGE);
  }
  return true;
}

async function buildFollowUpDescription(priorTaskId: string, instruction: string): Promise<string> {
  let prior: unknown;
  try {
    const res = await ddb.send(new GetCommand({ TableName: process.env.TASK_TABLE_NAME!, Key: { task_id: priorTaskId } }));
    prior = res.Item?.task_description;
  } catch (err) {
    logger.warn('Follow-up new work: prior task row unreadable — dispatching with the comment alone', {
      prior_task_id: priorTaskId, error: err instanceof Error ? err.message : String(err),
    });
  }
  const followUp = [
    '---',
    'An earlier run on this issue ended without a pull request.',
    `The reviewer now asks: ${instruction}`,
  ].join('\n');
  const room = MAX_TASK_DESCRIPTION_LENGTH - followUp.length - 2;
  if (typeof prior !== 'string' || !prior.trim() || room <= 0) return instruction;
  const appendedAt = prior.search(APPENDED_BLOCK);
  const issueText = appendedAt === -1 ? prior : prior.slice(0, appendedAt);
  const appended = prior.slice(issueText.length);
  return `${issueText.slice(0, Math.max(0, room - appended.length))}${appended}\n\n${followUp}`;
}

async function maybeResumeClarifyHold(args: {
  issueId: string;
  task: { task_id: string; repo?: string; user_id?: string };
  workspaceId: string;
  commentId: string;
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: BuilderResolvedToken;
  registryTableName: string;
}): Promise<boolean> {
  const { issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;
  const answer = trigger.instruction.trim();
  if (!answer) return false;

  let row: Record<string, unknown> | undefined;
  try {
    const res = await ddb.send(new GetCommand({ TableName: process.env.TASK_TABLE_NAME!, Key: { task_id: task.task_id } }));
    row = res.Item;
  } catch (err) {
    logger.warn('Clarify-resume: failed to read task row — treating as non-resumable', {
      linear_issue_id: issueId, task_id: task.task_id, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!isClarifyHold(row)) return false;
  if (!task.repo || !task.user_id) {
    logger.warn('Clarify-resume: hold row missing repo/user — cannot resume', {
      linear_issue_id: issueId, task_id: task.task_id, has_repo: Boolean(task.repo),
    });
    return false;
  }

  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);
  await channel.reactToComment?.({ commentId }, target, 'started');
  const iterationReplyId = lookupValueOr(await postIterationAck(workspaceId, registryTableName, issueId, replyTargetId), null);
  const ack: CommentAck = { channel, issue: target, commentId, replyTargetId, replyId: iterationReplyId };

  const resumeDescription = buildClarifyResumeDescription(
    typeof row.task_description === 'string' ? row.task_description : undefined,
    typeof row.answer_text === 'string' ? row.answer_text : undefined,
    answer,
  );
  const idempotencyKey = `clarify_${issueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const channelMetadata: Record<string, string> = {
    linear_issue_id: issueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    ...vaultMetadata(resolved),
    trigger_comment_id: replyTargetId,
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };
  const resumeTaskId = ulid();
  const resumeHydrated = await hydrateCommentAttachments({
    issueId,
    commentBody,
    workspaceId,
    platformUserId: task.user_id,
    accessToken: resolved.accessToken,
    taskId: resumeTaskId,
    probeIssue: true,
  });
  if (!resumeHydrated.ok) {
    await settleFailedCommentAck(ack, `❌ ${resumeHydrated.message}`);
    return true;
  }

  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: 'coding/new-task-v1',
        task_description: resumeDescription,
      },
      {
        userId: task.user_id,
        channelSource: 'linear',
        channelMetadata,
        idempotencyKey,
        taskId: resumeTaskId,
        ...(resumeHydrated.records.length > 0 && { preScreenedAttachments: resumeHydrated.records }),
      },
      idempotencyKey,
    );
    if (result.statusCode !== 201) {
      await cleanupPreScreenedForComment(resumeHydrated.records);
      await reportCommentTaskNotCreated(ack, result.statusCode, result.body);
    }
    logger.info('Clarify-resume: fresh new-task dispatched from the reviewer answer', {
      linear_issue_id: issueId,
      prior_task_id: task.task_id,
      status_code: result.statusCode,
      attachments: resumeHydrated.records.length,
    });
  } catch (err) {
    await cleanupPreScreenedForComment(resumeHydrated.records);
    logger.error('Clarify-resume: createTaskCore threw', {
      linear_issue_id: issueId, prior_task_id: task.task_id, error: err instanceof Error ? err.message : String(err),
    });
    await settleFailedCommentAck(ack, COMMENT_TASK_ERROR_MESSAGE);
  }
  return true;
}

function shouldTrigger(payload: LinearIssueEvent, labelFilter: string): boolean {
  const base = (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase();
  return labelJustPresent(payload, (name) => !!name && name.trim().toLowerCase() === base);
}

const NUDGE_KNOWN_BASES = ['abca', 'bgagent'] as const;

function looksLikeAbcaTriggerLabel(name: string | undefined | null): boolean {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return false;
  return NUDGE_KNOWN_BASES.some((b) => n === b || n === `${b}:${HELP_SUFFIX}`);
}

function shouldTriggerHelp(payload: LinearIssueEvent, labelFilter: string): boolean {
  const base = (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase();
  const help = `${base}:${HELP_SUFFIX}`;
  return labelJustPresent(payload, (name) => !!name && name.toLowerCase() === help);
}

function labelJustPresent(
  payload: LinearIssueEvent,
  matches: (name: string | undefined | null) => boolean,
): boolean {
  const current = payload.data.labels ?? [];
  const hasLabel = current.some((l) => matches(l?.name));

  if (payload.action === 'create') {
    return hasLabel;
  }

  if (payload.action === 'update') {
    if (!hasLabel) return false;
    const updatedFrom = payload.updatedFrom ?? {};
    const labelIdsChanged = Object.prototype.hasOwnProperty.call(updatedFrom, 'labelIds');
    if (!labelIdsChanged) return false;
    const previousIds = new Set((updatedFrom.labelIds as string[] | undefined) ?? []);
    return current.some((l) => matches(l?.name) && l?.id && !previousIds.has(l.id));
  }

  return false;
}

async function handleHelpLabel(args: {
  issue: LinearIssueEvent['data'];
  workspaceId: string | undefined;
  labelFilter: string;
}): Promise<void> {
  const { issue, workspaceId, labelFilter } = args;
  const base = (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase();
  if (!WORKSPACE_REGISTRY_TABLE || !ORCHESTRATION_TABLE || !workspaceId) {
    logger.info('Linear :help label — cannot post explainer (a table is not configured, or no workspace id)', {
      issue_id: issue.id,
    });
    return;
  }
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id), 'help',
    new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
  );
  if (!won) {
    logger.info('Linear :help label — explainer already posted for this issue (redelivery)', { issue_id: issue.id });
    return;
  }
  await channelFor(WORKSPACE_REGISTRY_TABLE).upsertComment(
    issueRef(issue.id, workspaceId),
    renderLabelHelp(base),
  );
  logger.info('Linear :help label — posted label explainer', { issue_id: issue.id });
}

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
  issue: LinearIssueEvent['data'],
  contextHint: string = '',
  comments: readonly RenderedComment[] = [],
  projectDocs: readonly LinearProbeDocument[] = [],
): string {
  const parts: string[] = [];
  if (issue.identifier && issue.title) {
    parts.push(`${issue.identifier}: ${issue.title}`);
  } else if (issue.title) {
    parts.push(issue.title);
  }
  const hintIndex = parts.length;
  if (issue.description && issue.description.trim()) {
    parts.push('');
    parts.push(issue.description.trim());
  }
  if (contextHint && parts.join('\n').length + contextHint.length + 2 <= MAX_TASK_DESCRIPTION_LENGTH) {
    parts.splice(hintIndex, 0, '', contextHint);
  }
  let out = parts.join('\n') || 'Linear issue';

  const sep = '\n';
  if (projectDocs.length > 0) {
    const section = renderProjectDocsSection(projectDocs);
    const budget = MAX_TASK_DESCRIPTION_LENGTH - out.length - sep.length;
    if (budget > 0) {
      const fitted = section.length <= budget ? section : truncateSection(section, budget, DOC_TRUNCATION_NOTICE);
      if (fitted) out = out + sep + fitted;
    }
  }
  if (comments.length > 0) {
    const commentSection = renderCommentSection(comments);
    const budget = MAX_TASK_DESCRIPTION_LENGTH - out.length - sep.length;
    if (budget > 0) {
      const fitted = commentSection.length <= budget
        ? commentSection
        : truncateSection(commentSection, budget, COMMENT_TRUNCATION_NOTICE);
      if (fitted) out = out + sep + fitted;
    }
  }
  return out;
}

const DOC_TRUNCATION_NOTICE = '\n\n_(project documents truncated)_';

function renderProjectDocsSection(docs: readonly LinearProbeDocument[]): string {
  const lines: string[] = ['', '## Project documents', '',
    '_Wiki documents from this issue\'s Linear project, included for reference:_'];
  for (const d of docs) {
    lines.push('');
    lines.push(`### ${d.title}`);
    lines.push('');
    lines.push(d.content.trim());
  }
  return lines.join('\n');
}

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

function truncateSection(section: string, budget: number, notice: string): string {
  const room = budget - notice.length;
  if (room <= 0) return '';
  return section.slice(0, room) + notice;
}

async function screenProjectDocsOrDrop(
  docs: readonly LinearProbeDocument[],
  issueId: string,
  workspaceId: string,
): Promise<readonly LinearProbeDocument[]> {
  if (docs.length === 0) return docs;
  if (!attachmentsBedrockClient || !GUARDRAIL_ID || !GUARDRAIL_VERSION) {
    logger.warn('Dropping Linear project docs: guardrail not configured to screen them', {
      issue_id: issueId, linear_workspace_id: workspaceId,
    });
    return [];
  }
  const text = renderProjectDocsSection(docs);
  try {
    const result = await attachmentsBedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));
    if (result.action === 'GUARDRAIL_INTERVENED') {
      logger.warn('Dropping Linear project docs: blocked by content policy (task still proceeds)', {
        issue_id: issueId, linear_workspace_id: workspaceId,
      });
      return [];
    }
    return docs;
  } catch (err) {
    emitWebhookScreeningFailedMetric('linear-docs');
    logger.warn('Dropping Linear project docs: screening unavailable (task still proceeds)', {
      issue_id: issueId,
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- advisory enrichment that cannot be screened is dropped and the task proceeds (ADR-026)
  }
}

async function screenCommentsOrDrop(
  comments: RenderedComment[],
  issueId: string,
  workspaceId: string,
): Promise<RenderedComment[]> {
  if (comments.length === 0) return comments;
  if (!attachmentsBedrockClient || !GUARDRAIL_ID || !GUARDRAIL_VERSION) {
    logger.warn('Dropping Linear comments: guardrail not configured to screen them', {
      issue_id: issueId,
      linear_workspace_id: workspaceId,
    });
    return [];
  }
  const text = renderCommentSection(comments);
  try {
    const result = await attachmentsBedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));
    if (result.action === 'GUARDRAIL_INTERVENED') {
      logger.warn('Dropping Linear comments: blocked by content policy (task still proceeds)', {
        issue_id: issueId,
        linear_workspace_id: workspaceId,
      });
      return [];
    }
    return comments;
  } catch (err) {
    emitWebhookScreeningFailedMetric('linear-comments');
    logger.warn('Dropping Linear comments: screening unavailable (task still proceeds)', {
      issue_id: issueId,
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- advisory enrichment that cannot be screened is dropped and the task proceeds (ADR-026)
  }
}

function extractImageUrlAttachments(description: string | undefined): Attachment[] {
  if (!description) return [];

  // Linear normalizes an image link into the angle-bracket form `![alt](<https://…>)`.
  const imagePattern = /!\[[^\]]*\]\(<?(https:\/\/[^)>]+)>?\)/g;
  const attachments: Attachment[] = [];
  let skippedLinearUploads = 0;
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(description)) !== null) {
    if (attachments.length >= 10) break;
    const url = match[1];
    // An `uploads.linear.app` file can only be fetched with the workspace's OAuth token.
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

// Linear's "Agent session events" toggle is per app installation: a workspace can have it off while the stack-wide flag is on.
async function mentionYieldsToAgentSession(workspaceId: string): Promise<boolean> {
  if (!isLinearAgentSessionsEnabled() || !WORKSPACE_REGISTRY_TABLE) return false;
  return workspaceDeliversAgentSessions(ddb, WORKSPACE_REGISTRY_TABLE, workspaceId);
}

async function readConsoleStartClaim(issueId: string, workspaceId: string): Promise<string | null> {
  if (!WEBHOOK_DEDUP_TABLE) return null;
  try {
    const user = await readStartClaim(ddb, WEBHOOK_DEDUP_TABLE, issueId, workspaceId);
    if (user) logger.info('Linear label from the operator console attributed via start claim', { issue_id: issueId, linear_workspace_id: workspaceId });
    return user;
  } catch (err) {
    logger.warn('Could not read a console start claim', { issue_id: issueId, error: err instanceof Error ? err.message : String(err) });
    return null; // nosemgrep: ts-silent-success-masking -- falls through to the existing "not linked" reply, which is the correct outcome without a claim
  }
}

async function releaseConsoleStartClaim(issueId: string, platformUserId: string): Promise<void> {
  if (!WEBHOOK_DEDUP_TABLE) return;
  try {
    await releaseStartClaim(ddb, WEBHOOK_DEDUP_TABLE, issueId, platformUserId);
  } catch (err) {
    logger.warn('Could not release a console start claim (it expires on its own)', { issue_id: issueId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function lookupPlatformUser(workspaceId: string, userId: string): Promise<string | null> {
  return lookupLinearPlatformUser(ddb, USER_MAPPING_TABLE, workspaceId, userId);
}
