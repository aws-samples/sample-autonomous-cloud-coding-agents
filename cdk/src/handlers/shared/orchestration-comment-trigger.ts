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

export interface CommentTrigger {
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
 * Rules:
 *  - Must contain ``@bgagent`` (case-insensitive), as a token boundary so
 *    ``@bgagentx`` / an email-like ``foo@bgagent.io`` do NOT trigger. A mention
 *    that ends a sentence (``… onto main, @bgagent.``) does.
 *  - The instruction is everything after stripping the token (all occurrences),
 *    trimmed, with its line breaks and indentation kept. A bare ``@bgagent``
 *    with no text still triggers (instruction === '').
 */
export function parseCommentTrigger(body: string | undefined | null): CommentTrigger {
  if (!body) return { triggered: false, instruction: '' };
  if (isBotAuthoredComment(body)) return { triggered: false, instruction: '' };
  const re = / ?@bgagent(?!\w|\.\w)\.* ?/gi;
  if (!re.test(body)) return { triggered: false, instruction: '' };
  // replace() restarts a global pattern from index 0, whatever test() left.
  const instruction = body.replace(re, ' ').trim();
  return { triggered: true, instruction };
}

const BOT_COMMENT_PREFIXES = [
  '👋',
  '✅',
  '❌',
  '⚠️',
  '🔄',
  '🤖',
  '🖼️',
  '🔗',
  '🗂️',
  '💬',
  '👀',
] as const;

export function isBotAuthoredComment(body: string): boolean {
  const trimmed = body.trimStart();
  return BOT_COMMENT_PREFIXES.some((p) => trimmed.startsWith(p));
}

const NEAR_MISS_MENTION_PATTERNS: readonly RegExp[] = [
  /@abca\b/i,
  /@bgagent\w/i,
  /@bg[-_]agent\b/i,
  /@bg[-_]?bot\b/i,
  /@background[-_]?agent\b/i,
];

/**
 * Detect a NEAR-MISS bot mention: the reviewer clearly meant to
 * address the bot but used the wrong handle (``@abca``, ``@bgagentx``, …), so
 * {@link parseCommentTrigger} didn't fire. Skips the bot's own comments.
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

/** The instruction for an iteration on the COMBINED PR of an integration node. */
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

const MAX_COMMAND_WORDS = 6;

function isAlnum(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
}

function hasPhrase(text: string, phrase: string): boolean {
  const hay = text.toLowerCase();
  const needle = phrase.toLowerCase();
  if (!needle) return false;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!isAlnum(hay[i - 1]) && !isAlnum(hay[i + needle.length])) return true;
  }
  return false;
}

/**
 * Does an ``@bgagent`` comment read as a RETRY request —
 * "re-run the work that failed" — rather than a change instruction?
 *
 * Only fires when the instruction is a SHORT
 * (≤{@link MAX_COMMAND_WORDS}-word) comment that contains a retry phrase. An
 * empty instruction (bare ``@bgagent``) is NOT a retry.
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

/** The command words ABCA recognises in an ``@bgagent`` comment on an epic. */
export const KNOWN_EPIC_COMMANDS = ['retry'] as const;
