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
 * This adapter demonstrates the capability-awareness of the interface: Jira's
 * feedback surface is comment-only, so the adapter implements the REQUIRED methods
 * (`postComment`, `upsertComment`, `reportFailure`) and OMITS the optional ones
 * the surface can't do today — there's no reaction API, no workflow-state
 * transition wired here, and the sub-issue DAG isn't derived from Jira. The
 * orchestration engine checks for those methods and no-ops gracefully when a
 * surface omits them, so the same engine drives Jira without any Jira-specific
 * branching in the core.
 *
 * ``credentialsRef`` on an {@link IssueRef} is the Atlassian tenant id (``cloudId``)
 * that keys the Jira token registry.
 */

import {
  postIssueComment,
  reportIssueFailure,
  transitionIssueState,
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
      const ok = await postIssueComment(ctxFor(issue), issue.issueId, body);
      // The Jira helper doesn't return the new comment id, so an edit-in-place
      // isn't possible yet (see upsertComment); report success/failure only.
      return ok ? { commentId: '' } : null;
    },

    async upsertComment(issue, body) {
      // Jira has no comment-update helper wired today, so a repeated "upsert"
      // posts a fresh comment rather than editing in place. Behaviourally safe
      // (the reviewer sees the latest state); a true edit-in-place needs a Jira
      // update-comment call and a returned comment id — tracked as a follow-up.
      const ok = await postIssueComment(ctxFor(issue), issue.issueId, body);
      return ok ? { commentId: '' } : null;
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
