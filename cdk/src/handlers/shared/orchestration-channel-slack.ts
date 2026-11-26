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

import { logger } from './logger';
import { lookupValueOr } from './lookup-result';
import {
  type Channel,
  type IssueRef,
  type Reaction,
} from './orchestration-channel';
import { slackFetch, slackFetchTs } from './slack-api';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './slack-verify';

const REACTION_EMOJI: Record<Reaction, string> = {
  started: 'eyes',
  succeeded: 'white_check_mark',
  failed: 'x',
  needs_input: 'question',
};

const OWN_EMOJI: readonly string[] = Object.values(REACTION_EMOJI);

/** A colon appears in neither a Slack channel id nor a message ts. */
const THREAD_REF_SEPARATOR = ':';

/** Build the ``issueId`` for a Slack thread. */
export function slackThreadRef(channelId: string, threadTs: string): string {
  return `${channelId}${THREAD_REF_SEPARATOR}${threadTs}`;
}

function parseThreadRef(issueId: string): { channel: string; threadTs: string } | null {
  const at = issueId.indexOf(THREAD_REF_SEPARATOR);
  if (at <= 0 || at === issueId.length - 1) return null;
  return { channel: issueId.slice(0, at), threadTs: issueId.slice(at + 1) };
}

/**
 * Build a Slack {@link Channel}. ``secretPrefix`` is the Secrets Manager prefix
 * the per-workspace bot tokens live under; an {@link IssueRef}'s
 * ``credentialsRef`` is the ``team_id`` that completes it.
 */
export function makeSlackChannel(secretPrefix: string = SLACK_SECRET_PREFIX): Channel {
  const tokenFor = async (issue: IssueRef): Promise<string | null> => {
    const token = await getSlackSecret(`${secretPrefix}${issue.credentialsRef}`);
    if (!token) {
      logger.warn('Slack channel: no bot token for workspace — skipping feedback', {
        team_id: issue.credentialsRef,
      });
    }
    return token;
  };

  const contextFor = async (issue: IssueRef) => {
    const thread = parseThreadRef(issue.issueId);
    if (!thread) {
      logger.warn('Slack channel: issue ref is not a <channel>:<thread_ts> pair', {
        issue_id: issue.issueId,
      });
      return null;
    }
    const token = await tokenFor(issue);
    return token ? { token, ...thread } : null;
  };

  return {
    kind: 'slack',

    async postComment(issue, body) {
      const ctx = await contextFor(issue);
      if (!ctx) return null;
      const ts = lookupValueOr(await slackFetchTs(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: body,
      }), null);
      return ts ? { commentId: ts } : null;
    },

    async upsertComment(issue, body, existing) {
      const ctx = await contextFor(issue);
      if (!ctx) return null;
      if (existing?.commentId) {
        const ts = lookupValueOr(await slackFetchTs(ctx.token, 'chat.update', {
          channel: ctx.channel,
          ts: existing.commentId,
          text: body,
        }), null);
        return ts ? { commentId: ts } : null;
      }
      const ts = lookupValueOr(await slackFetchTs(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: body,
      }), null);
      return ts ? { commentId: ts } : null;
    },

    async reportFailure(issue, message) {
      const ctx = await contextFor(issue);
      if (!ctx) return;
      await slackFetch(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: message,
      });
    },

    async reactToComment(comment, issue, reaction) {
      const ctx = await contextFor(issue);
      if (!ctx) return false;
      return slackFetch(ctx.token, 'reactions.add', {
        channel: ctx.channel,
        timestamp: comment.commentId,
        name: REACTION_EMOJI[reaction],
      });
    },

    async replaceCommentReaction(comment, issue, reaction) {
      const ctx = await contextFor(issue);
      if (!ctx) return false;
      // Slack has no atomic reaction swap. `reactions.remove` on a reaction that is not
      // there answers `no_reaction`, which slackFetch counts as success.
      const target = REACTION_EMOJI[reaction];
      const stale: string[] = [];
      for (const emoji of OWN_EMOJI) {
        if (emoji === target) continue;
        const removed = await slackFetch(ctx.token, 'reactions.remove', {
          channel: ctx.channel,
          timestamp: comment.commentId,
          name: emoji,
        });
        if (!removed) stale.push(emoji);
      }
      const added = await slackFetch(ctx.token, 'reactions.add', {
        channel: ctx.channel,
        timestamp: comment.commentId,
        name: target,
      });
      if (stale.length > 0) {
        logger.warn('Slack channel: a stale status marker could not be removed', {
          event: 'slack_channel.reaction_replace_incomplete',
          message_ts: comment.commentId,
          target,
          stale,
        });
      }
      return added && stale.length === 0;
    },

    async replaceIssueReaction(issue, reaction) {
      const thread = parseThreadRef(issue.issueId);
      if (!thread) return false;
      return this.replaceCommentReaction!(
        { commentId: thread.threadTs },
        issue,
        reaction,
      );
    },

    async postThreadedReply(issue, parent, body) {
      const ctx = await contextFor(issue);
      if (!ctx) return null;
      const ts = lookupValueOr(await slackFetchTs(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: parent.commentId,
        text: body,
      }), null);
      return ts ? { commentId: ts } : null;
    },

    async upsertThreadedReply(issue, parent, body, existing) {
      const ctx = await contextFor(issue);
      if (!ctx) return null;
      if (existing?.commentId) {
        const ts = lookupValueOr(await slackFetchTs(ctx.token, 'chat.update', {
          channel: ctx.channel,
          ts: existing.commentId,
          text: body,
        }), null);
        return ts ? { commentId: ts } : null;
      }
      return this.postThreadedReply!(issue, parent, body);
    },

    // transitionState / revertState: omitted — Slack has no workflow state.
  } satisfies Channel as Channel;
}
