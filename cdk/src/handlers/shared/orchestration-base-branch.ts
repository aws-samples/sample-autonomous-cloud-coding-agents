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
 * Pure base-branch selection for stacked child PRs (#247 A4).
 *
 * A released child must SEE its predecessors' code without waiting for a
 * human merge. A git branch has exactly one base, so:
 *   - 0 predecessors (root)  → branch off the repo default branch (main).
 *   - 1 predecessor (linear) → stack: base = that predecessor's branch
 *     (a true stacked PR; the child's diff shows only its own changes).
 *   - N predecessors (diamond) → branch off main and MERGE all
 *     predecessor branches into the child's branch before work starts,
 *     so the child sees every predecessor's code. (No human merge needed;
 *     starts as soon as all predecessors are task-complete.)
 *
 * Pure: takes the predecessors' resolved branch names + the repo default
 * branch, returns the base + merge-list the release path threads to the
 * agent. No I/O, so the diamond/linear/root branching is unit-testable in
 * isolation.
 */

/** A predecessor whose branch the child may stack on / merge in. */
export interface PredecessorBranch {
  readonly sub_issue_id: string;
  /** The predecessor task's current head branch (persisted branch_name). */
  readonly branch_name: string;
}

export interface BaseBranchSelection {
  /** Branch the child is cut from (and its PR targets). */
  readonly base_branch: string;
  /**
   * Predecessor branches to merge into the child's branch before work
   * (multi-predecessor only). Empty for root + linear children.
   */
  readonly merge_branches: readonly string[];
  /** Shape, for logging/observability. */
  readonly shape: 'root' | 'linear' | 'diamond';
}

export interface SelectBaseBranchParams {
  /** Predecessors of the child being released (already terminal-success). */
  readonly predecessors: readonly PredecessorBranch[];
  /** Repo default branch (root base / diamond base). Defaults to 'main'. */
  readonly defaultBranch?: string;
}

/**
 * Choose a child's base branch + any predecessor branches to merge in.
 *
 * Predecessors missing a usable ``branch_name`` are dropped from the
 * merge/stack decision (they can't be stacked on); if that leaves a
 * single-predecessor child with no branch, it degrades to a root-style
 * branch off main rather than producing an invalid base.
 */
export function selectBaseBranch(params: SelectBaseBranchParams): BaseBranchSelection {
  const defaultBranch = params.defaultBranch ?? 'main';
  // Dedup BEFORE the count check: two predecessors resolving to the same
  // branch are one stack target, not a diamond — stack cleanly rather
  // than needlessly branching off main to "merge" a single branch.
  const branches = [...new Set(
    params.predecessors
      .map((p) => p.branch_name)
      .filter((b): b is string => typeof b === 'string' && b.length > 0),
  )].sort();

  if (branches.length === 0) {
    return { base_branch: defaultBranch, merge_branches: [], shape: 'root' };
  }
  if (branches.length === 1) {
    return { base_branch: branches[0], merge_branches: [], shape: 'linear' };
  }
  // Diamond: branch off the default branch, merge every distinct
  // predecessor branch in (already deduped + sorted above).
  return { base_branch: defaultBranch, merge_branches: branches, shape: 'diamond' };
}
