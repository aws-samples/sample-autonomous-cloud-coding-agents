# ADR-001: Stacked pull requests for multi-PR features

**Status:** accepted
**Date:** 2026-05-19
**Last-updated:** 2026-11-26

## Context

Complex features in ABCA often span multiple packages, resource types, and concerns. Delivering such a feature as a single large PR creates four problems:

- **Review fatigue.** Reviewers pay less attention to a PR of more than about 500 lines, and they miss critical issues among the mechanical changes.
- **Context loss.** Without a framework, sequential PRs do not tell reviewers where they are in the overall delivery, what came before, or what remains.
- **Agent discoverability.** An AI coding agent that picks up a sub-task cannot determine the broader goal, prior decisions, or remaining work without reconstructing context from scattered commits and issues.
- **Blocked progress.** A single large PR blocks all progress until the entire feature is reviewed. A stall on one concern (for example, IAM review) blocks unrelated work (for example, documentation).

The [Pragmatic Engineer analysis of stacked diffs](https://newsletter.pragmaticengineer.com/p/stacked-diffs) documents how organizations (Meta, Google, Graphite users) use this pattern to maintain velocity on complex changes while keeping review quality high.

## Decision

Use **stacked pull requests** for features that span multiple concerns, or where review time and blast radius justify decomposition. The numeric thresholds below are guidelines. The primary signal is whether a single PR would exceed a reasonable review session, not file count alone. Each PR in the stack follows these rules:

### 1. Position statement

Every PR description states its position:

```markdown
## Stack position

PR {N} for #{parent-issue} — {overall goal one-liner}

### Prior: {what the previous PR delivered}
### This PR: {what this adds}
### Next (optional): {what comes next, if scope is known}
```

The position statement tells reviewers and agents where the PR sits in the stack. The "Next" section is optional. Include it when the remaining scope is fixed and known. Omit it when the scope is still evolving. The parent issue is the source of truth for overall progress.

### 2. Branch targeting

- PR 1 targets `main`
- PR N targets PR N-1's branch
- PRs merge **bottom-up, one at a time**, each to its current base. The whole
  stack does NOT land at once through a merge of the top PR. See §8 for the
  merge sequence and for GitHub's auto-retarget-on-delete behaviour.

```
main
 └── feat/first-concern       (PR 1, base: main)
      └── feat/second-concern  (PR 2, base: PR 1's branch)
           └── feat/third-concern   (PR 3, base: PR 2's branch)
```

The merge order is PR 1, then PR 2, then PR 3. Each PR lands on `main` after
its predecessor (§8). The stack does not land in a single "merge the tip"
operation.

### 3. Self-contained reviewability

Each PR:
- Compiles and passes tests independently
- Can be deployed without breaking the system (see exception below)
- Has a single clear responsibility (one concern per PR)
- Does not leave dead code, TODOs, or broken intermediate states

**Infrastructure stack exception.** Some multi-PR CDK and IAM changes have intermediate slices that cannot deploy independently (for example, a policy that references a resource added in a later PR). For those changes, the validation gate is **synth + tests passing**, not a successful deploy. In this case, designate a **deploy-gate PR** in the stack position block. The deploy-gate PR is the specific PR where the stack becomes end-to-end deployable. Acceptable intermediate states include feature-flagged resources, no-op stubs, and constructs gated behind context variables.

### 4. Size guidelines

| Metric | Target | Maximum |
|--------|--------|---------|
| Lines changed | 200–400 | 600 |
| Review time | 20–30 min | 45 min |
| Files touched | 3–8 | 12 |

If a PR exceeds these guidelines, decompose it further.

### 5. Rebase discipline

When a lower PR changes after review feedback:
- Rebase all PRs above it in the stack.
- CI must pass on each PR independently after the rebase.
- GitHub notifies reviewers of the rebase automatically.

### 6. Sub-issue linking

- The parent issue lists all sub-issues, with a diagram of the stack.
- Each sub-issue references the parent and its position in the stack.
- GitHub's task list in the parent tracks completion.
- Estimated review time is listed per sub-issue, to help reviewers plan.
- Sub-issues express dependency order with `blocked by #NNN` and `blocking #NNN` relationships. Agents and reviewers can then identify which issues are unblocked and ready for pickup.

### 7. When NOT to use stacked PRs

- Changes under about 200 lines that fit naturally in one PR
- Hotfixes that need immediate merge
- Dependency bumps (use Dependabot grouping instead)
- Documentation-only changes that are self-contained

### 8. Merge semantics

The default topology is a **classic stack**, in which each PR targets its predecessor's branch. Merges proceed **bottom-up, one PR at a time**. No single operation merges the tip and lands the whole stack. When an early PR merges to `main` before later PRs are reviewed:

0. **Deleting the merged branch is what triggers GitHub's auto-retarget.** When PR N's branch is deleted after the merge, GitHub automatically retargets the PRs that pointed at it onto PR N's base (`main`). The merge *itself* does not retarget. The branch deletion does. If you keep the merged branch, the child PRs keep showing the already-merged commits in their diff. Steps 1 to 3 are the manual fallback for when auto-retarget does not apply (for example, the branch was kept, or the base is an intermediate branch that was not deleted).
1. **Retarget** all PRs that pointed at the merged branch to `main` (or to the next unmerged predecessor). Use `gh pr edit <N> --base main` or GitHub's "Retarget" button.
2. **Rebase** each retargeted PR onto its new base so that the diff is clean. Use `git rebase --skip` for commits whose content is already in main through the merged predecessor.
3. **Force-push with lease** (`--force-with-lease`) so that the PR diff on GitHub shows only net-new changes, not already-merged content.
4. **CI must pass** on each retargeted PR independently after rebase.

**This sequence is mandatory, not optional.** Until the sequence completes, GitHub shows already-merged commits in the child PR's diff. Reviewers cannot distinguish new work from old, and stacking loses its purpose. A merge is not complete until all child PRs are rebased clean.

After retargeting, the remaining PRs form a shorter stack rooted on `main`. This is the expected, normal path, not an exception.

**When the stack diverges.** If review feedback on PR 2 invalidates assumptions in PR 3 and later PRs, prefer closing and re-opening the affected PRs to accumulating fixup commits that obscure intent. The parent issue remains the source of truth for what shipped and what remains.

### 9. Agent-orchestrated stacks (issue #247)

§1 to §8 describe a **human-authored** stack. ABCA's Linear orchestration (#247) builds the same topology **automatically** from the sub-issue DAG of a parent issue. Reviewers should know three differences:

- **The base branch is passed to the child, not retargeted by hand.** When the orchestrator releases a stacked child, it passes the predecessor's branch as the child's `base_branch` (persisted on the `TaskRecord`). The agent creates the child branch *from* that base and opens the PR against it. The classic stack of §2 is produced up front, so the retarget sequence of §8 is needed only if a human merges mid-run. The orchestrator releases a child only once all its predecessors have **succeeded** (task-complete), not merged.
- **Diamonds as well as linear stacks.** A sub-issue with multiple predecessors (fan-in) cannot target two bases. The orchestrator branches it off `main` and **merges each predecessor branch into the child's branch** before the agent starts, so that the child's branch contains the code of all predecessors. Linear chains still use the single-predecessor base-targeting of §2.
- **Merge is still human and bottom-up.** The orchestrator opens the stack. It does **not** merge. A human merges bottom-up as §8 describes, and GitHub's delete-triggers-retarget (§8.0) moves the remaining children onto `main`. The parent epic carries a live status block and a rollup. The platform maintains them, and they are the "position statement" of §1 and the source of truth of §6.

**Open follow-up (#305, A6).** The rebase discipline of §5 and the diamond re-merge above apply at *initial creation* only. If a predecessor branch is **edited after** a dependent child already merged it in, the child goes stale. Automatic re-stack or re-merge on predecessor change is tracked in #305 (A6) and is not yet wired.

## Consequences

- (+) Each PR stays in the "reviewable without fatigue" window (about 15 to 40 min)
- (+) Agents can pick up any sub-issue independently, because the position statement provides full context
- (+) Partial delivery is meaningful, because each merged PR adds value independently
- (+) Reviewers approve incrementally without needing the context of the full stack
- (+) Early PRs can merge and ship while later ones are still in review
- (-) Rebase cascades when early PRs receive feedback
- (-) More overhead in PR descriptions and branch management
- (-) Requires discipline to keep each PR independently valid (no "this will be fixed in PR N+1")
- (!) If the stack grows beyond about 8 PRs, consider decomposing it into independent sub-stacks

## References

- [Stacked Diffs, Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/stacked-diffs)
- RFC #120, the first formal use of this pattern in ABCA
- Issue #129, the implementation of this ADR

## Changelog

- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
