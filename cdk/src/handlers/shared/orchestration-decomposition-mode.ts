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
 * Pure label-mode parsing for the #299 Mode B decomposition planner (B1).
 *
 * #247 (Mode A) reads a *human-authored* sub-issue graph and runs it. #299
 * (Mode B) lets a single, undecomposed issue be auto-decomposed by an LLM
 * planner into that graph first. The two are selected by which trigger label
 * is on the issue:
 *
 *   - ``bgagent``            — today's behaviour. No sub-issues → single task;
 *                              already has sub-issues → run the graph (Mode A).
 *   - ``bgagent:decompose``  — decompose, then POST a plan and WAIT for
 *                              ``@bgagent approve`` (the spend-safe default).
 *   - ``bgagent:auto``       — decompose and run immediately (no approval gate).
 *
 * The decompose suffixes only mean something on an *undecomposed* issue: you
 * cannot decompose what is already a graph, so a ``:decompose`` / ``:auto``
 * suffix on a parent that already has sub-issues is a no-op and falls back to
 * Mode A (#299: "On a parent that already has sub-issues the suffix is a
 * no-op → falls back to the #247 executor").
 *
 * Kept pure (no I/O, no Linear/AWS types) so the routing decision is
 * unit-testable in isolation; the webhook processor does the I/O (resolve the
 * label filter from the project mapping, check for sub-issues, dispatch).
 */

/** The base trigger label when a project doesn't override ``label_filter``. */
export const DEFAULT_LABEL_FILTER = 'bgagent';

/** Suffix (after ``:``) that requests decompose-then-approve. */
export const DECOMPOSE_SUFFIX = 'decompose';
/** Suffix (after ``:``) that requests decompose-then-auto-run. */
export const AUTO_SUFFIX = 'auto';

/**
 * What the webhook processor should do for a triggered Linear issue.
 *
 *  - ``none``      — no trigger label present at all; ignore the event. (A
 *                    pure-function total-ness guard; the processor's
 *                    label-transition gate normally rules this out first.)
 *  - ``single``    — base label, no sub-issues → today's single task.
 *  - ``mode_a``    — base label (or a decompose suffix, see above) on an issue
 *                    that ALREADY has sub-issues → run the existing graph.
 *  - ``decompose`` — decompose suffix on an undecomposed issue → propose a
 *                    plan and wait for approval.
 *  - ``auto``      — auto suffix on an undecomposed issue → decompose + run.
 */
export type DecompositionMode = 'none' | 'single' | 'mode_a' | 'decompose' | 'auto';

export interface DecompositionDecision {
  readonly mode: DecompositionMode;
  /**
   * The label that matched (lower-cased), for logging / the plan comment.
   * Empty when ``mode === 'none'``.
   */
  readonly matchedLabel: string;
  /**
   * True when a decompose suffix was present on the issue but was SUPPRESSED
   * because the issue already has sub-issues (→ ``mode_a``). Surfaced so the
   * processor can post a one-line note ("already decomposed; running the
   * existing graph") instead of silently ignoring the user's stated intent.
   */
  readonly suffixSuppressed: boolean;
}

/** Normalise a label name for comparison: trim + lower-case. */
function norm(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Decide the orchestration mode from the labels on a Linear issue.
 *
 * @param labelNames  All label names currently on the issue (any case).
 * @param hasSubIssues  Whether the issue already has child sub-issues.
 * @param labelFilter  The project's base trigger label (default ``bgagent``).
 *
 * Precedence when more than one trigger variant is present (user error, but
 * we must be deterministic): the SPEND-SAFE choice wins. ``:decompose``
 * (requires approval) beats ``:auto`` (auto-spends) beats the bare base label.
 * This guarantees an ambiguous label set never silently auto-runs N agents.
 */
export function parseDecompositionMode(
  labelNames: readonly (string | undefined | null)[],
  hasSubIssues: boolean,
  labelFilter: string = DEFAULT_LABEL_FILTER,
): DecompositionDecision {
  const base = norm(labelFilter) || DEFAULT_LABEL_FILTER;
  const decomposeLabel = `${base}:${DECOMPOSE_SUFFIX}`;
  const autoLabel = `${base}:${AUTO_SUFFIX}`;

  const present = new Set(labelNames.map(norm).filter((n) => n.length > 0));

  const hasDecompose = present.has(decomposeLabel);
  const hasAuto = present.has(autoLabel);
  const hasBase = present.has(base);

  // No trigger variant at all → ignore (total-ness guard).
  if (!hasDecompose && !hasAuto && !hasBase) {
    return { mode: 'none', matchedLabel: '', suffixSuppressed: false };
  }

  // A decompose suffix is meaningful ONLY on an undecomposed issue. On an
  // existing graph the suffix is a no-op → Mode A (run the human/earlier graph).
  if (hasDecompose || hasAuto) {
    const matchedLabel = hasDecompose ? decomposeLabel : autoLabel;
    if (hasSubIssues) {
      // Suffix suppressed: the issue is already decomposed. Run the graph.
      return { mode: 'mode_a', matchedLabel, suffixSuppressed: true };
    }
    // Spend-safe precedence: decompose (approval-gated) wins over auto.
    return { mode: hasDecompose ? 'decompose' : 'auto', matchedLabel, suffixSuppressed: false };
  }

  // Bare base label: existing graph → Mode A; otherwise a single task.
  return {
    mode: hasSubIssues ? 'mode_a' : 'single',
    matchedLabel: base,
    suffixSuppressed: false,
  };
}

/**
 * All trigger label variants for a given base filter, lower-cased. The webhook
 * processor's trigger gate must match ANY of these (not just the bare base),
 * or a ``bgagent:decompose``-only issue would never fire. (B6 uses this.)
 */
export function triggerLabelVariants(labelFilter: string = DEFAULT_LABEL_FILTER): readonly string[] {
  const base = norm(labelFilter) || DEFAULT_LABEL_FILTER;
  return [base, `${base}:${DECOMPOSE_SUFFIX}`, `${base}:${AUTO_SUFFIX}`];
}
