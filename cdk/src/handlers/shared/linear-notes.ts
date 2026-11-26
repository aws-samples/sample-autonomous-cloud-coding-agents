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
 * Prefix that marks a comment as one of the bot's own notes.
 *
 * The self-trigger guard (``isBotAuthoredComment``) skips comments starting with
 * it.
 */
export const BOT_NOTE_PREFIX = '🗂️';

/**
 * Posted when someone mentions ``@bgagent`` on an issue we cannot link to any
 * task of ours.
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
 * nothing.
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
 * ``@bgagentx``.
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
 * label. ``base`` is the project's trigger label (default ``bgagent``).
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
    '- Once I\'m working, you can reply to my comments with **`@bgagent <what you want>`** to ask a '
      + 'question or request a change.',
    '- If some sub-issues fail, reply **`@bgagent retry`** on the epic — it re-runs only the '
      + 'failed/skipped work and keeps the parts that succeeded.',
    '',
    '_(You can remove this label now — it\'s just here to explain things.)_',
  ].join('\n');
}

/**
 * Re-trigger of an already-terminal epic that HAS failed/skipped children: we're
 * retrying them. ``succeeded`` nodes are left alone and called out.
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
 */
export function renderEpicAlreadyCompleteNote(): string {
  return (
    `${BOT_NOTE_PREFIX} This epic already finished — every sub-issue succeeded, so there's `
    + 'nothing to re-run. To change something, comment on the specific sub-issue with '
    + '`@bgagent <what to change>`.'
  );
}
