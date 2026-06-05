# ADR-010: Error recovery and rollback protocol

**Status:** proposed
**Date:** 2026-05-19

## Context

When merged code breaks something, the response is ad-hoc. Agents operating autonomously may merge code that passes CI but breaks integration. No protocol defines when to revert vs. fix forward, who decides, or how stacked PR chains recover.

## Decision

### Decision tree

```
Broken thing detected
├─ Production affected (users impacted NOW)?
│  └─ Yes → REVERT immediately, investigate after
├─ Fix obvious and < 30 minutes?
│  └─ Yes → Fix forward (new PR, not amend)
├─ Stacked PR chain?
│  └─ Yes → Pause dependent PRs, fix the base
└─ Scope of damage unclear?
   └─ Yes → REVERT (safe default), then investigate
```

### Revert protocol

1. Create a revert commit (not force-push) — preserves history
2. Open an issue: what broke, why CI did not catch it, what the fix needs
3. The fix goes through normal review (no rushing, no skipping gates)

### Fix-forward protocol

1. Only if the fix is obvious, small, and low-risk
2. Must still go through PR + review
3. If the fix introduces new complexity — revert instead

### Stacked PR chain recovery

1. Identify which PR introduced the breakage
2. Pause/close all PRs above it
3. Fix the base PR
4. Rebase and re-evaluate dependent PRs
5. Re-run CI on each before re-opening

### Agents must NEVER do during recovery

- Force-push to shared branches
- Delete branches with others' work
- Amend published commits
- Skip review "because it's urgent"
- Self-approve a revert

## Consequences

- (+) Clear decision tree prevents analysis paralysis during incidents
- (+) Revert-first default limits blast radius
- (+) Stacked chain recovery is defined (not improvised)
- (+) History is preserved (revert commits, not force-push)
- (-) Reverts create noise in git history
- (-) Fix-forward temptation may lead to rushed fixes
- (!) "Production affected" requires definition per deployment (self-hosted varies)

## References

- Issue #141 — full RFC with open questions
- ADR-003 — governance (no bypasses during recovery)
- ADR-001 — stacked PRs (chain recovery protocol)
- ADR-009 — security (revert authority tied to role)
