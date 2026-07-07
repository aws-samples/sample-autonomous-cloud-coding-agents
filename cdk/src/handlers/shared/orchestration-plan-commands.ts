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
 * #299 plan-mode T4 — direct-manipulation command grammar for a pending
 * decomposition plan.
 *
 * Most revisions a reviewer wants are STRUCTURAL, not semantic: "drop #3",
 * "merge 1 and 2", "make #2 small". Those don't need the ~2-min clone+re-plan
 * agent round the revise loop spends — the platform can mutate the pending
 * plan's node list DETERMINISTICALLY and re-render instantly, for free. This
 * module is the pure core: parse a structural command from a comment, and apply
 * it to the plan's ``PlannedSubIssue[]`` with correct positional-edge
 * re-indexing (``depends_on`` are indices into the array, so a drop/merge must
 * remap every surviving edge). No I/O — the webhook does the read/persist/render.
 *
 * Research basis (NN/g, Shneiderman): for "many actions on many objects" a terse
 * command grammar is faster than free-text re-prompting, and human-initiated
 * explicit actions give control/predictability. So the grammar is deliberately
 * STRICT — an explicit command verb + concrete 1-based indices — to avoid
 * misfiring on prose (a fuzzy match that silently reshapes the plan is worse UX
 * than falling through to the agent revise loop, which stays the fallback for
 * anything not recognized here).
 */

import { validateDag, type DagNode } from './orchestration-dag';
import { SIZE_DEFAULT_BUDGET_USD } from './orchestration-decomposition-planner';
import type { PlannedSubIssue, SubIssueSize } from './orchestration-decomposition-types';

/** A parsed structural edit against a pending plan (indices are 0-based here). */
export type PlanCommand =
  /** Remove one or more sub-issues. */
  | { readonly kind: 'drop'; readonly indices: readonly number[] }
  /** Combine two or more sub-issues into one (kept at the lowest position). */
  | { readonly kind: 'merge'; readonly indices: readonly number[] }
  /** Re-size one sub-issue (recomputes its budget ceiling). */
  | { readonly kind: 'size'; readonly index: number; readonly size: SubIssueSize };

/** Outcome of applying a command to a plan's nodes. */
export type ApplyCommandResult =
  /** The edit applied; ``nodes`` is the new list (edges re-indexed, DAG-valid). */
  | { readonly kind: 'ok'; readonly nodes: readonly PlannedSubIssue[] }
  /**
   * The edit would collapse the plan to fewer than 2 sub-issues — nothing left
   * to orchestrate. The caller surfaces this as "now a single task" and does NOT
   * silently apply it (the pending plan stays as-is, approvable).
   */
  | { readonly kind: 'collapses'; readonly remaining: number }
  /** The command was invalid against this plan (bad index, etc.). */
  | { readonly kind: 'error'; readonly message: string };

/** Command verbs, grouped. Kept explicit so prose doesn't misfire. */
const DROP_VERBS = ['drop', 'remove', 'delete', 'cut'];
const MERGE_VERBS = ['merge', 'combine', 'consolidate', 'join', 'fold'];
const SIZE_VERBS = ['size', 'set', 'make', 'resize'];

/** Map a size word/letter → canonical S/M/L (null if not a size token). */
function parseSize(tok: string): SubIssueSize | null {
  const t = tok.trim().toLowerCase();
  if (t === 's' || t === 'small') return 'S';
  if (t === 'm' || t === 'medium' || t === 'med') return 'M';
  if (t === 'l' || t === 'large' || t === 'big') return 'L';
  return null;
}

/** All 1-based integers referenced in ``text`` (``#3``, ``3``, ``3rd`` all → 3). */
function extractIndices(text: string): number[] {
  const nums: number[] = [];
  // Match a bare or #-prefixed integer, optionally with an ordinal suffix.
  const re = /#?(\d+)(?:st|nd|rd|th)?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) nums.push(n);
  }
  return nums;
}

/**
 * Parse a STRUCTURAL plan command from an already-mention-stripped instruction.
 * Returns null when the text is not a recognized command (→ the caller falls
 * back to the agent revise loop). Strict by design: a command verb PLUS concrete
 * 1-based indices; anything vaguer is left to the semantic re-plan.
 *
 * Indices in the returned command are 0-BASED (converted from the 1-based
 * numbers a human types, matching the numbered proposal list).
 */
export function parsePlanCommand(instruction: string): PlanCommand | null {
  const text = instruction.replace(/[*_`>]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  const firstWord = text.split(/[\s.,!?:—–-]+/)[0];

  // SIZE: "<verb> #2 (to) L" / "make 3 small" / "size 2 large". Requires a size
  // token AND exactly one index. Checked before drop/merge so "make 3 small"
  // isn't mistaken for anything else. ("make it 2 tasks" has NO size token → not
  // a size command → falls through to revise, preserving T1's revise routing.)
  if (SIZE_VERBS.includes(firstWord)) {
    const idxs = extractIndices(text);
    // Find a size token anywhere in the words.
    let size: SubIssueSize | null = null;
    for (const w of text.split(' ')) {
      const s = parseSize(w);
      if (s) { size = s; break; }
    }
    if (size && idxs.length === 1) {
      return { kind: 'size', index: idxs[0] - 1, size };
    }
    // A size verb without a clear (index, size) pair → not a structural command;
    // let the semantic revise loop handle it (e.g. "make it simpler").
    return null;
  }

  // DROP: "drop 3" / "remove #2 and #4" / "delete 2, 3".
  if (DROP_VERBS.includes(firstWord)) {
    const idxs = dedupe(extractIndices(text));
    if (idxs.length === 0) return null; // "drop the last one" → revise loop
    return { kind: 'drop', indices: idxs.map((n) => n - 1) };
  }

  // MERGE: "merge 1 and 2" / "combine 2, 3" / "merge #1 #3". Needs ≥2 indices.
  if (MERGE_VERBS.includes(firstWord)) {
    const idxs = dedupe(extractIndices(text));
    if (idxs.length < 2) return null; // "merge them all" → revise loop
    return { kind: 'merge', indices: idxs.map((n) => n - 1) };
  }

  return null;
}

/**
 * Apply a parsed command to a plan's nodes. Pure. Re-indexes ``depends_on``
 * edges (they are positional), drops self/dup edges, and re-validates the result
 * is a DAG (a drop/merge only removes nodes/edges, so it can't introduce a cycle,
 * but we validate defensively). Returns ``collapses`` when the edit would leave
 * <2 nodes (the caller keeps the current plan and tells the reviewer), or
 * ``error`` on an out-of-range index.
 */
export function applyPlanCommand(
  nodes: readonly PlannedSubIssue[],
  cmd: PlanCommand,
): ApplyCommandResult {
  const n = nodes.length;
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n;

  if (cmd.kind === 'size') {
    if (!inRange(cmd.index)) return outOfRange([cmd.index], n);
    const next = nodes.map((node, i) =>
      i === cmd.index
        ? { ...node, size: cmd.size, max_budget_usd: SIZE_DEFAULT_BUDGET_USD[cmd.size] }
        : node,
    );
    return { kind: 'ok', nodes: next };
  }

  if (cmd.kind === 'drop') {
    const bad = cmd.indices.filter((i) => !inRange(i));
    if (bad.length > 0) return outOfRange(bad, n);
    const dropSet = new Set(cmd.indices);
    const remaining = n - dropSet.size;
    if (remaining < 2) return { kind: 'collapses', remaining };
    // old index → new index (dropped → -1).
    const oldToNew = buildOldToNewAfterDrop(n, dropSet);
    const next: PlannedSubIssue[] = [];
    nodes.forEach((node, i) => {
      if (dropSet.has(i)) return;
      next.push({ ...node, depends_on: remapEdges(node.depends_on, oldToNew, oldToNew[i]) });
    });
    return finalize(next);
  }

  // merge
  const bad = cmd.indices.filter((i) => !inRange(i));
  if (bad.length > 0) return outOfRange(bad, n);
  const mergeSet = new Set(cmd.indices);
  if (mergeSet.size < 2) return { kind: 'error', message: 'Merge needs at least two distinct sub-issues.' };
  const remaining = n - mergeSet.size + 1; // the merged nodes become one
  if (remaining < 2) return { kind: 'collapses', remaining };

  const target = Math.min(...cmd.indices); // merged node keeps the lowest position
  // old index → new index: merged non-target nodes fold onto the target's slot.
  const oldToNew = buildOldToNewAfterMerge(n, mergeSet, target);

  // Build the merged node's content from all members (in original order).
  const members = [...mergeSet].sort((a, b) => a - b).map((i) => nodes[i]);
  const merged = mergeNodes(members);

  const next: PlannedSubIssue[] = [];
  nodes.forEach((node, i) => {
    if (mergeSet.has(i) && i !== target) return; // folded away
    if (i === target) {
      next.push({ ...merged, depends_on: remapEdges(merged.depends_on, oldToNew, oldToNew[target]) });
    } else {
      next.push({ ...node, depends_on: remapEdges(node.depends_on, oldToNew, oldToNew[i]) });
    }
  });
  return finalize(next);
}

// ── helpers ──────────────────────────────────────────────────────────────

function dedupe(nums: readonly number[]): number[] {
  return [...new Set(nums)];
}

function outOfRange(bad: readonly number[], n: number): ApplyCommandResult {
  const shown = bad.map((i) => `#${i + 1}`).join(', ');
  return {
    kind: 'error',
    message: `There's no sub-issue ${shown} — the plan has ${n} (numbered 1–${n}).`,
  };
}

/** old→new index map after removing ``dropSet`` (dropped entries map to -1). */
function buildOldToNewAfterDrop(n: number, dropSet: ReadonlySet<number>): number[] {
  const map: number[] = new Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (dropSet.has(i)) continue;
    map[i] = next++;
  }
  return map;
}

/**
 * old→new index map after merging ``mergeSet`` onto ``target``. Merged non-target
 * indices map to the target's new index; everything else compacts around them.
 */
function buildOldToNewAfterMerge(n: number, mergeSet: ReadonlySet<number>, target: number): number[] {
  const map: number[] = new Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (mergeSet.has(i) && i !== target) continue; // folded onto target — set below
    map[i] = next++;
  }
  const targetNew = map[target];
  for (const i of mergeSet) map[i] = targetNew;
  return map;
}

/** Remap an edge list through ``oldToNew``; drop removed (-1), self, and dup edges. */
function remapEdges(
  edges: readonly number[],
  oldToNew: readonly number[],
  selfNew: number,
): number[] {
  const out: number[] = [];
  for (const e of edges) {
    const mapped = oldToNew[e];
    if (mapped === undefined || mapped < 0) continue; // predecessor was dropped
    if (mapped === selfNew) continue; // a merge could point a node at itself
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** Combine merged members into one node: joined title/scope, largest size. */
function mergeNodes(members: readonly PlannedSubIssue[]): PlannedSubIssue {
  const title = members.map((m) => m.title).join(' + ');
  const description = members.map((m) => m.description).filter((d) => d).join(' ');
  const size = largestSize(members.map((m) => m.size));
  // depends_on: union of members' edges (still old indices — remapped by caller).
  const deps: number[] = [];
  for (const m of members) for (const d of m.depends_on) if (!deps.includes(d)) deps.push(d);
  return { title, description: description || title, size, max_budget_usd: SIZE_DEFAULT_BUDGET_USD[size], depends_on: deps };
}

function largestSize(sizes: readonly SubIssueSize[]): SubIssueSize {
  if (sizes.includes('L')) return 'L';
  if (sizes.includes('M')) return 'M';
  return 'S';
}

/** Re-validate the mutated node list is a DAG; wrap as an ApplyCommandResult. */
function finalize(nodes: readonly PlannedSubIssue[]): ApplyCommandResult {
  const dagNodes: DagNode[] = nodes.map((node, i) => ({
    id: `n${i}`,
    depends_on: node.depends_on.map((d) => `n${d}`),
  }));
  const v = validateDag(dagNodes);
  if (!v.ok) {
    // Shouldn't happen (we only remove nodes/edges), but never persist a bad graph.
    return { kind: 'error', message: `That edit would break the dependency graph (${v.reason}).` };
  }
  return { kind: 'ok', nodes };
}
