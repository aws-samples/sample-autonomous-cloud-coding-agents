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
 * Pure renderer for the success reply to an ``@bgagent`` comment-iteration
 * (A6/#299 — the question-vs-edit fix).
 *
 * Background: every ``@bgagent`` comment on a PR-bearing issue spawns a
 * ``coding/pr-iteration-v1`` task. When that task completes + builds, the
 * platform replied "✅ Updated — PR #N" UNCONDITIONALLY — even when the comment
 * was a QUESTION ("where is the login page?") and the agent made no commit. That
 * read as a false success: a "✅ Updated" with nothing updated and the question
 * unanswered.
 *
 * The agent now persists ``code_changed`` (did the branch HEAD advance?) and,
 * on a no-change run, ``answer_text`` (its reply to the question). This renderer
 * branches on that:
 *   - code changed (or unknown — back-compat) → "✅ Updated — PR #N." (as before)
 *   - no code changed                         → "💬 <answer>" (no false ✅)
 *
 * Pure + no I/O so both settle paths (the standalone fanout reply and the
 * orchestration reconciler) render identically and it is unit-testable.
 */

/** Max chars of the agent's answer surfaced inline before truncation. */
const MAX_ANSWER_CHARS = 1500;

export interface IterationReplyInput {
  /**
   * Did the iteration advance the PR branch (a real commit landed)?
   *  - ``true``      → a normal edit; render the "✅ Updated" success.
   *  - ``false``     → a no-op iteration (a question / nothing to change).
   *  - ``undefined`` → unknown (pre-fix task, non-PR workflow, or the agent
   *                    couldn't read the baseline). Treated as ``true`` so
   *                    behaviour is unchanged for anything that doesn't opt in.
   */
  readonly codeChanged?: boolean;
  /** The PR number, when resolvable (only used on the changed path). */
  readonly prNumber?: number | null;
  /** The agent's final answer text, surfaced on the no-change path. */
  readonly answerText?: string;
}

/**
 * Render the reply for a SUCCESSFUL (completed + build-passing) iteration.
 * (Failures are rendered by the existing ``renderFailureReply`` — this is only
 * the success branch, which is where the false-"✅ Updated" lived.)
 */
export function renderIterationSuccessReply(input: IterationReplyInput): string {
  const noChange = input.codeChanged === false;

  if (noChange) {
    const answer = (input.answerText ?? '').trim();
    if (answer) {
      return `💬 ${truncate(answer, MAX_ANSWER_CHARS)}`;
    }
    // No commit AND no captured answer — be honest that nothing changed rather
    // than claim an update. (Rare: the agent settled without a result text.)
    return '💬 No code change was needed — nothing to update on this PR.';
  }

  // Changed (or unknown → back-compat): the existing success ack.
  return typeof input.prNumber === 'number'
    ? `✅ Updated — PR #${input.prNumber}.`
    : '✅ Updated.';
}

/** True when this is a no-change iteration (drives the 👀→💬 reaction choice). */
export function isNoChangeIteration(codeChanged?: boolean): boolean {
  return codeChanged === false;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
