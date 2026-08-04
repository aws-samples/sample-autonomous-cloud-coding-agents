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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import type { ScreeningConfig } from './shared/attachment-screening';
import { buildClarifyResumeDescription, isClarifyHold } from './shared/clarify-resume';
import { createTaskCore } from './shared/create-task-core';
import { renderMaturingReply } from './shared/iteration-reply';
import { cleanupPreScreenedAttachments, downloadScreenAndStoreLinearAttachments, LinearAttachmentError } from './shared/linear-attachments';
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
import { resolveLinearOauthToken } from './shared/linear-oauth-resolver';
import { fetchIssueParentId } from './shared/linear-subissue-fetch';
import { lookupTaskByLinearIssue, prNumberFromTask } from './shared/linear-task-by-issue';
import { logger } from './shared/logger';
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
import { claimCommentAck, clearRollupClaim, deriveOrchestrationId, loadOrchestration, setChildOwnAttachments, setRetryCommentId, setStatusCommentId, type OrchestrationChildRow, type OrchestrationReleaseContext } from './shared/orchestration-store';
import { DEFAULT_LABEL_FILTER, hasHelpLabel, HELP_SUFFIX } from './shared/trigger-label';
import type { Attachment, PassedAttachmentRecord } from './shared/types';
import { abcaUserAgent } from './shared/ua';
import { MAX_ATTACHMENTS_PER_TASK, MAX_TASK_DESCRIPTION_LENGTH } from './shared/validation';
import { CODING_WORKFLOW_ID } from './shared/workflows';
import { TERMINAL_STATUSES, type TaskStatusType } from '../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ ...abcaUserAgent() }));

const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.LINEAR_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
// Sub-issue orchestration: name of OrchestrationTable. Unset until the
// orchestration stack is deployed — while unset, the parent/sub-issue path is
// fully dormant and the handler behaves exactly as one-issue → one-task.
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME;
// Throttle the seed-time root release to the user's free concurrency
// budget. Unset → release all roots (back-compat; admission still gates).
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
// Attachment enrichment (ADR-016): fetch uploads.linear.app images with the
// workspace OAuth token at admission time, screen, store, inject as
// preScreenedAttachments — Linear has no MCP so the agent can't fetch them.
// Mirrors the Jira processor. Absent env → the authenticated-fetch path
// is off (the public-URL image path in extractImageUrlAttachments still runs).
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET_NAME;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const attachmentsS3Client = ATTACHMENTS_BUCKET ? new S3Client({}) : undefined;
const attachmentsBedrockClient = GUARDRAIL_ID && GUARDRAIL_VERSION ? new BedrockRuntimeClient({}) : undefined;
const attachmentsScreeningConfig: ScreeningConfig | undefined =
  attachmentsBedrockClient && GUARDRAIL_ID && GUARDRAIL_VERSION
    ? { bedrockClient: attachmentsBedrockClient, guardrailId: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION }
    : undefined;
// createTaskCore rejects idempotency keys longer than this; synthesized keys
// are sliced to fit the validated /^[A-Za-z0-9_-]{1,128}$/ pattern.
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/**
 * TTL (seconds) for the per-comment ack-claim marker. Only needs
 * to outlive Linear's webhook redelivery window (minutes), but we keep a day of
 * slack so a delayed redelivery still dedups; the row self-expires after.
 */
const ACK_CLAIM_TTL_SECONDS = 86_400;

/**
 * Feedback (comments / reactions / state) goes through the surface-agnostic
 * {@link Channel} rather than calling a surface's helpers directly, so the
 * orchestration logic in this handler stays free of surface details. This entry
 * point is Linear-specific by definition (it processes Linear webhooks), so it
 * builds the Linear channel; the ops it invokes are the neutral ones.
 */
const channelFor = (registryTable: string): Channel => makeLinearChannel(registryTable);
/** Address an issue on the channel: its surface id + the credentials key
 *  (for Linear, the workspace/organization id the token registry is keyed by). */
const issueRef = (issueId: string, workspaceId: string): IssueRef => ({ issueId, credentialsRef: workspaceId });

/**
 * Panel ``failureReasons`` for children that failed BEFORE becoming a task, so a
 * guardrail rejection at seed time shows "why + how to fix" on its row rather than a
 * bare ❌. The normal path reads the reason off the task record; these children have
 * no task, so the reason persisted on the row is the only source.
 *
 * Returns a spreadable object — empty when there is nothing to report.
 */
function seedFailureReasons(
  children: readonly OrchestrationChildRow[],
): { failureReasons?: Record<string, string> } {
  const reasons: Record<string, string> = {};
  for (const c of children) {
    if (c.child_status === 'failed' && c.failure_reason) reasons[c.sub_issue_id] = c.failure_reason;
  }
  return Object.keys(reasons).length > 0 ? { failureReasons: reasons } : {};
}

/**
 * First-run "starting" courtesy comment (ADR-016 P4.5). The 🤖 prefix matches
 * the bot-comment markers the self-trigger guard skips (isBotAuthoredComment),
 * so this never re-triggers ABCA. Kept short — the terminal fan-out comment
 * carries the outcome + cost + PR link.
 */
const LINEAR_START_COMMENT = '🤖 Starting on this issue — I\'ll open a PR and report back here when it\'s ready.';

/** Outcome of {@link hydrateLinearIssueAttachments}. */
type HydrateResult =
  | { readonly ok: true; readonly records: PassedAttachmentRecord[] }
  | { readonly ok: false; readonly message: string };

/** Inputs for {@link hydrateLinearAttachments} — the source of uploads can be an
 *  issue description OR a comment body, and the paperclips come from a probe. */
interface HydrateAttachmentsParams {
  /** The Linear issue id (for logging + the reject message). */
  readonly issueId: string;
  /** Markdown scanned for `uploads.linear.app` links — issue description OR comment body. */
  readonly uploadsText: string | undefined;
  readonly workspaceId: string;
  readonly platformUserId: string;
  readonly accessToken: string;
  /** S3 key namespace — the minted taskId (or `epic-<parentId>` for an epic). */
  readonly taskId: string;
  /** Free attachment slots after any public-URL images (usually the full cap). */
  readonly remainingSlots: number;
  /** Native paperclip attachments from a context probe (only uploads.linear.app ones are fetched). */
  readonly paperclips: readonly LinearProbeAttachment[];
  /** Wording tweak: the initial label path says "re-apply the trigger label";
   *  a comment path says "re-comment". Defaults to the label phrasing. */
  readonly retriggerHint?: string;
}

/**
 * Fetch + screen + store the `uploads.linear.app` attachments referenced by
 * `uploadsText` (description or comment body) plus any native paperclips,
 * returning `passed` records for `preScreenedAttachments`. Shared by EVERY
 * Linear task-dispatch path — the initial single-task path, the epic seed from a
 * human-authored graph, and the `@bgagent` comment paths — so the agent (which
 * has no Linear MCP) always receives the files a human pointed it at, wherever
 * they were attached.
 *
 * Fail-closed: returns `{ok:false, message}` when uploads ARE present but can't
 * be screened (screening unconfigured, or a fetch/screen failure) — the caller
 * rejects the task/epic with that message rather than run the agent blind.
 * Returns `{ok:true, records:[]}` when there's genuinely nothing to hydrate.
 */
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

/**
 * Convenience wrapper for the issue-labeled paths (single-task + epic seed):
 * hydrate an issue's OWN attachments (description links + probed paperclips).
 */
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

/**
 * Comment-trigger paths: hydrate the attachments a human just pointed the bot at in a
 * `@bgagent` comment. A file dropped INTO a comment becomes an
 * `uploads.linear.app` markdown link in the comment body; a file attached to the
 * ISSUE shows on its `attachments` connection. Cover both — scan the comment
 * body, and (when `probeIssue`) probe the issue for current paperclips. The
 * dispatched task gets all free slots (it's a fresh task, no inline images).
 * Fail-closed like the issue paths: an unscreenable file rejects the dispatch so
 * the agent never iterates blind on a spec it can't see.
 */
async function hydrateCommentAttachments(params: {
  readonly issueId: string;
  readonly commentBody: string | undefined;
  readonly workspaceId: string;
  readonly platformUserId: string;
  readonly accessToken: string;
  readonly taskId: string;
  /** Also probe the issue for paperclips (true for fresh new-work; false for
   *  PR-iteration/clarify where the new material rides in the comment body and
   *  re-probing would re-screen the issue's existing files every round). */
  readonly probeIssue: boolean;
}): Promise<HydrateResult> {
  const commentHasUploads = Boolean(params.commentBody && params.commentBody.includes('uploads.linear.app'));
  let paperclips: readonly LinearProbeAttachment[] = [];
  if (params.probeIssue) {
    const probe = await probeLinearIssueContext(params.accessToken, params.issueId);
    // Fail-CLOSED on a probe error. When probeIssue is set, a
    // newly-attached paperclip on the issue is a valid material source; if the
    // probe couldn't read the issue (ok:false — 500/timeout) an empty paperclip
    // list means "unknown", not "none", so a paperclip-only spec would silently
    // vanish. Reject rather than dispatch blind. (The comment BODY was still read
    // above; this only guards the probe-sourced paperclips.)
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

/**
 * Best-effort cleanup of S3 objects a comment-path hydrate uploaded when the
 * subsequent createTaskCore did NOT mint a fresh task (non-201, incl. a 200
 * idempotent replay) — those objects would otherwise orphan. No-op when there's
 * nothing to clean or storage isn't configured. Never throws.
 */
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

/**
 * Hydrate each human-authored sub-issue's OWN attachments (a file attached to that
 * sub-issue specifically, e.g. a mockup for just that piece) and stamp them on
 * its child row so release merges them with the inherited parent spec. Probes
 * each real child for its paperclips + scans its description for uploads links,
 * screens under a per-child S3 key, and persists via {@link setChildOwnAttachments}.
 *
 * Fail-OPEN per child (unlike the epic's shared spec, which is fail-closed): a
 * child's own file is enrichment, so a screening failure for one sub-issue skips
 * THAT file and logs it rather than aborting the whole epic. Integration nodes
 * (pure branch merges) are skipped. Returns a Map of sub_issue_id → the stamped
 * records so the caller can patch the in-memory snapshot directly (a re-load
 * here would be eventually-consistent and could miss the just-written stamp).
 * Best-effort end to end.
 */
async function hydrateChildrenOwnAttachments(
  children: readonly { sub_issue_id: string; description?: string }[],
  workspaceId: string,
  platformUserId: string,
  accessToken: string,
  orchestrationId: string,
  /** Count of parent-epic attachments every child inherits — used to trim a
   *  child's OWN set so the merged (own + inherited) total never exceeds the cap
   *  in releaseChild, and to NOTIFY the user which own files won't fit — no
   *  silent drop. */
  inheritedCount: number,
): Promise<Map<string, PassedAttachmentRecord[]>> {
  const stampedByChild = new Map<string, PassedAttachmentRecord[]>();
  if (!attachmentsS3Client || !ATTACHMENTS_BUCKET || !attachmentsScreeningConfig) return stampedByChild;
  const now = new Date().toISOString();
  for (const child of children) {
    if (isIntegrationNode(child.sub_issue_id)) continue;
    // Probe the sub-issue for its own paperclips; scan its own description for
    // uploads links. Skip the round-trip when neither could exist.
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
    // Cap the child's OWN budget = per-task limit − inherited parent
    // files, and TRIM THE INPUT before hydrating so we never fetch+screen+UPLOAD
    // files that would only be dropped afterward (the old code uploaded the full
    // 10 then sliced, orphaning the excess in S3 until lifecycle expiry). The
    // paperclip inputs carry a friendly `title`, so the drop note names real
    // filenames, not the path-safe UUID the record exposes.
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
    // If the budget is fully consumed by inherited files and there are no
    // description-embedded uploads to try, there's nothing left to hydrate.
    if (ownBudget === 0 && !descHasUploads) continue;
    try {
      // Per-child S3 namespace so a child's own files never collide with the
      // epic key or another child's. taskId is a label here, not a real task id.
      // remainingSlots = ownBudget so the helper's own overflow guard matches the
      // cap; description-derived uploads beyond it throw → caught fail-open below.
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
        // Fail-OPEN: log + skip this child's own file (the epic + its inherited
        // spec still run). The reject message is a diagnostic, not user-facing.
        logger.warn('Child own attachment could not be screened — releasing child WITHOUT it (non-fatal)', {
          orchestration_id: orchestrationId, sub_issue_id: child.sub_issue_id, detail: hydrated.message,
        });
        continue;
      }
      if (hydrated.records.length > 0) {
        await setChildOwnAttachments(ddb, ORCHESTRATION_TABLE!, orchestrationId, child.sub_issue_id, hydrated.records, now);
        // Return the records so the caller can patch the in-memory snapshot
        // directly — a re-loadOrchestration here is eventually-consistent and
        // could read a pre-stamp replica, releasing the child WITHOUT its own
        // attachment. Patching in memory sidesteps that read-after-write window.
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

/**
 * Return a copy of `snapshot` with each child row's `pre_screened_attachments`
 * set from `stampedByChild` (sub_issue_id → records). Used right after
 * {@link hydrateChildrenOwnAttachments} so the release path sees a child's OWN
 * attachments WITHOUT a re-loadOrchestration (that Query is eventually-consistent
 * and could read a replica from before the stamp write — the release would then
 * omit the just-stamped attachment; patching in memory closes that window).
 */
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
/**
 * Iteration-UX: post the IMMEDIATE threaded "👀 On it" reply under the trigger
 * comment, synchronously at trigger time. This is what kills the multi-minute
 * silence (cold start + clone + agent run) — the user sees a textual ack at once,
 * not just the 👀 reaction. Returns the reply's comment id so the spawn can stash
 * it in ``channel_metadata.iteration_reply_comment_id``; the fanout dispatcher
 * then EDITS this same reply on the pr_created milestone + on terminal, instead
 * of posting fresh top-level comments. Best-effort: null on any failure (the
 * iteration still runs; the terminal path falls back to a fresh reply).
 *
 * ``issueId`` is the issue the trigger comment lives on (sub-issue for a direct
 * comment, parent epic for a parent-routed one); ``replyTargetId`` is the thread
 * root to reply under.
 */
async function postIterationAck(
  workspaceId: string,
  registryTableName: string,
  issueId: string,
  replyTargetId: string,
): Promise<string | null> {
  try {
    const ref = await channelFor(registryTableName).upsertThreadedReply?.(
      issueRef(issueId, workspaceId),
      { commentId: replyTargetId },
      renderMaturingReply({ state: 'on_it' }),
    );
    // An empty id means the surface posted but can't address the reply later —
    // report "no reply to mature" rather than stamping a blank id on the task.
    return ref?.commentId || null;
  } catch (err) {
    logger.warn('Iteration ack reply failed (non-fatal)', {
      issue_id: issueId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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

/** Shape of a Linear `Comment` webhook (the @bgagent comment trigger). */
interface LinearCommentEvent {
  readonly action: 'create' | 'update' | 'remove' | string;
  readonly type: 'Comment';
  readonly data: {
    readonly id: string;
    readonly body?: string;
    /** The issue the comment is on (the sub-issue, for a comment trigger). */
    readonly issueId?: string;
    readonly issue?: { readonly id?: string };
    readonly userId?: string;
    /**
     * Set when this comment is a REPLY within a thread — the id of the thread
     * ROOT (top-level) comment. Linear threads are one level deep, and
     * commentCreate rejects a reply whose parentId is itself a reply ("Parent
     * comment must be a top level comment"). So the ✅/❌ ack must reply to the
     * ROOT, not to this comment when it's a reply (observed in practice: a
     * thread-reply @bgagent trigger had its ack silently dropped).
     */
    readonly parentId?: string;
    readonly [key: string]: unknown;
  };
  readonly actor?: { readonly id?: string; readonly name?: string };
  readonly organizationId?: string;
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
 * - Call `createTaskCore` with `channelSource: 'linear'` and metadata that ties
 *   the task back to the originating issue (the platform — not the agent —
 *   handles all Linear I/O deterministically; there is no Linear MCP).
 */
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

  // A Comment with an @bgagent mention on an orchestrated sub-issue
  // re-iterates that sub-issue's PR (the reconciler then cascades the
  // re-stack). Handled on a separate path from Issue → task creation.
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

  // ``<base>:help`` — post a one-time explainer of what the trigger labels do
  // and create NO task (customer-caught: a first-time user couldn't tell the
  // labels apart). Handled BEFORE the trigger gate because ``:help`` is
  // deliberately not a trigger variant (it must never spawn work). Requires the
  // project to be onboarded (we need a workspace token to post) + the
  // orchestration table (for the redelivery claim); otherwise a true no-op.
  if (
    hasHelpLabel((issue.labels ?? []).map((l) => l?.name), labelFilter)
    && shouldTriggerHelp(payload, labelFilter)
  ) {
    await handleHelpLabel({ issue, workspaceId: payload.organizationId ?? '', labelFilter, mappingItem });
    return;
  }

  // Silent kill-switch: an issue without the trigger label is not for us.
  // This MUST run before any user-facing comment path. Previously the
  // projectId-missing and not-onboarded paths ran first and posted
  // "❌ project isn't onboarded" comments on every Issue event in every
  // unmapped team — workspace webhooks fire workspace-wide, so a single
  // un-onboarded team produced dozens of comments per issue change.
  // Moving the label check first means an unlabeled issue is a true no-op:
  // no comment, no reaction, no task creation, no DDB writes.
  if (!shouldTrigger(payload, labelFilter)) {
    // A just-added label that looks like an ABCA trigger (the base
    // ``abca``/``bgagent``, or that base with the ``:help`` suffix) fell
    // through here SILENTLY when the project wasn't mapped — because an unmapped
    // project has no configured ``label_filter``, so it defaults to ``bgagent``
    // and a plain ``abca`` label never matches ``shouldTrigger``. Observed in
    // practice: a user applied a plain ``abca`` label on an unmapped project and
    // heard nothing back. Speak up ONLY for a JUST-ADDED recognized-ABCA label on
    // a project-less OR
    // unmapped-project issue, and the recognized-grammar check keeps it from
    // firing on an unrelated team's own labels (the workspace-wide spam this gate
    // guards against). This is a UX NUDGE, not a trigger — no task is created.
    const abcaLabelJustAdded = labelJustPresent(payload, looksLikeAbcaTriggerLabel);
    if (abcaLabelJustAdded && (!projectId || !mappingItem)) {
      // Claim-once so a webhook redelivery doesn't re-nudge:
      // ``labelJustPresent`` only limits to "just added", not "once per issue" —
      // a redelivery carries the identical ``updatedFrom.labelIds`` and would
      // re-post). Keyed on the issue id; gated on the orchestration table (the
      // same guard the :help nudge uses). No table → best-effort single post.
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
      "❌ This Linear user isn't linked to a platform user. In v1 only the API-token owner can submit tasks from Linear; multi-user OAuth support is planned (tracked as a GitHub issue).",
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
  // (no registry lookup at task-execution time).
  //
  // When the registry table IS configured but resolution returns null —
  // workspace not in registry, status not active, or token unreadable —
  // the receiver only let this through because the stack-wide fallback
  // verified. Creating a task against a workspace ABCA doesn't recognize
  // is the wrong behaviour: outbound Linear comments would silently
  // skip, the user mapping lookup would fail, and we'd burn agent
  // quota for no observable result. Drop the event explicitly here
  // rather than rely on downstream lookups to incidentally block it.
  //
  // Also capture the access token — the orchestration path below
  // needs it to fetch the sub-issue graph. Past this block ``resolved``
  // is guaranteed present (we return otherwise), so the token is set
  // whenever the registry table is configured.
  let resolvedAccessToken: string | undefined;
  let contextHint = '';
  // Native paperclip attachments (the `attachments` connection) surfaced by the
  // probe — hydrated below alongside description-embedded links.
  let probedAttachments: readonly LinearProbeAttachment[] = [];
  // Project wiki documents WITH content (ADR-016 doc pre-hydration) — screened +
  // folded into the task description below.
  let probedDocuments: readonly LinearProbeDocument[] = [];
  // Whether the context probe actually reached Linear. When
  // it FAILED (500/timeout), an empty `probedAttachments` means "unknown", not
  // "none" — so a paperclip-only spec could be silently missing. Attachment
  // hydration fails-closed on this rather than run blind.
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
    resolvedAccessToken = resolved.accessToken;
    // Probe the issue once for native paperclip attachments + project docs. The
    // uploads.linear.app paperclips are fetched/screened/stored below (like
    // description links); project docs with content are screened + folded into
    // the description; a non-uploads paperclip / empty-body doc becomes a hint.
    const probe = await probeLinearIssueContext(resolved.accessToken, issue.id);
    contextHint = renderIssueContextHint(probe);
    probedAttachments = probe.attachments ?? [];
    probedDocuments = probe.projectDocuments ?? [];
    // Only an EXPLICIT false means the probe failed; treat a probe object missing
    // the field (older shape / a hand-built test mock) as ok to avoid falsely
    // rejecting every task.
    probeOk = probe.ok !== false;
  }

  // Parent/sub-issue orchestration. Env-var gated: until the orchestration
  // stack sets ORCHESTRATION_TABLE_NAME this whole branch is dormant and the
  // handler behaves exactly as before (one issue → one task). When enabled AND
  // we have a workspace token, probe the labeled issue for a sub-issue
  // dependency graph:
  //   - has sub-issues → seed the DAG and hand off to the reconciler, which
  //     creates children in dependency order. The parent
  //     issue itself does NOT spawn a task here (no special label
  //     needed: a human-authored graph is implicit consent to execute).
  //   - no sub-issues → fall through to the single-task path below.
  //   - invalid graph (cycle/dangling) → terminal ❌ comment, no task.
  //   - transient Linear error → terminal comment; do NOT silently
  //     degrade to a single task (that would drop the epic structure).
  if (ORCHESTRATION_TABLE && resolvedAccessToken) {
    // Hydrate the parent's attachments and stamp them on the meta row
    // (releaseContext) so every child inherits them.
    //
    // Fetch the sub-issue graph ONCE up front so we can (a) only hydrate the
    // parent's attachments to the `epic-<id>` key when children ACTUALLY exist
    // (a plain issue that falls through to single_task must NOT hydrate here —
    // that would double-screen the file and orphan the epic-keyed S3 object,
    // since the single-task path below re-hydrates under the taskId), and
    // (b) hand the SAME graph to discoverOrchestration so it doesn't re-fetch.
    const graphSource = linearGraphSource(resolvedAccessToken, issue.id);
    const graphResult = await graphSource();
    // Hydrate ONLY on the FIRST seed. seedOrchestration is
    // frozen-at-first-seed, so on a RE-TRIGGER of an already-seeded epic the meta
    // row's releaseContext already pins the original records (a specific
    // s3_version_id). Re-uploading here would PUT a new current version and demote
    // the pinned one to noncurrent — which the bucket's 7-day
    // noncurrentVersionExpiration then reaps, so a child released/retried >7 days
    // later would reference an expired version. (My earlier "replay re-screens
    // identical bytes, never orphans a pinned version" comment was WRONG: S3
    // versioning makes each PUT a new version.) So skip the re-upload when the
    // orchestration meta row already exists.
    const alreadySeeded = graphResult.kind === 'ok'
      ? Boolean(await loadOrchestration(ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id)))
      : false;
    let epicAttachments: PassedAttachmentRecord[] = [];
    if (graphResult.kind === 'ok' && !alreadySeeded) {
      // A failed context probe means we can't see the parent's
      // native paperclips — don't seed a whole epic whose children would inherit a
      // spec we couldn't read. Fail-closed (the graph fetch above succeeded, so
      // this is specifically an attachment-probe failure).
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
        // Fail-closed: don't seed children blind to a spec they may need.
        await safeReportIssueFailure(issue.id, workspaceId, `❌ ${hydrated.message}`);
        return;
      }
      epicAttachments = hydrated.records;
    }

    const releaseContext: OrchestrationReleaseContext = {
      platform_user_id: platformUserId,
      // This orchestration was seeded by the Linear trigger; stamp the
      // channel on the meta row so downstream release + rollup follow it
      // (trigger-agnostic seam). Defaults to 'linear' if ever omitted.
      channel_source: 'linear',
      ...(channelMetadata.linear_oauth_secret_arn && {
        linear_oauth_secret_arn: channelMetadata.linear_oauth_secret_arn,
      }),
      ...(channelMetadata.linear_workspace_slug && {
        linear_workspace_slug: channelMetadata.linear_workspace_slug,
      }),
      linear_project_id: projectId,
      // The label this project actually triggers on, persisted at seed time
      // because this is the only point where the project mapping is in hand — the
      // reconciler works from the meta row and has no project id to look one up
      // with. The epic panel's retry hint names it, and telling an operator to
      // re-apply the default when their project triggers on something else sends
      // them to a label that starts nothing. Normalised through the same
      // expression the trigger gate matches on, so the hint can never name a label
      // the webhook would not accept.
      trigger_label: (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase(),
      // The epic's own words, captured here because this is the only point where
      // the issue body is in hand — the reconciler releases children from the
      // stored row and has no token to re-fetch it. Every child then gets the same
      // text, so PARALLEL siblings share one statement of names and shapes instead
      // of each inventing its own at a boundary they both touch. Truncated at the
      // store's single write site, not here.
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
      // Reuse the graph we already fetched above — don't hit Linear twice.
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
      // Child-OWN attachments: a human-authored sub-issue can carry a file
      // attached to IT specifically (a mockup for just that piece), distinct from
      // the epic's shared spec that every child inherits. Hydrate each child's own
      // attachments on the FIRST seed and stamp them on the child row so release
      // merges them with the inherited parent records. Fail-OPEN per child (unlike
      // the parent spec, which is fail-closed): a child's own file is enrichment,
      // so a screening failure skips THAT file + notes it rather than nuking the
      // whole epic. The stamped records are patched into the in-memory snapshot
      // below (NOT via re-load — that Query is eventually-consistent).
      if (snapshot && !discovery.alreadyExisted && resolvedAccessToken) {
        const stampedByChild = await hydrateChildrenOwnAttachments(
          snapshot.children, workspaceId, snapshot.meta.release_context.platform_user_id,
          resolvedAccessToken, discovery.orchestrationId,
          epicAttachments.length,
        );
        // Patch the in-memory snapshot with the stamped records (NOT a reload —
        // that Query is eventually-consistent and can miss the just-written
        // stamp, releasing a child without its own attachment).
        if (stampedByChild.size > 0) {
          snapshot = patchChildOwnAttachments(snapshot, stampedByChild);
        }
      }
      let releasedRoots = 0;
      // Set when a root failed terminally at release time: the epic may already be
      // settled, so the panel below must render the outcome rather than 'in progress'.
      let seedHadTerminalFailure = false;
      if (snapshot) {
        // Throttle the root release to the user's free concurrency
        // budget. A wide-root epic (many independent sub-issues, no shared
        // foundation) would otherwise release >cap roots at once; the
        // overflow gets hard-failed by admission — and a failed ROOT is
        // UNRECOVERABLE (the sweep re-releases a child from its succeeded
        // predecessor; a root has none). Leftover roots stay ``ready`` and
        // the stranded sweep releases them as slots free. Unset table → release
        // all (back-compat; admission still gates).
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
          // full child set for base-branch selection (roots have no preds → off-main)
          snapshot.children,
          'main',
          budget,
        );
        releasedRoots = results.filter((r) => r.kind === 'released').length;
        // A root rejected DETERMINISTICALLY (guardrail, validation) never becomes a
        // task, so no task event will ever wake the reconciler for it — and the
        // reconciler is what normally skips a failed node's dependents and settles
        // the epic. Without this the panel sits at "🔄 N/M" with a 👀 on a finished
        // epic until the 10-minute stranded sweep notices (observed in practice).
        // Persist the skips here so the panel posted just below already shows the
        // settled picture.
        const patched = await applyTerminalCreateFailures(
          ddb, ORCHESTRATION_TABLE, discovery.orchestrationId, snapshot.children, results, new Date().toISOString(),
        );
        // Identity, not deep-compare: the helper returns the SAME array when nothing
        // failed terminally, and a fresh one when it patched anything.
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
      // Post the initial epic panel + mirror the parent start signal (👀
      // reaction + a running state) in one upsertEpicPanel call. The reconciler
      // edits this same panel on every later event and advances the parent to
      // awaiting-review on completion. Only on the first seed — a replay
      // (alreadyExisted) routes to the 'extended' branch instead. Best-effort;
      // gated on the registry table like every other feedback.
      if (WORKSPACE_REGISTRY_TABLE && !discovery.alreadyExisted) {
        // Post the initial maturing panel (in-progress) and mirror the parent
        // start signal in one call. Re-load post-release so roots show
        // 'running'. Stamp the comment id so the reconciler edits this same
        // panel on every later event. Best-effort.
        try {
          const postReleaseSnapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
          if (postReleaseSnapshot) {
            // When a root failed terminally the epic may ALREADY be finished, so
            // render the settled panel (❌ rows + the retry hint) instead of
            // claiming it's in progress. Read from the freshly-loaded rows, which
            // include the skips just persisted.
            const settled = seedHadTerminalFailure && postReleaseSnapshot.children.every(
              (c) => c.child_status === 'succeeded' || c.child_status === 'failed' || c.child_status === 'skipped',
            );
            const commentId = await upsertEpicPanel({
              channel: channelFor(WORKSPACE_REGISTRY_TABLE),
              parent: issueRef(issue.id, workspaceId),
              children: postReleaseSnapshot.children,
              ...seedFailureReasons(postReleaseSnapshot.children),
              inProgress: !settled,
              mirrorParentState: true,
            });
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
      // The parent issue itself spawns no task; the reconciler (off the
      // TaskTable stream) releases downstream children as roots succeed.
      return;
    }
    if (discovery.kind === 'extended') {
      // Orchestration-extend: sub-issues were added to an already-seeded epic.
      // Release the newly-added nodes whose predecessors are ALREADY done (the
      // store marked them 'ready'); the rest are 'blocked' and the reconciler
      // releases them as predecessors finish. A re-trigger with no new nodes
      // returns empty → nothing to do.
      if (discovery.addedSubIssueIds.length === 0) {
        // Pure re-trigger, no new nodes. If the existing graph already
        // reached terminal WITH failures (failed/skipped children), a re-label is
        // the user asking to RETRY the parts that didn't finish — re-run them
        // instead of the old misleading "running the existing sub-issue graph"
        // note that re-ran nothing. A still-running or all-succeeded epic has
        // nothing to retry and reports honestly.
        await maybeRetryTerminalEpic(discovery.orchestrationId, issue.id, workspaceId);
        logger.info('Linear orchestration re-trigger — no new sub-issues to add', {
          issue_id: issue.id, orchestration_id: discovery.orchestrationId,
        });
        return;
      }
      let snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      // Hydrate the NEWLY-ADDED children's OWN attachments too — the
      // seed-time pass only saw the original children, so a sub-issue added to an
      // existing epic (with its own mockup) would otherwise release without it.
      // Scope to just the added ids; reuse the meta row's inherited parent count
      // for the per-task cap. Patch the in-memory snapshot with the stamped
      // records (NOT a reload — eventually-consistent, can miss the write).
      // (The parent epic's OWN attachments stay frozen-at-first-seed by design —
      // see the retrigger note below; children still inherit the original spec.)
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
        // Release only the newly-added 'ready' nodes. Pass the FULL child set
        // as allChildren so base-branch selection sees finished
        // predecessors' branches (a new node stacks on its done predecessor).
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
            snapshot.children, // full set → base branch off finished predecessors
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
      // No standalone '➕ Added' comment — the new row appearing in the maturing
      // panel IS the signal (the user just added the sub-issue themselves, so
      // they don't need a ping). Refresh the panel so it shows the new row(s) +
      // reverts the header to in-progress. Re-load post-release so a
      // just-released added node shows 'running'. Best-effort.
      if (WORKSPACE_REGISTRY_TABLE && snapshot) {
        try {
          const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
          const children = fresh?.children ?? snapshot.children;
          const meta = (fresh ?? snapshot).meta;
          const newId = await upsertEpicPanel({
            channel: channelFor(WORKSPACE_REGISTRY_TABLE),
            parent: issueRef(issue.id, workspaceId),
            ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
            children,
            inProgress: true, // the extend re-opened the epic
          });
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
      return;
    }
    // discovery.kind === 'single_task' → the issue had no sub-issues, so fall
    // through to the single-task path below.
  }

  // ADR-016 pre-hydration: fetch recent HUMAN comments and fold them into the
  // task description — the agent has no Linear MCP to read the thread at
  // runtime. Advisory + fail-open end to end: a fetch failure yields no
  // comments, and third-party comment text that trips the guardrail is dropped
  // (never the task; the reporter-authored description is screened separately by
  // createTaskCore). Mirrors the Jira processor.
  let recentComments: RenderedComment[] = [];
  if (WORKSPACE_REGISTRY_TABLE && resolvedAccessToken) {
    const fetched = await fetchRecentComments(
      { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
      issue.id,
    );
    recentComments = await screenCommentsOrDrop(fetched, issue.id, workspaceId);
  }

  // ADR-016: project wiki docs the issue's project carries are pre-hydrated with
  // CONTENT (the agent has no Linear MCP to fetch them at runtime). Screen the
  // combined doc text on its own — third-party doc content that trips the
  // guardrail is DROPPED (fail-open), never gating the reporter's task.
  const projectDocs = await screenProjectDocsOrDrop(probedDocuments, issue.id, workspaceId);

  const taskDescription = buildTaskDescription(issue, contextHint, recentComments, projectDocs);

  // Extract embedded image URLs from the issue description markdown. Non-Linear
  // (public CDN) images become URL attachments fetched+screened during context
  // hydration; uploads.linear.app images are handled below (they need auth).
  const attachments = extractImageUrlAttachments(issue.description);

  // Mint the taskId up-front so pre-screened attachment S3 keys match the
  // eventual task record (createTaskCore honors ctx.taskId). Mirrors Jira.
  const taskId = ulid();

  // If the context probe FAILED, we can't see native paperclips —
  // a paperclip-only spec would silently vanish. Fail-closed rather than run the
  // agent blind. (A description-embedded uploads link would still be caught by
  // the hydrate below, but a paperclip attached with no link in the body is only
  // discoverable via the probe.) Only rejects when the probe genuinely errored;
  // a healthy empty probe proceeds as before.
  if (resolvedAccessToken && !probeOk) {
    await safeReportIssueFailure(
      issue.id, workspaceId,
      "❌ ABCA couldn't read this issue's attachments from Linear (the API errored or timed out). "
      + 'Re-apply the trigger label to retry — this avoids running on a spec that may be attached but unreadable.',
    );
    return;
  }

  // ADR-016: fetch uploads.linear.app files with the workspace OAuth token,
  // screen, store, inject as preScreenedAttachments. Fail-closed via
  // the shared helper — an unscreenable attachment rejects the whole task.
  // Combined cap: public-URL image attachments already consume slots.
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
  // The processor is a bare async (Event) Lambda invoke — a throw
  // AFTER createTaskCore returned 201 makes Lambda re-run the whole handler on
  // the same delivery (default 2 async retries), duplicating the coding task +
  // PR. The receiver's DEDUP_TABLE only guards Linear REDELIVERY, not the
  // processor's own retry. Pass a deterministic idempotency key so a retried
  // delivery replays (200) instead of re-creating. Keyed on the Linear
  // webhookTimestamp (stable across a delivery's retries) + issue id — a genuine
  // later re-label is a new delivery with a new timestamp, so it is NOT blocked.
  // Sanitized to createTaskCore's charset /^[A-Za-z0-9_-]{1,128}$/.
  const labelTriggerKey = `linear-label-${issue.id}-${(payload as LinearIssueEvent).webhookTimestamp ?? requestId}`
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const result = await createTaskCore(
    {
      repo,
      task_description: taskDescription,
      // Explicit coding workflow: a label-triggered Linear task always targets a
      // mapped repo, so it must not fall through the resolution ladder to the
      // repo-less default/agent-v1 (which never commits or opens a PR). Mirrors
      // the Jira processor. See CODING_WORKFLOW_ID.
      workflow_ref: CODING_WORKFLOW_ID,
      ...(attachments.length > 0 && { attachments }),
    },
    {
      userId: platformUserId,
      channelSource: 'linear',
      channelMetadata,
      taskId,
      ...(preScreenedAttachments.length > 0 && { preScreenedAttachments }),
      // Guards duplicate dispatch: a stable idempotency key (issue id + webhook
      // timestamp) so a Linear webhook redelivery can't mint a second task.
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
    // Don't orphan the attachment objects we uploaded before this call failed —
    // createTaskCore only rolls back its own inline uploads, not ours.
    if (preScreenedAttachments.length > 0 && attachmentsS3Client && ATTACHMENTS_BUCKET) {
      await cleanupPreScreenedAttachments(attachmentsS3Client, ATTACHMENTS_BUCKET, preScreenedAttachments);
    }
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

  // ADR-016 P4.5: post the first-run "🤖 Starting" courtesy comment from the
  // Lambda tier. This used to be the agent's own `mcp__linear-server__save_comment`
  // call — with the Linear MCP removed (Linear is fully deterministic), the
  // platform owns the comment. Only the single-task first-run path posts it:
  // orchestration seeds and comment-iterations returned earlier (their
  // panel / maturing reply already narrate start). Best-effort — never gates the
  // run that already started. The 👀 reaction + In Progress transition still
  // happen agent-side (linear_reactions.react_task_started); this is the human-
  // readable companion, posted at admission so it lands before the container
  // cold-starts. The terminal ✅/⚠️/❌ + PR link is posted by the fan-out plane.
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

/** Outcome of {@link maybeRetryTerminalEpic} — lets a comment-driven caller
 *  distinguish a real retry from the "nothing to retry" cases. */
type RetryOutcome = 'retried' | 'all_succeeded' | 'still_running' | 'no_orchestration';

/**
 * Retry an already-terminal epic on a pure re-trigger (re-label with
 * no new sub-issues). The seed/extend paths never re-run terminal children, so a
 * re-label of an epic that finished WITH failures previously re-ran nothing while
 * claiming it was "running the existing sub-issue graph". This resets the
 * failed + skipped children and re-releases the now-ready layer (the forward
 * reconciler cascade carries the rest as retried predecessors re-succeed),
 * mirroring the recovery-cascade shape. ``succeeded`` nodes are never touched.
 *
 * Three outcomes, all with honest copy:
 *  - failed/skipped children exist → RETRY them (reset + re-release + re-open the
 *    rollup claim so the panel re-settles) and post {@link renderEpicRetryNote}.
 *  - every child succeeded → post {@link renderEpicAlreadyCompleteNote} (nothing to run).
 *  - the epic is still RUNNING (a child released/running, none failed/skipped) →
 *    stay quiet; the live panel already shows the work in flight, so a re-apply
 *    needs no note of its own.
 *
 * Best-effort throughout; never throws out of the webhook. Idempotency: the retry
 * is naturally convergent — a redelivery finds the nodes already reset to
 * ready/blocked/released (computeEpicRetryPlan sees 0 failed/skipped) and no-ops.
 *
 * Returns a {@link RetryOutcome} so a comment-driven caller can react: keep 👀
 * on ``retried``, else reply honestly instead of resetting nothing.
 */
async function maybeRetryTerminalEpic(
  orchestrationId: string,
  parentIssueId: string,
  workspaceId: string,
  /**
   * When a COMMENT (not a re-label) drives the retry, the caller owns
   * the user-facing acknowledgement (👀→🔄 on the comment + its own reply), so
   * suppress the label-path advisory note (already-complete) — it'd double up
   * with the comment reply. The retry mechanics (reset + re-release) are identical.
   */
  opts: {
    readonly suppressAdvisoryNotes?: boolean;
    /**
     * Idempotency: when a COMMENT drives the retry, pass its comment id. It's
     * the natural once-key — unique per genuine user action, identical across a
     * webhook redelivery — so it dedups the comment path reliably even when a
     * failed child has NO task_id (the fingerprint below can't disambiguate
     * those). Absent → the label path's failed-set fingerprint.
     */
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

  // Nothing failed/skipped → nothing to retry.
  if (plan.statusUpdates.length === 0) {
    const allSucceeded = plan.succeededCount > 0 && plan.succeededCount === snapshot.children.length;
    const outcome: RetryOutcome = allSucceeded ? 'all_succeeded' : 'still_running';
    // A comment-driven caller posts its own honest reply — skip the
    // label-path advisory note so they don't double up.
    if (opts.suppressAdvisoryNotes) return outcome;
    // Still running (nodes released/running, none terminal-failed) — the live
    // panel already says so, so a re-apply gets no note of its own.
    if (!allSucceeded) return outcome;
    if (!channel) return outcome;
    // Post the advisory note at most once per re-trigger window (a webhook
    // redelivery of the SAME label event must not repost). Distinct claim key
    // from the retry itself. Crucially this also stops a redelivery that arrives
    // AFTER a successful retry (children now released/running, none failed) from
    // re-posting a stale "already finished" note.
    const won = await claimCommentAck(
      ddb, ORCHESTRATION_TABLE, orchestrationId, 'retrigger-note',
      now, Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
    );
    if (!won) return outcome;
    // Every child succeeded — the epic is genuinely done.
    await channel.upsertComment(parentRef, renderEpicAlreadyCompleteNote());
    return outcome;
  }

  // Claim-once for THIS retry round so a webhook redelivery doesn't re-reset +
  // re-release + re-note. Keyed on the epic + the current terminal-child
  // fingerprint, so a genuine LATER retry is a distinct claim and proceeds, but
  // a redelivery of the same re-label no-ops. Without this, two deliveries each
  // post a retry note (the duplicate the user saw).
  //
  // Claim key for THIS retry round. A COMMENT-driven retry passes the comment id
  // — the natural once-key (unique per user action, stable across redelivery) —
  // which is reliable even when a failed child has no task_id.
  //
  // The LABEL path (re-apply the trigger) has no such id, so it fingerprints the
  // current failed/skipped set. The fingerprint must include each child's
  // ``child_task_id`` (not just sub_issue_id) — a retry spawns a NEW task per
  // failed child (see the idempotency salt below), so a same-way re-failure has
  // an identical SET and a sub_issue_id-only key silently drops the genuine 2nd
  // re-label (observed in practice). Also fold in ``updated_at`` so a child that
  // failed with NO task_id (the deterministic-create-rejection case, which never
  // mints a task) still gets a distinct key each round — its row is re-touched on
  // every reset, so ``sub:none:<updated_at>`` differs across rounds while a true
  // redelivery
  // (same timestamps) still collides + no-ops.
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
    // A redelivery of an already-processed retry: from the caller's view the
    // retry IS in flight (the first delivery reset + released it), so report
    // 'retried' — the comment path's 👀→🔄 ack is correct + idempotent.
    return 'retried';
  }

  logger.info('Epic retry: resetting failed/skipped children', {
    orchestration_id: orchestrationId,
    failed: plan.failedCount,
    skipped: plan.skippedCount,
    succeeded: plan.succeededCount,
    re_releasing: plan.toRelease.length,
  });

  // 1. Persist the resets (failed→ready/blocked, skipped→blocked), including the
  //    toRelease rows — releaseReadyChildren's conditional write accepts
  //    child_status IN (blocked, ready), so a row must be one of those before we
  //    release it (same ordering the recovery path relies on).
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
      // A racing redelivery already flipped it — fine, keep going.
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  // 2. The epic had settled to "⚠️ finished with failures" — release the once-only
  //    rollup claim so the parent state re-settles (❌→🔄→✅) as the retried work
  //    lands (same as the recovery path).
  await clearRollupClaim(ddb, ORCHESTRATION_TABLE, orchestrationId, now);

  // 3. Re-release the now-ready layer against a fresh read, gated on the budget.
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
        // Salt the idempotency key with each child's prior (failed)
        // task id so the retry spawns a NEW task instead of idempotently
        // replaying the failed one. releasableRows carry the old child_task_id
        // (the reset only changed child_status) — exactly the salt releaseChild
        // needs. Without this the row flips to 'released' but points at the dead
        // task and nothing actually re-runs (observed on the first retry pass).
        true,
      );
    }
  }

  // 4. Honest note + REPOSITION the live panel beneath it. The maturing panel is
  //    a single edited-in-place comment that was first posted at seed time — so on
  //    a much-later retry it's buried far up the thread, above all the newer
  //    notes, and "I'll update the panel below" points at a comment that's
  //    actually ABOVE (the confusing surface the user hit: couldn't tell what was
  //    running). Fix: post the retry note, then DELETE the old panel comment and
  //    re-post it fresh so the live status sits right under the note. The new
  //    comment id replaces status_comment_id, so the reconciler keeps editing the
  //    same (now-repositioned) panel in place on every later event.
  if (channel && WORKSPACE_REGISTRY_TABLE) {
    await channel.upsertComment(
      parentRef,
      renderEpicRetryNote({ failed: plan.failedCount, skipped: plan.skippedCount, succeeded: plan.succeededCount }),
    );
    try {
      const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
      const meta = (refreshed ?? fresh ?? snapshot).meta;
      const children = (refreshed ?? fresh ?? snapshot).children;
      // Delete the stale panel comment (best-effort) so we don't leave two panels.
      // Repositioning a comment by delete-and-repost is a thread-shape detail of
      // this surface, so it stays a direct call rather than a channel operation.
      if (meta.status_comment_id) {
        await deleteComment(
          { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
          meta.status_comment_id,
        );
      }
      // Post the panel FRESH (no statusCommentId → new comment, below the note).
      const newPanelId = await upsertEpicPanel({
        channel,
        parent: parentRef,
        children,
        inProgress: true,
        mirrorParentState: true,
      });
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

/**
 * Handle a ``@bgagent retry`` comment on an epic OR one of its children —
 * shared by both comment paths so they behave IDENTICALLY (the whole point of
 * the fix). The caller has already claimed + 👀-acked the comment; this runs the
 * epic-retry machinery and, on the no-op cases, replies honestly and swaps
 * 👀→❓. On ``retried`` it leaves the 👀 (work in flight; the epic panel shows the
 * 🔄). Returns nothing — the caller returns immediately after.
 *
 * @param replyIssueId  the issue to post the "nothing to retry" reply on (the
 *                      epic for a parent comment; the commented child otherwise).
 */
async function handleEpicRetryIntent(args: {
  orchestrationId: string;
  parentIssueId: string;
  workspaceId: string;
  commentId: string;
  replyIssueId: string;
  replyTargetId: string;
  channel: Channel;
}): Promise<void> {
  const { orchestrationId, parentIssueId, workspaceId, commentId, replyIssueId, replyTargetId, channel } = args;
  const outcome = await maybeRetryTerminalEpic(
    orchestrationId, parentIssueId, workspaceId,
    // Dedup on the COMMENT id — reliable even for a failed child with no task_id,
    // and it covers the "nothing to retry" reply too (a redelivery must not
    // re-post the reply / re-swap the reaction).
    { suppressAdvisoryNotes: true, retryClaimKey: commentId },
  );
  if (outcome === 'retried') {
    // Keep 👀 for now — the work really is in flight, and the live panel shows the
    // 🔄. But record the comment so the epic's next settle moves that 👀 to the
    // outcome: this handler is done the moment the retry is dispatched, and the
    // reconciler that observes the result has no other way to know which comment
    // asked for it, so without this the comment the user is watching stays on 👀
    // forever even after the epic finishes (observed in practice).
    try {
      // maybeRetryTerminalEpic already returned 'no_orchestration' when the table
      // is unset, so reaching 'retried' means it is configured.
      await setRetryCommentId(ddb, ORCHESTRATION_TABLE!, orchestrationId, commentId);
    } catch (err) {
      // Non-fatal: the retry itself is already running, and the panel still
      // reports the outcome. Only the comment's marker is lost.
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
  // Nothing to retry (all succeeded / still running / no orchestration) — reply
  // honestly rather than resetting nothing, and swap 👀→❓ (a question, not work).
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

/** Hex chars of the retry-fingerprint hash kept for the claim key — enough to avoid
 *  collision across an epic's retry rounds while keeping the DDB sort key short. */
const RETRY_FINGERPRINT_HASH_LEN = 16;

/** Stable short hash of the retry fingerprint for the claim key (crypto, not Math.random). */
function hashRetryFingerprint(fingerprint: string): string {
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, RETRY_FINGERPRINT_HASH_LEN);
}

/**
 * A comment addressed the bot by the WRONG
 * handle (@abca — mistaking the trigger label for the mention handle — or a
 * boundary-miss like @bgagentx). {@link parseCommentTrigger} didn't fire, so the
 * comment used to vanish silently (no reply, no reaction) and the reviewer never
 * learned their instruction wasn't seen. Post a one-line nudge to the right
 * handle + react ❓ so it's visibly acknowledged.
 *
 * Idempotent: claim-once on the comment id (a webhook redelivery is a no-op) —
 * keyed under a distinct ``wrong-mention:`` action so it doesn't collide with the
 * real-trigger claim if the reviewer later fixes the handle on the same thread.
 * Best-effort throughout; never throws out of the webhook.
 */
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

  // ❓ on the reviewer's comment + a one-line "I answer to @bgagent" reply, so a
  // wrong-handle mention is visibly acknowledged instead of vanishing. The reply
  // is 👋-prefixed (self-trigger guard skips it), so it can't loop.
  await channel.reactToComment?.({ commentId }, commented, 'needs_input');
  const replyTargetId = payload.data?.parentId ?? commentId;
  await channel.postThreadedReply?.(commented, { commentId: replyTargetId }, renderWrongMentionNudge());
  logger.info('Near-miss mention: nudged reviewer to @bgagent', { issue_id: commentedIssueId, comment_id: commentId });
}

/**
 * Comment trigger. A Linear comment with an ``@bgagent`` mention on an
 * orchestrated sub-issue runs a ``coding/pr-iteration-v1`` task on that
 * sub-issue's PR; the comment text is the instruction. When that task
 * completes, the reconciler cascades the re-stack to dependents.
 *
 * Resolution: comment.issueId (the sub-issue) → its parent (Linear fetch) →
 * deriveOrchestrationId(parent) → loadOrchestration → the child row for the
 * sub-issue → its PR number (from the child's task record). All best-effort;
 * a non-orchestration comment, a missing mention, or an un-started sub-issue is
 * a clean no-op (no failure comment — comments are conversational).
 */
async function handleCommentTrigger(payload: LinearCommentEvent): Promise<void> {
  // Orchestration must be enabled + a workspace token resolvable.
  if (!ORCHESTRATION_TABLE || !WORKSPACE_REGISTRY_TABLE) {
    return;
  }
  const body = payload.data?.body;
  const trigger = parseCommentTrigger(body);
  if (!trigger.triggered) {
    // Before silently dropping, check for a NEAR-MISS mention — the reviewer
    // addressed the bot by the wrong handle
    // (@abca, @bgagentx). That used to vanish with no reply/reaction, so the
    // reviewer had no idea their instruction was never seen. Nudge them to the
    // right handle. A genuine non-mention comment (human discussion, the bot's own
    // progress) still falls through to a silent ignore.
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
  // The ✅/❌ ack must reply to the thread ROOT — Linear rejects a reply whose
  // parentId is itself a reply. When the trigger is a thread-reply, data.parentId
  // is the root; otherwise the comment IS the root. The 👀 still goes on the
  // actual comment the human wrote (reactions work at any thread depth).
  const replyTargetId = payload.data.parentId ?? commentId;

  // AUTHORIZATION: the issue→task path gates on lookupPlatformUser
  // (a Linear actor with no linked ABCA user can't create tasks). The COMMENT
  // path did NOT — so ANY workspace member or guest who can post @bgagent could
  // retry an epic and START code-pushing agent runs, all attributed to and
  // BILLED against the original requester. Resolve the commenter to a platform
  // user BEFORE any dispatch. Unmapped →
  // ❓ + a one-line reply, then stop. (The bot's own comments never carry the
  // mention token, so they don't reach here; and an app-actor commenter is
  // likewise unmapped, which is correct — the app can't authorize itself.)
  const commenterId = payload.actor?.id;
  const commenterPlatformUserId = commenterId
    ? await lookupPlatformUser(workspaceId, commenterId)
    : null;
  if (!commenterPlatformUserId) {
    logger.warn('Comment trigger: commenter has no linked platform user — refusing to act on the trigger', {
      linear_workspace_id: workspaceId, linear_user_id: commenterId, linear_issue_id: commentedIssueId,
    });
    const channel = channelFor(WORKSPACE_REGISTRY_TABLE);
    const commented = issueRef(commentedIssueId, workspaceId);
    await channel.reactToComment?.({ commentId }, commented, 'needs_input');
    try {
      await channel.upsertThreadedReply?.(
        commented, { commentId: replyTargetId },
        'I can only act on `@bgagent` requests from a linked ABCA user. Link your Linear '
          + 'account first (ask your ABCA admin / run `bgagent linear link`), then re-comment.',
      );
    } catch { /* best-effort reply */ }
    return;
  }

  // Is the commented issue itself a PARENT epic? deriveOrchestrationId
  // is a pure hash of the issue id, so the parent's own id maps to ITS
  // orchestration; a sub-issue's id hashes to nothing. The maturing panel lives
  // on the parent, so reviewers comment THERE ("@bgagent for the footer, …") —
  // route that to the sub-issue it names. (Was a silent drop: the parent has no
  // PR, so it fell to the standalone GSI path → miss → ignored.)
  const ownOrchestrationId = deriveOrchestrationId(commentedIssueId);
  const parentSnapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, ownOrchestrationId);
  if (parentSnapshot && parentSnapshot.meta.parent_issue_ref === commentedIssueId) {
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

  // Sub-issue → parent → orchestration. When ANY of these don't hold (no
  // parent, parent isn't an orchestration, or this isn't a STARTED child),
  // the issue may still be a plain (non-orchestration) issue that ABCA opened
  // a PR for — fall through to the standalone path, which iterates
  // on that PR with the same 👀/reply ack but no dependency cascade.
  const parentId = await fetchIssueParentId(resolved.accessToken, commentedIssueId);
  const orchestrationId = parentId ? deriveOrchestrationId(parentId) : null;
  const snapshot = orchestrationId
    ? await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId)
    : null;
  const child = snapshot?.children.find((c) => c.sub_issue_id === commentedIssueId);
  if (!snapshot || !child || !child.child_task_id) {
    await handleStandaloneCommentTrigger({
      subIssueId: commentedIssueId,
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

  // A RETRY request on a sub-issue that belongs to an orchestration means the
  // same thing as a retry on the epic — "re-run the failed/skipped work" — so
  // route it to the SAME epic-retry helper the parent
  // path uses (a child that failed before opening a PR can't be "iterated"; and
  // retry must behave identically whether typed on the epic or a child). Only a
  // bare-ish retry phrase; "retry but also change X" stays an iteration.
  if (parseRetryIntent(trigger.instruction)) {
    const channel = channelFor(WORKSPACE_REGISTRY_TABLE);
    await channel.reactToComment?.({ commentId }, issueRef(commentedIssueId, workspaceId), 'started');
    await handleEpicRetryIntent({
      orchestrationId: orchestrationId!,
      parentIssueId: snapshot.meta.parent_issue_ref,
      workspaceId,
      commentId,
      replyIssueId: commentedIssueId, // reply on the child the user commented on
      replyTargetId,
      channel,
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

/**
 * An ``@bgagent`` comment left on the PARENT epic. The maturing
 * panel lives on the parent, so a reviewer's natural move is to comment there.
 * The parent has no PR of its own, so we route the request to the sub-issue it
 * names (by identifier or title keyword) and iterate THAT sub-issue's PR. When
 * the comment names no single sub-issue, we 👀 + post a "which one?" reply
 * (with a best-effort suggestion + the create-a-sub-issue path) — NEVER a
 * silent drop, and NEVER auto-creating new work (user's call).
 */
async function handleParentEpicCommentTrigger(args: {
  orchestrationId: string;
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>;
  workspaceId: string;
  commentId: string;
  /** Raw @bgagent comment body — carries any newly-attached uploads.linear.app links. */
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<void> {
  const { orchestrationId, snapshot, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;
  const channel = channelFor(registryTableName);
  const parentRef = issueRef(snapshot.meta.parent_issue_ref, workspaceId);

  // Claim-once BEFORE any side-effect. Linear redelivers a comment
  // webhook when the handler exceeds its ~5s ack window (this path does several
  // Linear API calls and can run >5s), and EACH redelivery would otherwise
  // re-react + re-post the disambiguation reply — observed in practice spamming
  // 50+ duplicate replies. The conditional claim (keyed on this comment id) lets
  // only the FIRST delivery proceed; redeliveries no-op here. The marker
  // self-expires via the table TTL. (The iterate path also has its own
  // createTaskCore idempotency key — this is the outer guard that also covers
  // the 👀 + the ask-reply, which have no other dedup.)
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

  // ACK immediately — a parent comment is never silently dropped again.
  await channel.reactToComment?.({ commentId }, parentRef, 'started');

  // A RETRY request on the epic ("@bgagent retry", "try again") — the failure
  // panel literally says "reply here to try again" — must route to the epic-retry
  // machinery (reset + re-run the failed/skipped children), NOT to node
  // disambiguation, which used to dead-end and loop on exactly this input. Same
  // helper as the child path so both behave identically.
  // Only a bare-ish retry phrase; "retry the footer but change X" is a
  // substantive edit and falls through to iterate.
  if (parseRetryIntent(trigger.instruction)) {
    await handleEpicRetryIntent({
      orchestrationId,
      parentIssueId: snapshot.meta.parent_issue_ref,
      workspaceId,
      commentId,
      replyIssueId: snapshot.meta.parent_issue_ref, // reply on the epic
      replyTargetId,
      channel,
    });
    return;
  }

  // Only STARTED children with a task are iterable candidates; match against all
  // real nodes for the disambiguation list, but iterate only a started one.
  const match = parseParentNodeReference(trigger.instruction, snapshot.children);
  const target = match.reason === null ? match.matches[0] : null;

  // When the epic has failed/skipped children, every "can't act on this"
  // reply surfaces the `retry` command — so an unrecognised comment always shows
  // what the user CAN do (no intent-guessing needed).
  const epicHasFailures = snapshot.children.some(
    (c) => c.child_status === 'failed' || c.child_status === 'skipped',
  );

  if (!target || !target.child_task_id) {
    // No confident single match (or matched a not-yet-started node) → ask.
    const reason = match.reason === 'ambiguous' ? 'ambiguous' : 'none';
    const suggestion = reason === 'none' ? suggestClosestNode(trigger.instruction, snapshot.children) : null;
    // If it reads like NEW work AND we found no close existing node,
    // lead with the create-a-sub-issue path rather than the generic "couldn't
    // tell". A close suggestion takes precedence (more likely a vague edit).
    const newWork = reason === 'none' && !suggestion && looksLikeNewWork(trigger.instruction);
    const body = renderParentDisambiguationReply(reason, snapshot.children, suggestion, newWork, epicHasFailures);
    await channel.postThreadedReply?.(parentRef, { commentId: replyTargetId }, body);
    // This is a QUESTION, not work-in-progress. Replace the 👀 we put on receipt
    // with ❓ so the comment doesn't look like it's still being worked.
    await channel.replaceCommentReaction?.({ commentId }, parentRef, 'needs_input');
    logger.info('Comment trigger (parent epic): no single iterable sub-issue matched — asked', {
      orchestration_id: orchestrationId, reason, match_count: match.matches.length,
    });
    return;
  }

  const prNumber = await resolveChildPrNumber(target.child_task_id);
  if (prNumber === null) {
    // Matched a node but it has no PR to iterate. If that node FAILED, the user
    // named it to fix it — there's nothing to iterate (no PR), so point them
    // straight at retry instead of the generic disambiguation. Observed in
    // practice: naming a failed child got "couldn't tell / no PR" with no way out.
    const targetRow = snapshot.children.find((c) => c.sub_issue_id === target.sub_issue_id);
    const body = targetRow?.child_status === 'failed'
      ? `👋 **${nodeDisplayId(target) ?? target.sub_issue_id}** failed before opening a PR, so there's `
        + 'nothing to iterate on yet. Reply `@bgagent retry` on this epic to re-run the failed work '
        + '(or remove and re-apply the `abca` label) — then comment again once it has a PR.'
      : renderParentDisambiguationReply('none', snapshot.children, target, false, epicHasFailures);
    await channel.postThreadedReply?.(parentRef, { commentId: replyTargetId }, body);
    // Matched a node but it has no PR yet — also a "wait / clarify" state, not
    // active work; 👀 → ❓.
    await channel.replaceCommentReaction?.({ commentId }, parentRef, 'needs_input');
    logger.info('Comment trigger (parent epic): matched sub-issue has no PR yet — asked', {
      orchestration_id: orchestrationId,
      sub_issue_id: target.sub_issue_id,
      child_status: targetRow?.child_status,
    });
    return;
  }

  // Resolve the FULL child row (the matcher returns a trimmed view without
  // ``repo``) so the iteration carries the sub-issue's repo.
  const childRow = snapshot.children.find((c) => c.sub_issue_id === target.sub_issue_id)!;

  // Route to the matched sub-issue exactly as if the human had commented there.
  // The 👀 is already on the parent comment; the ✅/❌ reply threads back to it.
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
    // The trigger comment lives on the PARENT epic, not the
    // sub-issue — the reconciler must reply with the parent issue id.
    triggerCommentIssueId: snapshot.meta.parent_issue_ref,
    // Already acked on the parent comment above.
    skipAck: true,
    prNumber,
  });
  logger.info('Comment trigger (parent epic): routed to sub-issue', {
    orchestration_id: orchestrationId, sub_issue_id: target.sub_issue_id, pr_number: prNumber,
  });
}

/**
 * Spawn a ``coding/pr-iteration-v1`` task for one orchestration sub-issue from
 * an ``@bgagent`` comment. Shared by the direct sub-issue
 * path (comment on the sub-issue) and the parent-epic path (comment on the
 * epic, routed here). Acks the trigger comment with 👀 (unless already acked),
 * marks the task as a cascade SOURCE so the reconciler re-stacks dependents,
 * and threads ✅/❌ back to ``replyTargetId`` on completion.
 */
async function iterateOrchestrationChild(args: {
  orchestrationId: string;
  snapshot: NonNullable<Awaited<ReturnType<typeof loadOrchestration>>>;
  child: { sub_issue_id: string; repo: string; child_task_id?: string };
  workspaceId: string;
  commentId: string;
  replyTargetId: string;
  /**
   * The Linear ISSUE the trigger comment lives on — the sub-issue for a direct
   * comment, the PARENT epic for a parent-routed comment. The reconciler
   * replies ✅/❌ using THIS as commentCreate's issueId. Defaults to
   * the sub-issue id.
   */
  triggerCommentIssueId?: string;
  trigger: CommentTrigger;
  /** Raw @bgagent comment body — carries any newly-attached uploads.linear.app links. */
  commentBody: string | undefined;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
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

  const prNumber = args.prNumber ?? (child.child_task_id ? await resolveChildPrNumber(child.child_task_id) : null);
  if (prNumber === null || prNumber === undefined) {
    logger.warn('Comment trigger: sub-issue has no resolvable PR — cannot iterate', {
      orchestration_id: orchestrationId, sub_issue_id: subIssueId, child_task_id: child.child_task_id,
    });
    return;
  }

  // Attribute to the orchestration's release user (the comment author may not
  // be a linked platform user; the orchestration already ran under this id).
  const platformUserId = snapshot.meta.release_context.platform_user_id;

  // ACK the request the instant we commit to acting on it. 👀 on the TRIGGERING
  // comment is the zero-clutter "on it" signal. The parent-epic path already
  // acked, so it passes skipAck.
  const channel = channelFor(registryTableName);
  const commentedRef = issueRef(triggerCommentIssueId, workspaceId);
  if (!args.skipAck) {
    await channel.reactToComment?.({ commentId }, commentedRef, 'started');
  }

  // Iteration-UX: post the immediate "👀 On it" threaded reply (kills the
  // silence) and persist its id so the fanout dispatcher matures THIS reply
  // (🔄→✅/💬) instead of posting new top-level comments. The reply threads under
  // the conversation root (replyTargetId) on the issue the comment lives on.
  const iterationReplyId = await postIterationAck(workspaceId, registryTableName, triggerCommentIssueId, replyTargetId);

  // Idempotency: one iteration per (sub-issue, comment). The comment id is
  // unique per comment, so a webhook retry of the same comment dedups.
  const idempotencyKey = `iterate_${subIssueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);

  const channelMetadata: Record<string, string> = {
    orchestration_id: orchestrationId,
    orchestration_sub_issue_id: subIssueId,
    // Mark this as a cascade SOURCE so the reconciler re-stacks dependents
    // when the iteration completes (the reconciler reads this flag).
    orchestration_iteration: 'true',
    // The reconciler replies ✅/❌ to the thread ROOT when the
    // iteration lands (threaded ack — closes the conversation the human opened).
    trigger_comment_id: replyTargetId,
    // The issue that comment lives on, so the reconciler's reply
    // uses the right commentCreate issueId (parent epic for a routed comment;
    // the sub-issue for a direct comment).
    trigger_comment_issue_id: triggerCommentIssueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    // The agent addresses a REAL Linear issue for its reactions/comments. The
    // synthetic integration node has no Linear issue — its id is a derived string
    // (`<orchestrationId>__integration`), and handing that to the agent makes it
    // call Linear with an id that cannot resolve. Fall back to the issue the
    // trigger comment lives on, which for a routed parent comment is the epic.
    linear_issue_id: isIntegrationNode(subIssueId) ? triggerCommentIssueId : subIssueId,
    // Iteration-UX: the maturing reply to EDIT (not re-create) on later events.
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  // ADR-016: a reviewer can drop a NEW screenshot/log into the @bgagent comment
  // ("this is still broken, see attached"). The agent has no Linear MCP to fetch
  // it, so hydrate the comment's uploads here and pass them to the iteration.
  // The new material rides in the comment body — don't re-probe the issue (that
  // would re-screen the issue's existing paperclips every round). Fail-closed:
  // an unscreenable attachment aborts the iteration with a threaded reply rather
  // than iterating blind on a spec the agent can't see.
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
    await channel.postThreadedReply?.(commentedRef, { commentId: replyTargetId }, `❌ ${iterHydrated.message}`);
    return;
  }

  try {
    const result = await createTaskCore(
      {
        repo: child.repo,
        workflow_ref: 'coding/pr-iteration-v1',
        pr_number: prNumber,
        // An iteration on the COMBINED PR gets a prompt that tells the agent to
        // reproduce across the merged siblings and fix the mismatch at its source.
        // The default prompt is actively wrong there: on a branch that builds and
        // whose tests pass, "X is wrong" reads as a presentation bug.
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
    // A non-201 (validation reject, or a 200 idempotent replay on a webhook
    // redelivery) means THIS call's freshly-minted taskId never became a task —
    // its S3 uploads would orphan (the replay points at the first delivery's
    // distinct key). Clean them up.
    if (result.statusCode !== 201) {
      await cleanupPreScreenedForComment(iterHydrated.records);
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
  }
}

/**
 * The GENERALIZED comment trigger. An ``@bgagent`` comment on a
 * PLAIN Linear issue (no orchestration epic) that ABCA already opened a PR for
 * runs a ``coding/pr-iteration-v1`` task on that PR, with the same 👀-on-receipt
 * / threaded-reply-on-completion ack as the orchestration path — but NO
 * dependency cascade (there are no dependents). The issue → newest-task → PR
 * link comes from the ``LinearIssueIndex`` GSI (orchestration sub-issues use
 * the orchestration table instead; this is the everything-else case).
 *
 * The completion reply is posted by the fanout dispatcher (``dispatchToLinear``)
 * — a standalone iteration carries ``trigger_comment_id`` but NO
 * ``orchestration_iteration`` marker, so the reconciler ignores it and fanout
 * owns the ✅/❌ reply. A clean no-op when the issue was never run by ABCA
 * (GSI miss) or its task opened no PR.
 */
/**
 * Post a one-line nudge on an issue we could not act on, and settle the trigger
 * comment's reaction so the thread does not sit on 👀 forever.
 *
 * Claims the comment first, so a webhook redelivery (Linear retries) does not post
 * the same nudge twice — the same guard the near-miss path uses.
 */
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
    // ❓ not ✅: nothing succeeded, and the user may need to act.
    await channel.replaceCommentReaction?.({ commentId }, target, 'needs_input');
  } catch (err) {
    // Best-effort telling-the-user; a posting failure must not turn an ignorable
    // comment into a handler error (and it is already logged by the caller).
    logger.warn('Could not post the standalone nudge (non-fatal)', {
      linear_issue_id: issueId,
      comment_id: commentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleStandaloneCommentTrigger(args: {
  subIssueId: string;
  workspaceId: string;
  commentId: string;
  /** Raw @bgagent comment body — carries any newly-attached uploads.linear.app links. */
  commentBody: string | undefined;
  /** Thread ROOT to reply to (= parentId when the trigger is a reply, else commentId). */
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<void> {
  const { subIssueId: issueId, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;

  // Reaching here means someone explicitly mentioned @bgagent (parseCommentTrigger
  // gates the whole path), so silence is never the right answer — they addressed
  // the bot and are waiting. Distinguish "no task" from "the lookup broke": the
  // first is a real answer, the second is us not knowing, and reporting the second
  // as the first is a guess presented as a fact.
  const lookup = await lookupTaskByLinearIssue(ddb, process.env.TASK_TABLE_NAME!, issueId);
  if (lookup.kind !== 'found') {
    // The issue→task link comes from a sparse GSI on an attribute that is only
    // written going forward, with no back-fill, so on the deploy that first enables
    // this path every in-flight issue lands here. Tell the user and point at the
    // way forward (re-label for a fresh run) instead of logging at info and moving
    // on, which is indistinguishable from being ignored.
    const nudge = lookup.kind === 'error'
      ? renderTaskLookupFailedNudge()
      : renderNoLinkedTaskNudge();
    await postStandaloneNudge({ issueId, workspaceId, commentId, registryTableName, nudge });
    logger.info('Comment trigger (standalone): no linked task — told the user', {
      linear_issue_id: issueId, lookup: lookup.kind,
    });
    return;
  }
  const task = lookup.task;
  const prNumber = prNumberFromTask(task);
  if (prNumber === null || !task.repo) {
    // Clarify-resume: a task with no PR MIGHT be a clarify-HOLD (a
    // new-task-v1 that paused to ask a question — code_changed=false,
    // answer_text=<question>, no PR). The GSI doesn't project those fields, so
    // read the full base row before giving up. If it's a hold, the user's reply
    // is the answer — re-dispatch the original task with it and resume.
    if (await maybeResumeClarifyHold({ issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName })) {
      return;
    }
    // A PR-less completed task (no-change-needed, failed-before-commit, or
    // a question/investigation run) is NOT an iteration target — but a follow-up
    // ``@bgagent <request>`` on it is almost always NEW work ("then just do X
    // instead"). When the repo is known, dispatch a fresh new-task-v1 rather than
    // dropping the comment silently (the old dead-end). Falls through to the
    // no-op log below only when we genuinely can't act (no repo/user, or a bare
    // mention with no instruction).
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

  // ACK the instant we commit (same as the orchestration path).
  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);
  await channel.reactToComment?.({ commentId }, target, 'started');
  // Immediate "👀 On it" threaded reply + persist its id so the fanout dispatcher
  // matures THIS reply instead of posting new comments.
  const iterationReplyId = await postIterationAck(workspaceId, registryTableName, issueId, replyTargetId);

  const idempotencyKey = `iterate_${issueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const channelMetadata: Record<string, string> = {
    // NO orchestration_id / orchestration_iteration — the reconciler skips
    // this; the fanout dispatcher posts the ✅/❌ reply on terminal. Reply to
    // the thread ROOT (replyTargetId), never to a reply.
    trigger_comment_id: replyTargetId,
    linear_issue_id: issueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    // Iteration-UX: the maturing reply to EDIT on later events.
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  // ADR-016: hydrate any file the reviewer dropped into this iteration comment
  // (see iterateOrchestrationChild). New material rides in the comment body →
  // don't re-probe the issue. Fail-closed: an unscreenable file aborts with a reply.
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
    await channel.postThreadedReply?.(target, { commentId: replyTargetId }, `❌ ${iterHydrated.message}`);
    return;
  }

  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: 'coding/pr-iteration-v1',
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
  }
}

/**
 * Start NEW work from a follow-up comment on a PR-less completed task.
 *
 * The standalone path only knows how to *iterate* an existing PR. But a task
 * can finish with no PR (no change needed, failed before committing, or a
 * question/investigation run), and a follow-up ``@bgagent <request>`` on such an
 * issue is almost always a fresh ask ("then just do X instead") — not iteration.
 * Such comments used to hit a silent ``return`` and vanish. This dispatches
 * a fresh ``coding/new-task-v1`` against the SAME repo, using the comment text as
 * the task description, with the same 👀-ack + threaded reply + fanout terminal
 * ownership as the iteration/clarify paths.
 *
 * Returns true when it handled the comment (a task was dispatched, OR a bare
 * mention was answered with a "nothing to do" reply), false when it cannot act
 * (no repo/user) so the caller falls through to its no-op log.
 *
 * Best-effort: a dispatch failure is logged and still returns true (we already
 * ACKed) — the fanout terminal path reports the outcome.
 */
async function maybeStartStandaloneNewWork(args: {
  issueId: string;
  task: { task_id: string; repo?: string; user_id?: string; status?: string };
  workspaceId: string;
  commentId: string;
  /** Raw @bgagent comment body — carries any newly-attached uploads.linear.app links. */
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<boolean> {
  const { issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;
  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);

  // Can't act without a repo to work in or a user to attribute the task to —
  // let the caller no-op-log. (These are the only genuinely unactionable cases.)
  if (!task.repo || !task.user_id) return false;

  // Only start new work when the resolved task is TERMINAL. prNumber===null is
  // TRUE both for a finished PR-less task AND for one still RUNNING that hasn't
  // opened its PR yet — so without this gate a follow-up @bgagent comment on an
  // in-flight task spawns a SECOND,
  // context-free parallel task. If the task is still running, ACK + tell the
  // user we're already on it (handled: return true, no dispatch). An ABSENT
  // status is an old/unknown row — allow (preserves the older behavior there).
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

  // A bare ``@bgagent`` with no text has nothing to start. Unlike iteration
  // (where an empty instruction means "address the latest review"), there is no
  // PR to fall back on here — so acknowledge briefly rather than dispatch a
  // vague task or stay silent. Handled (return true) so we don't no-op-log.
  if (!instruction) {
    await channel.reactToComment?.({ commentId }, target, 'started');
    try {
      await channel.upsertThreadedReply?.(
        target,
        { commentId: replyTargetId },
        'This task already finished and has no open PR to iterate on. Reply with what '
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

  // ACK immediately (👀 reaction + threaded "On it"), same as the iteration and
  // clarify-resume paths.
  await channel.reactToComment?.({ commentId }, target, 'started');
  const iterationReplyId = await postIterationAck(workspaceId, registryTableName, issueId, replyTargetId);

  // Idempotency: key on (issue, comment) so a webhook redelivery of the SAME
  // comment doesn't spawn a second task. Distinct prefix from iterate_/clarify_.
  const idempotencyKey = `newwork_${issueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const channelMetadata: Record<string, string> = {
    // NO orchestration_id / orchestration_iteration — the reconciler skips this;
    // the fanout dispatcher posts the ✅/❌ reply on terminal. Reply to the thread
    // ROOT (replyTargetId), never to a reply.
    trigger_comment_id: replyTargetId,
    linear_issue_id: issueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  // ADR-016: this starts FRESH work from the comment, so hydrate BOTH the
  // comment body's uploads AND any paperclip newly attached to the issue
  // (probeIssue: true) — a "do X instead, see attached mockup" follow-up puts the
  // file on the issue or in the comment. Fail-closed: an unscreenable file aborts
  // with a reply rather than running the new task blind.
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
    await channel.postThreadedReply?.(target, { commentId: replyTargetId }, `❌ ${newHydrated.message}`);
    return true;
  }

  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: 'coding/new-task-v1',
        task_description: instruction,
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
  }
  return true;
}

/**
 * Clarify-resume. A ``coding/new-task-v1`` run can HOLD to ask a
 * clarifying question (no PR, ``code_changed=false``, ``answer_text=<question>``;
 * surfaced as a 💬 comment). When the reviewer replies ``@bgagent <answer>``, we
 * land here (the standalone path found a PR-less task). This reads the FULL base
 * row (the ``LinearIssueIndex`` GSI doesn't project the clarify fields), and — if
 * it's a clarify-hold — re-dispatches a fresh ``new-task-v1`` carrying the
 * original ask + the Q&A so the run resumes with the missing detail.
 *
 * Returns true when it handled the comment (a resume was dispatched), false when
 * the task is not a clarify-hold (caller falls through to its no-op log).
 * Best-effort: a read/dispatch failure returns false (caller logs the no-op).
 */
async function maybeResumeClarifyHold(args: {
  issueId: string;
  task: { task_id: string; repo?: string; user_id?: string };
  workspaceId: string;
  commentId: string;
  /** Raw @bgagent comment body — carries any newly-attached uploads.linear.app links. */
  commentBody: string | undefined;
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<boolean> {
  const { issueId, task, workspaceId, commentId, commentBody, replyTargetId, trigger, resolved, registryTableName } = args;
  // A bare mention with no answer text can't resume anything — let the caller
  // no-op rather than re-dispatch the same vague task.
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

  // ACK immediately (👀 reaction + threaded "On it") — same feedback as an
  // iteration, so the reviewer sees the answer was received.
  const channel = channelFor(registryTableName);
  const target = issueRef(issueId, workspaceId);
  await channel.reactToComment?.({ commentId }, target, 'started');
  const iterationReplyId = await postIterationAck(workspaceId, registryTableName, issueId, replyTargetId);

  const resumeDescription = buildClarifyResumeDescription(
    typeof row.task_description === 'string' ? row.task_description : undefined,
    typeof row.answer_text === 'string' ? row.answer_text : undefined,
    answer,
  );
  // Idempotency: key on (issue, comment) so a webhook redelivery of the SAME
  // answer reply doesn't spawn a second resume.
  const idempotencyKey = `clarify_${issueId}_${commentId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  const channelMetadata: Record<string, string> = {
    linear_issue_id: issueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    // Reply to the thread root, and mature THIS ack on terminal (fanout path).
    trigger_comment_id: replyTargetId,
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };
  // ADR-016: the reviewer may answer a clarifying question WITH a file ("here's
  // the mockup you asked for"), attached to the issue or dropped in the reply.
  // Hydrate both (probeIssue: true) so the resumed run sees it. Fail-closed.
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
    await channel.postThreadedReply?.(target, { commentId: replyTargetId }, `❌ ${resumeHydrated.message}`);
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
  }
  return true;
}

/** Read a child task's PR number (numeric pr_number, else parse pr_url). Null if neither. */
async function resolveChildPrNumber(taskId: string): Promise<number | null> {
  try {
    const res = await ddb.send(new GetCommand({ TableName: process.env.TASK_TABLE_NAME!, Key: { task_id: taskId } }));
    const pr = res.Item?.pr_number;
    if (typeof pr === 'number') return pr;
    const url = res.Item?.pr_url;
    if (typeof url === 'string') {
      const m = url.match(/\/pull\/(\d+)\b/);
      if (m) return Number(m[1]);
    }
    return null;
  } catch (err) {
    logger.warn('Comment trigger: failed to read sub-issue task record for PR number', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Decide whether a Linear Issue event should trigger a task.
 *
 * - `create` with the label already on the issue → trigger
 * - `update` where labelIds transitions to include the label (previously didn't) → trigger
 * - Everything else → no-op
 */
function shouldTrigger(payload: LinearIssueEvent, labelFilter: string): boolean {
  const base = (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase();
  return labelJustPresent(payload, (name) => !!name && name.trim().toLowerCase() === base);
}

/**
 * The base names to recognise for the unmapped/project-less NUDGE. This is the
 * ONE place we can't derive the filter from config — an
 * un-onboarded project has no mapping row, so there's no configured
 * ``label_filter`` to compare against (it defaults to ``bgagent``). ``bgagent``
 * is the platform default; ``abca`` is included because it's the base this
 * install ships with, and the case observed in practice was a plain ``abca``
 * label. This is a deliberate, documented heuristic for a NUDGE only (never
 * dispatch), not a
 * general pattern-match — kept narrow so it can't fire on an unrelated team's
 * labels. If a third base is ever configured, add it here.
 */
const NUDGE_KNOWN_BASES = ['abca', 'bgagent'] as const;

/**
 * Does a label name LOOK like an ABCA trigger, for the unmapped-project NUDGE
 * only? Recognises a {@link NUDGE_KNOWN_BASES} base on its own, or that base
 * carrying the ``:help`` suffix — taken from {@link HELP_SUFFIX} rather than
 * spelled out here, so it can't drift from the label the help gate matches.
 */
function looksLikeAbcaTriggerLabel(name: string | undefined | null): boolean {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return false;
  return NUDGE_KNOWN_BASES.some((b) => n === b || n === `${b}:${HELP_SUFFIX}`);
}

/**
 * ``<base>:help`` explainer gate — same "created-with or just-added" semantics
 * as {@link shouldTrigger} so a redelivery / unrelated edit doesn't re-post the
 * explainer, but scoped to the single ``:help`` label (which is NOT a trigger
 * variant — it must never dispatch a task).
 */
function shouldTriggerHelp(payload: LinearIssueEvent, labelFilter: string): boolean {
  const base = (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase();
  const help = `${base}:${HELP_SUFFIX}`;
  return labelJustPresent(payload, (name) => !!name && name.toLowerCase() === help);
}

/**
 * Shared "this label is present because it was just applied" test for the Issue
 * webhook. Returns true on ``create`` with the label already on, or ``update``
 * where a matching label id transitioned from absent → present. Extracted so the
 * trigger gate and the ``:help`` gate share one definition of "just added" and
 * can't drift (both must ignore redeliveries + unrelated edits).
 */
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
    // If the event doesn't include a label change, skip — something else on the
    // issue was edited, and we shouldn't re-act on every title/description edit.
    const updatedFrom = payload.updatedFrom ?? {};
    const labelIdsChanged = Object.prototype.hasOwnProperty.call(updatedFrom, 'labelIds');
    if (!labelIdsChanged) return false;
    // The label must have just been ADDED, not removed: a currently-present
    // matching label whose id was absent before.
    const previousIds = new Set((updatedFrom.labelIds as string[] | undefined) ?? []);
    return current.some((l) => matches(l?.name) && l?.id && !previousIds.has(l.id));
  }

  return false;
}

/**
 * Post the one-time ``<base>:help`` explainer (customer-caught label
 * discoverability). Best-effort and idempotent: gated on an onboarded project
 * (need a workspace token to post) + the orchestration table (for the
 * redelivery claim). Creates no task and does not touch issue state.
 */
async function handleHelpLabel(args: {
  issue: LinearIssueEvent['data'];
  workspaceId: string;
  labelFilter: string;
  mappingItem: Record<string, unknown> | undefined;
}): Promise<void> {
  const { issue, workspaceId, labelFilter, mappingItem } = args;
  const base = (labelFilter || DEFAULT_LABEL_FILTER).trim().toLowerCase();
  if (!WORKSPACE_REGISTRY_TABLE || !ORCHESTRATION_TABLE || !mappingItem || !workspaceId) {
    logger.info('Linear :help label — cannot post explainer (not onboarded / no token table)', {
      issue_id: issue.id, has_mapping: Boolean(mappingItem),
    });
    return;
  }
  // Claim-once keyed on the issue so a webhook redelivery doesn't repost. The
  // help "comment id" slot uses a stable synthetic key (one explainer per issue).
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
  if (contextHint) {
    parts.push('');
    parts.push(contextHint);
  }
  if (issue.description && issue.description.trim()) {
    parts.push('');
    parts.push(issue.description.trim());
  }
  let out = parts.join('\n') || 'Linear issue';

  // Fold pre-hydrated context under clear headings so the agent can tell each
  // apart from the description (ADR-016 — the agent has no Linear MCP to fetch
  // any of it). ORDER: project docs (reference material the issue builds on),
  // then recent comments (discussion). Both are ADVISORY + fail-open: neither may
  // grow the description past MAX_TASK_DESCRIPTION_LENGTH and turn createTaskCore's
  // length check into a hard rejection, so each is appended only if it fits the
  // remaining budget (truncated if needed). Mirrors the Jira processor.
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

/** Notice appended when the project-docs section is truncated to fit the budget. */
const DOC_TRUNCATION_NOTICE = '\n\n_(project documents truncated)_';

/**
 * Render pre-hydrated project wiki documents under a clear heading. Each doc gets
 * a sub-heading (its title) so the agent can attribute the content. The raw
 * markdown body is included verbatim (already guardrail-screened by the caller).
 */
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
 * Trim a rendered section to at most ``budget`` characters, leaving room for the
 * given truncation notice. Returns '' if even the notice can't fit, so the caller
 * cleanly drops the section. Shared by the comment + project-doc sections.
 */
function truncateSection(section: string, budget: number, notice: string): string {
  const room = budget - notice.length;
  if (room <= 0) return '';
  return section.slice(0, room) + notice;
}

/**
 * Screen the pre-hydrated project-doc block through the Bedrock Guardrail on its
 * own, so third-party doc content that trips the policy is DROPPED (fail-open)
 * rather than gating the reporter's task. Returns the docs unchanged when they
 * pass, ``[]`` when the guardrail intervenes or is unavailable — the task still
 * proceeds with the reporter-authored title/description. Mirrors
 * {@link screenCommentsOrDrop}: doc content is advisory, fail-open end to end.
 */
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
    logger.warn('Dropping Linear project docs: screening unavailable (task still proceeds)', {
      issue_id: issueId,
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Screen the rendered comment block through the Bedrock Guardrail on its own, so
 * third-party comment content that trips the policy is DROPPED (fail-open)
 * rather than gating the reporter's task. Returns the comments unchanged when
 * they pass, and ``[]`` when the guardrail intervenes or is unavailable — the
 * task still proceeds with the reporter-authored title/description (which
 * createTaskCore screens separately). Keeps the comment-enrichment contract
 * fail-open end to end. Mirrors the Jira processor.
 */
async function screenCommentsOrDrop(
  comments: RenderedComment[],
  issueId: string,
  workspaceId: string,
): Promise<RenderedComment[]> {
  if (comments.length === 0) return comments;
  if (!attachmentsBedrockClient || !GUARDRAIL_ID || !GUARDRAIL_VERSION) {
    // No guardrail configured — drop unscreened third-party text rather than
    // route it, unscreened, into the agent context.
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
    // Fail-open on a screening outage too — comments are advisory.
    logger.warn('Dropping Linear comments: screening unavailable (task still proceeds)', {
      issue_id: issueId,
      linear_workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Extract image URL attachments from Linear issue description markdown.
 *
 * Scans for standard markdown image references: `![alt](url)`.
 * Only HTTPS URLs are included (security: no HTTP, no data: URIs).
 * Capped at 10 images per issue to stay within attachment limits.
 *
 * Linear-hosted upload URLs (`uploads.linear.app`) are SKIPPED HERE because
 * they require the workspace's OAuth token to fetch — the unauthenticated
 * URL-resolver would fail closed with 401. They are NOT lost: the caller
 * fetches them AUTHENTICATED at admission via `downloadScreenAndStoreLinearAttachments`
 * (ADR-016), which screens the bytes through the Bedrock Guardrail and stores
 * them to S3 as pre-screened attachments. So this function handles only the
 * public-CDN images (imgur, github-user-content), which the URL-resolver fetches
 * + screens during context hydration. There is no Linear MCP.
 */
function extractImageUrlAttachments(description: string | undefined): Attachment[] {
  if (!description) return [];

  // Angle-bracket URL form `![alt](<https://…>)` is the CommonMark autolink
  // Linear normalizes links into (see
  // linear-attachments.MARKDOWN_LINK_OR_IMAGE_PATTERN). Optional `<`/`>`,
  // excluded from the capture.
  const imagePattern = /!\[[^\]]*\]\(<?(https:\/\/[^)>]+)>?\)/g;
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
