# ADR-006: Feature flags for concurrent development

**Status:** proposed
**Date:** 2026-05-19

## Context

Multiple agents that work on related features in the same area must serialize. One waits for the other to merge. Incomplete features either block the main branch or require long-lived branches that diverge. SRE needs kill switches that do not require reverting commits.

Feature flags enable trunk-based development, in which incomplete work merges safely behind toggles and concurrent contributors do not block each other.

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

- **Planners** decide which features get flags (issue or RFC level).
- **Implementors** add and use flags in code (PR level).
- **SRE and operators** toggle flags in production (runtime level).
- **No self-approval.** The person who introduces a flag cannot approve its removal.

### Flag lifecycle

1. **Proposed.** An issue identifies the need for a flag.
2. **Introduced.** A PR adds the flag (default: off).
3. **Active.** The feature behind the flag is in development.
4. **Verified.** The feature is complete, and the flag is toggled on in testing.
5. **Permanent.** The flag is removed, and the feature is always on (or removed entirely).

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

Flags must be removed within the declared max lifetime (default: 4 weeks) of the feature being verified. The max lifetime can be overridden for a single flag, with a justification in the issue. Stale flags are treated as technical debt and surfaced in periodic reviews.

### Mechanism constraint

Infrastructure flags MUST be resolvable at synth time, and behavior flags MUST be resolvable at runtime. The specific storage mechanism (CDK context, DynamoDB, SSM Parameter Store, env vars) depends on the context and follows from this split. This ADR does not prescribe it.

## Consequences

- (+) Concurrent work proceeds without blocking
- (+) Trunk-based development keeps main deployable
- (+) SRE can disable features without code changes
- (+) Partial features merge safely
- (-) Flag management overhead
- (-) Combinatorial testing complexity if many flags exist simultaneously
- (!) Maximum lifetime must be enforced or flags accumulate indefinitely

## References

- Issue #137, the full RFC with open questions on the mechanism (CDK context, DynamoDB, or env vars)
- ADR-003, governance (flag introduction requires approval)
- ADR-005, the feedback loop (a reviewer may flag-gate a feature during review)
