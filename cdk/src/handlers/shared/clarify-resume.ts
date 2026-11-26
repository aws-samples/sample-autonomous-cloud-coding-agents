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

import { MAX_TASK_DESCRIPTION_LENGTH } from './validation';

const NEW_TASK_WORKFLOW_ID = 'coding/new-task-v1';

const EXCHANGE_HEADER = '---\nThis continues an earlier run that paused to ask a clarifying question.';

/**
 * Where the reviewer's later words start in a description: the first block that
 * a comment appended, a clarifying exchange or a follow-up request.
 */
export const APPENDED_BLOCK = /(?:^|\n\n)---\n(?:This continues an earlier run that paused to ask a clarifying question\.|An earlier run on this issue ended without a pull request\.)/;

const LONE_SURROGATE_AT_END = /\p{Surrogate}$/u;

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
export function isNewTaskWorkflow(row: ClarifyHoldRow): boolean {
  const pinned = row.resolved_workflow?.id;
  if (typeof pinned === 'string' && pinned === NEW_TASK_WORKFLOW_ID) return true;
  return typeof row.workflow_ref === 'string' && row.workflow_ref.startsWith(NEW_TASK_WORKFLOW_ID);
}

/**
 * True for a clarify-HOLD: a ``new-task-v1`` that finished with
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
 * Assemble the resume task description: the original ask, then the question the
 * agent posed and the user's answer.
 *
 * ``question`` is the held ``answer_text``; ``answer`` is the user's reply
 * (already stripped of the ``@bgagent`` mention by the comment parser). A blank
 * original degrades to just the exchange.
 *
 * The new exchange and the blocks an earlier description ends with are kept
 * whole. An ask that would push the description past
 * ``MAX_TASK_DESCRIPTION_LENGTH`` is cut at its end, in front of those blocks.
 * When the blocks alone exceed the limit, nothing is cut.
 */
export function buildClarifyResumeDescription(
  originalDescription: string | undefined,
  question: string | undefined,
  answer: string,
): string {
  const q = (question ?? '').trim();
  const a = answer.trim();
  const exchange: string[] = [];
  if (q) exchange.push(`You asked: ${q}`);
  exchange.push(`The reviewer answered: ${a}`);
  const block = [EXCHANGE_HEADER, ...exchange, 'Proceed with the original request using this answer.'].join('\n');

  const original = (originalDescription ?? '').trim();
  const earlierAt = original.search(APPENDED_BLOCK);
  const ask = earlierAt === -1 ? original : original.slice(0, earlierAt);
  const earlier = original.slice(ask.length);
  const room = Math.max(0, MAX_TASK_DESCRIPTION_LENGTH - earlier.length - block.length - 2);
  const fitted = ask.length > room ? ask.slice(0, room).replace(LONE_SURROGATE_AT_END, '').trimEnd() : ask;
  const kept = (fitted + earlier).trim();
  return kept ? `${kept}\n\n${block}` : block;
}
