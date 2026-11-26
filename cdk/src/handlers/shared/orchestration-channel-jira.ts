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

    // The reaction methods are omitted: Jira has no reaction API.
  };
}
