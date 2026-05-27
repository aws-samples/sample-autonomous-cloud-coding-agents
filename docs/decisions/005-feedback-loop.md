# ADR-005: Feedback loop — PR reviews propagate to issues and ADRs

**Status:** proposed
**Date:** 2026-05-19

## Context

PR review comments are addressed locally (fix the code) but systemic issues they reveal are not propagated upstream. A reviewer says "this approach is wrong" but the issue still says "use this approach." ADRs are treated as immutable when they should be living decisions that evolve with implementation experience.

Without a feedback protocol, review insights are lost, issue bodies rot, and architectural mistakes persist across stacked PR chains.

## Decision

### Review comment classification

| Type | Action | Propagates to |
|------|--------|---------------|
| Nit (style, naming) | Fix in PR | Nothing |
| Bug (logic error) | Fix in PR | Nothing (unless systemic) |
| Design concern | Pause PR; evaluate | Issue body |
| Architecture challenge | Pause PR; escalate | ADR (supersede? amend?) |
| Scope question | Clarify | Issue body |
| Blocker (won't approve as-is) | Pause PR | Issue body |

### Upstream propagation

When a review surfaces a design concern or architecture challenge:

1. **Pause** — Do not force-merge. Do not continue stacked PRs above this one.
2. **Assess** — Does this invalidate the issue's approach? The ADR's decision?
3. **Propagate** — Update the relevant upstream document (issue body, ADR, stacked PR dependents).
4. **Resolve** — Revise the approach, defend with evidence, or cancel the work.
5. **Resume** — Once resolved, unblock the PR and dependents.

### ADR evolution

| Trigger | Response |
|---------|----------|
| Implementation reveals the decision doesn't work | New RFC proposing a successor ADR |
| Reviewer challenges the architectural premise | `**UNRESOLVED**` on the issue; pause |
| New information makes the decision obsolete | Successor ADR with `Supersedes: ADR-NNN` |
| Decision works but needs refinement | Amend via PR (minor, no new ADR) |

Never silently ignore a challenged decision.

### Stacked PR chain revision

When feedback on PR N invalidates PRs N+1 through N+M:
1. Comment on all affected PRs
2. Do not rebase dependent PRs until the base is stable
3. If architectural: re-evaluate whether the remaining stack is valid
4. If redesign needed: close dependent PRs, revise issue, re-plan

## Consequences

- (+) Review insights propagate to architectural decisions
- (+) Issue bodies stay current with implementation learnings
- (+) ADRs evolve rather than silently becoming outdated
- (+) Stacked PR chains have a defined recovery protocol
- (-) Adds process overhead to reviews (classification step)
- (-) Pausing stacked chains delays delivery
- (!) Requires discipline to actually propagate feedback upstream

## References

- Issue #136 — full RFC with open questions
- ADR-003 — governance (issue body as source of truth)
- ADR-001 — stacked PRs (chain revision protocol)
