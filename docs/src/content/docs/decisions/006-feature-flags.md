---
title: 006 feature flags
---

# ADR-006: Feature flags for concurrent development

**Status:** proposed
**Date:** 2026-05-19

## Context

Multiple agents working on related features in the same area must serialize — one waits for the other to merge. Incomplete features either block the main branch or require long-lived branches that diverge. SRE needs kill switches without reverting commits.

Feature flags enable trunk-based development where incomplete work merges safely behind toggles, and concurrent contributors avoid blocking each other.

## Decision

### When to use flags

| Situation | Use a flag? |
|-----------|-------------|
| Feature spans multiple PRs, incomplete state is unsafe | Yes |
| Two contributors touch the same module for different purposes | Yes |
| SRE needs a kill switch for a new capability | Yes |
| Simple refactor with no behavioral change | No |
| Bug fix | No |
| One-PR feature, complete on merge | No |

### Flag ownership

- Every flag has an owner (the issue that introduced it)
- Every flag has an expiration (the issue/PR that removes it)
- Flags without a removal plan are rejected in review

### Separation of concerns

- **Planners** decide which features get flags (issue/RFC level)
- **Implementors** add/use flags in code (PR level)
- **SRE/operators** toggle flags in production (runtime level)
- **No self-approval** — the person who introduces a flag cannot approve its removal

### Flag lifecycle

1. **Proposed** — issue identifies the need for a flag
2. **Introduced** — PR adds the flag (default: off)
3. **Active** — feature behind flag is in development
4. **Verified** — feature complete, flag toggled on in testing
5. **Permanent** — flag removed, feature is always-on (or removed entirely)

### Lifecycle metadata

Each flag must track:

| Field | Required | Source |
|-------|----------|--------|
| Flag name | Yes | Code constant |
| Purpose / linked issue | Yes | Issue reference |
| First merge date | Yes | Auto from git log |
| Max lifetime | Yes | Declared at creation (default: 4 weeks) |
| Expected removal date | Yes | first_merge + max_lifetime |
| Actual removal date | — | Auto when flag deleted |
| Days active | — | Computed |

### Maximum lifetime

Flags must be removed within the declared max lifetime (default: 4 weeks) of the feature being verified. The max lifetime can be overridden per-flag with justification in the issue. Stale flags are treated as technical debt and surfaced in periodic reviews.

### Mechanism constraint

Flags MUST be resolvable at synth time for infrastructure flags and at runtime for behavior flags. The specific storage mechanism (CDK context, DynamoDB, SSM Parameter Store, env vars) is context-dependent and follows from this split — it is not prescribed by this ADR.

## Consequences

- (+) Concurrent work proceeds without blocking
- (+) Trunk-based development: main stays deployable
- (+) SRE can disable features without code changes
- (+) Partial features merge safely
- (-) Flag management overhead
- (-) Combinatorial testing complexity if many flags exist simultaneously
- (!) Maximum lifetime must be enforced or flags accumulate indefinitely

## References

- Issue #137 — full RFC with open questions on mechanism (CDK context vs. DynamoDB vs. env vars)
- ADR-003 — governance (flag introduction requires approval)
- ADR-005 — feedback loop (reviewer may flag-gate a feature during review)
