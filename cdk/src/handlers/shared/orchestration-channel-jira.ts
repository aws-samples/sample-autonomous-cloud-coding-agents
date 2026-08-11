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
 * Jira implementation of the surface-agnostic {@link Channel}. It maps the
 * channel-neutral feedback operations onto the existing Jira comment-back helpers
 * (`postIssueComment` / `reportIssueFailure`, which render the body as an Atlassian
 * Document Format doc under the hood).
 *
 * Jira's feedback surface is comment-only, so the adapter implements the required
 * post/update/failure methods plus workflow transitions. It omits reaction
 * capabilities because Jira has no equivalent primitive. The orchestration engine
 * checks optional methods and no-ops gracefully when a surface omits them.
 *
 * ``credentialsRef`` on an {@link IssueRef} is the Atlassian tenant id (``cloudId``)
 * that keys the Jira token registry.
 */

import {
  postIssueComment,
  reportIssueFailure,
  transitionIssueState,
  updateIssueComment,
  type JiraFeedbackContext,
} from './jira-feedback';
import { type Channel, type IssueRef } from './orchestration-channel';

/**
 * Build a Jira {@link Channel}. ``registryTableName`` is the Jira workspace
 * registry the token resolver reads; an {@link IssueRef}'s ``credentialsRef`` is
 * the ``cloudId`` that keys it, and ``issueId`` is the Jira issue id-or-key.
 */
export function makeJiraChannel(registryTableName: string): Channel {
  const ctxFor = (issue: IssueRef): JiraFeedbackContext => ({
    cloudId: issue.credentialsRef,
    registryTableName,
  });

  return {
    kind: 'jira',

    async postComment(issue, body) {
      const commentId = await postIssueComment(ctxFor(issue), issue.issueId, body);
      return commentId ? { commentId } : null;
    },

    async upsertComment(issue, body, existing) {
      if (!existing?.commentId) {
        const commentId = await postIssueComment(ctxFor(issue), issue.issueId, body);
        return commentId ? { commentId } : null;
      }
      const ok = await updateIssueComment(
        ctxFor(issue),
        issue.issueId,
        existing.commentId,
        body,
      );
      return ok ? existing : null;
    },

    async reportFailure(issue, message) {
      await reportIssueFailure(ctxFor(issue), issue.issueId, message);
    },

    async transitionState(issue, intent, options) {
      return transitionIssueState(
        ctxFor(issue),
        issue.issueId,
        intent,
        issue.stateOverrides,
        options,
      );
    },

    // Remaining optional capabilities are intentionally omitted: no reaction API
    // (reactToComment, replaceCommentReaction, replaceIssueReaction), no guarded
    // revertState, no threaded-reply helper
    // (postThreadedReply, upsertThreadedReply), no note sweep (sweepNotes), and
    // the sub-issue DAG isn't derived from Jira (fetchChildGraph). The engine
    // checks for each method and skips it, so the same orchestration core drives
    // Jira without Jira-specific branching. Implementing one here is additive:
    // no engine change is needed to pick it up.
  };
}
