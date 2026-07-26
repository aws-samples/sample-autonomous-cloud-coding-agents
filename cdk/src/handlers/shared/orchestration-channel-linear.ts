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

/**
 * Linear implementation of the surface-agnostic {@link Channel}. A thin adapter:
 * it maps the channel-neutral operations onto the existing Linear feedback +
 * sub-issue-graph helpers, so the orchestration engine gets exactly today's
 * Linear behavior through the abstraction — no behavior change, just an indirection
 * the engine can also satisfy for other surfaces.
 *
 * Surface-specific choices made here (kept OUT of the engine): the reaction-emoji
 * mapping, the markdown comment format (Linear-native), and reading the sub-issue
 * DAG from Linear's `blocks` relations.
 */

import {
  EMOJI_FAILURE,
  EMOJI_NEEDS_INPUT,
  EMOJI_STARTED,
  EMOJI_SUCCESS,
  postIssueComment,
  reactToComment as addCommentReaction,
  replyToComment,
  reportIssueFailure,
  revertIssueToNotStarted,
  swapCommentReaction,
  swapIssueReaction,
  sweepDecompositionNotes,
  transitionIssueState,
  upsertStatusComment,
  upsertThreadedReply as upsertLinearThreadedReply,
  type LinearFeedbackContext,
} from './linear-feedback';
import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { fetchSubIssueGraph } from './linear-subissue-fetch';
import { logger } from './logger';
import {
  type Channel,
  type ChannelSubIssueNode,
  type IssueRef,
  type Reaction,
  type StateIntent,
} from './orchestration-channel';

/** Map the engine's small reaction vocabulary to Linear's emoji names. This is
 *  the one place the surface's reaction set is known. */
const REACTION_EMOJI: Record<Reaction, string> = {
  started: EMOJI_STARTED,
  succeeded: EMOJI_SUCCESS,
  failed: EMOJI_FAILURE,
  needs_input: EMOJI_NEEDS_INPUT,
};

/**
 * Map the engine's state intent onto how Linear is asked for that state: the
 * semantic state TYPE plus the state NAMES to prefer within it.
 *
 * The name preference is load-bearing, not decoration. Linear models both "In
 * Progress" and "In Review" as type ``started``, so type alone cannot say which
 * one the engine meant — without the name the transition would resolve to
 * whichever the team happens to order first and the two intents would collapse
 * into the same move. Teams that lack the preferred name still resolve to a
 * sensible state of the right type.
 */
const STATE_TARGET: Record<StateIntent, { type: 'started' | 'completed'; prefer: readonly string[] }> = {
  started: { type: 'started', prefer: ['In Progress'] },
  in_review: { type: 'started', prefer: ['In Review'] },
  completed: { type: 'completed', prefer: [] },
};

/**
 * Build a Linear {@link Channel}. ``registryTableName`` is the workspace-registry
 * table the token resolver reads; an {@link IssueRef}'s ``credentialsRef`` is the
 * Linear workspace (organization) id that keys it. The feedback helpers each take
 * a {@link LinearFeedbackContext} built from that pair.
 */
export function makeLinearChannel(registryTableName: string): Channel {
  const ctxFor = (issue: IssueRef): LinearFeedbackContext => ({
    linearWorkspaceId: issue.credentialsRef,
    registryTableName,
  });

  return {
    kind: 'linear',

    async postComment(issue, body) {
      const res = await postIssueComment(ctxFor(issue), issue.issueId, body);
      // postIssueComment doesn't return the new comment id, so callers that need
      // to edit later use upsertComment instead. Report success/failure only.
      return res.ok ? { commentId: '' } : null;
    },

    async upsertComment(issue, body, existing) {
      const id = await upsertStatusComment(ctxFor(issue), issue.issueId, body, existing?.commentId);
      return id ? { commentId: id } : null;
    },

    async reportFailure(issue, message) {
      await reportIssueFailure(ctxFor(issue), issue.issueId, message);
    },

    async reactToComment(comment, issue, reaction) {
      // ADD-only (no delete of prior markers) — the instant receipt ack.
      return addCommentReaction(ctxFor(issue), comment.commentId, REACTION_EMOJI[reaction]);
    },

    async replaceCommentReaction(comment, issue, reaction) {
      return swapCommentReaction(ctxFor(issue), comment.commentId, REACTION_EMOJI[reaction]);
    },

    async replaceIssueReaction(issue, reaction) {
      return swapIssueReaction(ctxFor(issue), issue.issueId, REACTION_EMOJI[reaction]);
    },

    async transitionState(issue, intent, options) {
      const target = STATE_TARGET[intent];
      return transitionIssueState(
        ctxFor(issue),
        issue.issueId,
        target.type,
        target.prefer,
        options?.allowRegression ?? false,
      );
    },

    async revertState(issue) {
      return revertIssueToNotStarted(ctxFor(issue), issue.issueId);
    },

    async postThreadedReply(issue, parent, body) {
      const id = await replyToComment(ctxFor(issue), issue.issueId, parent.commentId, body);
      return id ? { commentId: id } : null;
    },

    async upsertThreadedReply(issue, parent, body, existing, options) {
      const id = await upsertLinearThreadedReply(
        ctxFor(issue),
        issue.issueId,
        parent.commentId,
        body,
        existing?.commentId,
        {
          preservePreview: options?.preservePreview ?? false,
          skipIfSettled: options?.skipIfSettled ?? false,
        },
      );
      return id ? { commentId: id } : null;
    },

    async sweepNotes(issue, keep) {
      return sweepDecompositionNotes(ctxFor(issue), issue.issueId, keep?.commentId);
    },

    async fetchChildGraph(parent): Promise<readonly ChannelSubIssueNode[]> {
      const resolved = await resolveLinearOauthToken(parent.credentialsRef, registryTableName);
      if (!resolved?.accessToken) {
        logger.warn('Linear channel: no token to fetch sub-issue graph', {
          issue_id: parent.issueId,
        });
        return [];
      }
      const graph = await fetchSubIssueGraph(resolved.accessToken, parent.issueId);
      if (graph.kind !== 'ok') return [];
      // Map Linear's SubIssueNode (blocks-derived depends_on) to the neutral shape.
      return graph.children.map((n) => ({
        issueId: n.id,
        ...(n.identifier !== undefined && { displayId: n.identifier }),
        ...(n.title !== undefined && { title: n.title }),
        dependsOn: n.depends_on,
      }));
    },
  };
}
