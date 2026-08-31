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
 * Pure logic for the comment trigger that iterates on an existing PR. A
 * reviewer who wants
 * a sub-issue's PR changed mentions ``@bgagent`` in a Linear comment on that
 * sub-issue; the platform runs a ``coding/pr-iteration-v1`` task on the
 * sub-issue's PR (and the reconciler then cascades the re-stack to dependents).
 *
 * This module decides — from a comment body alone — whether the comment is an
 * instruction for the agent and what the instruction text is. Kept pure (no
 * I/O, no Linear/AWS types) so the mention parsing is unit-testable and reused
 * regardless of how the comment arrives. The processor does the I/O (resolve
 * sub-issue → orchestration → PR, spawn the task).
 */

export interface CommentTrigger {
  /** True when the comment is an explicit instruction for the agent. */
  readonly triggered: boolean;
  /**
   * The instruction text with the mention token stripped, trimmed. Empty when
   * not triggered, or when the mention had no accompanying text (the caller
   * treats an empty instruction as "address the latest review" — still valid).
   */
  readonly instruction: string;
}

/**
 * Decide whether a comment body is an ``@bgagent`` instruction, and extract
 * the instruction text.
 *
 * Rules (deliberately strict to avoid false-positives on human discussion and,
 * critically, on the agent's OWN progress comments which never contain the
 * mention token):
 *  - Must contain ``@bgagent`` (case-insensitive), as a token boundary so
 *    ``@bgagentx`` / an email-like ``foo@bgagent.io`` do NOT trigger.
 *  - The instruction is everything after stripping the token (all occurrences),
 *    collapsed/trimmed. A bare ``@bgagent`` with no text still triggers
 *    (instruction === '').
 */
export function parseCommentTrigger(body: string | undefined | null): CommentTrigger {
  if (!body) return { triggered: false, instruction: '' };
  // SELF-COMMENT GUARD: the bot's OWN rendered comments must NEVER trigger it,
  // or it talks to itself forever. This happened in practice — the
  // disambiguation reply embedded a literal "@bgagent ENG-123: …" example, so
  // the reply re-matched the mention and spawned another reply, ~50 deep.
  // The agent's progress comments are also bot-authored.
  // Cheapest robust signal that needs no actor-identity config: a body that
  // STARTS WITH one of our own template markers is ours, not a user
  // instruction. (Linear strips a leading emoji to its own line sometimes, so
  // we test the trimmed start.) Keep this list in sync with the rendered
  // comment prefixes (panel, acks, disambiguation, agent progress).
  if (isBotAuthoredComment(body)) return { triggered: false, instruction: '' };
  // Token-boundary match: @bgagent not immediately followed by a word char or
  // a '.' (so it won't fire on @bgagentbot or an @bgagent.io address).
  const re = /@bgagent(?![\w.])/gi;
  if (!re.test(body)) return { triggered: false, instruction: '' };
  const instruction = body.replace(/@bgagent(?![\w.])/gi, ' ').replace(/\s+/g, ' ').trim();
  return { triggered: true, instruction };
}

/**
 * Markers that begin a comment the BOT itself rendered (panel, acks,
 * disambiguation reply, agent progress). A comment starting with any of these
 * is never a human instruction — used to break self-trigger loops.
 */
const BOT_COMMENT_PREFIXES = [
  '👋', // disambiguation "which sub-issue?" reply
  '✅', // "✅ Updated — PR #…" ack / "✅ **ABCA orchestration complete**" panel
  '❌', // failure reply
  '⚠️', // "finished with failures" panel
  '🔄', // in-progress panel
  '🤖', // agent progress ("🤖 Starting…")
  '🖼️', // preview screenshot comment
  '🔗', // "PR opened" / combined-PR
  '🗂️', // bot notes: the label explainer, the epic re-trigger notes (embed literal "@bgagent")
  '💬', // maturing-reply "answered" state (a no-change/question iteration)
  '👀', // instant "on it" ack reply (posted at trigger time)
] as const;

/** True when ``body`` is one of the bot's own rendered comments (loop guard). */
export function isBotAuthoredComment(body: string): boolean {
  const trimmed = body.trimStart();
  return BOT_COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * Near-miss mention handles. A reviewer who
 * addresses the bot by the WRONG handle (most often ``@abca`` — confusing the
 * trigger LABEL for the mention handle — or a boundary-miss like ``@bgagentx``)
 * previously fell into a silent black hole: {@link parseCommentTrigger} returned
 * ``triggered: false`` and the webhook dropped the comment with no reply and no
 * reaction, so the reviewer had no idea their instruction was never seen.
 *
 * This is a DELIBERATELY NARROW allowlist of handles that are clearly meant for
 * THIS bot but aren't the exact ``@bgagent`` token — so the near-miss nudge never
 * fires on a real teammate mention. Generic words (``@agent``/``@bot``) are
 * intentionally EXCLUDED (they can be real usernames); only bot-specific
 * near-misses qualify. Matching is done by {@link detectNearMissMention}.
 */
const NEAR_MISS_MENTION_PATTERNS: readonly RegExp[] = [
  // @abca (+ optional :suffix) — the label-name confusion.
  /@abca\b/i,
  // @bgagent immediately followed by a word char — a boundary-miss that
  // parseCommentTrigger's `@bgagent(?![\w.])` deliberately does NOT trigger
  // (@bgagentbot, @bgagentx). NOT `@bgagent ` (a space → real trigger) nor
  // `@bgagent.` (an email-like foo@bgagent.io → not a mention).
  /@bgagent\w/i,
  // Hyphen/underscore variants. The separator is REQUIRED (not optional) so these
  // match @bg-agent / @bg_agent but NOT the canonical @bgagent (which parses as a
  // real trigger, not a near-miss) — an optional separator would wrongly flag it.
  /@bg[-_]agent\b/i,
  // @bgbot / @bg-bot / @bg_bot — a plausible shorthand. Distinct from @bgagent.
  /@bg[-_]?bot\b/i,
  // The spelled-out name — @backgroundagent / @background-agent. Distinct too.
  /@background[-_]?agent\b/i,
];

/**
 * Detect a NEAR-MISS bot mention: the reviewer clearly meant to
 * address the bot but used the wrong handle (``@abca``, ``@bgagentx``, …), so
 * {@link parseCommentTrigger} didn't fire. Returns true so the caller can nudge
 * ("I answer to ``@bgagent``") instead of silently dropping the comment.
 *
 * Only consulted in the NOT-triggered branch (a real ``@bgagent`` never reaches
 * here). Skips the bot's own comments (never nudge ourselves). Strict allowlist
 * ({@link NEAR_MISS_MENTION_PATTERNS}) so it can't misfire on human discussion or
 * a genuine teammate mention.
 */
export function detectNearMissMention(body: string | undefined | null): boolean {
  if (!body) return false;
  if (isBotAuthoredComment(body)) return false;
  return NEAR_MISS_MENTION_PATTERNS.some((re) => re.test(body));
}

/**
 * Build the task description handed to ``coding/pr-iteration-v1`` from the
 * comment instruction. When the reviewer left explicit text, that IS the
 * instruction; when they only mentioned ``@bgagent`` with no text, fall back
 * to a generic "address the latest review feedback on this PR" so the agent
 * still has a directive.
 */
export function buildIterationInstruction(trigger: CommentTrigger): string {
  if (trigger.instruction.length > 0) return trigger.instruction;
  return 'Address the latest review feedback on this pull request.';
}

/**
 * The instruction for an iteration on the COMBINED PR of an integration node.
 *
 * A defect that only appears once siblings are merged cannot be found the way a
 * single-child defect can, and the default iteration prompt actively misleads here:
 * an agent told "the dates are wrong" on a branch that builds and whose tests pass
 * will do the locally-sensible thing and adjust presentation. That is what happened
 * — the reported symptom was a contract mismatch between the API and UI children,
 * and the agent changed how the error was displayed.
 *
 * So the prompt states plainly what does NOT count as evidence. A clean merge and
 * green isolated tests are exactly what the broken epic already had; treating them
 * as proof is the failure mode, not an oversight. The agent is asked to reproduce
 * the behaviour against the combined code first, read both sides of every boundary
 * it touches, and leave behind a test that crosses that boundary — the artefact
 * that would have caught it and that no per-child test suite can express.
 */
export function buildIntegrationIterationInstruction(trigger: CommentTrigger): string {
  const reported = trigger.instruction || 'The combined result does not work end to end.';
  return [
    'This is the COMBINED branch of an epic: it already contains every sibling',
    "sub-issue's merged work. The reported problem is one that only appears once they",
    'are combined, so it will not be visible in any single sub-issue\'s PR.',
    '',
    `Reported: ${reported}`,
    '',
    'Work in this order:',
    '1. REPRODUCE it against this combined code before changing anything. If you',
    '   cannot reproduce it, say so and stop — do not guess at a fix.',
    '2. Read BOTH sides of every boundary the symptom crosses — the caller and the',
    '   callee, the request builder and the handler, the emitter and the consumer.',
    '   The likely cause is two siblings that each made a reasonable choice and',
    '   disagreed: a differing name, route, field, id, casing, or date format.',
    '3. Fix the MISMATCH at its source. Do not adjust an error message, a fallback,',
    '   or presentation so the symptom stops showing.',
    '4. Add or run a test that exercises the path ACROSS the boundary, so this',
    '   cannot regress. A test living wholly inside one side cannot catch it.',
    '',
    'A clean merge and passing per-component tests are NOT evidence that this is',
    'fixed — the broken version already had both. State in your PR description what',
    'you reproduced, what the mismatch was, and which test now covers it.',
  ].join('\n');
}

/**
 * A comment of at most this many words reads as a bare COMMAND rather than an
 * instruction that happens to contain a command word. Anything longer is
 * substantive and belongs on the iteration path.
 */
const MAX_COMMAND_WORDS = 6;

/** True when ``c`` is one of the [a-z0-9] chars that count as "inside a word". */
function isAlnum(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
}

/** Word/phrase boundary match: the phrase appears as whole words in ``text``.
 *
 *  Plain substring scan rather than a phrase-interpolated ``new RegExp`` — a
 *  dynamically built pattern would need metachar escaping to stay correct and
 *  would make the phrase list a regex-injection / ReDoS surface if it ever grew
 *  a non-literal member. Comparing chars directly cannot misparse its input.
 */
function hasPhrase(text: string, phrase: string): boolean {
  const hay = text.toLowerCase();
  const needle = phrase.toLowerCase();
  if (!needle) return false;
  // Accept only occurrences flanked by a non-[a-z0-9] char (or a string edge),
  // so "retry" doesn't fire inside a longer word like "retryx" / "abcretry".
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!isAlnum(hay[i - 1]) && !isAlnum(hay[i + needle.length])) return true;
  }
  return false;
}

/**
 * Does an ``@bgagent`` comment read as a RETRY request —
 * "re-run the work that failed" — rather than a change instruction? The failure
 * panel tells the user "reply here to try again", so a bare ``@bgagent retry`` /
 * "try again" / "re-run" must route to the epic-retry machinery (reset + re-run
 * the failed/skipped children), NOT to the disambiguation/iteration path, which
 * either dead-ended or looped and so never actually re-ran anything.
 *
 * Deliberately conservative: only fires when the instruction is a SHORT
 * (≤{@link MAX_COMMAND_WORDS}-word) comment led by (or consisting of) a retry
 * phrase — so "retry the footer but change the color and …" (a substantive edit
 * that happens to start with "retry") is NOT swallowed as a bare retry; it falls
 * through to the normal iterate path. An empty instruction (bare ``@bgagent``) is
 * NOT a retry — that stays "address the latest review" per
 * {@link buildIterationInstruction}.
 */
const RETRY_PHRASES = [
  'retry', 'retries', 'try again', 'rerun', 're-run', 're run', 'run again', 'run it again',
] as const;
export function parseRetryIntent(instruction: string): boolean {
  const text = instruction.replace(/[*_`>]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return false;
  if (text.split(' ').length > MAX_COMMAND_WORDS) return false;
  const firstWord = text.split(/[\s.,!?—–-]+/)[0];
  if (firstWord === 'retry' || firstWord === 'rerun') return true;
  return RETRY_PHRASES.some((p) => hasPhrase(text, p));
}

/** The command words ABCA recognises in an ``@bgagent`` comment on an epic.
 *  Today there is exactly one — ``retry``. Surfaced in the epic
 *  disambiguation/fallback reply so the user always sees what they CAN type
 *  (rather than us trying to guess a typo). Extend this together with
 *  {@link RETRY_PHRASES} when a new command is added. */
export const KNOWN_EPIC_COMMANDS = ['retry'] as const;
