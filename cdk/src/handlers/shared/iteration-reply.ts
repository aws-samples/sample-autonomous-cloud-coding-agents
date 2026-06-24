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

/**
 * The maturing iteration reply (iteration-UX redesign). One threaded reply per
 * ``@bgagent`` comment that EDITS IN PLACE through these states instead of
 * posting ~5 separate top-level comments per round. Mirrors the #247 epic panel.
 *
 *  - ``on_it``    — posted synchronously at trigger time (kills the silence).
 *  - ``working``  — the agent opened/updated the PR (pr_created milestone).
 *  - ``updated``  — terminal success WITH a commit → the ✅ + cost + total.
 *  - ``answered`` — terminal success, NO commit (a question) → 💬 + the answer.
 *  - ``failed``   — terminal failure.
 */
export type IterationState = 'on_it' | 'working' | 'updated' | 'answered' | 'failed';

export interface MaturingReplyInput {
  readonly state: IterationState;
  readonly prNumber?: number | null;
  /** Full PR URL — makes the "PR #N" reference a clickable link when present. */
  readonly prUrl?: string | null;
  /** Agent's answer (answered state). */
  readonly answerText?: string;
  /** This iteration's cost (USD) — shown on terminal states. */
  readonly costUsd?: number | null;
  /** Wall-clock seconds for this iteration — shown on terminal states. */
  readonly durationS?: number | null;
  /** Cumulative cost across ALL iterations on this PR/issue (incl. this one). */
  readonly runningTotalUsd?: number | null;
  /**
   * Captured deploy-preview screenshot PNG (our CloudFront URL). Embedded as a
   * clickable image thumbnail in the reply when present, NOT a standalone comment.
   */
  readonly screenshotUrl?: string | null;
  /**
   * Live deploy URL (the Vercel/preview site). When present, the embedded
   * screenshot links to it ({@link renderPreviewBlock}). MUST be markdown-escaped
   * by the caller (payload-derived).
   */
  readonly deployUrl?: string | null;
  /** Sanitized failure reason (failed state). */
  readonly failureReason?: string;
}

/**
 * The deploy-preview block folded into a maturing reply: the captured screenshot
 * PNG embedded as an image, made CLICKABLE to the live deploy when the deploy URL
 * is known (the user picked the clickable-thumbnail UX over a bare text link).
 *  - both urls → ``[![preview](screenshot.png)](deploy)`` (image links to deploy)
 *  - screenshot only → ``![preview](screenshot.png)`` (plain embed, no link target)
 *  - no screenshot → '' (nothing to show)
 * ``screenshotUrl`` is our own CloudFront key (no parens) so it's safe as-is;
 * ``deployUrl`` is payload-derived, so callers MUST pass it already
 * markdown-escaped (see ``encodeMarkdownUrl``) to avoid a link-breakout. Pure.
 */
export function renderPreviewBlock(
  screenshotUrl: string | null | undefined,
  deployUrl?: string | null,
): string {
  if (!screenshotUrl) return '';
  return deployUrl
    ? `[![preview](${screenshotUrl})](${deployUrl})`
    : `![preview](${screenshotUrl})`;
}

/** Format a USD cost as "$X.XX", or "" when unknown. */
function usd(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
}

/** Compact "Ns"/"Nm Ns" duration, or "" when unknown. */
function dur(s: number | null | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Render the maturing iteration reply for a given {@link IterationState}. Pure.
 * The metadata line (cost · duration · running total) appears only on terminal
 * states and only for the fields that are known. The screenshot is a link, not
 * an embed, so the reply stays compact across many rounds.
 */
export function renderMaturingReply(input: MaturingReplyInput): string {
  const meta = terminalMetaLine(input);
  // Clickable image thumbnail (screenshot PNG → live deploy), on its own block.
  const previewBlock = renderPreviewBlock(input.screenshotUrl, input.deployUrl);

  const prRef = prReference(input.prNumber, input.prUrl);
  switch (input.state) {
    case 'on_it':
      return '👀 On it — reading the PR…';
    case 'working':
      return prRef ? `🔄 Working — updating ${prRef}…` : '🔄 Working…';
    case 'updated': {
      const head = prRef ? `✅ Updated — ${prRef}.` : '✅ Updated.';
      // headline + metadata, then the embedded preview thumbnail on its own line.
      const lines = [meta ? `${head}\n${meta}` : head];
      if (previewBlock) lines.push(previewBlock);
      return lines.join('\n\n');
    }
    case 'answered': {
      const answer = (input.answerText ?? '').trim();
      const head = answer
        ? `💬 ${truncate(answer, MAX_ANSWER_CHARS)}`
        : '💬 No code change was needed — nothing to update on this PR.';
      return meta ? `${head}\n${meta}` : head;
    }
    case 'failed': {
      const reason = (input.failureReason ?? '').trim();
      const head = reason ? `❌ ${truncate(reason, MAX_ANSWER_CHARS)}` : '❌ The iteration failed.';
      return meta ? `${head}\n${meta}` : head;
    }
  }
}

/** A clickable "[PR #N](url)" when the url is known, else plain "PR #N", else "". */
function prReference(prNumber: number | null | undefined, prUrl: string | null | undefined): string {
  if (prNumber == null) return '';
  return prUrl ? `[PR #${prNumber}](${prUrl})` : `PR #${prNumber}`;
}

/** "cost: $X · 2m 3s · total this PR: $Y" — only the known parts. */
function terminalMetaLine(input: MaturingReplyInput): string {
  const parts: string[] = [];
  const c = usd(input.costUsd);
  if (c) parts.push(c);
  const d = dur(input.durationS);
  if (d) parts.push(d);
  const t = usd(input.runningTotalUsd);
  if (t) parts.push(`total this PR: ${t}`);
  return parts.length ? `_${parts.join(' · ')}_` : '';
}

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

/**
 * Matches a preview block folded onto a matured reply, in either shape
 * {@link renderPreviewBlock} emits: a clickable thumbnail
 * ``[![preview](png)](deploy)`` or a plain embed ``![preview](png)``. Captures
 * the whole block so convergence re-attaches it verbatim (image + deploy link).
 */
const PREVIEW_BLOCK_RE = /\[?!\[preview\]\([^)\s]+\)(?:\]\([^)\s]+\))?/;

/**
 * iteration-UX convergence: the deploy-preview block and the terminal-settle of
 * a maturing reply are written by two INDEPENDENT async paths (the screenshot
 * webhook appends the ``![preview]`` block; the fanout/reconciler terminal-settle
 * re-renders the whole reply body) with no ordering guarantee. Whichever runs
 * last wins, so a terminal re-render would silently drop a preview the webhook
 * already appended (live-caught on ABCA-434: appended 18:56:09, clobbered by the
 * terminal edit 18:56:23). This makes the edit path CONVERGE rather than
 * overwrite: if ``currentBody`` already carries a ``[preview]`` block and the
 * freshly-rendered ``newBody`` does not, carry that exact block onto the new body
 * on its own line. Pure; idempotent (a no-op when newBody already has its own
 * preview or currentBody has none).
 */
export function preservePreviewSuffix(newBody: string, currentBody: string | null | undefined): string {
  if (typeof currentBody !== 'string') return newBody;
  if (newBody.includes('[preview]')) return newBody; // new render already carries one
  const block = currentBody.match(PREVIEW_BLOCK_RE)?.[0];
  if (!block) return newBody;
  return `${newBody}\n\n${block}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
