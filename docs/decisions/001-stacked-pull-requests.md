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

Use **stacked pull requests** for features requiring 4+ files changed or spanning multiple concerns. Each PR in the stack follows these rules:

### 1. Position statement

Every PR description states its position:

```markdown
## Stack position

PR {N} of {M} for #{parent-issue} — {overall goal one-liner}

### Prior (PR {N-1}): {what was delivered}
### This PR: {what this adds}
### Remaining ({M-N} PRs): {what comes next}
```

This gives reviewers and agents immediate orientation without reading the parent issue.

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
- Can be deployed without breaking the system
- Has a single clear responsibility (one concern per PR)
- Does not leave dead code, TODOs, or broken intermediate states

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

### 7. When NOT to use stacked PRs

- Changes under ~200 lines that fit naturally in one PR
- Hotfixes that need immediate merge
- Dependency bumps (use Dependabot grouping instead)
- Documentation-only changes that are self-contained

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
