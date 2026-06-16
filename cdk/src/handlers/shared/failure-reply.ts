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
 * #247 UX.5 — "failure is a conversation". Renders the threaded ❌ reply the
 * agent posts beneath a human's ``@bgagent`` comment when the requested
 * iteration does not land cleanly. Two distinct shapes, per the user's design:
 *
 *  - BUILD/TEST failure (the agent ran and opened/updated a PR, but the build
 *    or tests are red): a sanitized ONE-LINE reason pointing at the PR's
 *    checks. We deliberately do NOT dump the raw build output — it's untrusted
 *    repo code and the per-test detail isn't persisted platform-side; the PR's
 *    checks tab is the authoritative, safe place to read it.
 *
 *  - AGENT-ITSELF failure (the agent crashed / timed out / hit a cap before a
 *    clean terminal): the classified one-line title + a TRUNCATED excerpt of
 *    the raw error, plus a pointer to the full CloudWatch logs by task id.
 *
 * Both always end by inviting a reply — the failure reply is answerable, so
 * the user replies ``@bgagent <guidance>`` and the comment trigger re-runs the
 * iteration on the same PR (UX.3). Pure + deterministic; no I/O.
 */

import { classifyError } from './error-classifier';
import { TaskStatus, type TaskStatusType } from '../../constructs/task-status';

/** Max chars of the raw agent error surfaced inline (the rest is in CloudWatch). */
const EXCERPT_MAX = 200;

export interface FailureReplyInput {
  /** Terminal task status (COMPLETED with build_passed=false is a build fail). */
  readonly status: TaskStatusType | string;
  /** Whether the post-change build/tests passed. false ⇒ build/test failure. */
  readonly buildPassed?: boolean | null;
  /** Raw agent error_message, if any (drives the agent-failure classification). */
  readonly errorMessage?: string | null;
  /** Task id — surfaced so the user can find the run in CloudWatch. */
  readonly taskId: string;
}

/**
 * True when the failure is a BUILD/TEST failure (agent completed, PR exists,
 * but the verification gate is red) vs an agent-itself failure. A COMPLETED
 * status with ``build_passed === false`` and NO crash error_message is the
 * build-fail case; anything else terminal-but-not-clean is an agent failure.
 */
function isBuildFailure(input: FailureReplyInput): boolean {
  return (
    input.status === TaskStatus.COMPLETED
    && input.buildPassed === false
    && !input.errorMessage
  );
}

/** Collapse whitespace + clip to EXCERPT_MAX chars with an ellipsis. */
function excerpt(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > EXCERPT_MAX ? `${oneLine.slice(0, EXCERPT_MAX)}…` : oneLine;
}

/**
 * Render the ❌ failure reply body. Best-effort, never throws.
 */
export function renderFailureReply(input: FailureReplyInput): string {
  if (isBuildFailure(input)) {
    // Build/test failure — one line, point at the PR's checks (the safe,
    // authoritative detail surface). No raw output dump.
    return (
      "❌ I made the change, but the build/tests didn't pass — see the PR's "
      + 'checks for details. Reply with guidance and I\'ll try again.'
    );
  }

  // Agent-itself failure: classified title + truncated excerpt + CloudWatch.
  const classification = classifyError(input.errorMessage);
  const title = classification?.title ?? "the task didn't complete";
  const detail = input.errorMessage ? ` ${excerpt(input.errorMessage)}` : '';
  return (
    `❌ ${title} —${detail} see CloudWatch for task \`${input.taskId}\`. `
    + 'Reply with guidance and I\'ll try again.'
  );
}
