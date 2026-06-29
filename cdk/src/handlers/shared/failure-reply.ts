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
 *    or tests are red): a sanitized ONE-LINE reason pointing at the agent's
 *    CloudWatch build log. We deliberately do NOT dump the raw build output —
 *    it's untrusted repo code. The pointer is CloudWatch (by task id), NOT the
 *    PR's GitHub checks: the agent runs the configured build (``mise run
 *    build``) INSIDE the microVM, so that output lives in CloudWatch, and the
 *    target repo may have no GitHub CI at all. ("subissues
 *    pass, parent build fails" + "saw nothing in the PR" — the old "see the
 *    PR's checks" copy pointed at the wrong, often-empty surface.)
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
import type { TaskStatusType } from '../../constructs/task-status';

/** Max chars of the raw agent error surfaced inline (the rest is in CloudWatch). */
const EXCERPT_MAX = 200;

export interface FailureReplyInput {
  /** Terminal task status. */
  readonly status: TaskStatusType | string;
  /** Whether the post-change build/tests passed. false ⇒ build/test failure. */
  readonly buildPassed?: boolean | null;
  /** Raw agent error_message, if any (drives the agent-failure classification). */
  readonly errorMessage?: string | null;
  /** Task id — surfaced so the user can find the run in CloudWatch. */
  readonly taskId: string;
}

/**
 * The agent pipeline's signature for "the AGENT finished fine, but the build
 * verification GATE failed" (a build/test regression). Live-verified
 * (2026-06-16): the pipeline gates this to ``status=FAILED`` with
 * ``error_message="Task did not succeed (agent_status='success', build_ok=False)"``
 * and leaves the separate ``build_passed`` attribute null — so the previous
 * ``COMPLETED && build_passed===false`` check NEVER matched a real regression
 * and every build failure fell through to the (wrong) agent-crash copy. We
 * key off the real persisted signal instead. See
 * ``agent/src/pipeline.py`` ``_resolve_overall_task_status`` /
 * ``_apply_post_hook_gates``.
 */
const BUILD_GATE_FAILED_RE = /agent_status=['"]?(success|end_turn)['"]?.*build_ok\s*=\s*(False|timeout)/i;

/**
 * The agent finished cleanly but the build gate failed because the build
 * VERIFICATION TIMED OUT (exceeded ``BUILD_VERIFY_TIMEOUT_S`` and was killed) —
 * a different diagnosis from a genuine red build. ``agent/src/pipeline.py``
 * ``_resolve_overall_task_status`` emits ``build_ok=timeout`` for this case so
 * we render "build timed out" rather than the misleading "build/tests failed"
 * (the build didn't fail — it didn't finish in time; the fix is a faster build
 * or a higher cap, not a code change).
 */
const BUILD_GATE_TIMEOUT_RE = /agent_status=['"]?(success|end_turn)['"]?.*build_ok\s*=\s*timeout/i;

/**
 * True when the failure is a BUILD/TEST failure (the agent completed and a PR
 * exists, but the verification gate is red) vs an agent-itself failure
 * (crash / cap / timeout). Two shapes are accepted:
 *  - the live gating shape: ``error_message`` says ``agent_status='success' …
 *    build_ok=False`` (the agent succeeded; only the build gate failed), OR
 *    ``build_ok=timeout`` (the build gate timed out — also a build-side, not
 *    agent-crash, failure); OR
 *  - the explicit field shape: a terminal task with ``build_passed === false``
 *    and no crash error_message (defensive — e.g. an informational-gate path
 *    that surfaces build_passed directly).
 */
function isBuildFailure(input: Pick<FailureReplyInput, 'buildPassed' | 'errorMessage'>): boolean {
  if (input.errorMessage && BUILD_GATE_FAILED_RE.test(input.errorMessage)) {
    return true;
  }
  return input.buildPassed === false && !input.errorMessage;
}

/** True when the build gate failed specifically because it TIMED OUT (a subset of build failures). */
function isBuildTimeout(input: Pick<FailureReplyInput, 'errorMessage'>): boolean {
  return !!input.errorMessage && BUILD_GATE_TIMEOUT_RE.test(input.errorMessage);
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
  if (isBuildTimeout(input)) {
    // Build verification TIMED OUT — a distinct diagnosis from a red build:
    // the build didn't fail, it didn't finish within the time limit. Say so,
    // so the user fixes the right thing (a slow build / a higher cap), not
    // their code. Still answerable — a reply re-runs it.
    return (
      '❌ I made the change, but the build/tests didn\'t finish in time (timed '
      + `out) — see the build log in CloudWatch for task \`${input.taskId}\`. `
      + "Reply with guidance and I'll try again."
    );
  }
  if (isBuildFailure(input)) {
    // Build/test failure — one line. Point at the agent's CloudWatch build log
    // (by task id), NOT the PR's GitHub checks: the agent ran the configured
    // build inside the microVM, so that's where the failing output is, and the
    // repo may have no GitHub CI. No raw output dump (untrusted repo code).
    return (
      "❌ I made the change, but the build/tests didn't pass — see the build "
      + `log in CloudWatch for task \`${input.taskId}\`. Reply with guidance `
      + "and I'll try again."
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

/**
 * Compose the SHORT one-line failure reason shown as a sub-line under a ❌ row
 * on the parent epic panel (K1). The panel path
 * (``reconcileTerminalChild → refreshPanelAndSettle``) is where a failed node —
 * crucially the SYNTHETIC integration node, which has no Linear sub-issue and
 * therefore no comment-iteration reply — would otherwise surface as a bare
 * "❌ … — failed" with no reason and no pointer. This gives the user the one
 * thing they need to debug: WHAT failed (build vs agent-crash) and WHERE to
 * read it (CloudWatch by task id).
 *
 * Same security stance as {@link renderFailureReply}: classified reason + task
 * id only, never the raw (untrusted) build output. Returns null when there's no
 * task id to point at (nothing actionable to render). ``isIntegration`` tailors
 * the build-failure wording to name the merge — the integration node's failure
 * is specifically "the combined build after merging the sub-issue branches",
 * which is the exact failure mode reported and the panel must make legible.
 */
export function renderPanelFailureReason(input: {
  readonly buildPassed?: boolean | null;
  readonly errorMessage?: string | null;
  readonly taskId?: string;
  readonly isIntegration?: boolean;
}): string | null {
  if (!input.taskId) return null;
  if (isBuildTimeout(input)) {
    // Distinct from a red build: the build didn't finish within the time limit.
    const what = input.isIntegration
      ? 'Combined build timed out after merging the sub-issue branches'
      : 'Build/tests timed out';
    return `${what} — see the build log in CloudWatch for task \`${input.taskId}\`.`;
  }
  if (isBuildFailure(input)) {
    const what = input.isIntegration
      ? 'Combined build failed after merging the sub-issue branches'
      : 'Build/tests failed';
    return `${what} — see the build log in CloudWatch for task \`${input.taskId}\`.`;
  }
  const classification = classifyError(input.errorMessage);
  const title = classification?.title ?? "the task didn't complete";
  return `${title} — see CloudWatch for task \`${input.taskId}\`.`;
}
