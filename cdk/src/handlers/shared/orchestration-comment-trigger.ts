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
