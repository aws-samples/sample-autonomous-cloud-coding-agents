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
 * Pure renderers for the short notes ABCA posts on a Linear issue — the label
 * explainer, the "I can't act on this" nudges, and the epic re-trigger notes.
 *
 * These build markdown deterministically with no I/O; the webhook processor does
 * the posting. Kept together (rather than inline at each call site) so every note
 * is reviewable as rendered output, which is the only way to catch a spliced
 * fragment or a stale instruction in copy a user actually reads.
 */

/**
 * Prefix that marks a comment as one of the bot's own notes.
 *
 * Two things depend on it. The self-trigger guard (``isBotAuthoredComment``)
 * skips comments starting with it, which matters because several of these notes
 * embed a literal ``@bgagent`` — without the prefix, posting one would trigger
 * the bot on its own comment. The thread sweep also treats it as "transient",
 * so a note can be tidied away later without tracking its comment id.
 */
export const BOT_NOTE_PREFIX = '🗂️';

/**
 * Posted when someone mentions ``@bgagent`` on an issue we cannot link to any
 * task of ours.
 *
 * The link comes from a sparse GSI on ``linear_issue_id``, an attribute only
 * written since that hoist shipped. Nothing back-fills it, so on the deploy that
 * first enables this path EVERY issue already in flight looks unlinked — someone
 * comments on work ABCA opened a PR for yesterday and the lookup misses. Staying
 * silent there reads as the bot ignoring them, and it is the worst moment for
 * that, since it is the moment the feature arrives.
 *
 * Says what to do instead of only what failed: re-applying the trigger label
 * starts a fresh run, which is the actual path forward. Bot-prefixed (👋) so the
 * self-trigger guard skips it.
 */
export function renderNoLinkedTaskNudge(): string {
  return (
    '👋 I don\'t have a task linked to this issue, so there\'s nothing for me to '
    + 'iterate on here. If I worked on it before this feature shipped, that link '
    + 'doesn\'t exist yet — re-apply this project\'s trigger label and I\'ll pick it '
    + 'up as a fresh run.'
  );
}

/**
 * Posted when the issue → task lookup itself FAILED, as distinct from finding
 * nothing. We cannot tell whether this issue is ours, so claiming it is not
 * would be a guess dressed as a fact — and it would be indistinguishable, to the
 * user, from being ignored. Bot-prefixed (⚠️) so the self-trigger guard skips it.
 */
export function renderTaskLookupFailedNudge(): string {
  return (
    '⚠️ I couldn\'t look up whether I have a task for this issue, so I haven\'t '
    + 'acted on your message. This is a transient fault on my side, not something '
    + 'wrong with your request — mention `@bgagent` again to retry.'
  );
}

/**
 * Posted when a reviewer addresses the bot by the WRONG handle — most often by
 * mistaking the trigger LABEL for the mention handle, or a boundary-miss like
 * ``@bgagentx``. Such a comment used to vanish silently (parseCommentTrigger
 * returned ``triggered: false`` → dropped, no reply, no reaction), so the
 * reviewer never learned their instruction wasn't seen. This one-liner tells
 * them the right handle, and says outright that the label is not a handle —
 * which is the mistake that lands here most often. Bot-prefixed (👋) so the
 * self-trigger guard skips it.
 */
export function renderWrongMentionNudge(): string {
  return (
    '👋 I answer to `@bgagent` — I don\'t pick up other @-names, and the trigger '
    + 'label isn\'t a mention handle. Re-send your message mentioning `@bgagent` '
    + 'and I\'ll get right on it.'
  );
}

/**
 * Render the one-time explainer posted when someone applies the ``<base>:help``
 * label (customer-caught: a first-time user couldn't tell the labels apart).
 * Explains the trigger label in plain English and creates no task. ``base`` is
 * the project's trigger label (default ``bgagent``) so the copy matches the
 * workspace's actual label names.
 */
export function renderLabelHelp(base: string): string {
  return [
    `${BOT_NOTE_PREFIX} **How to use ABCA on a Linear issue**`,
    '',
    `Add the **\`${base}\`** label to an issue and I'll get to work: I read the issue, make the `
      + 'change, and open a pull request.',
    '',
    'A few things worth knowing:',
    '- If an issue already has sub-issues, I run those in dependency order instead of the parent '
      + 'on its own — one pull request per sub-issue.',
    // The reply MENTION is my Linear app handle (@bgagent) — fixed, and separate
    // from the trigger LABEL (which the project can rename). This line used to
    // derive it from the label base (`@${base}`), which told users to reply with
    // the label name when only the app handle actually fires. Match the real,
    // working mention token.
    '- Once I\'m working, you can reply to my comments with **`@bgagent <what you want>`** to ask a '
      + 'question or request a change.',
    // One way named, not two: re-applying the label is a different gesture that
    // only happens to retry when nothing else changed (see the panel's retry hint).
    '- If some sub-issues fail, reply **`@bgagent retry`** on the epic — it re-runs only the '
      + 'failed/skipped work and keeps the parts that succeeded.',
    '',
    '_(You can remove this label now — it\'s just here to explain things.)_',
  ].join('\n');
}

/**
 * Re-trigger of an already-terminal epic that HAS failed/skipped children: we're
 * retrying them. Names exactly what's being re-run so the note is honest (the
 * earlier copy claimed "running the existing sub-issue graph" while
 * nothing actually re-ran). ``succeeded`` nodes are left alone and called out so
 * the user knows finished work isn't being redone.
 */
export function renderEpicRetryNote(counts: {
  failed: number;
  skipped: number;
  succeeded: number;
}): string {
  const retried = counts.failed + counts.skipped;
  const parts: string[] = [];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  const kept = counts.succeeded > 0
    ? ` The ${counts.succeeded} that already succeeded ${counts.succeeded === 1 ? 'is' : 'are'} left as-is.`
    : '';
  return (
    `${BOT_NOTE_PREFIX} Re-running the parts of this epic that didn't finish — `
    + `${retried} sub-issue${retried === 1 ? '' : 's'} (${parts.join(' + ')}).${kept} `
    + "I'll update the panel below as they go."
  );
}

/**
 * Re-trigger of an epic that already finished with EVERY child succeeded.
 * Nothing to retry; say so plainly instead of the misleading
 * "running the existing sub-issue graph".
 */
export function renderEpicAlreadyCompleteNote(): string {
  return (
    `${BOT_NOTE_PREFIX} This epic already finished — every sub-issue succeeded, so there's `
    + 'nothing to re-run. To change something, comment on the specific sub-issue with '
    + '`@bgagent <what to change>`.'
  );
}
