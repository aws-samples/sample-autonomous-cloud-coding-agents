# ADR-001: Stacked pull requests for multi-PR features

**Status:** accepted
**Date:** 2026-05-19

## Context

Complex features in ABCA often span multiple packages, resource types, and concerns. Delivering these as a single large PR creates several problems:

- **Review fatigue:** PRs exceeding ~500 lines suffer from diminished reviewer attention — critical issues get missed in the noise of mechanical changes.
- **Context loss:** Without a framework, sequential PRs leave reviewers without knowledge of where they are in the overall delivery, what came before, or what remains.
- **Agent discoverability:** AI coding agents picking up a sub-task cannot determine the broader goal, prior decisions, or remaining work without reconstructing context from scattered commits and issues.
- **Blocked progress:** A single large PR blocks all progress until the entire feature is reviewed. Stalling on one concern (e.g., IAM review) blocks unrelated work (e.g., documentation).

The [Pragmatic Engineer analysis of stacked diffs](https://newsletter.pragmaticengineer.com/p/stacked-diffs) documents how organizations (Meta, Google, Graphite users) use this pattern to maintain velocity on complex changes while keeping review quality high.

## Decision

Use **stacked pull requests** for features spanning multiple concerns or where review time and blast radius justify decomposition. The numeric thresholds below are guidelines — the primary signal is whether a single PR would exceed a reasonable review session, not file count alone. Each PR in the stack follows these rules:

### 1. Position statement

Every PR description states its position:

```markdown
## Stack position

PR {N} for #{parent-issue} — {overall goal one-liner}

### Prior: {what the previous PR delivered}
### This PR: {what this adds}
### Next (optional): {what comes next, if scope is known}
```

This gives reviewers and agents immediate orientation. The "Next" section is optional — include it when the remaining scope is fixed and known; omit it when scope is still evolving. The parent issue is the source of truth for overall progress.

### 2. Branch targeting

- PR 1 targets `main`
- PR N targets PR N-1's branch
- Final PR merges the full stack to `main`

```
main
 └── feat/first-concern       (PR 1)
      └── feat/second-concern  (PR 2)
           └── feat/third-concern   (PR 3 → merge to main)
```

### 3. Self-contained reviewability

Each PR:
- Compiles and passes tests independently
- Can be deployed without breaking the system (see exception below)
- Has a single clear responsibility (one concern per PR)
- Does not leave dead code, TODOs, or broken intermediate states

**Infrastructure stack exception:** For multi-PR CDK/IAM changes where intermediate slices cannot deploy independently (e.g., a policy referencing a resource added in a later PR), the validation gate is **synth + tests passing** — not a successful deploy. In this case, designate a **deploy-gate PR** in the stack position block: the specific PR where the stack becomes end-to-end deployable. Acceptable intermediate states include feature-flagged resources, no-op stubs, and constructs gated behind context variables.

### 4. Size guidelines

| Metric | Target | Maximum |
|--------|--------|---------|
| Lines changed | 200–400 | 600 |
| Review time | 20–30 min | 45 min |
| Files touched | 3–8 | 12 |

If a PR exceeds these, decompose further.

### 5. Rebase discipline

When a lower PR changes after review feedback:
- All PRs above it in the stack must be rebased
- CI must pass on each PR independently after rebase
- Reviewers are notified of the rebase (GitHub does this automatically)

### 6. Sub-issue linking

- Parent issue lists all sub-issues with a stack visualization diagram
- Each sub-issue references the parent and its position in the stack
- GitHub's task list in the parent tracks completion
- Estimated review time is listed per sub-issue to help reviewers plan
- Sub-issues use `blocked by #NNN` / `blocking #NNN` relationships to express dependency order — agents and reviewers can identify which issues are unblocked and ready for pickup

### 7. When NOT to use stacked PRs

- Changes under ~200 lines that fit naturally in one PR
- Hotfixes that need immediate merge
- Dependency bumps (use Dependabot grouping instead)
- Documentation-only changes that are self-contained

### 8. Merge semantics

The default topology is a **classic stack** — each PR targets its predecessor's branch. When an early PR merges to `main` before later PRs are reviewed:

1. **Retarget** all PRs that pointed at the merged branch to `main` (or to the next unmerged predecessor). Use `gh pr edit <N> --base main` or GitHub's "Retarget" button.
2. **Rebase** each retargeted PR onto its new base so the diff is clean.
3. **CI must pass** on each retargeted PR independently after rebase.

After retargeting, the remaining PRs form a shorter stack rooted on `main`. This is the expected, normal path — not an exception.

**When the stack diverges:** If review feedback on PR 2 invalidates assumptions in PRs 3+, prefer closing and re-opening the affected PRs over accumulating fixup commits that obscure intent. The parent issue remains the source of truth for what shipped and what remains.

## Consequences

- (+) Each PR stays in the "reviewable without fatigue" window (~15–40 min)
- (+) Agents can pick up any sub-issue independently — the position statement provides full context
- (+) Partial delivery is meaningful — each merged PR adds value independently
- (+) Reviewers approve incrementally without needing full-stack mental context
- (+) Early PRs can merge and ship while later ones are still in review
- (-) Rebase cascades when early PRs receive feedback
- (-) More overhead in PR descriptions and branch management
- (-) Requires discipline to keep each PR independently valid (no "this will be fixed in PR N+1")
- (!) If the stack grows beyond ~8 PRs, consider decomposing into independent sub-stacks

## References

- [Stacked Diffs — Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/stacked-diffs)
- RFC #120 — first formal use of this pattern in ABCA
- Issue #129 — implementation of this ADR
