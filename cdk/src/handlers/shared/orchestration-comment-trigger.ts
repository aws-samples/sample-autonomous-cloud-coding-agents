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
 * #299 BLOCKER-2 (@abca black hole) — near-miss mention handles. A reviewer who
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
  // @abca (+ optional :suffix like @abca:decompose) — the label-name confusion.
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
 * #299 BLOCKER-2 — detect a NEAR-MISS bot mention: the reviewer clearly meant to
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
 * #299 Mode B — the verdict of an ``@bgagent`` comment on a pending decomposition
 * plan. ``none`` means the comment is an ordinary change instruction (routes to
 * the revise loop). ``ambiguous`` means an unqualified negation ("no", "no
 * thanks", "don't approve") that is NOT a clear discard — the processor nudges
 * the reviewer to pick (approve / reject / change) rather than destroy the plan.
 */
export type PlanVerdict = 'approve' | 'reject' | 'none' | 'ambiguous';

/**
 * Natural ways a reviewer signals "go ahead" on a pending plan. Real people don't
 * type the exact keyword — a strict ``approve``-only parser silently swallowed
 * "lgtm", "yes go ahead", "👍", "looks good" (live-confirmed). Multi-word phrases
 * are matched as phrases; single tokens as whole words.
 */
const APPROVE_PHRASES = [
  'approve', 'approved', 'approves', 'lgtm', 'sgtm', 'yes', 'yep', 'yeah', 'yup',
  'ok', 'okay', 'sure', 'proceed', 'accept', 'accepted', 'confirm', 'confirmed',
  'ship it', 'shipit', 'do it', 'go ahead', 'go for it', 'sounds good',
  'looks good', 'looks great', 'send it', '+1',
] as const;
/**
 * EXPLICIT, unambiguous "kill it" words — these DISCARD the pending plan (the one
 * destructive, irreversible action in the flow: a discarded plan is gone, whereas
 * an approved plan's sub-issues can still be closed). A discard therefore demands
 * explicit intent. A SOFT negation ("no", "don't") is deliberately NOT here — see
 * {@link SOFT_NEGATION_PHRASES}: it is ambiguous between "discard" and "change it",
 * so it must never silently destroy the plan (F-reject-revision, live-caught).
 */
const EXPLICIT_REJECT_PHRASES = [
  'reject', 'rejected', 'rejects', 'cancel', 'cancelled', 'canceled',
  'stop', 'discard', 'abort',
] as const;
/**
 * SOFT negations. On their own — or as pure negativity ("no, looks wrong") — these
 * are AMBIGUOUS: "no" could mean "discard it" or "no, change it". Rather than
 * guess-and-destroy, we nudge the reviewer to pick. When a soft negation is
 * FOLLOWED BY a substantive change instruction ("no, make it 3 tasks") it is a
 * REVISE. Live-caught destructive bug (ABCA-562): "no, just 2 tasks" was parsed as
 * reject and DELETED the pending plan; the QA-1 length guard only saved LONG
 * negations, not a short one carrying an instruction.
 */
const SOFT_NEGATION_PHRASES = [
  'no', 'nope', 'nah', "don't", 'do not', 'dont', '-1',
  // review #4(a): 'not' was MISSING, so "not sure" / "not ok" / "not approved"
  // fell through to APPROVE (they contain approve words). As a soft negation it
  // now routes to ambiguous (nudge) or, with a change instruction, revise —
  // never a silent approval against the reviewer's "not".
  'not',
] as const;
/**
 * Change-instruction signals that mark a soft-negation comment as a REVISE (re-plan
 * from the feedback) rather than a bare negation. An imperative change verb
 * ("make", "split", "merge", "keep", …) or a numeric-count directive ("2 tasks",
 * "3 sub-issues"). Best-effort: an unrecognized instruction falls back to a NUDGE
 * (safe — asks the reviewer to rephrase; the choice between revise and nudge is
 * purely UX, since BOTH are non-destructive — only reject destroys).
 */
const CHANGE_VERBS = [
  'make', 'split', 'merge', 'combine', 'consolidate', 'add', 'remove', 'drop',
  'delete', 'keep', 'change', 'rename', 'reorder', 'move', 'reduce', 'increase',
  'use', 'separate', 'group', 'break', 'expand', 'swap', 'replace',
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
 * Does ``text`` carry a substantive CHANGE instruction (beyond the leading verdict
 * word)? True when it contains an imperative change verb ({@link CHANGE_VERBS}) or a
 * numeric-count directive ("2 tasks", "3 sub-issues", "into 4"). Used to tell a
 * bare soft negation ("no", "no thanks", "no, looks wrong") from a negation that
 * asks for a re-plan ("no, make it 3 tasks", "no, just 2 tasks").
 */
function hasChangeInstruction(text: string): boolean {
  if (CHANGE_VERBS.some((v) => hasPhrase(text, v))) return true;
  // Numeric-count directive: a number adjacent to a plan-unit noun, or "just N",
  // "into N" — "no, just 2 tasks" / "3 sub-issues" / "into 4".
  if (/\b\d+\s+(tasks?|sub-?issues?|units?|parts?|pieces?|steps?|prs?)\b/.test(text)) return true;
  if (/\b(just|only|into|to)\s+\d+\b/.test(text)) return true;
  return false;
}

/**
 * Classify an already-parsed comment instruction (only consulted when a pending
 * plan exists on the issue). Four outcomes:
 *  - ``approve`` — a clear go-ahead (natural affirmations included: lgtm/yes/👍/…).
 *  - ``reject``  — an EXPLICIT, unambiguous discard ({@link EXPLICIT_REJECT_PHRASES}
 *    / 👎🛑❌). Discard is the one destructive, irreversible action, so it demands
 *    explicit intent — a bare "no" is NOT enough.
 *  - ``none``    — a change instruction → the revise loop (re-plan). Includes any
 *    LONGER comment (>6 words: an edit request, not a verdict — "no, go back to two
 *    sub-issues …") AND a SHORT soft-negation that carries a change instruction
 *    ("no, make it 3 tasks" — F-reject-revision residual: previously parsed reject
 *    → DELETED the plan).
 *  - ``ambiguous`` — a soft negation with NO change instruction ("no", "no thanks",
 *    "don't approve", "no, looks wrong"): could mean discard OR change. Never
 *    guess-and-destroy — the processor nudges the reviewer to pick.
 *
 * ``reject``/``ambiguous`` precede ``approve`` so a negation that also contains an
 * affirmative word ("don't approve", "not approved") isn't read as approval. A
 * reject EMOJI discards only when it LEADS the comment or appears in a short
 * verdict (review #4(b) — not merely buried in prose). An approve word paired
 * with a contrastive/change qualifier ("yes, but smaller") routes to revise, not
 * approve (review #4(c)). An approve emoji (👍) is honoured regardless of length.
 */
export function parsePlanVerdict(instruction: string): PlanVerdict {
  // Normalize: drop markdown emphasis/backticks, lowercase, collapse whitespace.
  const text = instruction.replace(/[*_`>]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return 'none';

  const wordCount = text.split(' ').length;
  const firstWord = text.split(/[\s.,!?—–-]+/)[0];
  const short = wordCount <= MAX_VERDICT_WORDS;

  // ── DISCARD: explicit destructive intent only ────────────────────────────
  // A discard is irreversible (the plan is gone), so it requires an EXPLICIT kill
  // word — never a bare soft negation.
  //
  // review #4(b): a reject EMOJI now only discards when it is the VERDICT, not
  // merely present. The old ``instruction.includes(❌)`` fired on a long comment
  // that happened to contain ❌ anywhere ("this isn't ❌ a blocker, looks fine")
  // → irreversibly deleting the plan. Require the reject emoji to lead the comment
  // (first non-space char) OR appear in a SHORT (≤6-word) verdict — the same
  // discipline the phrase branches already use.
  const trimmed = instruction.trim();
  const rejectEmojiIsVerdict = REJECT_EMOJI.some((e) => trimmed.startsWith(e))
    || (short && REJECT_EMOJI.some((e) => instruction.includes(e)));
  if (rejectEmojiIsVerdict) return 'reject';
  if (short && EXPLICIT_REJECT_PHRASES.includes(firstWord as (typeof EXPLICIT_REJECT_PHRASES)[number])) return 'reject';
  if (short && EXPLICIT_REJECT_PHRASES.some((p) => hasPhrase(text, p))) return 'reject';

  // ── SOFT NEGATION in a SHORT comment: ambiguous, never destroy ────────────
  // A short soft negation could mean "discard" or "no, change it". If it carries a
  // change instruction (a verb like "make/split" or a count like "2 tasks"), it's
  // a REVISE → ``none`` (routes to the re-plan loop; fixes the F-reject-revision
  // residual ABCA-562 "no, just 2 tasks" that previously fell through to discard).
  // Otherwise it's genuinely ambiguous → ``ambiguous`` (the processor nudges:
  // approve / reject / change).
  //
  // Only SHORT: a LONG comment is already substantive (an edit request) and falls
  // through to ``none`` below — preserving the live-verified QA-1 behavior that
  // "no, I'd rather have three sub-issues: split the API …" REVISES (worded counts
  // like "three" wouldn't match the change-instruction heuristic, so we must NOT
  // route long comments through the ambiguity check or they'd wrongly nudge).
  const softNegationLed =
    SOFT_NEGATION_PHRASES.includes(firstWord as (typeof SOFT_NEGATION_PHRASES)[number])
    || SOFT_NEGATION_PHRASES.some((p) => hasPhrase(text, p));
  if (short && softNegationLed) {
    return hasChangeInstruction(text) ? 'none' : 'ambiguous';
  }

  // ── APPROVE: clear go-ahead, short comment only ──────────────────────────
  // review #4(c): an approve word paired with a substantive change instruction
  // ("yes, but smaller", "ok but split the API layer") is NOT a clean go-ahead —
  // approving would start spending against a plan the reviewer wants changed.
  // Route it to the revise loop (``none``) instead. A pure approve emoji (👍) has
  // no qualifier so it stays a straight approve.
  if (APPROVE_EMOJI.some((e) => instruction.includes(e))) return 'approve';
  const approveLed =
    (short && APPROVE_PHRASES.includes(firstWord as (typeof APPROVE_PHRASES)[number]))
    || (short && APPROVE_PHRASES.some((p) => hasPhrase(text, p)));
  if (approveLed) {
    // A contrastive qualifier ("yes, BUT smaller"; "ok, HOWEVER split it") or an
    // explicit change instruction means the reviewer is NOT cleanly approving the
    // plan as-is — route to revise rather than spend on it. A bare approve
    // ("yes", "lgtm", "approve") has neither → straight approve.
    const hasQualifier = /(^|[^a-z0-9])(but|however|though|although|except)([^a-z0-9]|$)/i.test(text);
    return (hasQualifier || hasChangeInstruction(text)) ? 'none' : 'approve';
  }

  // Anything else (incl. a long non-negation edit request) → revise loop.
  return 'none';
}
