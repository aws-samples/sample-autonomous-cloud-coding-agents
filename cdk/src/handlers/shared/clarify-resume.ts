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
 * Clarify-before-spend RESUME (PM-1).
 *
 * A ``coding/new-task-v1`` run can HOLD to ask a clarifying question instead of
 * guessing on a vague issue: it makes no commit, opens no PR, and persists the
 * question as ``answer_text`` with ``code_changed=false``. The fanout dispatcher
 * surfaces that as a 💬 question comment on the Linear issue.
 *
 * The gap this closes: when the user REPLIES to that question (``@bgagent <the
 * answer>``), the standalone comment path found a task with no PR and silently
 * no-op'd — the answer was dropped and the task never resumed. Now we recognise
 * the clarify-HOLD shape and re-dispatch a fresh ``new-task-v1`` carrying the
 * original ask, the question the agent posed, and the user's answer, so the run
 * continues with the missing information.
 *
 * Pure + no I/O so the predicate and the resume-prompt assembly are
 * unit-testable; the processor does the DDB read + ``createTaskCore`` dispatch.
 */

/** The workflow a clarify-HOLD can only originate from (a brand-new task run). */
export const NEW_TASK_WORKFLOW_ID = 'coding/new-task-v1';

/**
 * The subset of a persisted TaskRecord needed to recognise a clarify-HOLD and
 * reconstruct a resume. Read from the BASE table by ``task_id`` (the
 * ``LinearIssueIndex`` GSI does not project ``code_changed`` / ``answer_text`` /
 * ``task_description`` / the workflow pin — only ``pr_url`` and friends).
 */
export interface ClarifyHoldRow {
  readonly resolved_workflow?: { readonly id?: string } | null;
  readonly workflow_ref?: string;
  readonly code_changed?: boolean;
  readonly answer_text?: string;
  readonly task_description?: string;
  readonly pr_url?: string;
  readonly pr_number?: number;
}

/** True when this task ran ``coding/new-task-v1`` (via pin or the raw ref). */
function isNewTaskWorkflow(row: ClarifyHoldRow): boolean {
  const pinned = row.resolved_workflow?.id;
  if (typeof pinned === 'string' && pinned === NEW_TASK_WORKFLOW_ID) return true;
  // Fallback for rows written before the pin, or where only the raw ref exists.
  // ``workflow_ref`` may be a bare ``coding/new-task-v1`` or carry a version.
  return typeof row.workflow_ref === 'string' && row.workflow_ref.startsWith(NEW_TASK_WORKFLOW_ID);
}

/**
 * Recognise the clarify-HOLD shape precisely, so a resume never misfires on:
 *  - a running task (``code_changed`` unset until terminal),
 *  - an ordinary no-change PR iteration (has ``pr_url`` + is ``pr-iteration-v1``),
 *  - a completed task that shipped a PR (``pr_url`` present),
 *  - a plain failure (no ``answer_text``).
 *
 * The distinguishing signature is: a ``new-task-v1`` that finished with
 * ``code_changed===false``, a non-empty ``answer_text`` (the question), and NO
 * PR. See {@link ClarifyHoldRow}.
 */
export function isClarifyHold(row: ClarifyHoldRow | null | undefined): row is ClarifyHoldRow {
  if (!row) return false;
  if (row.code_changed !== false) return false;
  if (typeof row.answer_text !== 'string' || row.answer_text.trim() === '') return false;
  if (typeof row.pr_url === 'string' && row.pr_url.trim() !== '') return false;
  if (typeof row.pr_number === 'number') return false;
  return isNewTaskWorkflow(row);
}

/**
 * Assemble the resume task description: the original ask, the question the agent
 * posed, and the user's answer — so the fresh run has the context that was
 * missing the first time. Order matters: original intent first, then the
 * clarifying exchange, so the agent reads it as "do the original thing, now with
 * this detail resolved".
 *
 * ``question`` is the held ``answer_text``; ``answer`` is the user's reply
 * (already stripped of the ``@bgagent`` mention by the comment parser). A blank
 * original (older rows) degrades to just the exchange.
 */
export function buildClarifyResumeDescription(
  originalDescription: string | undefined,
  question: string | undefined,
  answer: string,
): string {
  const parts: string[] = [];
  const orig = (originalDescription ?? '').trim();
  if (orig) parts.push(orig);
  const q = (question ?? '').trim();
  const a = answer.trim();
  const exchange: string[] = [];
  if (q) exchange.push(`You asked: ${q}`);
  exchange.push(`The reviewer answered: ${a}`);
  parts.push(
    [
      '---',
      'This continues an earlier run that paused to ask a clarifying question.',
      ...exchange,
      'Proceed with the original request using this answer.',
    ].join('\n'),
  );
  return parts.join('\n\n');
}
