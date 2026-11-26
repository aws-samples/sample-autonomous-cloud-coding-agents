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

export interface PredecessorBranch {
  readonly sub_issue_id: string;
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
  return { base_branch: defaultBranch, merge_branches: branches, shape: 'diamond' };
}
