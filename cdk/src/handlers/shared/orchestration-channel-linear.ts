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
  transitionIssueState,
  upsertStatusComment,
  upsertThreadedReply as upsertLinearThreadedReply,
  type LinearFeedbackContext,
} from './linear-feedback';
import {
  type Channel,
  type IssueRef,
  type Reaction,
  type StateIntent,
} from './orchestration-channel';

const REACTION_EMOJI: Record<Reaction, string> = {
  started: EMOJI_STARTED,
  succeeded: EMOJI_SUCCESS,
  failed: EMOJI_FAILURE,
  needs_input: EMOJI_NEEDS_INPUT,
};

/**
 * Linear models both "In Progress" and "In Review" as type ``started``, so type
 * alone cannot say which one the engine meant.
 */
const STATE_TARGET: Record<StateIntent, { type: 'started' | 'completed'; prefer: readonly string[] }> = {
  started: { type: 'started', prefer: ['In Progress'] },
  in_review: { type: 'started', prefer: ['In Review'] },
  completed: { type: 'completed', prefer: [] },
};

/**
 * Build a Linear {@link Channel}. ``registryTableName`` is the workspace-registry
 * table the token resolver reads; an {@link IssueRef}'s ``credentialsRef`` is the
 * Linear workspace (organization) id that keys it.
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
          repairIfOverwritten: options?.repairIfOverwritten ?? false,
        },
      );
      return id ? { commentId: id } : null;
    },
  };
}
