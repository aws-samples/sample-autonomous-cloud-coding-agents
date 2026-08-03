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
 * Slack implementation of the surface-agnostic {@link Channel}.
 *
 * Slack is deliberately the SECOND-most-different surface available: it is a chat
 * product, not an issue tracker, so it exercises the interface's capability
 * gating for real rather than hypothetically. Two mappings carry the weight:
 *
 *  - **A "thread" is the issue.** ``IssueRef.issueId`` is ``<channel>:<thread_ts>``
 *    — the conversation an orchestration reports into. Slack has no issue object,
 *    so the thread is the durable thing a panel can live in.
 *  - **A message ts is the comment id.** ``CommentRef.commentId`` is a message
 *    ``ts``; ``chat.update`` edits it, which is what lets one status panel mature
 *    in place instead of streaming new messages.
 *
 * ``credentialsRef`` is the Slack ``team_id``, which keys the per-workspace bot
 * token secret (``bgagent/slack/<team_id>``) — the same lookup the Slack event
 * handlers use.
 *
 * DELIBERATELY OMITTED — Slack has no workflow state, so there is nothing for
 * ``transitionState`` / ``revertState`` to move. They are absent rather than
 * stubbed to a no-op, so the engine's capability guards skip them: a silent
 * success would claim the platform mirrored a state it never did, and the panel
 * is then the only place the epic's progress is visible. ``sweepNotes`` is also
 * omitted (deleting other messages in a shared channel is a blunt instrument that
 * needs its own product decision, not a quiet default), as is ``fetchChildGraph``
 * — Slack has no dependency model to read a DAG from, so a Slack-triggered
 * orchestration supplies its graph declaratively.
 */

import { logger } from './logger';
import {
  type Channel,
  type IssueRef,
  type Reaction,
} from './orchestration-channel';
import { slackFetch, slackFetchTs } from './slack-api';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './slack-verify';

/**
 * Map the engine's reaction vocabulary to Slack emoji names. The one place
 * Slack's reaction set is known — the engine only ever names a {@link Reaction}.
 */
const REACTION_EMOJI: Record<Reaction, string> = {
  started: 'eyes',
  succeeded: 'white_check_mark',
  failed: 'x',
  needs_input: 'question',
};

/** Every emoji this adapter may have applied, so a "replace" clears its own
 *  prior markers without touching a human's reaction. */
const OWN_EMOJI: readonly string[] = Object.values(REACTION_EMOJI);

/** Separator between the channel id and thread ts inside an ``issueId``. A colon
 *  can't appear in either part, so the split is unambiguous. */
const THREAD_REF_SEPARATOR = ':';

/** Build the ``issueId`` for a Slack thread. Exported so a Slack-side seeding
 *  path composes the ref the same way this adapter parses it. */
export function slackThreadRef(channelId: string, threadTs: string): string {
  return `${channelId}${THREAD_REF_SEPARATOR}${threadTs}`;
}

/** Split an ``issueId`` back into its channel + thread ts. */
function parseThreadRef(issueId: string): { channel: string; threadTs: string } | null {
  const at = issueId.indexOf(THREAD_REF_SEPARATOR);
  if (at <= 0 || at === issueId.length - 1) return null;
  return { channel: issueId.slice(0, at), threadTs: issueId.slice(at + 1) };
}

/**
 * Build a Slack {@link Channel}. ``secretPrefix`` is the Secrets Manager prefix
 * the per-workspace bot tokens live under; an {@link IssueRef}'s
 * ``credentialsRef`` is the ``team_id`` that completes it.
 *
 * Signature matches the other adapters (one string) so it registers as a
 * {@link ChannelFactory} without special-casing.
 */
export function makeSlackChannel(secretPrefix: string = SLACK_SECRET_PREFIX): Channel {
  /** Resolve the workspace bot token, or null when the workspace isn't installed. */
  const tokenFor = async (issue: IssueRef): Promise<string | null> => {
    const token = await getSlackSecret(`${secretPrefix}${issue.credentialsRef}`);
    if (!token) {
      logger.warn('Slack channel: no bot token for workspace — skipping feedback', {
        team_id: issue.credentialsRef,
      });
    }
    return token;
  };

  /** Resolve the token AND the thread the ref names; null if either is missing. */
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
      const ts = await slackFetchTs(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: body,
      });
      return ts ? { commentId: ts } : null;
    },

    async upsertComment(issue, body, existing) {
      const ctx = await contextFor(issue);
      if (!ctx) return null;
      if (existing?.commentId) {
        // Edit in place — this is what makes the maturing panel one message
        // rather than a stream. chat.update echoes the ts it edited.
        const ts = await slackFetchTs(ctx.token, 'chat.update', {
          channel: ctx.channel,
          ts: existing.commentId,
          text: body,
        });
        return ts ? { commentId: ts } : null;
      }
      const ts = await slackFetchTs(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: body,
      });
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
      // ADD-only — the instant receipt ack, which must not disturb any marker
      // already present.
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
      // Slack has no atomic swap, so clear this adapter's OWN markers then add
      // the target. Scoped to OWN_EMOJI so a human's reaction survives; a
      // `no_reaction` error on a marker that isn't there is benign and treated
      // as success by slackFetch.
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
        // Reporting the add alone would claim the promised end state — ONE marker
        // — while the message still carries a contradictory one ("saw it" beside
        // "done"), and the contradiction is precisely what a caller checks this
        // result to rule out.
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
      // The "issue" is a thread, so its at-a-glance marker goes on the thread's
      // root message — the closest equivalent to reacting to an issue.
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
      // Slack threads are one level deep: a reply goes to the thread the parent
      // belongs to. Using the parent's own ts as thread_ts starts a thread on it
      // when the parent is a root, and stays in-thread otherwise.
      const ts = await slackFetchTs(ctx.token, 'chat.postMessage', {
        channel: ctx.channel,
        thread_ts: parent.commentId,
        text: body,
      });
      return ts ? { commentId: ts } : null;
    },

    // The convergence options (preview preservation, settle checks, outcome
    // repair) are deliberately not implemented here: each needs a read of the
    // current message text, and this adapter posts and edits without reading
    // back. Ignoring them is what the interface specifies for a surface that
    // can't, and it costs nothing today because no multi-writer maturing reply
    // runs on Slack — the orchestration engine's late-progress race is between
    // Lambdas that write to the issue surface. Anything wiring a maturing reply
    // onto Slack needs to honour them first, via `conversations.replies`.
    async upsertThreadedReply(issue, parent, body, existing) {
      const ctx = await contextFor(issue);
      if (!ctx) return null;
      if (existing?.commentId) {
        const ts = await slackFetchTs(ctx.token, 'chat.update', {
          channel: ctx.channel,
          ts: existing.commentId,
          text: body,
        });
        return ts ? { commentId: ts } : null;
      }
      return this.postThreadedReply!(issue, parent, body);
    },

    // transitionState / revertState: omitted — Slack has no workflow state.
    // sweepNotes: omitted — bulk-deleting messages in a shared channel needs its
    //   own product decision.
    // fetchChildGraph: omitted — no dependency model; graphs arrive declaratively.
  } satisfies Channel as Channel;
}

