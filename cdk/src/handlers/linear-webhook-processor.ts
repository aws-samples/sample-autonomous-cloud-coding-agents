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
import { reactToComment, replyToComment, reportIssueFailure, EMOJI_STARTED } from './shared/linear-feedback';
import {
  probeLinearIssueContext,
  renderIssueContextHint,
} from './shared/linear-issue-context-probe';
import { resolveLinearOauthToken } from './shared/linear-oauth-resolver';
import { fetchIssueParentId } from './shared/linear-subissue-fetch';
import { resolveTaskByLinearIssue, prNumberFromTask } from './shared/linear-task-by-issue';
import { logger } from './shared/logger';
import { buildIterationInstruction, parseCommentTrigger, type CommentTrigger } from './shared/orchestration-comment-trigger';
import { discoverOrchestration } from './shared/orchestration-discovery';
import { parseParentNodeReference, renderParentDisambiguationReply, suggestClosestNode } from './shared/orchestration-parent-comment';
import { readConcurrencyBudget, releaseReadyChildren } from './shared/orchestration-release';
import { upsertEpicPanel } from './shared/orchestration-rollup';
import { claimCommentAck, deriveOrchestrationId, loadOrchestration, setStatusCommentId, type OrchestrationReleaseContext } from './shared/orchestration-store';
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
      // Release the ROOT children (layer 0) now — the reconciler only
      // fires on a child's terminal event, so nothing would start the
      // graph otherwise. Downstream children are released by the
      // reconciler as predecessors succeed. On idempotent replay
      // (alreadyExisted) the roots were released on the first pass and
      // releaseChild's idempotency key makes a re-release a no-op, so we
      // still load + release defensively (cheap, and recovers a crash
      // between seed and root-release on the first pass).
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
    // discovery.kind === 'single_task' → fall through to the single-task
    // path below (issue had no sub-issues).
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
    // Ordinary human discussion or the agent's own progress comment — ignore.
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
    const body = renderParentDisambiguationReply(reason, snapshot.children, suggestion);
    await replyToComment(feedbackCtx, snapshot.meta.parent_linear_issue_id, replyTargetId, body);
    logger.info('A6 comment (parent epic): no single iterable sub-issue matched — asked', {
      orchestration_id: orchestrationId, reason, match_count: match.matches.length,
    });
    return;
  }

  const prNumber = await resolveChildPrNumber(target.child_task_id);
  if (prNumber === null) {
    const body = renderParentDisambiguationReply('none', snapshot.children, target);
    await replyToComment(feedbackCtx, snapshot.meta.parent_linear_issue_id, replyTargetId, body);
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
