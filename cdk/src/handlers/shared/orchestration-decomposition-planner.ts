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
 * #299 Mode B — the decomposition planner (B3).
 *
 * A single Bedrock ``InvokeModel`` call that does BOTH jobs the issue asks for:
 *   1. **Complexity judge** — should this issue be decomposed at all, or is it
 *      a single cohesive change? (No → fall back to today's single task.)
 *   2. **Planner** — if yes, propose a dependency-aware sub-issue breakdown with
 *      per-child S/M/L sizing and ``blockedBy`` edges (as indices).
 *
 * Combining them in one call is cheaper and lets the judge's "why it's complex"
 * reasoning directly inform the breakdown.
 *
 * Design choices:
 *  - **Budget is derived from size, not asked of the model.** The model is poor
 *    at dollar estimates and would make the cost ceiling non-deterministic.
 *    S/M/L → a fixed per-child ``max_budget_usd`` ({@link SIZE_DEFAULT_BUDGET_USD}),
 *    so Σ is a stable, explainable worst-case ceiling.
 *  - **Edges are indices, validated as a DAG.** The model returns
 *    ``depends_on: number[]`` referencing positions in its own ``sub_issues``
 *    array (no Linear ids exist yet — those are minted at write-back, B5). We
 *    map indices → synthetic ids and run the proven {@link validateDag} so a
 *    self-contradictory plan (cycle / dangling / dup) is rejected here, not at
 *    seed time.
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
}

/**
 * Injected model boundary: take a fully-built prompt, return the model's raw
 * completion text. The prod impl ({@link bedrockInvokeModel}) calls Bedrock;
 * tests pass a stub.
 */
export type InvokeModelFn = (prompt: string) => Promise<string>;

/** Discriminated outcome of a decomposition attempt. */
export type DecompositionResult =
  // The judge said don't decompose (or it produced <2 nodes) → single task.
  | { readonly kind: 'single_task'; readonly reasoning: string }
  // A valid, DAG-checked plan ready to gate against caps + render.
  | { readonly kind: 'plan'; readonly plan: DecompositionPlan }
  // The model failed / returned an unusable or self-contradictory plan.
  | { readonly kind: 'error'; readonly message: string };

/**
 * Plan a decomposition for one issue. Never throws — model/parse/validation
 * failures are returned as ``{ kind: 'error' }`` so the caller decides the UX
 * (typically: fall back to a single task with a note).
 */
export async function planDecomposition(
  input: PlannerInput,
  invoke: InvokeModelFn,
): Promise<DecompositionResult> {
  const prompt = buildDecompositionPrompt(input);

  let raw: string;
  try {
    raw = await invoke(prompt);
  } catch (err) {
    logger.error('Decomposition planner: model invocation failed', {
      repo: input.repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'The decomposition planner could not be reached. Try again shortly.' };
  }

  return parsePlannerResponse(raw, input.maxSubIssues);
}

/**
 * Build the planner prompt. Pure + deterministic so the prompt is testable and
 * stable across deploys. Instructs the model to return ONLY a JSON object.
 */
export function buildDecompositionPrompt(input: PlannerInput): string {
  const description = input.description.trim() || '(no description provided)';
  return [
    'You are a senior engineering lead planning how to execute a software task with a fleet',
    'of autonomous coding agents. Each agent works one sub-task in an isolated clone, opens a',
    'pull request, and a build/test gate must pass before its dependents start.',
    '',
    'Decide whether the task below should be DECOMPOSED into multiple dependency-ordered',
    'sub-issues, or run as ONE task.',
    '',
    'Decompose ONLY when the work genuinely spans separable units that benefit from independent',
    'PRs (distinct surfaces/files/layers, or a natural build order). Do NOT decompose a small or',
    'cohesive change — over-splitting creates merge overhead and a longer critical path for no',
    'gain. When unsure, prefer a single task.',
    '',
    'If you decompose:',
    `- Propose at most ${input.maxSubIssues} sub-issues (fewer is better).`,
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
    '  "should_decompose": boolean,',
    '  "reasoning": "one or two sentences explaining the verdict",',
    '  "sub_issues": [',
    '    { "title": "string", "description": "string", "size": "S"|"M"|"L", "depends_on": [int, ...] }',
    '  ]',
    '}',
    'When "should_decompose" is false, "sub_issues" must be an empty array.',
    '',
    `Repository: ${input.repo}`,
    `Task title: ${input.title}`,
    'Task description:',
    description,
  ].join('\n');
}

/**
 * Parse + validate the model's raw completion into a {@link DecompositionResult}.
 * Pure. Handles markdown-fenced or prose-wrapped JSON, a no-decompose verdict,
 * and rejects self-contradictory graphs (cycle / dangling / duplicate) via
 * {@link validateDag}.
 */
export function parsePlannerResponse(raw: string, maxSubIssues: number): DecompositionResult {
  const obj = extractJsonObject(raw);
  if (!obj) {
    return { kind: 'error', message: 'The planner returned a response that could not be parsed as a plan.' };
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';
  const shouldDecompose = obj.should_decompose === true;
  const rawNodes = Array.isArray(obj.sub_issues) ? obj.sub_issues : [];

  // Judge said no, or there's nothing worth orchestrating (<2 nodes) → single task.
  if (!shouldDecompose || rawNodes.length < 2) {
    return { kind: 'single_task', reasoning: reasoning || 'Single cohesive change — running as one task.' };
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
