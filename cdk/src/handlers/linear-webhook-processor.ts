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
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { buildClarifyResumeDescription, isClarifyHold } from './shared/clarify-resume';
import { createTaskCore } from './shared/create-task-core';
import { renderMaturingReply } from './shared/iteration-reply';
import {
  reactToComment,
  replyToComment,
  reportIssueFailure,
  sweepDecompositionNotes,
  swapCommentReaction,
  transitionIssueState,
  upsertStatusComment,
  upsertThreadedReply,
  EMOJI_STARTED,
  EMOJI_SUCCESS,
  EMOJI_NEEDS_INPUT,
} from './shared/linear-feedback';
import {
  probeLinearIssueContext,
  renderIssueContextHint,
} from './shared/linear-issue-context-probe';
import { resolveLinearOauthToken } from './shared/linear-oauth-resolver';
import { fetchIssueParentId, type SubIssueNode } from './shared/linear-subissue-fetch';
import { resolveTaskByLinearIssue, prNumberFromTask } from './shared/linear-task-by-issue';
import { logger } from './shared/logger';
import { buildIterationInstruction, detectNearMissMention, parseCommentTrigger, parsePlanVerdict, type CommentTrigger } from './shared/orchestration-comment-trigger';
import { applyPlanCaps, readProjectCaps } from './shared/orchestration-decomposition-caps';
import {
  runPlanVerdict,
  type DecompositionEffects,
} from './shared/orchestration-decomposition-flow';
import {
  DEFAULT_LABEL_FILTER as MODE_DEFAULT_LABEL_FILTER,
  hasDecomposeSuffixLabel,
  hasHelpLabel,
  looksMultiPart,
  parseDecompositionMode,
  triggerLabelVariants,
} from './shared/orchestration-decomposition-mode';
import {
  renderAlreadyDecomposedNote,
  renderApprovedPlanReference,
  renderCommandCollapseNote,
  renderDecomposeStartedNote,
  renderDiscardedPlanReference,
  renderEpicAlreadyCompleteNote,
  renderEpicRetryNote,
  renderLabelHelp,
  renderMultiPartHint,
  renderPendingPlanNudge,
  renderPlanCommandError,
  renderPlanProposal,
  renderRevisionCapNote,
  renderRevisionFailedNote,
  renderRevisionOverCapNote,
  renderRevisionToSingleNote,
  renderReviseEscalatedNote,
  renderReviseNoChangeNote,
  renderReviseUnclearNote,
  renderSingleTaskCancelled,
  renderWrongMentionNudge,
} from './shared/orchestration-decomposition-render';
import {
  consumePendingPlan as consumePendingPlanRow,
  discardPendingPlan as discardPendingPlanRow,
  getPendingPlan,
  type PendingPlan,
  putPendingPlan as putPendingPlanRow,
  replacePendingPlan as replacePendingPlanRow,
} from './shared/orchestration-decomposition-store';
import { DEFAULT_MAX_SUB_ISSUES, type DecompositionPlan, type PlannedSubIssue } from './shared/orchestration-decomposition-types';
import { linearGraphqlFn } from './shared/orchestration-decomposition-writeback';
import { discoverOrchestration } from './shared/orchestration-discovery';
import { declarativeGraphSource } from './shared/orchestration-graph-source';
import {
  parseParentNodeReference,
  renderParentDisambiguationReply,
  suggestClosestNode,
  looksLikeNewWork,
} from './shared/orchestration-parent-comment';
import { applyPlanCommand, parsePlanCommand, type PlanCommand } from './shared/orchestration-plan-commands';
import { applyPlanEdits, diffPlans, renderPlanDiff } from './shared/orchestration-plan-revise';
import { bedrockInvokeRevise, interpretRevise, type InvokeReviseFn } from './shared/orchestration-plan-revise-interpret';
import { computeEpicRetryPlan } from './shared/orchestration-reconcile';
import { readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { upsertEpicPanel } from './shared/orchestration-rollup';
import { claimCommentAck, clearRollupClaim, deriveOrchestrationId, loadOrchestration, setStatusCommentId, type OrchestrationReleaseContext } from './shared/orchestration-store';
import type { Attachment } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PROJECT_MAPPING_TABLE = process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.LINEAR_USER_MAPPING_TABLE_NAME!;
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
// #247 Mode A: name of OrchestrationTable. Unset until PR A3 wires the
// orchestration stack — while unset, the parent/sub-issue path is fully
// dormant and the handler behaves exactly as one-issue → one-task.
const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME;
const DEFAULT_LABEL_FILTER = 'bgagent';
// #331: throttle the seed-time root release to the user's free concurrency
// budget. Unset → release all roots (back-compat; admission still gates).
const USER_CONCURRENCY_TABLE = process.env.USER_CONCURRENCY_TABLE_NAME;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_TASKS_PER_USER ?? '10');
// #299 Mode B: TTL (seconds) for a persisted pending plan awaiting approval. A
// week is ample for a human to approve; the row self-expires after.
const PENDING_PLAN_TTL_SECONDS = 604_800;
// #299 revise loop: hard cap on re-plan rounds per pending plan. Each revision
// is a full clone+plan agent run (~$0.20 / ~2min), so an endless "no, again"
// loop is real spend. At the cap we stop re-planning and tell the reviewer to
// approve the current plan, reject, or edit the issue + re-label to start over.
const MAX_DECOMPOSE_REVISIONS = 3;
// #299 BLOCKER-1: the model transport for the deterministic revise INTERPRET step
// (current plan + digest + instruction → structured edits). Lazily binds a Bedrock
// client on first use (cold-start cost only paid on the revise path). Module-level
// so it's reused across warm invocations.
const reviseInvoke: InvokeReviseFn = bedrockInvokeRevise();
// createTaskCore rejects idempotency keys longer than this; synthesized keys
// are sliced to fit the validated /^[A-Za-z0-9_-]{1,128}$/ pattern.
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/**
 * TTL (seconds) for the per-comment ack-claim marker (#247 UX.20). Only needs
 * to outlive Linear's webhook redelivery window (minutes), but we keep a day of
 * slack so a delayed redelivery still dedups; the row self-expires after.
 */
const ACK_CLAIM_TTL_SECONDS = 86_400;

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
 * comment, parent epic for a UX.18-routed one); ``replyTargetId`` is the thread
 * root to reply under.
 */
async function postIterationAck(
  workspaceId: string,
  registryTableName: string,
  issueId: string,
  replyTargetId: string,
): Promise<string | null> {
  try {
    return await upsertThreadedReply(
      { linearWorkspaceId: workspaceId, registryTableName },
      issueId,
      replyTargetId,
      renderMaturingReply({ state: 'on_it' }),
    );
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

/** Shape of a Linear `Comment` webhook (#247 A6 trigger). */
interface LinearCommentEvent {
  readonly action: 'create' | 'update' | 'remove' | string;
  readonly type: 'Comment';
  readonly data: {
    readonly id: string;
    readonly body?: string;
    /** The issue the comment is on (the sub-issue, for A6). */
    readonly issueId?: string;
    readonly issue?: { readonly id?: string };
    readonly userId?: string;
    /**
     * Set when this comment is a REPLY within a thread — the id of the thread
     * ROOT (top-level) comment. Linear threads are one level deep, and
     * commentCreate rejects a reply whose parentId is itself a reply ("Parent
     * comment must be a top level comment"). So the ✅/❌ ack must reply to the
     * ROOT, not to this comment when it's a reply (#247 — live-caught: a
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
 * - Call `createTaskCore` with `channelSource: 'linear'` and metadata the agent uses
 *   to address the originating issue via the Linear MCP.
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

  // #247 A6: a Comment with an @bgagent mention on an orchestrated sub-issue
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
    // F-noproject: a decompose/auto SUFFIX label on an issue with NO project won't
    // match the (bgagent-default) trigger variants, so it fell through here
    // silently — the user applied an ABCA label and heard nothing. Speak up ONLY
    // for a just-added decompose/auto suffix on a project-less issue: the suffix
    // is ABCA-specific + deliberate (unlike the bare base label whose workspace-
    // wide firing caused the original comment spam this gate guards against), and
    // ``labelJustPresent`` + no-project keep it a one-shot, not per-edit spam.
    if (
      !projectId
      && hasDecomposeSuffixLabel((issue.labels ?? []).map((l) => l?.name))
      && labelJustPresent(payload, (name) => {
        const n = (name ?? '').toLowerCase();
        return n.endsWith(':decompose') || n.endsWith(':auto');
      })
    ) {
      logger.info('Linear decompose-suffix on a project-less issue — nudging (was a silent drop)', {
        issue_id: issue.id,
      });
      await safeReportIssueFailure(
        issue.id,
        payload.organizationId,
        "❌ This Linear issue isn't in a project — ABCA needs a Linear project to route the task to a repo. "
        + 'Move the issue into an onboarded project, then re-apply the label.',
      );
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

  // #299 Mode B: classify the trigger label. ``:decompose``/``:auto`` on an
  // UNDECOMPOSED issue runs the planner; otherwise this is unchanged Mode A /
  // single-task. ``hasSubIssues`` is determined authoritatively by
  // discoverOrchestration below (seeded/extended ⇒ it had a graph), so here we
  // only need the suffix intent — pass hasSubIssues=false and let discovery's
  // result decide. The caps come from the same mapping row.
  const decompositionDecision = parseDecompositionMode(
    (issue.labels ?? []).map((l) => l?.name),
    /* hasSubIssues (refined by discovery) */ false,
    labelFilter,
  );
  const decompositionCaps = readProjectCaps(mappingItem);

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
  // #247: also capture the access token — the orchestration path below
  // needs it to fetch the sub-issue graph. Past this block ``resolved``
  // is guaranteed present (we return otherwise), so the token is set
  // whenever the registry table is configured.
  let resolvedAccessToken: string | undefined;
  let contextHint = '';
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
    // Best-effort presence probe: ask Linear once whether the issue has
    // paperclip attachments or sits in a project with documents. The agent
    // will fetch the actual content via the Linear MCP at runtime — this
    // step only flags that there's something worth fetching.
    const probe = await probeLinearIssueContext(resolved.accessToken, issue.id);
    contextHint = renderIssueContextHint(probe);
  }

  // #247 Mode A — parent/sub-issue orchestration. Env-var gated: until
  // the orchestration stack (PR A3) sets ORCHESTRATION_TABLE_NAME this
  // whole branch is dormant and the handler behaves exactly as before
  // (one issue → one task). When enabled AND we have a workspace token,
  // probe the labeled issue for a sub-issue dependency graph:
  //   - has sub-issues → seed the DAG and hand off to the reconciler
  //     (A3) which creates children in dependency order. The parent
  //     issue itself does NOT spawn a task here (no special label
  //     needed: a human-authored graph is implicit consent to execute).
  //   - no sub-issues → fall through to the single-task path below.
  //   - invalid graph (cycle/dangling) → terminal ❌ comment, no task.
  //   - transient Linear error → terminal comment; do NOT silently
  //     degrade to a single task (that would drop the epic structure).
  if (ORCHESTRATION_TABLE && resolvedAccessToken) {
    const releaseContext: OrchestrationReleaseContext = {
      platform_user_id: platformUserId,
      // This orchestration was seeded by the Linear trigger; stamp the
      // channel on the meta row so downstream release + rollup follow it
      // (#247 trigger-agnostic seam). Defaults to 'linear' if ever omitted.
      channel_source: 'linear',
      ...(channelMetadata.linear_oauth_secret_arn && {
        linear_oauth_secret_arn: channelMetadata.linear_oauth_secret_arn,
      }),
      ...(channelMetadata.linear_workspace_slug && {
        linear_workspace_slug: channelMetadata.linear_workspace_slug,
      }),
      linear_project_id: projectId,
    };

    const discovery = await discoverOrchestration({
      ddb,
      tableName: ORCHESTRATION_TABLE,
      accessToken: resolvedAccessToken,
      parentLinearIssueId: issue.id,
      linearWorkspaceId: workspaceId,
      repo,
      now: new Date().toISOString(),
      releaseContext,
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
      // If a ``:decompose``/``:auto`` suffix was applied to an issue that ALREADY
      // has sub-issues, the suffix is a no-op — there's nothing to decompose, so
      // we just run the existing graph (Mode A). Surface that so the user's stated
      // decompose intent isn't silently ignored (F-already-decomposed: the note
      // renderer existed but was never posted). Reaching 'seeded' means a graph was
      // present, so a decompose/auto decision here was suffix-suppressed. Only on
      // the FIRST seed (not replays) + best-effort, like the panel below.
      await maybePostAlreadyDecomposedNote(decompositionDecision, discovery.alreadyExisted, issue.id, workspaceId);
      const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      let releasedRoots = 0;
      if (snapshot) {
        // #331: throttle the root release to the user's free concurrency
        // budget. A wide-root epic (many independent sub-issues, no shared
        // foundation) would otherwise release >cap roots at once; the
        // overflow gets hard-failed by admission — and a failed ROOT is
        // UNRECOVERABLE (the sweep re-releases a child from its succeeded
        // predecessor; a root has none). Leftover roots stay ``ready`` and
        // the #303 sweep releases them as slots free. Unset table → release
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
          // full child set for A4 base selection (roots have no preds → off-main)
          snapshot.children,
          'main',
          budget,
        );
        releasedRoots = results.filter((r) => r.kind === 'released').length;
      }
      logger.info('Linear orchestration seeded — root children released', {
        issue_id: issue.id,
        orchestration_id: discovery.orchestrationId,
        child_count: discovery.childCount,
        root_count: discovery.rootSubIssueIds.length,
        released_roots: releasedRoots,
        already_existed: discovery.alreadyExisted,
      });
      // #247 UX.2: post the initial epic panel + mirror the parent start
      // signal (👀 reaction + In Progress) in one upsertEpicPanel call. The
      // reconciler edits this same panel on every later event and advances the
      // parent to In Review on completion. Only on the first seed — a replay
      // (alreadyExisted) routes to the 'extended' branch instead. Best-effort;
      // gated on the registry table like every other feedback.
      if (WORKSPACE_REGISTRY_TABLE && !discovery.alreadyExisted) {
        const parentCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };
        // #247 UX.2: post the initial maturing panel (in-progress) and mirror
        // the parent start signal (👀 + In Progress) in one call. Re-load
        // post-release so roots show 'running'. Stamp the comment id so the
        // reconciler edits this same panel on every later event. Best-effort.
        try {
          const postReleaseSnapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
          if (postReleaseSnapshot) {
            const commentId = await upsertEpicPanel({
              ctx: parentCtx,
              parentLinearIssueId: issue.id,
              children: postReleaseSnapshot.children,
              inProgress: true,
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
        // Pure re-trigger, no new nodes. ABCA-659: if the existing graph already
        // reached terminal WITH failures (failed/skipped children), a re-label is
        // the user asking to RETRY the parts that didn't finish — re-run them
        // instead of the old misleading "running the existing sub-issue graph"
        // note that re-ran nothing. A still-running or all-succeeded epic has
        // nothing to retry and reports honestly.
        await maybeRetryTerminalEpic(discovery.orchestrationId, issue.id, workspaceId, decompositionDecision);
        logger.info('Linear orchestration re-trigger — no new sub-issues to add', {
          issue_id: issue.id, orchestration_id: discovery.orchestrationId,
        });
        return;
      }
      const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      let releasedAdded = 0;
      if (snapshot) {
        // Release only the newly-added 'ready' nodes. Pass the FULL child set
        // as allChildren so A4 base-branch selection sees finished
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
            snapshot.children, // full set → A4 base branch off finished predecessors
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
      // #247 UX.2: no standalone '➕ Added' comment — the new row appearing in
      // the maturing panel IS the signal (the user just added the sub-issue in
      // Linear, so they don't need a ping). Refresh the panel so it shows the
      // new row(s) + reverts the header to in-progress. Re-load post-release so
      // a just-released added node shows 'running'. Best-effort.
      if (WORKSPACE_REGISTRY_TABLE && snapshot) {
        try {
          const fresh = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
          const children = fresh?.children ?? snapshot.children;
          const meta = (fresh ?? snapshot).meta;
          const newId = await upsertEpicPanel({
            ctx: { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
            parentLinearIssueId: issue.id,
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
    // discovery.kind === 'single_task' → the issue had no sub-issues.
    //
    // #299 Mode B: if it carried a ``:decompose``/``:auto`` label, run the
    // planner now. On 'seed' we hand the planner's (now real-Linear-id) graph
    // to the SAME discovery+release path (Mode A) — single source of truth. On
    // 'handled'/'noop' a comment was posted (awaiting approval, rejected,
    // over-cap, write-back error) and we must NOT also create a task. On
    // 'single_task' the planner declined → fall through to the single task.
    if (
      resolvedAccessToken
      && (decompositionDecision.mode === 'decompose' || decompositionDecision.mode === 'auto')
    ) {
      // #299 agent-native planning: dispatch a coding/decompose-v1 AGENT TASK
      // instead of the old inline two-call Bedrock planner. The agent clones the
      // repo and plans with FULL context on the tunable substrate (root-fixes
      // ABCA-490's 30s Lambda ceiling + ABCA-492's repo-blindness), emitting the
      // plan JSON as an artifact. The reconciler's terminal branch reads that
      // artifact and seeds the sub-issues (caps + approval gate preserved there).
      // The decompose mode + caps + parent context ride in channel_metadata so
      // the terminal handler can act without re-deriving them.
      const planMeta: Record<string, string> = {
        ...channelMetadata,
        decompose_mode: decompositionDecision.mode, // 'decompose' | 'auto'
        decompose_parent_issue_id: issue.id,
        decompose_caps_max_sub_issues: String(decompositionCaps.max_sub_issues),
        decompose_caps_allowed: String(decompositionCaps.decompose_allowed),
        ...(decompositionCaps.max_parent_budget_usd !== undefined && {
          decompose_caps_max_parent_budget_usd: String(decompositionCaps.max_parent_budget_usd),
        }),
      };
      // Dedup guard (ABCA-606): a rapid label off/on toggle — or a webhook
      // redelivery — re-enters this branch and would dispatch a SECOND (third…)
      // decompose-v1 planning task for the same issue, since nothing here consults
      // the pending-plan/active-task state (getPendingPlan is only on the comment
      // path). Claim once per issue+mode over the redelivery window; a lost claim
      // means a planning run for this issue+mode is already in flight, so skip.
      // (A genuine re-decompose after the plan is consumed/expired is rare and is
      // caught downstream by the pending-plan + already-decomposed guards.)
      const planClaimTtl = Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS;
      const planClaimWon = await claimCommentAck(
        ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id),
        `decompose-dispatch:${decompositionDecision.mode}`, new Date().toISOString(), planClaimTtl,
      );
      if (!planClaimWon) {
        logger.info('Mode B decompose: a planning task for this issue+mode is already in flight — skipping duplicate dispatch', {
          issue_id: issue.id, mode: decompositionDecision.mode,
        });
        return;
      }
      const planReqId = crypto.randomUUID();
      const planResult = await createTaskCore(
        {
          repo,
          workflow_ref: 'coding/decompose-v1',
          task_description: buildDecompositionTaskDescription(issue),
        },
        { userId: platformUserId, channelSource: 'linear', channelMetadata: planMeta },
        planReqId,
      );
      if (planResult.statusCode !== 201) {
        logger.warn('Mode B decompose-planning task creation returned non-201', {
          status: planResult.statusCode, issue_id: issue.id,
        });
        await safeReportIssueFailure(
          issue.id, workspaceId,
          buildCreateTaskFailureMessage(planResult.statusCode, planResult.body),
        );
        return;
      }
      logger.info('Mode B decompose-planning task dispatched (agent-native)', {
        issue_id: issue.id, mode: decompositionDecision.mode, request_id: planReqId,
      });
      // PM-6: upfront ack. Planning clones the repo + reasons over full context
      // (30-120s). Without this the issue stays silent until the finished plan
      // lands — a slow plan read as "nothing happened". Post an immediate note
      // (idempotent via claimCommentAck so a redelivery doesn't repeat it, and
      // ordered before the reconciler's plan comment). Best-effort — never
      // blocks the planning run that already started.
      if (WORKSPACE_REGISTRY_TABLE && ORCHESTRATION_TABLE) {
        try {
          const won = await claimCommentAck(
            ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id), 'decompose-ack',
            new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
          );
          if (won) {
            const decomposeCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };
            await upsertStatusComment(
              decomposeCtx,
              issue.id,
              renderDecomposeStartedNote(decompositionDecision.mode === 'auto'),
            );
            // CONFUSING-4 (state vs thread disagree): the decompose planning task
            // is a read_only agent that deliberately does NOT touch Linear state
            // (Bug C's minimal prompt), so the issue used to stay in Backlog through
            // planning + approval — the board looked untouched while the bot worked,
            // and the help text says to watch comments (the WRONG place on the board).
            // Move it to a visible "started" state here so the board reflects reality,
            // mirroring the plain-abca path (which the agent transitions at runtime).
            // Idempotent + backward-safe inside transitionIssueState; best-effort.
            await transitionIssueState(decomposeCtx, issue.id, 'started', ['In Progress']);
          }
        } catch (err) {
          logger.warn('Failed to post decompose upfront ack (non-fatal)', {
            issue_id: issue.id, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The planning agent runs; the reconciler seeds on its terminal event.
      return;
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

  // Multi-part hint (customer-caught): a PLAIN ``bgagent`` label on an issue
  // that looks like several separate parts still runs as ONE task — but the
  // reviewer never saw a plan. Post a one-time, non-blocking nudge that
  // ``:decompose`` would show a plan first. Only for the bare-label single-task
  // path (not decompose/auto/mode_a), only when the description looks multi-part,
  // and idempotent so a redelivery doesn't repeat it. Best-effort — never blocks
  // the run that already started.
  if (
    decompositionDecision.mode === 'single'
    && WORKSPACE_REGISTRY_TABLE
    && ORCHESTRATION_TABLE
    && looksMultiPart(issue.description)
  ) {
    try {
      const won = await claimCommentAck(
        ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(issue.id), 'multipart-hint',
        new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
      );
      if (won) {
        await upsertStatusComment(
          { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
          issue.id,
          renderMultiPartHint(labelFilter.trim().toLowerCase() || MODE_DEFAULT_LABEL_FILTER),
        );
      }
    } catch (err) {
      logger.warn('Failed to post multi-part hint (non-fatal)', {
        issue_id: issue.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * #299 Mode B — build the {@link DecompositionEffects} the ``@bgagent
 * approve``/``reject`` verdict flow ({@link runPlanVerdict}) needs, binding the
 * injected boundaries to this request's real helpers (the Linear GraphQL
 * transport for write-back, the feedback comment poster, the pending-plan store).
 * Kept as a factory so the flow stays free of module-global wiring and is
 * unit-testable in isolation.
 *
 * #299 agent-native planning: the model-invoke boundary was removed — planning
 * now runs in the ``coding/decompose-v1`` agent and the reconciler seeds from its
 * artifact. This factory serves only the verdict path (which never plans).
 */
function buildDecompositionEffects(
  parentIssueId: string,
  workspaceId: string,
  repo: string,
  platformUserId: string,
  projectId: string,
  channelMetadata: Record<string, string>,
  accessToken: string,
): DecompositionEffects {
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE! };
  return {
    graphql: linearGraphqlFn(accessToken),
    postComment: async (issueId, body) =>
      WORKSPACE_REGISTRY_TABLE ? upsertStatusComment(feedbackCtx, issueId, body) : null,
    putPendingPlan: async ({ nodes, proposalCommentId }) => putPendingPlanRow({
      ddb,
      tableName: ORCHESTRATION_TABLE!,
      parentLinearIssueId: parentIssueId,
      linearWorkspaceId: workspaceId,
      repo,
      ...(projectId && { linearProjectId: projectId }),
      nodes,
      platformUserId,
      ...(proposalCommentId !== undefined && { proposalCommentId }),
      now: new Date().toISOString(),
      ttlEpochSeconds: Math.floor(Date.now() / 1000) + PENDING_PLAN_TTL_SECONDS,
    }),
    consumePendingPlan: async () => {
      const taken = await consumePendingPlanRow(ddb, ORCHESTRATION_TABLE!, parentIssueId);
      return taken ? { nodes: taken.nodes } : null;
    },
    discardPendingPlan: async () => { await discardPendingPlanRow(ddb, ORCHESTRATION_TABLE!, parentIssueId); },
  };
}

/**
 * ABCA-659 — retry an already-terminal epic on a pure re-trigger (re-label with
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
 *    fall back to the existing already-decomposed note (benign re-apply).
 *
 * Best-effort throughout; never throws out of the webhook. Idempotency: the retry
 * is naturally convergent — a redelivery finds the nodes already reset to
 * ready/blocked/released (computeEpicRetryPlan sees 0 failed/skipped) and no-ops.
 */
async function maybeRetryTerminalEpic(
  orchestrationId: string,
  parentIssueId: string,
  workspaceId: string,
  decompositionDecision: { mode: string },
): Promise<void> {
  if (!ORCHESTRATION_TABLE) return;
  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
  if (!snapshot) return;
  const now = new Date().toISOString();
  const plan = computeEpicRetryPlan(
    snapshot.children.map((c) => ({
      sub_issue_id: c.sub_issue_id,
      depends_on: c.depends_on,
      child_status: c.child_status,
    })),
  );

  const ctx = WORKSPACE_REGISTRY_TABLE
    ? { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE }
    : undefined;

  // Nothing failed/skipped → nothing to retry.
  if (plan.statusUpdates.length === 0) {
    if (!ctx) return;
    if (plan.succeededCount > 0 && plan.succeededCount === snapshot.children.length) {
      // Every child succeeded — the epic is genuinely done.
      await upsertStatusComment(ctx, parentIssueId, renderEpicAlreadyCompleteNote());
    } else {
      // Still running (nodes released/running, none terminal-failed) — benign
      // re-apply; keep the existing already-decomposed copy.
      await maybePostAlreadyDecomposedNote(decompositionDecision, false, parentIssueId, workspaceId);
    }
    return;
  }

  logger.info('ABCA-659 epic retry: resetting failed/skipped children', {
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
        // ABCA-659: salt the idempotency key with each child's prior (failed)
        // task id so the retry spawns a NEW task instead of idempotently
        // replaying the failed one. releasableRows carry the old child_task_id
        // (the reset only changed child_status) — exactly the salt releaseChild
        // needs. Without this the row flips to 'released' but points at the dead
        // task and nothing actually re-runs (live-caught on the first retry pass).
        true,
      );
    }
  }

  // 4. Honest note + refresh the panel so the reset rows stop showing ❌/⏭️ and
  //    the header reverts to in-progress.
  if (ctx) {
    await upsertStatusComment(
      ctx, parentIssueId,
      renderEpicRetryNote({ failed: plan.failedCount, skipped: plan.skippedCount, succeeded: plan.succeededCount }),
    );
    try {
      const refreshed = await loadOrchestration(ddb, ORCHESTRATION_TABLE, orchestrationId);
      const meta = (refreshed ?? fresh ?? snapshot).meta;
      await upsertEpicPanel({
        ctx,
        parentLinearIssueId: parentIssueId,
        ...(meta.status_comment_id !== undefined && { statusCommentId: meta.status_comment_id }),
        children: (refreshed ?? fresh ?? snapshot).children,
        inProgress: true,
        mirrorParentState: true,
      });
    } catch (err) {
      logger.warn('ABCA-659 epic retry: panel refresh failed (non-fatal)', {
        orchestration_id: orchestrationId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * #299 plan-cleanup — once a plan is settled (approved → seeded, or rejected →
 * discarded), converge the thread on the SAME shape as Mode A sub-issue
 * orchestration: ONE frozen plan-reference comment + (on approve) the live epic
 * panel, with all the transient decomposition notes swept away. Live-proven on
 * ABCA-670 that Linear has no comment fold, so we don't keep a bulky history —
 * the reference carries a compact "· refined over N rounds" footnote instead.
 *
 * Two moves, both best-effort (a cleanup failure is cosmetic, never blocks the
 * approve/reject that already happened):
 *  1. FREEZE the plan-proposal comment in place — edit it to the static
 *     {@link renderApprovedPlanReference} (approve) or {@link
 *     renderDiscardedPlanReference} (reject), dropping the now-stale action
 *     footer. On approve, requires the plan ``nodes`` (from the consumed pending
 *     row) to re-list the agreed breakdown; ``revisionRound`` drives the
 *     footnote. If there's no tracked proposal comment id (older plan), skip the
 *     freeze — the sweep still tidies the notes.
 *  2. SWEEP every other bot ``🗂️``/``👋`` note off the issue, keeping the frozen
 *     reference (and the differently-prefixed live panel, which the sweep can't
 *     match).
 */
async function cleanupPlanThread(args: {
  issueId: string;
  workspaceId: string;
  proposalCommentId?: string;
  outcome:
    | { readonly kind: 'approved'; readonly nodes: readonly PlannedSubIssue[]; readonly revisionRound?: number }
    | { readonly kind: 'rejected' };
}): Promise<void> {
  if (!WORKSPACE_REGISTRY_TABLE) return;
  const { issueId, workspaceId, proposalCommentId, outcome } = args;
  const ctx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };
  try {
    // 1. Freeze the plan reference in place (only if we tracked its id).
    if (proposalCommentId) {
      const frozenBody = outcome.kind === 'approved'
        ? renderApprovedPlanReference(
          { shouldDecompose: true, reasoning: '', nodes: outcome.nodes },
          outcome.revisionRound !== undefined ? { revisionRound: outcome.revisionRound } : {},
        )
        : renderDiscardedPlanReference();
      await upsertStatusComment(ctx, issueId, frozenBody, proposalCommentId);
    }
    // 2. Sweep the transient notes, keeping the frozen reference.
    await sweepDecompositionNotes(ctx, issueId, proposalCommentId);
  } catch (err) {
    logger.warn('Plan-thread cleanup failed (non-fatal)', {
      issue_id: issueId,
      outcome: outcome.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * #299 Mode B — seed the #247 executor from a planner-produced graph (real
 * Linear sub-issue ids) and release roots. Reuses the SAME discovery → release
 * → panel path as Mode A by passing a ``declarativeGraphSource`` rather than
 * re-reading Linear (the issues were just created; declarative avoids the
 * eventual-consistency race). On the seed result it releases roots + posts the
 * maturing panel exactly like the native-graph path.
 */
async function seedAndReleaseFromGraph(args: {
  parentIssueId: string;
  workspaceId: string;
  repo: string;
  projectId: string;
  platformUserId: string;
  channelMetadata: Record<string, string>;
  children: readonly SubIssueNode[];
}): Promise<void> {
  if (!ORCHESTRATION_TABLE) return;
  const { parentIssueId, workspaceId, repo, projectId, platformUserId, channelMetadata, children } = args;
  const releaseContext: OrchestrationReleaseContext = {
    platform_user_id: platformUserId,
    channel_source: 'linear',
    ...(channelMetadata.linear_oauth_secret_arn && { linear_oauth_secret_arn: channelMetadata.linear_oauth_secret_arn }),
    ...(channelMetadata.linear_workspace_slug && { linear_workspace_slug: channelMetadata.linear_workspace_slug }),
    linear_project_id: projectId,
  };

  const discovery = await discoverOrchestration({
    ddb,
    tableName: ORCHESTRATION_TABLE,
    // accessToken unused — graphSource is supplied — but the param is required.
    accessToken: '',
    parentLinearIssueId: parentIssueId,
    linearWorkspaceId: workspaceId,
    repo,
    now: new Date().toISOString(),
    releaseContext,
    graphSource: declarativeGraphSource(children),
  });

  if (discovery.kind !== 'seeded') {
    // 'rejected'/'error' shouldn't happen (we just built a valid DAG), but a
    // replay can return 'extended'/'single_task'; in all cases the reconciler
    // (or a prior pass) owns the children. Log + return without double-acting.
    logger.info('Mode B seed: discovery returned non-seeded', { parent_issue_id: parentIssueId, kind: discovery.kind });
    if (discovery.kind === 'rejected' || discovery.kind === 'error') {
      await safeReportIssueFailure(parentIssueId, workspaceId, `❌ ${discovery.message}`);
    }
    return;
  }

  const snapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
  if (snapshot) {
    const budget = USER_CONCURRENCY_TABLE
      ? await readConcurrencyBudget(ddb, USER_CONCURRENCY_TABLE, snapshot.meta.release_context.platform_user_id, MAX_CONCURRENT)
      : undefined;
    await releaseReadyChildren(
      ddb, ORCHESTRATION_TABLE, snapshot.children, snapshot.meta.release_context,
      createTaskCore, new Date().toISOString(), snapshot.children, 'main', budget,
    );
  }
  // Post the maturing panel (same as the native-graph seed path).
  if (WORKSPACE_REGISTRY_TABLE) {
    try {
      const postRelease = await loadOrchestration(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId);
      if (postRelease) {
        const commentId = await upsertEpicPanel({
          ctx: { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
          parentLinearIssueId: parentIssueId,
          children: postRelease.children,
          inProgress: true,
          mirrorParentState: true,
        });
        if (commentId) await setStatusCommentId(ddb, ORCHESTRATION_TABLE, discovery.orchestrationId, commentId);
      }
    } catch (err) {
      logger.warn('Mode B seed: failed to post panel (non-fatal)', {
        parent_issue_id: parentIssueId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Mode B: orchestration seeded from planner graph', {
    parent_issue_id: parentIssueId, orchestration_id: discovery.orchestrationId, child_count: discovery.childCount,
  });
}

/**
 * #299 BLOCKER-2 (@abca black hole) — a comment addressed the bot by the WRONG
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

  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };
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
  await reactToComment(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
  const replyTargetId = payload.data?.parentId ?? commentId;
  await replyToComment(feedbackCtx, commentedIssueId, replyTargetId, renderWrongMentionNudge());
  logger.info('Near-miss mention: nudged reviewer to @bgagent', { issue_id: commentedIssueId, comment_id: commentId });
}

/**
 * #247 A6 comment trigger. A Linear comment with an ``@bgagent`` mention on an
 * orchestrated sub-issue runs a ``coding/pr-iteration-v1`` task on that
 * sub-issue's PR; the comment text is the instruction. When that task
 * completes, the reconciler cascades the re-stack to dependents (A6.2).
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
    // #299 BLOCKER-2 (@abca black hole): before silently dropping, check for a
    // NEAR-MISS mention — the reviewer addressed the bot by the wrong handle
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
    logger.info('A6 comment: missing issueId/workspace — ignoring', { has_issue: Boolean(subIssueId) });
    return;
  }

  const resolved = await resolveLinearOauthToken(workspaceId, WORKSPACE_REGISTRY_TABLE);
  if (!resolved) {
    logger.info('A6 comment: workspace not resolvable — ignoring', { linear_workspace_id: workspaceId });
    return;
  }

  const commentedIssueId = subIssueId;
  const commentId = payload.data.id;
  // The ✅/❌ ack must reply to the thread ROOT — Linear rejects a reply whose
  // parentId is itself a reply. When the trigger is a thread-reply, data.parentId
  // is the root; otherwise the comment IS the root. The 👀 still goes on the
  // actual comment the human wrote (reactions work at any thread depth).
  const replyTargetId = payload.data.parentId ?? commentId;

  // #299 Mode B: a comment on a parent that has a PENDING plan (proposed but not
  // yet executed). Checked BEFORE A6 routing because NO orchestration is seeded
  // yet — the parent has only a pending-plan row, so loadOrchestration misses it.
  // Sub-cases on a pending plan (see parsePlanVerdict for the classification):
  //   - approve / reject  → runPlanVerdict (seed or DISCARD — reject is the one
  //     irreversible action, so it requires EXPLICIT intent: reject/discard/cancel/
  //     abort/👎, never a bare "no").
  //   - ambiguous (a soft negation with no change instruction: "no", "no thanks",
  //     "don't approve", "no, looks wrong") → NUDGE the reviewer to pick, never
  //     guess-and-destroy (F-reject-revision).
  //   - none WITH text → REVISE: re-plan from the feedback (the realistic "deny" —
  //     a reviewer rejects because they want changes, incl. "no, make it 3 tasks";
  //     we keep the conversation going instead of dead-ending at discard).
  //   - none, bare @bgagent (no text) → nudge.
  // With NO pending plan, none of this applies → fall through to the A6 paths
  // (so "approve" on a normal sub-issue isn't hijacked).
  const verdict = parsePlanVerdict(trigger.instruction);
  const pending = await getPendingPlan(ddb, ORCHESTRATION_TABLE, commentedIssueId);

  // #299 plan-mode T4: a STRUCTURAL command ("drop 3", "merge 1 and 2", "make #2
  // small") on a pending plan is applied DETERMINISTICALLY here — no clone, no
  // agent, instant + free — instead of spending a ~2-min re-plan round. Checked
  // BEFORE the verdict/revise routing: a recognized command is a definite edit
  // intent (approve/reject aren't command verbs, so they don't collide; a bare
  // "no" isn't a command → still routes to nudge). Anything not a recognized
  // command falls through to the semantic revise loop below.
  if (pending) {
    const command = parsePlanCommand(trigger.instruction);
    if (command) {
      await handlePlanCommand({
        pending, command, commentId, commentedIssueId, workspaceId, resolved,
      });
      return;
    }
  }

  if (pending && (verdict === 'approve' || verdict === 'reject')) {
    // Claim-once on this comment so a webhook redelivery doesn't double-seed
    // (the consume is also atomic, but this skips the duplicate 👀/work).
    const ttl = Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS;
    const won = await claimCommentAck(
      ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(commentedIssueId), commentId, new Date().toISOString(), ttl,
    );
    if (!won) {
      logger.info('Mode B verdict: redelivery already handled this comment — skipping', { comment_id: commentId });
      return;
    }
    await reactToComment({ linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE }, commentId, EMOJI_STARTED);
    // Rebuild the release context's OAuth metadata from the resolved token so
    // the released children can post back to Linear (the pending plan stores
    // only ids, not the secret arn — which rotates).
    const verdictChannelMetadata: Record<string, string> = {
      linear_oauth_secret_arn: resolved.oauthSecretArn,
      linear_workspace_slug: resolved.workspaceSlug,
    };
    const verdictProjectId = pending.linear_project_id ?? '';

    // #299 single-task gate (F-single-gate): the pending plan is a SINGLE task
    // (a ``:decompose`` that declined to split), not a graph. Approve → run ONE
    // coding task (no write-back, no orchestration); reject → discard. Handled
    // here rather than runPlanVerdict (which is graph-only: consume→writeBack→seed).
    if (pending.pending_kind === 'single') {
      await handleSingleTaskVerdict({
        pending, verdict, commentedIssueId, workspaceId, projectId: verdictProjectId, resolved,
      });
      return;
    }

    const effects = buildDecompositionEffects(
      commentedIssueId, workspaceId, pending.repo, pending.platform_user_id,
      verdictProjectId, verdictChannelMetadata, resolved.accessToken,
    );
    // Capture the plan shape BEFORE runPlanVerdict consumes the pending row —
    // the frozen reference re-lists the AGREED breakdown (pending.nodes), and the
    // footnote needs the revision round.
    const settledNodes = pending.nodes;
    const settledRound = pending.revision_round;
    const settledProposalCommentId = pending.proposal_comment_id;
    const flow = await runPlanVerdict({ parentIssueId: commentedIssueId, verdict, effects });
    if (flow.kind === 'seed') {
      await seedAndReleaseFromGraph({
        parentIssueId: commentedIssueId,
        workspaceId,
        repo: pending.repo,
        projectId: verdictProjectId,
        platformUserId: pending.platform_user_id,
        channelMetadata: verdictChannelMetadata,
        children: flow.children,
      });
      // #299 plan-cleanup: the panel is now live — freeze the plan comment into a
      // reference + sweep the transient notes so the thread matches Mode A.
      await cleanupPlanThread({
        issueId: commentedIssueId,
        workspaceId,
        ...(settledProposalCommentId !== undefined && { proposalCommentId: settledProposalCommentId }),
        outcome: { kind: 'approved', nodes: settledNodes, ...(settledRound !== undefined && { revisionRound: settledRound }) },
      });
    } else if (verdict === 'reject' && flow.kind === 'handled') {
      // Rejected → discard: freeze the plan comment to a one-line "discarded"
      // record + sweep the notes (incl. runPlanVerdict's own "Plan discarded" ack).
      await cleanupPlanThread({
        issueId: commentedIssueId,
        workspaceId,
        ...(settledProposalCommentId !== undefined && { proposalCommentId: settledProposalCommentId }),
        outcome: { kind: 'rejected' },
      });
    }
    logger.info('Mode B verdict handled', { issue_id: commentedIssueId, verdict, kind: flow.kind });
    return;
  }
  if (pending && verdict === 'none' && trigger.instruction.trim().length > 0) {
    // REVISE: the reviewer wants changes to the proposed plan. Re-plan with a
    // fresh decompose-v1 agent task that sees the original issue + the prior
    // proposed plan + this feedback, then the reconciler REPLACES the pending
    // plan and posts a revised proposal. Interactive, Claude-Code-style.
    await handlePlanRevision({
      pending,
      feedback: trigger.instruction.trim(),
      commentId,
      commentedIssueId,
      workspaceId,
      resolved,
    });
    return;
  }
  if (pending && (verdict === 'ambiguous' || (verdict === 'none' && trigger.instruction.trim().length === 0))) {
    // NUDGE, never guess-and-destroy. Two cases land here:
    //   - bare @bgagent (no text) — previously a silent drop (F-bare-mention).
    //   - an AMBIGUOUS soft negation ("no", "no thanks", "don't approve", "no,
    //     looks wrong") — a bare "no" could mean discard OR "change it", so we do
    //     NOT treat it as a reject (that would destroy the plan on the most
    //     ambiguous input — F-reject-revision). We ask the reviewer to pick.
    // Post the one-line nudge (approve / reject / change). Claim-once so a webhook
    // redelivery doesn't repost. Best-effort; gated on the registry table.
    if (WORKSPACE_REGISTRY_TABLE) {
      const won = await claimCommentAck(
        ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(commentedIssueId), commentId,
        new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
      );
      if (won) {
        await upsertStatusComment(
          { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
          commentedIssueId,
          renderPendingPlanNudge(),
        );
      }
    }
    logger.info('Mode B: ambiguous/bare @bgagent on a pending plan — posted nudge', {
      issue_id: commentedIssueId, verdict,
    });
    return;
  }
  // No pending plan → fall through to A6 paths.

  // #247 UX.18: is the commented issue itself a PARENT epic? deriveOrchestrationId
  // is a pure hash of the issue id, so the parent's own id maps to ITS
  // orchestration; a sub-issue's id hashes to nothing. The maturing panel lives
  // on the parent, so reviewers comment THERE ("@bgagent for the footer, …") —
  // route that to the sub-issue it names. (Was a silent drop: the parent has no
  // PR, so it fell to the standalone GSI path → miss → ignored.)
  const ownOrchestrationId = deriveOrchestrationId(commentedIssueId);
  const parentSnapshot = await loadOrchestration(ddb, ORCHESTRATION_TABLE, ownOrchestrationId);
  if (parentSnapshot && parentSnapshot.meta.parent_linear_issue_id === commentedIssueId) {
    await handleParentEpicCommentTrigger({
      orchestrationId: ownOrchestrationId,
      snapshot: parentSnapshot,
      workspaceId,
      commentId,
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
  // a PR for — fall through to the standalone path (#247 UX.3), which iterates
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
      replyTargetId,
      trigger,
      resolved,
      registryTableName: WORKSPACE_REGISTRY_TABLE,
    });
    return;
  }

  await iterateOrchestrationChild({
    orchestrationId: orchestrationId!,
    snapshot,
    child,
    workspaceId,
    commentId,
    replyTargetId,
    trigger,
    resolved,
    registryTableName: WORKSPACE_REGISTRY_TABLE,
  });
}

/**
 * #299 revise loop — the reviewer left feedback on a pending plan ("split X",
 * "drop Y", "make these sequential"). Re-plan: dispatch a fresh
 * ``coding/decompose-v1`` agent task that sees the ORIGINAL issue + the prior
 * proposed plan + this feedback, then the reconciler REPLACES the pending plan
 * and posts a revised proposal (round N). This is the realistic "deny" — a
 * reject-with-changes conversation, not a dead-end discard. Capped at
 * {@link MAX_DECOMPOSE_REVISIONS} rounds (each is a real clone+plan run). Never
 * throws — a failure posts a note and leaves the current plan approvable.
 */
async function handlePlanRevision(args: {
  pending: PendingPlan;
  feedback: string;
  commentId: string;
  commentedIssueId: string;
  workspaceId: string;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
}): Promise<void> {
  if (!ORCHESTRATION_TABLE || !WORKSPACE_REGISTRY_TABLE) return;
  const { pending, feedback, commentId, commentedIssueId, workspaceId, resolved } = args;
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };

  // Claim-once on the feedback comment so a webhook redelivery doesn't dispatch
  // the (costly) re-plan twice. Keyed on the comment id, same as the verdict path.
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(commentedIssueId), commentId,
    new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
  );
  if (!won) {
    logger.info('Mode B revise: redelivery already handled this feedback — skipping', { comment_id: commentId });
    return;
  }

  const priorRound = pending.revision_round ?? 0;
  if (priorRound >= MAX_DECOMPOSE_REVISIONS) {
    // Cap reached — stop re-planning (each round is a full clone+plan run). The
    // current plan is still pending and approvable; tell the reviewer their options.
    await upsertStatusComment(feedbackCtx, commentedIssueId, renderRevisionCapNote(MAX_DECOMPOSE_REVISIONS));
    logger.info('Mode B revise: revision cap reached', { issue_id: commentedIssueId, prior_round: priorRound });
    return;
  }

  // Re-read the project caps (the pending row doesn't store them; they gate the
  // revised plan the same as the original).
  const projectId = pending.linear_project_id ?? '';
  let caps = { decompose_allowed: true, max_sub_issues: DEFAULT_MAX_SUB_ISSUES } as ReturnType<typeof readProjectCaps>;
  if (projectId) {
    const mapping = await ddb.send(new GetCommand({ TableName: PROJECT_MAPPING_TABLE, Key: { linear_project_id: projectId } }));
    if (mapping.Item) caps = readProjectCaps(mapping.Item);
  }

  // #299 F-revise-in-place: 👀 on the reviewer's FEEDBACK comment is the "on it"
  // ack. The deterministic path settles it 👀→✅ inline the moment the plan updates;
  // the escalation path leaves it 👀 and the reconciler settles it (as before).
  await reactToComment(feedbackCtx, commentId, EMOJI_STARTED);

  // #299 BLOCKER-1 (revise amnesia + fabricated "What changed"): FIRST try to
  // interpret the instruction as EDITS to the CURRENT plan and apply them
  // deterministically — no clone, no re-derive. This is the fix for the round-2
  // repro (drop Careers → merge FAQ+Privacy → Careers reappeared): the old path
  // re-planned from the ISSUE (which still lists Careers) so dropped nodes came
  // back, and the model-authored "What changed" then invented a justification.
  // Editing the stored plan in code means untouched nodes survive verbatim and
  // edits STACK; the "What changed" line is a computed old→new diff that can't lie.
  // Only a genuinely repo-dependent change (needs_repo) or an interpret failure
  // escalates to the repo-cloning agent revise below.
  const interpretation = await interpretRevise({
    nodes: pending.nodes,
    instruction: feedback,
    ...(pending.repo_digest !== undefined && { repoDigest: pending.repo_digest }),
    invoke: reviseInvoke,
  });

  if (interpretation.kind === 'edits') {
    const applied = applyPlanEdits(pending.nodes, interpretation.edits);
    if (applied.kind === 'error') {
      // The interpreter proposed an edit that doesn't hold against the plan (bad
      // ref, cycle). Don't escalate to a 2-min clone for a bad edit — surface the
      // reason, leave the plan approvable, settle the ack to ❓ (needs input).
      await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
      await upsertStatusComment(feedbackCtx, commentedIssueId, renderReviseUnclearNote(applied.message));
      logger.info('Mode B revise (deterministic): edit invalid — plan untouched', {
        issue_id: commentedIssueId, message: applied.message,
      });
      return;
    }
    if (applied.kind === 'collapses') {
      // The edits leave <2 sub-issues — a revision-to-single. Don't auto-run (the
      // reviewer is mid-planning); hand them the decision, same as the agent path.
      await swapCommentReaction(feedbackCtx, commentId, EMOJI_SUCCESS);
      await upsertStatusComment(feedbackCtx, commentedIssueId, renderRevisionToSingleNote());
      logger.info('Mode B revise (deterministic): collapses to single unit — awaiting decision', {
        issue_id: commentedIssueId,
      });
      return;
    }

    // Caps still gate a revised plan (a merge can't exceed the cap, but an add
    // can). Over-cap → keep the current plan, tell the reviewer (revision-aware
    // note — no "re-label" dead-end), settle the ack.
    const capResult = applyPlanCaps(
      { shouldDecompose: true, reasoning: '', nodes: applied.nodes },
      caps,
    );
    if (capResult.kind === 'rejected') {
      await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
      await upsertStatusComment(feedbackCtx, commentedIssueId, renderRevisionOverCapNote(capResult.summary));
      logger.info('Mode B revise (deterministic): over cap — plan untouched', {
        issue_id: commentedIssueId, reason: capResult.reason,
      });
      return;
    }

    // Compute the honest before→after diff (NEVER model self-report) and render it
    // as the "What changed" line via renderPlanProposal's changeSummary slot.
    const diff = diffPlans(pending.nodes, applied.nodes);
    if (diff.unchanged) {
      // The edit resolved to a no-op — say so plainly, don't fake an "Updated".
      await swapCommentReaction(feedbackCtx, commentId, EMOJI_SUCCESS);
      await upsertStatusComment(feedbackCtx, commentedIssueId, renderReviseNoChangeNote());
      logger.info('Mode B revise (deterministic): no-op edit — plan unchanged', { issue_id: commentedIssueId });
      return;
    }
    const nextRound = priorRound + 1;
    const revisedPlan: DecompositionPlan = {
      shouldDecompose: true,
      reasoning: '',
      nodes: applied.nodes,
      changeSummary: renderPlanDiff(diff),
    };
    // Edit the ONE plan comment in place (F-revise-in-place), keeping the "Updated
    // breakdown" header + the computed "What changed" line.
    const renderedId = await upsertStatusComment(
      feedbackCtx,
      commentedIssueId,
      renderPlanProposal(revisedPlan, { autoRun: false, revisionRound: nextRound }),
      pending.proposal_comment_id,
    );
    const carriedCommentId = renderedId ?? pending.proposal_comment_id;
    // Persist the edited nodes as the new pending plan (replace — a revision must
    // overwrite). Bump revision_round; carry the digest + sha forward unchanged
    // (a plan edit doesn't change the repo). Preserves the same idempotency the
    // structural-command path uses.
    await replacePendingPlanRow({
      ddb,
      tableName: ORCHESTRATION_TABLE,
      parentLinearIssueId: commentedIssueId,
      linearWorkspaceId: workspaceId,
      repo: pending.repo,
      ...(pending.linear_project_id !== undefined && { linearProjectId: pending.linear_project_id }),
      nodes: applied.nodes,
      platformUserId: pending.platform_user_id,
      ...(carriedCommentId !== undefined && { proposalCommentId: carriedCommentId }),
      revisionRound: nextRound,
      ...(pending.repo_digest !== undefined && { repoDigest: pending.repo_digest }),
      ...(pending.repo_digest_sha !== undefined && { repoDigestSha: pending.repo_digest_sha }),
      now: new Date().toISOString(),
      ttlEpochSeconds: Math.floor(Date.now() / 1000) + PENDING_PLAN_TTL_SECONDS,
    });
    // Settle the reviewer's feedback comment 👀→✅ inline (the deterministic path
    // completes synchronously — no reconciler round to do it).
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_SUCCESS);
    logger.info('Mode B revise applied deterministically (no clone, no re-derive)', {
      issue_id: commentedIssueId,
      round: nextRound,
      node_count: applied.nodes.length,
      removed: diff.removed.length,
      added: diff.added.length,
      modified: diff.modified.length,
    });
    return;
  }

  if (interpretation.kind === 'unclear') {
    // Not an actionable edit (a question / too vague). Nudge with the interpreter's
    // clarifying ask; leave the plan approvable. Settle the ack to ❓ (needs input).
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
    await upsertStatusComment(feedbackCtx, commentedIssueId, renderReviseUnclearNote(interpretation.message));
    logger.info('Mode B revise: instruction not an actionable edit — nudged', { issue_id: commentedIssueId });
    return;
  }

  // needs_repo OR interpret error → ESCALATE to the repo-cloning agent revise.
  // Even here it REVISES the current plan (the agent gets the prior plan + digest
  // as the base), never regenerates from the issue.
  //
  // PM-BLOCKER (persona stress test): the escalation runs a 2-10 min repo-cloning
  // re-plan, but this path used to post an ack ONLY on needs_repo and was SILENT on
  // the interpret-error branch, and NEVER flipped the issue state. So a perfectly
  // valid revise looked dropped for 10+ min — no ack, no board movement — while the
  // initial :decompose posts an "On it" comment AND flips to In Progress (PM-6/#157).
  // Fix: ALWAYS post the "taking a closer look" ack (both branches) AND flip the
  // issue to In Progress here, mirroring the initial-decompose path, so the revise
  // is as visible as the first plan. The 👀 on the feedback comment stays for the
  // reconciler to settle 👀→✅ when the revised plan lands.
  const escalateReason = interpretation.kind === 'needs_repo' ? interpretation.reason : '';
  await upsertStatusComment(feedbackCtx, commentedIssueId, renderReviseEscalatedNote(escalateReason));
  // Flip to a visible "started" state for the duration of the re-plan (idempotent +
  // forward-only inside transitionIssueState; best-effort — never block the re-plan).
  try {
    await transitionIssueState(feedbackCtx, commentedIssueId, 'started', ['In Progress']);
  } catch (err) {
    logger.warn('Mode B revise: failed to flip issue to In Progress (non-fatal)', {
      issue_id: commentedIssueId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (interpretation.kind === 'needs_repo') {
    logger.info('Mode B revise: escalating to repo-cloning agent (needs_repo)', {
      issue_id: commentedIssueId, reason: interpretation.reason,
    });
  } else {
    logger.info('Mode B revise: interpret unavailable — escalating to repo-cloning agent', {
      issue_id: commentedIssueId, detail: interpretation.message,
    });
  }

  // Fetch the issue's real title+body so the revision description leads with the
  // SAME plain-issue text the round-0 description used (which passes the guardrail),
  // then appends the prior plan + feedback as reference data. Best-effort — an
  // empty issue text still yields a valid data-shaped description.
  const issueText = await fetchIssueText(resolved.accessToken, commentedIssueId);

  const planMeta: Record<string, string> = {
    linear_issue_id: commentedIssueId,
    linear_workspace_id: workspaceId,
    linear_project_id: projectId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    // Approval-gated re-plan: a revision always goes back through the proposal
    // gate (never auto-seeds), so the mode is 'decompose' regardless of the label.
    decompose_mode: 'decompose',
    decompose_parent_issue_id: commentedIssueId,
    decompose_revision_round: String(priorRound + 1),
    // #299 F-revise-in-place: the feedback comment to settle 👀→✅ when the revised
    // plan lands (rides on the task → back on the terminal record → reconciler).
    decompose_revising_feedback_comment_id: commentId,
    decompose_caps_max_sub_issues: String(caps.max_sub_issues),
    decompose_caps_allowed: String(caps.decompose_allowed),
    ...(caps.max_parent_budget_usd !== undefined && {
      decompose_caps_max_parent_budget_usd: String(caps.max_parent_budget_usd),
    }),
    // #299 plan-mode T2 (warm digest): carry the PRIOR run's repo digest + its sha
    // into this revise task via channel_metadata — a NON-guardrail-screened channel
    // (task_description IS screened; a large structural blob there would trip
    // PROMPT_ATTACK, the bfc57c5 class). The agent reads decompose_repo_digest from
    // channel_metadata and starts from that understanding instead of re-exploring;
    // the sha lets it drift-check. Absent on plans from older agents (no digest).
    ...(pending.repo_digest !== undefined && { decompose_repo_digest: pending.repo_digest }),
    ...(pending.repo_digest_sha !== undefined && { decompose_repo_digest_sha: pending.repo_digest_sha }),
  };

  const planResult = await createTaskCore(
    {
      repo: pending.repo,
      workflow_ref: 'coding/decompose-v1',
      task_description: buildRevisionTaskDescription(issueText, pending, feedback),
    },
    { userId: pending.platform_user_id, channelSource: 'linear', channelMetadata: planMeta },
    crypto.randomUUID(),
  );
  if (planResult.statusCode !== 201) {
    logger.warn('Mode B revise: re-plan task creation returned non-201', {
      status: planResult.statusCode, issue_id: commentedIssueId, body: planResult.body,
    });
    // Dispatch failed → the reconciler never runs to settle the 👀, so swap it to
    // ❓ here (the request needs the reviewer's attention, not "done") and post the
    // honest failure note. The current plan is untouched + still approvable; NO raw
    // "blocked by content policy" string (reads as if the user erred).
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
    await upsertStatusComment(feedbackCtx, commentedIssueId, renderRevisionFailedNote());
    return;
  }
  logger.info('Mode B revise: re-plan task dispatched', { issue_id: commentedIssueId, round: priorRound + 1 });
}

/**
 * #299 single-task gate (F-single-gate) — the ``@bgagent approve``/``reject``
 * verdict on a SINGLE-task pending plan (a ``:decompose`` that declined to
 * split). Approve → run the parent issue as ONE coding task (no write-back, no
 * orchestration — this is NOT a graph); reject → discard. Distinct from the
 * graph verdict path (``runPlanVerdict`` → writeBack → seed). The claim-once +
 * 👀 already fired in the caller. Never throws.
 */
async function handleSingleTaskVerdict(args: {
  pending: PendingPlan;
  verdict: 'approve' | 'reject';
  commentedIssueId: string;
  workspaceId: string;
  projectId: string;
  resolved: { oauthSecretArn: string; workspaceSlug: string };
}): Promise<void> {
  if (!ORCHESTRATION_TABLE || !WORKSPACE_REGISTRY_TABLE) return;
  const { pending, verdict, commentedIssueId, workspaceId, projectId, resolved } = args;
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };

  // Consume the pending plan either way (approve runs it, reject discards it).
  // The atomic delete also guards a racing second verdict (only one wins).
  const taken = await consumePendingPlanRow(ddb, ORCHESTRATION_TABLE, commentedIssueId);
  if (!taken) {
    logger.info('Mode B single-task verdict: no pending plan (raced/expired) — skipping', { issue_id: commentedIssueId });
    return;
  }

  if (verdict === 'reject') {
    // #299 plan-cleanup: sweep the transient planning notes (decompose-started
    // ack + single-task proposal), THEN post the durable "cancelled" record so it
    // survives the sweep (posted fresh after → the sweep's list didn't see it).
    // A single-task plan tracks no proposal comment id, so there's nothing to
    // freeze — the swept-clean thread + this one line is the whole record.
    await sweepDecompositionNotes(feedbackCtx, commentedIssueId);
    await upsertStatusComment(feedbackCtx, commentedIssueId, renderSingleTaskCancelled());
    logger.info('Mode B single-task verdict: rejected', { issue_id: commentedIssueId });
    return;
  }

  // approve → spawn ONE coding task, exactly like the reconciler's auto-run
  // single-task path (:auto), with the normal Linear channel_metadata so the
  // fanout dispatcher posts the completion + the agent posts its PR-opened
  // comment. The description was persisted on the pending plan at propose time.
  const result = await createTaskCore(
    {
      repo: pending.repo,
      task_description: taken.single_task_description ?? `Implement ${commentedIssueId}`,
    },
    {
      userId: pending.platform_user_id,
      channelSource: 'linear',
      channelMetadata: {
        linear_issue_id: commentedIssueId,
        linear_workspace_id: workspaceId,
        ...(projectId && { linear_project_id: projectId }),
        linear_oauth_secret_arn: resolved.oauthSecretArn,
        linear_workspace_slug: resolved.workspaceSlug,
      },
    },
    `decompose-single-approve-${deriveOrchestrationId(commentedIssueId)}`.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH),
  );
  if (result.statusCode !== 201) {
    logger.warn('Mode B single-task verdict: task creation returned non-201', {
      status: result.statusCode, issue_id: commentedIssueId,
    });
    await safeReportIssueFailure(commentedIssueId, workspaceId,
      buildCreateTaskFailureMessage(result.statusCode, result.body));
    return;
  }
  // #299 plan-cleanup: the single coding task is dispatched and the agent posts
  // its own 🤖 progress from here — sweep the transient planning notes (started
  // ack + single-task proposal) so the thread isn't cluttered by the plan phase.
  await sweepDecompositionNotes(feedbackCtx, commentedIssueId);
  logger.info('Mode B single-task verdict: approved — single task dispatched', { issue_id: commentedIssueId });
}

/**
 * #299 plan-mode T4 — apply a STRUCTURAL command ("drop 3", "merge 1 and 2",
 * "make #2 small") to a pending plan DETERMINISTICALLY: mutate the node list,
 * re-index the positional ``depends_on`` edges, REPLACE the pending-plan row, and
 * re-render the proposal — no clone, no agent, instant + free. This is the bulk
 * of what a reviewer's revisions actually are (structural, not semantic), so it
 * skips the ~2-min agent re-plan the {@link handlePlanRevision} path spends.
 *
 * Idempotent: claim-once on the comment id (a webhook redelivery is a no-op).
 * Preserves ``revision_round`` (a structural edit isn't an agent round — it
 * doesn't consume the re-plan budget). On an edit that collapses the plan to <2
 * sub-issues, or an out-of-range index, posts a note and leaves the plan
 * UNTOUCHED (approvable) — never silently destroys or mis-edits. Never throws.
 */
async function handlePlanCommand(args: {
  pending: PendingPlan;
  command: PlanCommand;
  commentId: string;
  commentedIssueId: string;
  workspaceId: string;
  resolved: { oauthSecretArn: string; workspaceSlug: string };
}): Promise<void> {
  if (!ORCHESTRATION_TABLE || !WORKSPACE_REGISTRY_TABLE) return;
  const { pending, command, commentId, commentedIssueId, workspaceId } = args;
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE };

  // Claim-once so a webhook redelivery doesn't apply the edit twice (a second
  // "drop 3" on the already-edited plan would drop a DIFFERENT node).
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE, deriveOrchestrationId(commentedIssueId), commentId,
    new Date().toISOString(), Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS,
  );
  if (!won) {
    logger.info('Mode B command: redelivery already handled this comment — skipping', { comment_id: commentId });
    return;
  }

  await reactToComment(feedbackCtx, commentId, EMOJI_STARTED);

  const result = applyPlanCommand(pending.nodes, command);
  if (result.kind === 'error') {
    // F-command-ack-stuck: settle the 👀 to ❓ — the command needs the reviewer's
    // attention (bad index etc.), it didn't silently succeed.
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
    await upsertStatusComment(feedbackCtx, commentedIssueId, renderPlanCommandError(result.message));
    logger.info('Mode B command: invalid — posted error, plan untouched', {
      issue_id: commentedIssueId, command: command.kind,
    });
    return;
  }
  if (result.kind === 'collapses') {
    // The edit would leave <2 sub-issues — nothing to orchestrate. Don't silently
    // apply it; tell the reviewer their options (approve to run as one task, or
    // give different feedback). The current plan stays pending + approvable.
    // F-command-ack-stuck: settle 👀→❓ (awaiting the reviewer's decision).
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
    await upsertStatusComment(feedbackCtx, commentedIssueId, renderCommandCollapseNote());
    logger.info('Mode B command: would collapse to single task — plan untouched', {
      issue_id: commentedIssueId, command: command.kind, remaining: result.remaining,
    });
    return;
  }

  // Re-render the proposal from the edited nodes. Reuse renderPlanProposal so the
  // layout matches every other proposal (numbered list, deps, summary, footer);
  // keep the "Updated breakdown" header when this plan had already been revised.
  // Lead with the computed before→after diff (same honest "What changed" line the
  // semantic revise path uses — never model-authored), so a command edit is as
  // legible as a semantic one.
  const commandDiff = diffPlans(pending.nodes, result.nodes);
  const editedPlan: DecompositionPlan = {
    shouldDecompose: true,
    reasoning: '',
    nodes: result.nodes,
    ...(!commandDiff.unchanged && { changeSummary: renderPlanDiff(commandDiff) }),
  };
  // #299 plan-mode T5: EDIT the existing proposal comment in place rather than
  // posting a fresh one. A reviewer firing several structural commands in a row
  // ("drop 3", then "merge 1 2", …) is watching the plan mature — a stack of N
  // full re-rendered proposals is noise, and Linear's chat.update-style edit is
  // the async channel's closest thing to the plan firming up live. The 👀 on
  // each command comment is the per-edit ack; the single plan comment is the
  // source of truth. Falls back to a fresh comment when no prior id was captured
  // (best-effort — upsertStatusComment returns null on a failed edit, and we then
  // don't clobber the stored id).
  const renderedId = await upsertStatusComment(
    feedbackCtx,
    commentedIssueId,
    renderPlanProposal(editedPlan, {
      autoRun: false,
      ...(pending.revision_round !== undefined && pending.revision_round > 0
        && { revisionRound: pending.revision_round }),
    }),
    pending.proposal_comment_id,
  );

  // Persist the edited node list (unconditional upsert — the claim-once above
  // gates redelivery). Preserve revision_round: a structural edit is not an agent
  // re-plan round, so it must not consume the revise budget. Carry the proposal
  // comment id forward (the freshly-created one if we had none, else the edited
  // one) so the NEXT command edits the same comment in place.
  const carriedCommentId = renderedId ?? pending.proposal_comment_id;
  await replacePendingPlanRow({
    ddb,
    tableName: ORCHESTRATION_TABLE,
    parentLinearIssueId: commentedIssueId,
    linearWorkspaceId: workspaceId,
    repo: pending.repo,
    ...(pending.linear_project_id !== undefined && { linearProjectId: pending.linear_project_id }),
    nodes: result.nodes,
    platformUserId: pending.platform_user_id,
    ...(carriedCommentId !== undefined && { proposalCommentId: carriedCommentId }),
    ...(pending.revision_round !== undefined && { revisionRound: pending.revision_round }),
    // #299 plan-mode T2: a structural command doesn't change the repo — carry the
    // cached digest + sha forward so a later semantic revise still reuses it.
    ...(pending.repo_digest !== undefined && { repoDigest: pending.repo_digest }),
    ...(pending.repo_digest_sha !== undefined && { repoDigestSha: pending.repo_digest_sha }),
    now: new Date().toISOString(),
    ttlEpochSeconds: Math.floor(Date.now() / 1000) + PENDING_PLAN_TTL_SECONDS,
  });

  // F-command-ack-stuck: settle the 👀 on the command comment to ✅ — the edit
  // applied + the plan comment updated in place, so the reviewer can tell it
  // finished (the 👀 previously never swapped → read as stuck). Synchronous, no
  // reconciler round-trip.
  await swapCommentReaction(feedbackCtx, commentId, EMOJI_SUCCESS);

  logger.info('Mode B command applied — plan edited deterministically (no agent)', {
    issue_id: commentedIssueId,
    command: command.kind,
    node_count: result.nodes.length,
    edited_in_place: pending.proposal_comment_id !== undefined && renderedId === pending.proposal_comment_id,
  });
}

/**
 * Fetch a Linear issue's title + description for the revision task description.
 * Best-effort: returns a minimal fallback on any failure (the revision still
 * runs — the prior plan + feedback carry the intent, and the agent re-clones).
 */
async function fetchIssueText(accessToken: string, issueId: string): Promise<string> {
  try {
    const data = await linearGraphqlFn(accessToken)(
      'query IssueText($id: String!) { issue(id: $id) { identifier title description } }',
      { id: issueId },
    );
    const issue = data?.issue as { identifier?: string; title?: string; description?: string } | undefined;
    if (!issue) return 'Revise the decomposition plan for this Linear issue.';
    const head = issue.identifier && issue.title ? `${issue.identifier}: ${issue.title}` : (issue.title ?? '');
    const body = issue.description?.trim() ? `\n\n${issue.description.trim()}` : '';
    return `${head}${body}`.trim() || 'Revise the decomposition plan for this Linear issue.';
  } catch (err) {
    logger.warn('Mode B revise: could not fetch issue text (using fallback)', {
      issue_id: issueId, error: err instanceof Error ? err.message : String(err),
    });
    return 'Revise the decomposition plan for this Linear issue.';
  }
}

/**
 * #247 UX.18 — an ``@bgagent`` comment left on the PARENT epic. The maturing
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
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<void> {
  const { orchestrationId, snapshot, workspaceId, commentId, replyTargetId, trigger, resolved, registryTableName } = args;
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName };

  // #247 UX.20: claim-once BEFORE any side-effect. Linear redelivers a comment
  // webhook when the handler exceeds its ~5s ack window (this path does several
  // Linear API calls and can run >5s), and EACH redelivery would otherwise
  // re-react + re-post the disambiguation reply — live-caught spamming 50+
  // duplicate replies. The conditional claim (keyed on this comment id) lets
  // only the FIRST delivery proceed; redeliveries no-op here. The marker
  // self-expires via the table TTL. (The iterate path also has its own
  // createTaskCore idempotency key — this is the outer guard that also covers
  // the 👀 + the ask-reply, which have no other dedup.)
  const ttlEpochSeconds = Math.floor(Date.now() / 1000) + ACK_CLAIM_TTL_SECONDS;
  const won = await claimCommentAck(
    ddb, ORCHESTRATION_TABLE!, orchestrationId, commentId, new Date().toISOString(), ttlEpochSeconds,
  );
  if (!won) {
    logger.info('A6 comment (parent epic): redelivery — already handled this comment, skipping', {
      orchestration_id: orchestrationId, comment_id: commentId,
    });
    return;
  }

  // ACK immediately — a parent comment is never silently dropped again.
  await reactToComment(feedbackCtx, commentId, EMOJI_STARTED);

  // Only STARTED children with a task are iterable candidates; match against all
  // real nodes for the disambiguation list, but iterate only a started one.
  const match = parseParentNodeReference(trigger.instruction, snapshot.children);
  const target = match.reason === null ? match.matches[0] : null;

  if (!target || !target.child_task_id) {
    // No confident single match (or matched a not-yet-started node) → ask.
    const reason = match.reason === 'ambiguous' ? 'ambiguous' : 'none';
    const suggestion = reason === 'none' ? suggestClosestNode(trigger.instruction, snapshot.children) : null;
    // #247 UX-2: if it reads like NEW work AND we found no close existing node,
    // lead with the create-a-sub-issue path rather than the generic "couldn't
    // tell". A close suggestion takes precedence (more likely a vague edit).
    const newWork = reason === 'none' && !suggestion && looksLikeNewWork(trigger.instruction);
    const body = renderParentDisambiguationReply(reason, snapshot.children, suggestion, newWork);
    await replyToComment(feedbackCtx, snapshot.meta.parent_linear_issue_id, replyTargetId, body);
    // #247 UX-1: this is a QUESTION, not work-in-progress. Swap the 👀 we put
    // on receipt to ❓ so the comment doesn't look like it's still being worked.
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
    logger.info('A6 comment (parent epic): no single iterable sub-issue matched — asked', {
      orchestration_id: orchestrationId, reason, match_count: match.matches.length,
    });
    return;
  }

  const prNumber = await resolveChildPrNumber(target.child_task_id);
  if (prNumber === null) {
    const body = renderParentDisambiguationReply('none', snapshot.children, target);
    await replyToComment(feedbackCtx, snapshot.meta.parent_linear_issue_id, replyTargetId, body);
    // #247 UX-1: matched a node but it has no PR yet — also a "wait / clarify"
    // state, not active work; swap 👀 → ❓.
    await swapCommentReaction(feedbackCtx, commentId, EMOJI_NEEDS_INPUT);
    logger.info('A6 comment (parent epic): matched sub-issue has no PR yet — asked', {
      orchestration_id: orchestrationId, sub_issue_id: target.sub_issue_id,
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
    replyTargetId,
    trigger,
    resolved,
    registryTableName,
    // #247 UX.19: the trigger comment lives on the PARENT epic, not the
    // sub-issue — the reconciler must reply with the parent issue id.
    triggerCommentIssueId: snapshot.meta.parent_linear_issue_id,
    // Already acked on the parent comment above.
    skipAck: true,
    prNumber,
  });
  logger.info('A6 comment (parent epic): routed to sub-issue', {
    orchestration_id: orchestrationId, sub_issue_id: target.sub_issue_id, pr_number: prNumber,
  });
}

/**
 * Spawn a ``coding/pr-iteration-v1`` task for one orchestration sub-issue from
 * an ``@bgagent`` comment (#247 A6 + UX.18). Shared by the direct sub-issue
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
   * comment, the PARENT epic for a UX.18 parent-routed comment. The reconciler
   * replies ✅/❌ using THIS as commentCreate's issueId (#247 UX.19). Defaults to
   * the sub-issue id.
   */
  triggerCommentIssueId?: string;
  trigger: CommentTrigger;
  resolved: { oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
  skipAck?: boolean;
  prNumber?: number;
}): Promise<void> {
  const {
    orchestrationId, snapshot, child, workspaceId, commentId, replyTargetId,
    trigger, resolved, registryTableName,
  } = args;
  const subIssueId = child.sub_issue_id;
  const triggerCommentIssueId = args.triggerCommentIssueId ?? subIssueId;

  const prNumber = args.prNumber ?? (child.child_task_id ? await resolveChildPrNumber(child.child_task_id) : null);
  if (prNumber === null || prNumber === undefined) {
    logger.warn('A6 comment: sub-issue has no resolvable PR — cannot iterate', {
      orchestration_id: orchestrationId, sub_issue_id: subIssueId, child_task_id: child.child_task_id,
    });
    return;
  }

  // Attribute to the orchestration's release user (the comment author may not
  // be a linked platform user; the orchestration already ran under this id).
  const platformUserId = snapshot.meta.release_context.platform_user_id;

  // #247 UX.3: ACK the request the instant we commit to acting on it. 👀 on the
  // TRIGGERING comment is the zero-clutter "on it" signal. The parent-epic path
  // already acked, so it passes skipAck.
  if (!args.skipAck) {
    await reactToComment({ linearWorkspaceId: workspaceId, registryTableName }, commentId, EMOJI_STARTED);
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
    // when the iteration completes (A6.2 reads this flag).
    orchestration_iteration: 'true',
    // #247 UX.3: the reconciler replies ✅/❌ to the thread ROOT when the
    // iteration lands (threaded ack — closes the conversation the human opened).
    trigger_comment_id: replyTargetId,
    // #247 UX.19: the issue that comment lives on, so the reconciler's reply
    // uses the right commentCreate issueId (parent epic for a routed comment;
    // the sub-issue for a direct comment).
    trigger_comment_issue_id: triggerCommentIssueId,
    linear_workspace_id: workspaceId,
    linear_oauth_secret_arn: resolved.oauthSecretArn,
    linear_workspace_slug: resolved.workspaceSlug,
    // The agent addresses the real sub-issue (reactions/comments).
    linear_issue_id: subIssueId,
    // Iteration-UX: the maturing reply to EDIT (not re-create) on later events.
    ...(iterationReplyId && { iteration_reply_comment_id: iterationReplyId }),
  };

  try {
    const result = await createTaskCore(
      {
        repo: child.repo,
        workflow_ref: 'coding/pr-iteration-v1',
        pr_number: prNumber,
        task_description: buildIterationInstruction(trigger),
      },
      { userId: platformUserId, channelSource: 'linear', channelMetadata, idempotencyKey },
      idempotencyKey,
    );
    logger.info('A6 comment: iteration task created for sub-issue PR', {
      orchestration_id: orchestrationId, sub_issue_id: subIssueId, pr_number: prNumber, status_code: result.statusCode,
    });
  } catch (err) {
    logger.error('A6 comment: createTaskCore threw for iteration', {
      orchestration_id: orchestrationId,
      sub_issue_id: subIssueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * #247 UX.3 — the GENERALIZED comment trigger. An ``@bgagent`` comment on a
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
async function handleStandaloneCommentTrigger(args: {
  subIssueId: string;
  workspaceId: string;
  commentId: string;
  /** Thread ROOT to reply to (= parentId when the trigger is a reply, else commentId). */
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<void> {
  const { subIssueId: issueId, workspaceId, commentId, replyTargetId, trigger, resolved, registryTableName } = args;

  const task = await resolveTaskByLinearIssue(ddb, process.env.TASK_TABLE_NAME!, issueId);
  if (!task) {
    logger.info('A6 comment (standalone): issue has no ABCA task — ignoring', { linear_issue_id: issueId });
    return;
  }
  const prNumber = prNumberFromTask(task);
  if (prNumber === null || !task.repo) {
    // PM-1 clarify-resume: a task with no PR MIGHT be a clarify-HOLD (a
    // new-task-v1 that paused to ask a question — code_changed=false,
    // answer_text=<question>, no PR). The GSI doesn't project those fields, so
    // read the full base row before giving up. If it's a hold, the user's reply
    // is the answer — re-dispatch the original task with it and resume.
    if (await maybeResumeClarifyHold({ issueId, task, workspaceId, commentId, replyTargetId, trigger, resolved, registryTableName })) {
      return;
    }
    logger.info('A6 comment (standalone): ABCA task has no resolvable PR/repo — cannot iterate', {
      linear_issue_id: issueId, task_id: task.task_id, has_repo: Boolean(task.repo),
    });
    return;
  }
  if (!task.user_id) {
    logger.warn('A6 comment (standalone): task missing user_id — cannot attribute iteration', {
      linear_issue_id: issueId, task_id: task.task_id,
    });
    return;
  }

  // ACK the instant we commit (same as the orchestration path).
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName };
  await reactToComment(feedbackCtx, commentId, EMOJI_STARTED);
  // Iteration-UX: immediate "👀 On it" threaded reply + persist its id so the
  // fanout dispatcher matures THIS reply instead of posting new comments.
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

  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: 'coding/pr-iteration-v1',
        pr_number: prNumber,
        task_description: buildIterationInstruction(trigger),
      },
      { userId: task.user_id, channelSource: 'linear', channelMetadata, idempotencyKey },
      idempotencyKey,
    );
    logger.info('A6 comment (standalone): iteration task created for issue PR', {
      linear_issue_id: issueId, pr_number: prNumber, status_code: result.statusCode,
    });
  } catch (err) {
    logger.error('A6 comment (standalone): createTaskCore threw for iteration', {
      linear_issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * PM-1 clarify-resume. A ``coding/new-task-v1`` run can HOLD to ask a
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
  replyTargetId: string;
  trigger: CommentTrigger;
  resolved: { accessToken: string; oauthSecretArn: string; workspaceSlug: string };
  registryTableName: string;
}): Promise<boolean> {
  const { issueId, task, workspaceId, commentId, replyTargetId, trigger, resolved, registryTableName } = args;
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
  const feedbackCtx = { linearWorkspaceId: workspaceId, registryTableName };
  await reactToComment(feedbackCtx, commentId, EMOJI_STARTED);
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
  try {
    const result = await createTaskCore(
      {
        repo: task.repo,
        workflow_ref: 'coding/new-task-v1',
        task_description: resumeDescription,
      },
      { userId: task.user_id, channelSource: 'linear', channelMetadata, idempotencyKey },
      idempotencyKey,
    );
    logger.info('Clarify-resume: fresh new-task dispatched from the reviewer answer', {
      linear_issue_id: issueId, prior_task_id: task.task_id, status_code: result.statusCode,
    });
  } catch (err) {
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
    logger.warn('A6 comment: failed to read sub-issue task record for PR number', {
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
  // #299 Mode B: the trigger fires on the base label OR a decompose suffix
  // (``bgagent:decompose`` / ``bgagent:auto``). Match against ALL variants so a
  // suffix-only issue still triggers; ``parseDecompositionMode`` later decides
  // which mode it is.
  const variants = new Set(triggerLabelVariants(labelFilter));
  return labelJustPresent(payload, (name) => !!name && variants.has(name.toLowerCase()));
}

/**
 * ``<base>:help`` explainer gate — same "created-with or just-added" semantics
 * as {@link shouldTrigger} so a redelivery / unrelated edit doesn't re-post the
 * explainer, but scoped to the single ``:help`` label (which is NOT a trigger
 * variant — it must never dispatch a task).
 */
function shouldTriggerHelp(payload: LinearIssueEvent, labelFilter: string): boolean {
  const base = (labelFilter || MODE_DEFAULT_LABEL_FILTER).trim().toLowerCase();
  const help = `${base}:${'help'}`;
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
  const base = (labelFilter || MODE_DEFAULT_LABEL_FILTER).trim().toLowerCase();
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
  await upsertStatusComment(
    { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
    issue.id,
    renderLabelHelp(base),
  );
  logger.info('Linear :help label — posted label explainer', { issue_id: issue.id });
}

/**
 * Post the "already has sub-issues — running the existing graph" note when a
 * ``:decompose``/``:auto`` suffix was applied to an issue that turned out to
 * already have a sub-issue graph (F-already-decomposed). Called from the seeded /
 * extended branches — reaching them means a graph existed, so the suffix was a
 * no-op. Only fires for a decompose/auto decision (a bare ``bgagent`` re-trigger
 * stays quiet); best-effort, gated on the registry table.
 */
async function maybePostAlreadyDecomposedNote(
  decision: { mode: string },
  suppressPost: boolean,
  issueId: string,
  workspaceId: string,
): Promise<void> {
  if (suppressPost) return; // e.g. idempotent seed replay — don't repost
  if (decision.mode !== 'decompose' && decision.mode !== 'auto') return;
  if (!WORKSPACE_REGISTRY_TABLE) return;
  try {
    await upsertStatusComment(
      { linearWorkspaceId: workspaceId, registryTableName: WORKSPACE_REGISTRY_TABLE },
      issueId,
      renderAlreadyDecomposedNote(),
    );
    logger.info('Linear decompose suffix on an already-decomposed issue — posted note', { issue_id: issueId });
  } catch (err) {
    logger.warn('Failed to post already-decomposed note (non-fatal)', {
      issue_id: issueId, error: err instanceof Error ? err.message : String(err),
    });
  }
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

/**
 * #299 agent-native planning: the task description handed to a
 * ``coding/decompose-v1`` planning agent — the issue's own title + description.
 * The agent's prompt (decompose.py) tells it to clone the repo, plan, and emit
 * the plan JSON as its artifact; no context hint, since it gathers context from
 * the clone itself (the whole point of moving planning into the agent).
 */
function buildDecompositionTaskDescription(issue: LinearIssueEvent['data']): string {
  const parts: string[] = [];
  if (issue.identifier && issue.title) {
    parts.push(`${issue.identifier}: ${issue.title}`);
  } else if (issue.title) {
    parts.push(issue.title);
  }
  if (issue.description && issue.description.trim()) {
    parts.push('');
    parts.push(issue.description.trim());
  }
  return parts.join('\n') || 'Plan a decomposition for this Linear issue.';
}

/**
 * #299 revise loop: the task description for a RE-PLAN. Gives the agent the
 * prior proposed breakdown + the reviewer's feedback so it revises rather than
 * starting cold. The agent still clones the repo for full context (and can
 * re-read the issue via the Linear MCP if it needs the original wording); the
 * key new signal is "here's what you proposed, here's what the human wants
 * changed." Depends_on is index-based within the plan, so we render it as such.
 */
function buildRevisionTaskDescription(issueText: string, pending: PendingPlan, feedback: string): string {
  const priorPlan = pending.nodes.map((n, i) => {
    const deps = n.depends_on.length > 0 ? ` (depends on: ${n.depends_on.map((d) => `#${d + 1}`).join(', ')})` : '';
    return `  ${i + 1}. [${n.size}] ${n.title}${deps}\n     ${n.description}`;
  }).join('\n');
  // IMPORTANT: this string is screened by the input guardrail's PROMPT_ATTACK
  // filter before the task runs. The FIRST revision-loop cut wrote it as
  // second-person imperatives ("You previously proposed… REVISE the plan… emit
  // the plan JSON as your final message") — instruction-shaped text that the
  // classifier reads as prompt-injection and blocks 100% (customer-caught: an
  // innocent "make it 2 tasks" surfaced a scary "blocked by content policy").
  // So frame this as neutral DATA the planner reads, NOT commands: the real
  // issue text first (identical shape to the round-0 description, which passes),
  // then the prior plan + requested changes as labelled reference material. The
  // decompose-v1 workflow prompt already tells the agent to plan and emit JSON.
  return [
    issueText.trim(),
    '',
    '--- Earlier proposed breakdown (for reference) ---',
    priorPlan || '(none — the earlier assessment did not split this issue)',
    '',
    '--- Requested changes from the reviewer ---',
    feedback.trim(),
  ].join('\n');
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
