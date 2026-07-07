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
 * #299 Mode B — the decomposition PLAN PARSER + validator (B3 core).
 *
 * #299 agent-native planning: the two-stage inline Bedrock planner (a critical
 * assessor + a decomposer, called from the webhook Lambda) was RETIRED. Planning
 * now runs inside a ``coding/decompose-v1`` agent task that clones the repo and
 * plans with FULL context (root-fixing ABCA-490's 30s Lambda ceiling + ABCA-492's
 * repo-blindness), emitting the plan JSON as an artifact. The reconciler reads
 * that artifact and feeds its text to {@link parseDecomposerResponse} here.
 *
 * What survives is the PURE parse/validate core the reconciler reuses — it never
 * invoked Bedrock and is unchanged by the migration:
 *  - {@link parseDecomposerResponse} — parse a plan JSON (markdown/prose tolerant),
 *    collapse <2 nodes to single_task, validate the graph is a DAG.
 *  - **Budget is derived from size, not asked of the model.** S/M/L → a fixed
 *    per-child ``max_budget_usd`` ({@link SIZE_DEFAULT_BUDGET_USD}), so Σ is a
 *    stable, explainable worst-case ceiling.
 *  - **Edges are indices, validated as a DAG.** ``depends_on: number[]`` into the
 *    plan's own ``sub_issues`` array (no Linear ids exist yet — minted at
 *    write-back, B5). Mapped to synthetic ids and run through {@link validateDag}
 *    so a cycle / dangling / dup is rejected here.
 */

import { logger } from './logger';
import { validateDag, type DagNode } from './orchestration-dag';
import {
  type DecompositionPlan,
  type PlannedSubIssue,
  type SubIssueSize,
} from './orchestration-decomposition-types';

/**
 * Per-size worst-case spend ceiling (USD). The plan's cost ceiling is Σ of
 * these over the proposed children. Conservative ceilings, not estimates —
 * a child rarely spends its whole budget. Threaded onto the child task's
 * ``max_budget_usd`` at release so a runaway child is capped.
 */
export const SIZE_DEFAULT_BUDGET_USD: Readonly<Record<SubIssueSize, number>> = {
  S: 1,
  M: 3,
  L: 6,
};

/** Discriminated outcome of parsing a decomposition plan. */
export type DecompositionResult =
  // The plan had <2 nodes → single task. ``reasoning`` is the plan's own
  // rationale (surfaced so the user sees WHY it wasn't split, even when asked).
  | { readonly kind: 'single_task'; readonly reasoning: string }
  // A valid, DAG-checked plan ready to gate against caps + render. ``repoDigest``
  // (#299 plan-mode T2) is the agent's reusable structural summary of the repo —
  // persisted on the pending-plan row and fed back into a later revise run so it
  // starts from this understanding instead of re-exploring. Absent on older
  // agents / when the field wasn't emitted.
  | { readonly kind: 'plan'; readonly plan: DecompositionPlan; readonly repoDigest?: string; readonly repoDigestSha?: string }
  // The plan text was unusable or self-contradictory (unparseable / invalid DAG).
  | { readonly kind: 'error'; readonly message: string };

/** #299 plan-mode T2: cap the persisted digest so a runaway blob can't bloat the
 *  pending-plan row (DDB item limit) or the next prompt. Generous vs the prompt's
 *  ~1500-char guidance; a longer digest is truncated with an honest marker. */
const MAX_REPO_DIGEST_CHARS = 4000;

/**
 * Parse + validate a decomposition plan's raw JSON into a {@link DecompositionResult}.
 * Pure. Handles markdown-fenced or prose-wrapped JSON (the ``coding/decompose-v1``
 * agent is told to emit bare JSON, but tolerate fences/prose); a <2-node breakdown
 * collapses to single_task (nothing to orchestrate); rejects self-contradictory
 * graphs (cycle / dangling / duplicate) via {@link validateDag}. ``fallbackReasoning``
 * is used as the single-task note when the breakdown collapses to one node and the
 * plan itself carried no ``reasoning`` (the reconciler passes '').
 */
export function parseDecomposerResponse(
  raw: string,
  maxSubIssues: number,
  fallbackReasoning: string,
): DecompositionResult {
  const obj = extractJsonObject(raw);
  if (!obj) {
    return { kind: 'error', message: 'The planner returned a response that could not be parsed as a plan.' };
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
  const rawNodes = Array.isArray(obj.sub_issues) ? obj.sub_issues : [];
  // #299 plan-mode T2: the agent's reusable structural summary of the repo. Only
  // carried on a plan (a single-task decline has nothing to re-plan against).
  // Capped so it can't bloat the DDB row / next prompt.
  const rawDigest = typeof obj.repo_digest === 'string' ? obj.repo_digest.trim() : '';
  const repoDigest = rawDigest.length > MAX_REPO_DIGEST_CHARS
    ? `${rawDigest.slice(0, MAX_REPO_DIGEST_CHARS)}\n…(truncated)`
    : rawDigest;
  // The repo HEAD sha the agent cloned to (echoed from the {repo_head_sha} the
  // prompt injected). Travels with the digest so the next run can drift-check.
  // Basic hex-sha shape guard so a hallucinated value can't poison the key.
  const rawSha = typeof obj.repo_digest_sha === 'string' ? obj.repo_digest_sha.trim() : '';
  const repoDigestSha = /^[0-9a-f]{7,40}$/i.test(rawSha) ? rawSha : '';

  // The plan has nothing worth orchestrating (<2 nodes) → single task.
  if (rawNodes.length < 2) {
    return {
      kind: 'single_task',
      reasoning: fallbackReasoning || reasoning || 'Single cohesive change — running as one task.',
    };
  }

  if (rawNodes.length > maxSubIssues) {
    // The model overshot the guidance. Don't silently truncate (drops edges);
    // surface so caps-handling (B2) reports it as over-cap with a clear message.
    // We still build the plan so the caller can show what was proposed.
    logger.info('Decomposition planner proposed more sub-issues than the cap', {
      proposed: rawNodes.length,
      cap: maxSubIssues,
    });
  }

  const nodes: PlannedSubIssue[] = [];
  for (let i = 0; i < rawNodes.length; i++) {
    const node = parseNode(rawNodes[i], i, rawNodes.length);
    if (!node) {
      return { kind: 'error', message: `The planner's sub-issue #${i + 1} was malformed.` };
    }
    nodes.push(node);
  }

  // Validate the proposed graph is a DAG by mapping indices → synthetic ids.
  const dagNodes: DagNode[] = nodes.map((n, i) => ({
    id: `n${i}`,
    depends_on: n.depends_on.map((d) => `n${d}`),
  }));
  const validation = validateDag(dagNodes);
  if (!validation.ok) {
    logger.warn('Decomposition planner produced an invalid graph', {
      reason: validation.reason,
      offending: validation.offendingIds,
    });
    return {
      kind: 'error',
      message: `The proposed plan was not a valid dependency graph (${validation.reason}).`,
    };
  }

  return {
    kind: 'plan',
    plan: { shouldDecompose: true, reasoning, nodes },
    ...(repoDigest && { repoDigest }),
    ...(repoDigest && repoDigestSha && { repoDigestSha }),
  };
}

/** Parse + validate one raw sub-issue node. Returns null when malformed. */
function parseNode(raw: unknown, index: number, total: number): PlannedSubIssue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!title) return null;

  const description = typeof r.description === 'string' ? r.description.trim() : '';
  const size = normalizeSize(r.size);

  // depends_on must be in-range, integer, deduped, and not self-referential.
  const depends_on: number[] = [];
  if (Array.isArray(r.depends_on)) {
    for (const d of r.depends_on) {
      const n = typeof d === 'number' ? d : Number(d);
      if (!Number.isInteger(n) || n < 0 || n >= total || n === index) continue;
      if (!depends_on.includes(n)) depends_on.push(n);
    }
  }

  return {
    title,
    description: description || title,
    size,
    max_budget_usd: SIZE_DEFAULT_BUDGET_USD[size],
    depends_on,
  };
}

/** Coerce an arbitrary size value to S/M/L, defaulting to M. */
function normalizeSize(v: unknown): SubIssueSize {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (s === 'S' || s === 'M' || s === 'L') return s;
  return 'M';
}

/** A parsed object "looks like a plan" if it carries any of the plan keys. Used
 *  to pick the RIGHT object out of a message that also contains other JSON-ish
 *  braces (e.g. inline CSS ``.nav { … }`` in the agent's prose findings — live-
 *  caught on ABCA-504, where the first ``{`` was CSS, not the plan). */
function looksLikePlan(obj: Record<string, unknown>): boolean {
  return 'decompose' in obj || 'sub_issues' in obj || 'reasoning' in obj;
}

/**
 * Extract the decomposition-plan JSON object from a model/agent completion.
 * Tolerates markdown fences and leading/trailing prose. The agent's message may
 * contain OTHER brace groups before the plan (prose that quotes CSS/code), so we
 * do NOT just balance from the first ``{``: we scan every top-level object and
 * return the LAST one that both parses AND looks like a plan (the emitted answer
 * is at the end). Falls back to the last parseable object, then null.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Fast path: the whole thing is JSON.
  const direct = tryParseObject(raw.trim());
  if (direct) return direct;

  // Collect every balanced top-level {...} span (string-aware), in order.
  const candidates: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; } else if (ch === '{') { if (depth === 0) start = i; depth++; } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const obj = tryParseObject(raw.slice(start, i + 1));
          if (obj) candidates.push(obj);
          start = -1;
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  // Prefer the LAST plan-shaped object (the agent's emitted answer); else the
  // last parseable object (back-compat with a lone non-annotated object).
  const plans = candidates.filter(looksLikePlan);
  return plans.length > 0 ? plans[plans.length - 1] : candidates[candidates.length - 1];
}

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}
