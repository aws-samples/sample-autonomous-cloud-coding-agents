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
 * #299 Mode B — the decomposition planner (B3, two-stage DJ-1 redesign).
 *
 * TWO Bedrock ``InvokeModel`` calls, deliberately separated:
 *   1. **Critical assessor** — should this issue be decomposed at all, or run as
 *      one coherent PR? Tiny output (``{decompose, reasoning}``). Kept separate
 *      because asking ONE call to also produce a breakdown anchors it toward
 *      finding seams (priming → over-decomposition). A judge that only decides
 *      yes/no isn't contaminated by having to draft a plan.
 *   2. **Decomposer** — runs only when needed; produces a dependency-aware
 *      sub-issue breakdown with per-child S/M/L sizing and ``blockedBy`` edges
 *      (as indices). It does NOT re-litigate the decision — it just decomposes.
 *
 * The assessment is **balanced, not biased** (the explicit design correction): a
 * genuinely multi-part feature (auth = OAuth + session + reset + RBAC) MUST
 * decompose; a cohesive change (same files, one internal ordering) runs as one
 * task. The yardstick is what an AUTONOMOUS AGENT does in one coherent PR — not
 * how a human team would slice tickets. No thumb on either side.
 *
 * DJ-2 — surface, don't silently veto: on an EXPLICIT ``:decompose`` the
 * decomposer runs even when the assessor leans one-shot, so the user always sees
 * a breakdown they can approve; the assessor's "I'd one-shot this" opinion rides
 * along as ``assessedDecompose`` for the flow to surface as a caveat. On ``:auto``
 * (no human in the loop) the assessor's verdict stands.
 *
 * Design choices (unchanged):
 *  - **Budget is derived from size, not asked of the model.** S/M/L → a fixed
 *    per-child ``max_budget_usd`` ({@link SIZE_DEFAULT_BUDGET_USD}), so Σ is a
 *    stable, explainable worst-case ceiling.
 *  - **Edges are indices, validated as a DAG.** The decomposer returns
 *    ``depends_on: number[]`` into its own ``sub_issues`` array (no Linear ids
 *    exist yet — minted at write-back, B5). Mapped to synthetic ids and run
 *    through {@link validateDag} so a cycle / dangling / dup is rejected here.
 *  - **The LLM boundary is injected.** {@link planDecomposition} takes an
 *    {@link InvokeModelFn}; the pure prompt-build + parse/validate core is fully
 *    unit-testable without Bedrock. {@link bedrockInvokeModel} is the prod impl.
 */

import { logger } from './logger';
import { validateDag, type DagNode } from './orchestration-dag';
import {
  type DecompositionPlan,
  type PlannedSubIssue,
  type SubIssueSize,
} from './orchestration-decomposition-types';

/** Cross-region inference profile id (platform standard — see ecs-agent-cluster.ts). */
export const DEFAULT_DECOMPOSITION_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';

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

/** Max tokens for the planner completion (a plan is small JSON). */
const PLANNER_MAX_TOKENS = 4096;

export interface PlannerInput {
  /** The issue title. */
  readonly title: string;
  /** The issue description / body (may be empty). */
  readonly description: string;
  /** The target repo (``owner/repo``) — context for the model. */
  readonly repo: string;
  /**
   * The project's ``max_sub_issues`` cap. Passed to the model as guidance so it
   * aims under the cap; the hard cap is still enforced by ``applyPlanCaps`` (B2).
   */
  readonly maxSubIssues: number;
  /**
   * DJ-2 — the human EXPLICITLY asked to decompose (``:decompose`` label). When
   * true, the decomposer runs even if the assessor leans one-shot, so the user
   * always sees a breakdown to approve (we don't silently override an explicit
   * opt-in). The assessor's opinion is surfaced as a caveat instead. When false
   * (``:auto``, no human), the assessor's verdict stands and a one-shot verdict
   * short-circuits to ``single_task``. Defaults to false.
   */
  readonly forceDecompose?: boolean;
}

/**
 * Injected model boundary: take a fully-built prompt, return the model's raw
 * completion text. The prod impl ({@link bedrockInvokeModel}) calls Bedrock;
 * tests pass a stub.
 */
export type InvokeModelFn = (prompt: string) => Promise<string>;

/** Discriminated outcome of a decomposition attempt. */
export type DecompositionResult =
  // The assessor said one-shot (and the human didn't force), or the decomposer
  // produced <2 nodes → single task. ``reasoning`` is the assessor's rationale.
  | { readonly kind: 'single_task'; readonly reasoning: string }
  // A valid, DAG-checked plan ready to gate against caps + render.
  // ``assessedDecompose`` is the assessor's independent verdict: false here means
  // the human FORCED a plan the assessor would have one-shot (DJ-2 caveat).
  // ``assessedReasoning`` is the assessor's rationale (surfaced in that caveat).
  | {
    readonly kind: 'plan';
    readonly plan: DecompositionPlan;
    readonly assessedDecompose: boolean;
    readonly assessedReasoning: string;
  }
  // The model failed / returned an unusable or self-contradictory plan.
  | { readonly kind: 'error'; readonly message: string };

/** The critical assessor's verdict (stage 1). */
export interface AssessmentResult {
  /** True = this issue genuinely spans separable units / a real build order. */
  readonly decompose: boolean;
  /** One or two sentences explaining the verdict (surfaced to the user). */
  readonly reasoning: string;
}

/**
 * Plan a decomposition for one issue (two-stage). Never throws — model/parse/
 * validation failures are returned as ``{ kind: 'error' }`` so the caller decides
 * the UX (typically: fall back to a single task with a note).
 *
 * Stage 1 (assessor) decides decompose-vs-one-shot. Stage 2 (decomposer) runs
 * when the assessor says decompose OR the human forced it (``forceDecompose``).
 * On ``:auto`` (no force) a one-shot verdict short-circuits to ``single_task``
 * WITHOUT a second model call.
 */
export async function planDecomposition(
  input: PlannerInput,
  invoke: InvokeModelFn,
): Promise<DecompositionResult> {
  // Stage 1 — critical assessor.
  const assessment = await assessDecomposition(input, invoke);
  if (assessment === null) {
    return { kind: 'error', message: 'The decomposition planner could not be reached. Try again shortly.' };
  }

  // One-shot verdict and the human didn't force it → single task (no 2nd call).
  if (!assessment.decompose && !input.forceDecompose) {
    return { kind: 'single_task', reasoning: assessment.reasoning || 'Single cohesive change — running as one task.' };
  }

  // Stage 2 — decomposer. Runs when the assessor said decompose, or the human
  // explicitly asked (DJ-2: never silently override an explicit :decompose).
  let raw: string;
  try {
    raw = await invoke(buildDecomposerPrompt(input));
  } catch (err) {
    logger.error('Decomposition planner: decomposer invocation failed', {
      repo: input.repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'The decomposition planner could not be reached. Try again shortly.' };
  }

  return parseDecomposerResponse(raw, input.maxSubIssues, assessment);
}

/**
 * Stage 1 — the critical assessor. One small model call returning only
 * ``{decompose, reasoning}``. Returns null on a model/parse failure (the caller
 * maps that to an error result). Balanced: see {@link buildAssessmentPrompt}.
 */
export async function assessDecomposition(
  input: PlannerInput,
  invoke: InvokeModelFn,
): Promise<AssessmentResult | null> {
  let raw: string;
  try {
    raw = await invoke(buildAssessmentPrompt(input));
  } catch (err) {
    logger.error('Decomposition planner: assessor invocation failed', {
      repo: input.repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return parseAssessment(raw);
}

/**
 * Build the ASSESSOR prompt (stage 1). Pure + deterministic. The model decides
 * ONLY whether to decompose — it does NOT draft a breakdown (that priming is
 * exactly what biased the old single-call judge toward over-splitting).
 *
 * Framed around the OBJECTIVE, not the artifact: accomplish the original task
 * reliably (fewest errors), at reasonable cost, splitting only where splitting
 * serves that goal. Right-sizing cuts both ways and the prompt says so —
 *  - too big: one agent run loses coherence over a large multi-part task and is
 *    likelier to fail (Anthropic "context rot"; METR task-length cliff);
 *  - too small: extra units add coordination + integration overhead and errors
 *    compound across steps (Cognition "Don't Build Multi-Agents"; p^n reliability).
 * The structural rule that operationalizes it is the agile vertical-slice test
 * (INVEST Independent + Valuable): split into units that each stand alone as a
 * coherent piece of work; don't split one feature across technical layers (the
 * horizontal-slice anti-pattern). A dependency ORDER between genuine units is
 * normal (the executor runs them in order) and is NOT a reason to merge. Stated
 * as principle — NO enumerated feature shapes (those over-fit to the last failure
 * and need re-patching per incident).
 */
export function buildAssessmentPrompt(input: PlannerInput): string {
  const description = input.description.trim() || '(no description provided)';
  return [
    'You are a senior engineering lead planning how a fleet of autonomous coding agents should',
    'tackle one software task. Each sub-issue you create is handled by ONE agent working in its',
    'own clone; the executor runs sub-issues in dependency order, so a sub-issue that depends on',
    'an earlier one is normal and fully supported.',
    '',
    'Your GOAL is to get the original task done as RELIABLY as possible — fewest errors — at',
    'reasonable cost. Decompose ONLY when splitting the work serves that goal; never split for its',
    'own sake.',
    '',
    'Splitting helps or hurts depending on size, so right-size the work:',
    '  • A task too large for one agent to hold coherently — many distinct parts in one run —',
    '    tends to drift and fail; breaking it into focused units each an agent can do well makes',
    '    the whole more reliable.',
    '  • But every extra unit is another full agent run and another review, and a chain of units',
    '    accumulates error and coordination overhead at each hand-off. Splitting work that was',
    '    fine as one unit makes the result LESS reliable and more expensive, not more.',
    '',
    'Decide: decompose this task into multiple dependency-ordered sub-issues, or do it as ONE unit?',
    '',
    'Decompose when the task genuinely contains two or more separable units of work that each',
    'stand on their own — a coherent change an agent could implement and a reviewer could judge',
    'in isolation, delivering its own identifiable piece of the goal. A broad request bundling',
    'several such capabilities under one heading should be split, roughly one unit per capability.',
    '',
    'Keep it as ONE unit when the parts only make sense together — none coherent or useful on its',
    'own. In particular, do NOT split a single feature across technical layers (its interface, its',
    'logic, its stored state, its tests): a lone layer has no standalone value and forces error-',
    'prone hand-offs, so one feature is one unit however many files or layers it touches.',
    '',
    'A dependency or build-order between parts is NOT by itself a reason to merge them — ordering',
    'is handled for you, and tightly-sequenced capabilities can still be separate units. Merge',
    'only when the parts lack standalone coherence, share mutable state, or must change in lockstep.',
    '',
    'If splitting would not clearly make the task more reliable to complete, do it as ONE unit.',
    '',
    'Respond with ONLY a JSON object (no prose, no markdown fences) of this exact shape:',
    '{ "decompose": boolean, "reasoning": "one or two sentences explaining the verdict" }',
    '',
    `Repository: ${input.repo}`,
    `Task title: ${input.title}`,
    'Task description:',
    description,
  ].join('\n');
}

/** Parse the assessor's tiny ``{decompose, reasoning}`` JSON. Null on garbage. */
export function parseAssessment(raw: string): AssessmentResult | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  return {
    decompose: obj.decompose === true,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '',
  };
}

/**
 * Build the DECOMPOSER prompt (stage 2). Pure + deterministic. By the time this
 * runs the decision to decompose is already made — the model's job is to produce
 * the BEST breakdown, not to re-litigate whether to. Instructs JSON-only output.
 */
export function buildDecomposerPrompt(input: PlannerInput): string {
  const description = input.description.trim() || '(no description provided)';
  return [
    'You are a senior engineering lead breaking a software task into dependency-ordered',
    'sub-issues for a fleet of autonomous coding agents. Each agent works ONE sub-issue in an',
    'isolated clone, opens a pull request, and a build/test gate must pass before its dependents',
    'start. The decision to decompose has already been made — your job is the BEST breakdown,',
    'not whether to decompose.',
    '',
    'Rules:',
    `- Propose at most ${input.maxSubIssues} sub-issues (fewer is better — only as many as the`,
    '  work honestly has). Each sub-issue must be a VERTICAL SLICE: a self-contained unit of work',
    '  an agent can implement on its own, delivering its own identifiable piece of the goal. Do NOT',
    '  split along technical layers (interface / logic / stored state / tests) — a single layer in',
    '  isolation has no standalone value and forces error-prone hand-offs; keep each feature whole',
    '  and slice by capability instead.',
    '- Each sub-issue gets a short imperative title, a one-paragraph scope, and a size:',
    '  "S" (small, isolated), "M" (medium), or "L" (large/involved).',
    '- Express dependencies with "depends_on": a list of the ZERO-BASED INDICES (into your own',
    '  "sub_issues" array) of the sub-issues that must finish first. Independent sub-issues have',
    '  "depends_on": []. Keep the critical path (longest dependency chain) as short as the work',
    '  honestly allows — parallelize independent work rather than chaining it.',
    '- Dependencies MUST form a DAG (no cycles). A sub-issue may only depend on others in the list.',
    '',
    'Respond with ONLY a JSON object (no prose, no markdown fences) of this exact shape:',
    '{',
    '  "reasoning": "one or two sentences describing the breakdown",',
    '  "sub_issues": [',
    '    { "title": "string", "description": "string", "size": "S"|"M"|"L", "depends_on": [int, ...] }',
    '  ]',
    '}',
    '',
    `Repository: ${input.repo}`,
    `Task title: ${input.title}`,
    'Task description:',
    description,
  ].join('\n');
}

/**
 * Parse + validate the DECOMPOSER's raw completion into a {@link DecompositionResult}.
 * Pure. Handles markdown-fenced or prose-wrapped JSON; a <2-node breakdown
 * collapses to single_task (nothing to orchestrate); rejects self-contradictory
 * graphs (cycle / dangling / duplicate) via {@link validateDag}. ``assessment``
 * carries through onto a ``plan`` result so the flow can surface a DJ-2 caveat
 * when the human forced a plan the assessor would have one-shot.
 */
export function parseDecomposerResponse(
  raw: string,
  maxSubIssues: number,
  assessment: AssessmentResult,
): DecompositionResult {
  const obj = extractJsonObject(raw);
  if (!obj) {
    return { kind: 'error', message: 'The planner returned a response that could not be parsed as a plan.' };
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
  const rawNodes = Array.isArray(obj.sub_issues) ? obj.sub_issues : [];

  // The decomposer produced nothing worth orchestrating (<2 nodes) → single task.
  // (No ``should_decompose`` veto — the assessor already made that call.)
  if (rawNodes.length < 2) {
    return {
      kind: 'single_task',
      reasoning: assessment.reasoning || reasoning || 'Single cohesive change — running as one task.',
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
    assessedDecompose: assessment.decompose,
    assessedReasoning: assessment.reasoning,
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

/**
 * Extract the first balanced top-level JSON object from a model completion.
 * Tolerates markdown fences and leading/trailing prose. Returns the parsed
 * object, or null if no parseable object is found.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Fast path: the whole thing is JSON.
  const trimmed = raw.trim();
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  // Scan for the first '{' and find its matching '}' (brace-balanced, string-aware).
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {inString = true;} else if (ch === '{') {depth++;} else if (ch === '}') {
      depth--;
      if (depth === 0) return tryParseObject(raw.slice(start, i + 1));
    }
  }
  return null;
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

/**
 * Production {@link InvokeModelFn}: invoke an Anthropic model on Bedrock via the
 * Messages API and return the concatenated text content. Lazy-imports the SDK
 * (mirrors confirm-uploads.ts) so cold-start cost is only paid on the
 * decomposition path. ``modelId`` defaults to {@link DEFAULT_DECOMPOSITION_MODEL_ID}.
 */
export function bedrockInvokeModel(modelId: string = DEFAULT_DECOMPOSITION_MODEL_ID): InvokeModelFn {
  let client: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | undefined;
  return async (prompt: string): Promise<string> => {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    if (!client) client = new BedrockRuntimeClient({});
    const res = await client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: PLANNER_MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    }));
    const decoded = JSON.parse(new TextDecoder().decode(res.body)) as {
      content?: { type?: string; text?: string }[];
    };
    return (decoded.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  };
}
