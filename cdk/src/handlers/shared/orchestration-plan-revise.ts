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
 * #299 BLOCKER-1 (revise amnesia + fabricated "What changed") — deterministic
 * plan EDITING.
 *
 * The bug: a semantic revise ("drop the careers page", "merge FAQ and Privacy")
 * dispatched a fresh ``coding/decompose-v1`` agent pointed at the ORIGINAL ISSUE,
 * which re-derived the whole breakdown from the issue text — so a sub-issue the
 * reviewer had explicitly dropped one turn earlier reappeared, and the
 * model-authored "What changed" line then FABRICATED a justification for it ("as
 * the issue always intended three pages"). Edits did not accumulate; only a full
 * restatement recovered.
 *
 * The fix, split across two responsibilities:
 *  1. INTERPRET (a model call, elsewhere) reads the CURRENT plan + the reviewer's
 *     instruction and returns a list of structured {@link PlanEdit}s — it decides
 *     WHICH nodes and WHAT ops, resolving "the careers page" → a node index
 *     semantically. It never emits a whole new plan.
 *  2. APPLY ({@link applyPlanEdits}, here) mutates the CURRENT plan by those edits
 *     — PURE, deterministic, no model. Every node the edits don't touch is carried
 *     forward BYTE-FOR-BYTE; positional ``depends_on`` edges are re-indexed exactly
 *     as {@link applyPlanCommand} does. Because the plan itself is only ever mutated
 *     by code, a dropped node CANNOT reappear and edits STACK across rounds.
 *
 * And {@link diffPlans}/{@link renderPlanDiff} compute the "What changed" line from
 * the actual before→after arrays — never from model self-report — so it can never
 * launder a state-loss bug into a plausible-sounding intentional decision.
 *
 * Edits reference nodes by their 1-based position in the plan the interpreter was
 * shown (matching the numbered proposal the reviewer sees). All edits in one batch
 * resolve against that SAME original numbering (never shifting mid-batch); the
 * final index remap happens once, after the survivor set is known.
 */

import { validateDag, type DagNode } from './orchestration-dag';
import { SIZE_DEFAULT_BUDGET_USD } from './orchestration-decomposition-planner';
import type { PlannedSubIssue, SubIssueSize } from './orchestration-decomposition-types';

/**
 * A structured edit against the current plan. Indices are 1-BASED positions in
 * the plan shown to the interpreter (converted to 0-based on apply), matching the
 * numbered list the reviewer sees. Kept small + declarative so the interpret model
 * has a tight target and the apply is trivially auditable.
 */
export type PlanEdit =
  /** Remove one or more sub-issues. */
  | { readonly op: 'drop'; readonly targets: readonly number[] }
  /** Combine two or more sub-issues into one (kept at the lowest position). */
  | { readonly op: 'merge'; readonly targets: readonly number[] }
  /**
   * Edit ONE existing sub-issue in place: any of title / description (scope) /
   * size. Absent fields are left exactly as they were. This is how a rename, a
   * re-scope, or a resize are all expressed — narrowly, without touching siblings.
   */
  | {
    readonly op: 'edit';
    readonly target: number;
    readonly title?: string;
    readonly description?: string;
    readonly size?: SubIssueSize;
  }
  /**
   * Add a NEW sub-issue with reviewer-/interpreter-supplied content. ``dependsOn``
   * references 1-based positions in the ORIGINAL plan (remapped on apply). Used
   * when the reviewer names a concrete new piece AND its scope is expressible
   * without exploring the repo; a "needs repo knowledge to scope it" add is routed
   * to the escalation path instead (see the webhook caller), not emitted here.
   */
  | {
    readonly op: 'add';
    readonly title: string;
    readonly description: string;
    readonly size: SubIssueSize;
    readonly dependsOn?: readonly number[];
  }
  /**
   * Replace one sub-issue's dependency list (reorder / re-wire). ``dependsOn`` are
   * 1-based ORIGINAL positions; an empty list makes the node a root.
   */
  | { readonly op: 'set_deps'; readonly target: number; readonly dependsOn: readonly number[] };

/** Outcome of applying a batch of edits to a plan's nodes. */
export type ApplyEditsResult =
  /** Applied; ``nodes`` is the new list (edges re-indexed, DAG-valid). */
  | { readonly kind: 'ok'; readonly nodes: readonly PlannedSubIssue[] }
  /**
   * The edits would collapse the plan to fewer than 2 sub-issues — nothing left to
   * orchestrate. The caller surfaces "now a single task" and does NOT apply it
   * (the current plan stays approvable), mirroring {@link applyPlanCommand}.
   */
  | { readonly kind: 'collapses'; readonly remaining: number }
  /** An edit was invalid against this plan (bad index, empty merge, cycle). */
  | { readonly kind: 'error'; readonly message: string };

/**
 * Apply a batch of {@link PlanEdit}s to a plan's nodes. PURE. All edit targets are
 * 1-based positions in ``nodes`` and are resolved against THIS original numbering
 * (never a shifting mid-batch index). Order of resolution:
 *   in-place edits (title/scope/size) + dependency rewrites → merges → drops →
 *   adds → single edge re-index + DAG validation.
 * A node touched by no edit is carried forward unchanged (same object identity is
 * not guaranteed, but every field is copied verbatim). Returns ``collapses`` when
 * <2 nodes would remain and ``error`` on a bad reference; the caller keeps the
 * current plan in both non-``ok`` cases. Never throws.
 */
export function applyPlanEdits(
  nodes: readonly PlannedSubIssue[],
  edits: readonly PlanEdit[],
): ApplyEditsResult {
  const n = nodes.length;
  const to0 = (oneBased: number): number => oneBased - 1;
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n;

  if (edits.length === 0) {
    return { kind: 'error', message: 'No changes to apply.' };
  }

  // Working copy of each original node's mutable fields, keyed by original index.
  // We mutate title/description/size/depends_on here for in-place edits + set_deps;
  // merge/drop then decide which originals survive. depends_on stays in ORIGINAL
  // index space throughout and is remapped exactly once at the end.
  const work: {
    title: string;
    description: string;
    size: SubIssueSize;
    depends_on: number[];
  }[] = nodes.map((node) => ({
    title: node.title,
    description: node.description,
    size: node.size,
    depends_on: [...node.depends_on],
  }));

  // Nodes appended by 'add', in order. Their depends_on are ORIGINAL indices
  // (remapped with everything else at the end); refs to other added nodes are not
  // supported in one batch (a single add rarely depends on another) and are dropped.
  const additions: { title: string; description: string; size: SubIssueSize; depends_on: number[] }[] = [];

  const dropSet = new Set<number>();
  // Merge groups: each is a set of ORIGINAL indices folded onto their lowest member.
  const mergeGroups: Set<number>[] = [];

  for (const edit of edits) {
    if (edit.op === 'edit') {
      const i = to0(edit.target);
      if (!inRange(i)) return outOfRange([i], n);
      if (edit.title !== undefined && edit.title.trim()) work[i].title = edit.title.trim();
      if (edit.description !== undefined && edit.description.trim()) work[i].description = edit.description.trim();
      if (edit.size !== undefined) work[i].size = edit.size;
      continue;
    }
    if (edit.op === 'set_deps') {
      const i = to0(edit.target);
      if (!inRange(i)) return outOfRange([i], n);
      const deps: number[] = [];
      for (const d of edit.dependsOn) {
        const di = to0(d);
        if (!inRange(di)) return outOfRange([di], n);
        if (di !== i && !deps.includes(di)) deps.push(di);
      }
      work[i].depends_on = deps;
      continue;
    }
    if (edit.op === 'add') {
      if (!edit.title.trim()) return { kind: 'error', message: 'A new sub-issue needs a title.' };
      const deps: number[] = [];
      for (const d of edit.dependsOn ?? []) {
        const di = to0(d);
        if (inRange(di) && !deps.includes(di)) deps.push(di); // refs to other adds unsupported → dropped
      }
      additions.push({
        title: edit.title.trim(),
        description: (edit.description || edit.title).trim(),
        size: edit.size,
        depends_on: deps,
      });
      continue;
    }
    if (edit.op === 'drop') {
      const idxs = edit.targets.map(to0);
      const bad = idxs.filter((i) => !inRange(i));
      if (bad.length > 0) return outOfRange(bad, n);
      idxs.forEach((i) => dropSet.add(i));
      continue;
    }
    // merge
    const idxs = dedupe(edit.targets.map(to0));
    const bad = idxs.filter((i) => !inRange(i));
    if (bad.length > 0) return outOfRange(bad, n);
    if (idxs.length < 2) {
      return { kind: 'error', message: 'Merge needs at least two distinct sub-issues.' };
    }
    mergeGroups.push(new Set(idxs));
  }

  // A node can't be both dropped and merged, or in two merge groups — that's an
  // ambiguous instruction; reject rather than silently pick one.
  const mergedMembers = new Set<number>();
  for (const g of mergeGroups) {
    for (const i of g) {
      if (dropSet.has(i)) {
        return { kind: 'error', message: 'That change both drops and merges the same sub-issue — please rephrase.' };
      }
      if (mergedMembers.has(i)) {
        return { kind: 'error', message: 'That change merges the same sub-issue in two different ways — please rephrase.' };
      }
      mergedMembers.add(i);
    }
  }

  // Each merge group folds onto its lowest-index member (the "target"), unioning
  // scope + taking the largest size + unioning edges — same rule as applyPlanCommand.
  const mergeTargetOf = new Map<number, number>(); // member original idx → target original idx
  for (const g of mergeGroups) {
    const members = [...g].sort((a, b) => a - b);
    const target = members[0];
    const merged = mergeNodes(members.map((i) => work[i]));
    work[target] = merged;
    for (const m of members) mergeTargetOf.set(m, target);
  }

  // Survivors, in original order: dropped removed; non-target merge members removed
  // (their content already folded into the target's work slot).
  const survivorOldIdxs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (dropSet.has(i)) continue;
    const t = mergeTargetOf.get(i);
    if (t !== undefined && t !== i) continue; // folded into another
    survivorOldIdxs.push(i);
  }

  const remaining = survivorOldIdxs.length + additions.length;
  if (remaining < 2) return { kind: 'collapses', remaining };

  // old original index → new index. Merged members map to their target's new slot;
  // dropped map to -1. Additions occupy the tail.
  const oldToNew: number[] = new Array(n).fill(-1);
  survivorOldIdxs.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx; });
  for (const [member, target] of mergeTargetOf) oldToNew[member] = oldToNew[target];

  const next: PlannedSubIssue[] = [];
  for (const oldIdx of survivorOldIdxs) {
    const w = work[oldIdx];
    next.push({
      title: w.title,
      description: w.description || w.title,
      size: w.size,
      max_budget_usd: SIZE_DEFAULT_BUDGET_USD[w.size],
      depends_on: remapEdges(w.depends_on, oldToNew, oldToNew[oldIdx]),
    });
  }
  for (const add of additions) {
    next.push({
      title: add.title,
      description: add.description || add.title,
      size: add.size,
      max_budget_usd: SIZE_DEFAULT_BUDGET_USD[add.size],
      // New node's slot has no old index; -1 as self so no edge is dropped as self.
      depends_on: remapEdges(add.depends_on, oldToNew, -1),
    });
  }

  return finalize(next);
}

// ── diff ("What changed"), computed from before→after, never model-reported ──

/** Structured before→after diff of two plans. All arrays are human-facing titles. */
export interface PlanDiff {
  readonly removed: readonly string[];
  readonly added: readonly string[];
  /** Titles whose scope/size/deps changed but that persisted (matched by title). */
  readonly modified: readonly string[];
  /** True when the node COUNT is unchanged and every title matches (no structural change). */
  readonly unchanged: boolean;
}

/**
 * Compute a before→after diff by TITLE identity. A revise renames rarely; matching
 * on title gives an honest "Removed / Added / Updated" that reflects the actual
 * arrays. This is the ONLY source of the "What changed" line — the model never
 * self-reports it, so it cannot fabricate a change that didn't happen (the
 * fabrication bug: a re-added dropped node was described as intentional). If a
 * dropped node reappears, this reports it as **Added**, surfacing the drift.
 */
export function diffPlans(
  before: readonly PlannedSubIssue[],
  after: readonly PlannedSubIssue[],
): PlanDiff {
  const beforeByTitle = new Map(before.map((nd) => [nd.title, nd]));
  const afterByTitle = new Map(after.map((nd) => [nd.title, nd]));

  const removed = before.filter((nd) => !afterByTitle.has(nd.title)).map((nd) => nd.title);
  const added = after.filter((nd) => !beforeByTitle.has(nd.title)).map((nd) => nd.title);
  const modified: string[] = [];
  for (const nd of after) {
    const prev = beforeByTitle.get(nd.title);
    if (!prev) continue; // it's in `added`
    if (prev.description !== nd.description || prev.size !== nd.size
      || !sameEdges(prev.depends_on, nd.depends_on)) {
      modified.push(nd.title);
    }
  }
  const unchanged = removed.length === 0 && added.length === 0 && modified.length === 0;
  return { removed, added, modified, unchanged };
}

/**
 * Render the "What changed" line from a {@link PlanDiff}. Plain, honest, one line.
 * Empty string when nothing changed (the caller then shows a "no change" note
 * rather than a misleading "Updated"). Because it's derived from the diff, it can
 * only ever state what actually differs between the two node lists.
 */
export function renderPlanDiff(diff: PlanDiff): string {
  if (diff.unchanged) return '';
  const parts: string[] = [];
  if (diff.removed.length) parts.push(`Removed ${humanList(diff.removed)}`);
  if (diff.added.length) parts.push(`Added ${humanList(diff.added)}`);
  if (diff.modified.length) parts.push(`Updated ${humanList(diff.modified)}`);
  // Sentence-case join: "Removed X. Added Y."
  return parts.map((p) => `${p}.`).join(' ');
}

// ── helpers (shared shape with orchestration-plan-commands.ts) ────────────────

function dedupe(nums: readonly number[]): number[] {
  return [...new Set(nums)];
}

function outOfRange(bad0: readonly number[], n: number): ApplyEditsResult {
  const shown = bad0.map((i) => `#${i + 1}`).join(', ');
  return {
    kind: 'error',
    message: `There's no sub-issue ${shown} — the plan has ${n} (numbered 1–${n}).`,
  };
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
    if (mapped === undefined || mapped < 0) continue; // predecessor dropped/merged-away
    if (mapped === selfNew) continue; // a merge could point a node at itself
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** Combine merged members into one: joined title/scope, largest size, union edges. */
function mergeNodes(
  members: readonly { title: string; description: string; size: SubIssueSize; depends_on: readonly number[] }[],
): { title: string; description: string; size: SubIssueSize; depends_on: number[] } {
  const title = members.map((m) => m.title).join(' + ');
  const description = members.map((m) => m.description).filter((d) => d).join(' ');
  const size = largestSize(members.map((m) => m.size));
  const deps: number[] = [];
  for (const m of members) for (const d of m.depends_on) if (!deps.includes(d)) deps.push(d);
  return { title, description: description || title, size, depends_on: deps };
}

function largestSize(sizes: readonly SubIssueSize[]): SubIssueSize {
  if (sizes.includes('L')) return 'L';
  if (sizes.includes('M')) return 'M';
  return 'S';
}

function sameEdges(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function humanList(titles: readonly string[]): string {
  if (titles.length === 1) return `“${titles[0]}”`;
  if (titles.length === 2) return `“${titles[0]}” and “${titles[1]}”`;
  return `${titles.slice(0, -1).map((t) => `“${t}”`).join(', ')}, and “${titles[titles.length - 1]}”`;
}

/** Re-validate the mutated node list is a DAG; wrap as an ApplyEditsResult. */
function finalize(nodes: readonly PlannedSubIssue[]): ApplyEditsResult {
  const dagNodes: DagNode[] = nodes.map((node, i) => ({
    id: `n${i}`,
    depends_on: node.depends_on.map((d) => `n${d}`),
  }));
  const v = validateDag(dagNodes);
  if (!v.ok) {
    return { kind: 'error', message: `That edit would break the dependency graph (${v.reason}).` };
  }
  return { kind: 'ok', nodes };
}
