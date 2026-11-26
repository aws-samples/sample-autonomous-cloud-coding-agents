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

const MAX_ANSWER_CHARS = 2000;

const HEARTBEAT_ELAPSED_FLOOR_S = 90;

const PROGRESS_NOTE_MAX = 80;

function workingLivenessSuffix(
  elapsedS: number | null | undefined,
  progressNote: string | undefined,
): string {
  const e = dur(elapsedS);
  const showElapsed =
    typeof elapsedS === 'number' && Number.isFinite(elapsedS) && elapsedS >= HEARTBEAT_ELAPSED_FLOOR_S;
  const note = (progressNote ?? '').replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  if (showElapsed && e) parts.push(`${e} elapsed`);
  if (note) parts.push(truncate(note, PROGRESS_NOTE_MAX));
  return parts.length ? `_${parts.join(' · ')}_` : '';
}

/**
 * The maturing iteration reply. One threaded reply per
 * ``@bgagent`` comment that EDITS IN PLACE through these states.
 *
 *  - ``on_it``    — posted synchronously at trigger time.
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
   * True when {@link runningTotalUsd} is known to be INCOMPLETE — the row cap was
   * hit or a read failed partway. Renders as "at least $X".
   */
  readonly runningTotalPartial?: boolean;
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
  /**
   * Liveness heartbeat: seconds elapsed since the task started, shown on the
   * ``working`` state. Only rendered from a small floor up (a just-started task
   * shows the plain "Working…" line). Distinct from ``durationS`` (a TERMINAL
   * total).
   */
  readonly elapsedS?: number | null;
  /**
   * Short, sanitized latest-progress hint from the agent's most recent
   * milestone (e.g. "running build verification"). Optional; appended to the
   * working line when present. Caller MUST pre-sanitize (it's agent-derived).
   */
  readonly progressNote?: string;
}

/**
 * The deploy-preview block folded into a maturing reply: the captured screenshot
 * PNG embedded as an image, made CLICKABLE to the live deploy when the deploy URL
 * is known.
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

function usd(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
}

function dur(s: number | null | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return '';
  const total = Math.round(s);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const rem = total % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Render the maturing iteration reply for a given {@link IterationState}. Pure.
 * The metadata line (cost · duration · running total) appears only on terminal
 * states and only for the fields that are known.
 */
export function renderMaturingReply(input: MaturingReplyInput): string {
  const meta = terminalMetaLine(input);
  const previewBlock = renderPreviewBlock(input.screenshotUrl, input.deployUrl);

  const prRef = prReference(input.prNumber, input.prUrl);
  switch (input.state) {
    case 'on_it':
      return '👀 On it — reading the PR…';
    case 'working': {
      const base = prRef ? `🔄 Working — updating ${prRef}…` : '🔄 Working…';
      const live = workingLivenessSuffix(input.elapsedS, input.progressNote);
      return live ? `${base}\n${live}` : base;
    }
    case 'updated': {
      const head = prRef ? `✅ Updated — ${prRef}.` : '✅ Updated.';
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

function prReference(prNumber: number | null | undefined, prUrl: string | null | undefined): string {
  if (prNumber == null) return '';
  return prUrl ? `[PR #${prNumber}](${prUrl})` : `PR #${prNumber}`;
}

function terminalMetaLine(input: MaturingReplyInput): string {
  const parts: string[] = [];
  const c = usd(input.costUsd);
  if (c) parts.push(c);
  const d = dur(input.durationS);
  if (d) parts.push(d);
  const t = usd(input.runningTotalUsd);
  if (t) parts.push(`total this PR: ${input.runningTotalPartial ? `at least ${t}` : t}`);
  return parts.length ? `_${parts.join(' · ')}_` : '';
}

export interface IterationReplyInput {
  /**
   * Did the iteration advance the PR branch (a real commit landed)?
   *  - ``true``      → a normal edit; render the "✅ Updated" success.
   *  - ``false``     → a no-op iteration (a question / nothing to change).
   *  - ``undefined`` → unknown (non-PR workflow, or the agent couldn't read
   *                    the baseline). Treated as ``true``.
   */
  readonly codeChanged?: boolean;
  /** The PR number, when resolvable (only used on the changed path). */
  readonly prNumber?: number | null;
  /** The agent's final answer text, surfaced on the no-change path. */
  readonly answerText?: string;
}

/** Render the reply for a SUCCESSFUL (completed + build-passing) iteration. */
export function renderIterationSuccessReply(input: IterationReplyInput): string {
  const noChange = input.codeChanged === false;

  if (noChange) {
    const answer = (input.answerText ?? '').trim();
    if (answer) {
      return `💬 ${truncate(answer, MAX_ANSWER_CHARS)}`;
    }
    return '💬 No code change was needed — nothing to update on this PR.';
  }

  return typeof input.prNumber === 'number'
    ? `✅ Updated — PR #${input.prNumber}.`
    : '✅ Updated.';
}

export function isNoChangeIteration(codeChanged?: boolean): boolean {
  return codeChanged === false;
}

const PREVIEW_BLOCK_RE = /\[?!\[preview\]\([^)\s]+\)(?:\]\([^)\s]+\))?/;

/**
 * Converge two independent writers of the same reply body (the screenshot
 * webhook appends the preview block; the terminal settle re-renders the whole
 * body): if ``currentBody`` already carries a ``[preview]`` block and the
 * freshly-rendered ``newBody`` does not, carry that exact block onto the new body
 * on its own line. Pure; idempotent (a no-op when newBody already has its own
 * preview or currentBody has none).
 */
export function preservePreviewSuffix(newBody: string, currentBody: string | null | undefined): string {
  if (typeof currentBody !== 'string') return newBody;
  if (newBody.includes('[preview]')) return newBody;
  const block = currentBody.match(PREVIEW_BLOCK_RE)?.[0];
  if (!block) return newBody;
  return `${newBody}\n\n${block}`;
}

const TERMINAL_REPLY_MARKERS: readonly string[] = ['✅', '💬', '❌'];

/**
 * Does this reply body already show a terminal outcome (✅ updated, 💬 answered,
 * ❌ failed)? Only a known terminal lead marker counts, so an unrecognised body
 * is treated as NOT settled.
 */
export function isTerminalMaturingReply(body: string | null | undefined): boolean {
  if (typeof body !== 'string') return false;
  const lead = body.trimStart();
  return TERMINAL_REPLY_MARKERS.some((marker) => lead.startsWith(marker));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
