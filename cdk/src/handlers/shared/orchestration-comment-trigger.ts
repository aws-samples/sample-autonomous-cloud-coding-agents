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
 * Pure logic for the A6 comment trigger (#247 redesign). A reviewer who wants
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

/** The mention token that turns a Linear comment into an agent instruction. */
export const MENTION_TOKEN = '@bgagent';

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
  // SELF-COMMENT GUARD (#247 UX.20 — live-caught infinite loop): the bot's OWN
  // rendered comments must NEVER trigger it, or it talks to itself forever.
  // This bit me when the disambiguation reply embedded a literal "@bgagent
  // ABCA-123: …" example — the reply re-matched the mention and spawned another
  // reply, ~50 deep. The agent's progress comments are also bot-authored.
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
 * is never a human instruction — used to break self-trigger loops (#247 UX.20).
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
  '🗂️', // #299 Mode B plan-proposal / decomposition notes (embed literal "@bgagent approve")
  '💬', // maturing-reply "answered" state (a no-change/question iteration)
  '👀', // instant "on it" ack reply (posted at trigger time)
] as const;

/** True when ``body`` is one of the bot's own rendered comments (loop guard). */
export function isBotAuthoredComment(body: string): boolean {
  const trimmed = body.trimStart();
  return BOT_COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));
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
 * #299 Mode B — the approve/reject verdict of an ``@bgagent`` comment on a
 * pending decomposition plan. ``none`` means the comment is an ordinary
 * instruction (not a plan verdict), so the caller falls through to the normal
 * iteration paths.
 */
export type PlanVerdict = 'approve' | 'reject' | 'none';

/**
 * Natural ways a reviewer signals "go ahead" / "don't" on a pending plan. Real
 * people don't type the exact keyword — a strict ``approve``-only parser silently
 * swallowed "lgtm", "yes go ahead", "👍", "looks good" (live-confirmed). These
 * cover the common affirmations/negations; ``reject`` is checked first so a
 * negation that also contains an affirmative word ("don't approve") reads as
 * reject. Multi-word phrases are matched as phrases; single tokens as whole words.
 */
const APPROVE_PHRASES = [
  'approve', 'approved', 'approves', 'lgtm', 'sgtm', 'yes', 'yep', 'yeah', 'yup',
  'ok', 'okay', 'sure', 'proceed', 'accept', 'accepted', 'confirm', 'confirmed',
  'ship it', 'shipit', 'do it', 'go ahead', 'go for it', 'sounds good',
  'looks good', 'looks great', 'send it', '+1',
] as const;
const REJECT_PHRASES = [
  'reject', 'rejected', 'rejects', 'no', 'nope', 'nah', 'cancel', 'cancelled',
  'canceled', 'stop', 'discard', 'abort', "don't", 'do not', 'dont', '-1',
] as const;
/** Emoji affirmations/negations — matched by inclusion (no word boundaries). */
const APPROVE_EMOJI = ['👍', '✅', '🚀'];
const REJECT_EMOJI = ['👎', '🛑', '❌'];

/**
 * A comment with at most this many words is read as a verdict if it contains ANY
 * approve/reject phrase; a longer comment only counts when its FIRST word is a
 * verdict word — so a genuine edit request ("also approve the dialog copy and …")
 * isn't hijacked as approval.
 */
const MAX_VERDICT_WORDS = 6;

/** Word/phrase boundary match: the phrase appears as whole words in ``text``. */
function hasPhrase(text: string, phrase: string): boolean {
  // Escape regex metachars (e.g. "+1", "don't"); match on non-word boundaries so
  // "approve" doesn't fire on "approval" and "no" doesn't fire on "notify".
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}

/**
 * Classify an already-parsed comment instruction as a plan ``approve``/``reject``
 * verdict. Only consulted when a pending plan exists on the issue, so we can read
 * natural affirmations/negations liberally — BUT we must not hijack a genuine
 * edit request. Rule: ONLY a SHORT comment (≤6 words) is a verdict (classified by
 * any approve/reject phrase it contains, or its verdict-word first token); a
 * LONGER comment is treated as a change request → ``none`` → the revise loop,
 * even when it opens with a verdict word ("no, go back to two sub-issues …" is a
 * re-plan, not a discard — F-reject-revision). ``reject`` wins over ``approve``
 * when both appear; emoji verdicts (👍/👎) are honoured regardless of length.
 */
export function parsePlanVerdict(instruction: string): PlanVerdict {
  // Normalize: drop markdown emphasis/backticks, lowercase, collapse whitespace.
  const text = instruction.replace(/[*_`>]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return 'none';

  const wordCount = text.split(' ').length;
  const firstWord = text.split(/[\s.,!?—–-]+/)[0];
  const short = wordCount <= MAX_VERDICT_WORDS;

  // A LONG comment is never a verdict — even one led by a verdict word — because a
  // long, instruction-bearing negation is a CHANGE REQUEST, not a discard. Live-
  // caught (F-reject-revision, destructive): "no, go back to just two sub-issues:
  // one API and one UI" was parsed reject → the pending plan was DELETED, all
  // revise rounds lost. So gate BOTH the firstWord fast-path AND the any-phrase
  // check on ``short``; a long comment falls through to ``none`` → routes to the
  // revise loop (re-plan), which is the whole point of "a deny isn't a discard".
  // Emoji stay unconditional (a 👎 is a verdict regardless of surrounding words).

  // reject precedence
  if (REJECT_EMOJI.some((e) => instruction.includes(e))) return 'reject';
  if (short && REJECT_PHRASES.includes(firstWord as (typeof REJECT_PHRASES)[number])) return 'reject';
  if (short && REJECT_PHRASES.some((p) => hasPhrase(text, p))) return 'reject';

  if (APPROVE_EMOJI.some((e) => instruction.includes(e))) return 'approve';
  if (short && APPROVE_PHRASES.includes(firstWord as (typeof APPROVE_PHRASES)[number])) return 'approve';
  if (short && APPROVE_PHRASES.some((p) => hasPhrase(text, p))) return 'approve';

  return 'none';
}
