# ADR-011: Conflict resolution protocol

**Status:** proposed
**Date:** 2026-05-19

## Context

Multiple concurrent contributors, human or AI, will propose incompatible approaches, create merge conflicts, and disagree on design. Without a defined escalation path, work stalls or the most insistent contributor wins.

## Decision

### Escalation ladder

```
Level 1: Contributor discussion (PR comments, issue thread)
   ↓ (no resolution within 2 interactions)
Level 2: Request additional reviewer (fresh perspective)
   ↓ (still no resolution)
Level 3: Competing proposals in the issue body (explicit trade-off comparison)
   ↓ (still no resolution)
Level 4: Admin decision (binding, documented in issue body)
```

### Decision criteria

When you compare approaches, evaluate them on these criteria:
1. **Correctness.** Does it solve the stated problem?
2. **Simplicity.** The approach with fewer parts wins when correctness is equal.
3. **Consistency.** Does it follow existing codebase patterns?
4. **Reversibility.** Can we change our mind later?
5. **Blast radius.** What breaks if this is wrong?

### Merge conflict ownership

| Situation | Who resolves |
|-----------|-------------|
| Two PRs modify same file, one merged first | Second PR's author rebases |
| Stacked PR conflict from lower change | Lower PR author notifies. Upper PRs rebase after the lower PR is stable |
| Concurrent agents modified same module | First to merge wins. Second adapts |
| Architectural conflict (both valid) | Escalate to Level 3 |

### Human vs. agent disagreement

- Agents present evidence (code, tests, measurements), not authority
- Humans can override but must document why
- Agents do not repeatedly argue a rejected point
- If an agent believes a human decision causes harm (security, data loss), it escalates to an admin

## Consequences

- (+) Disagreements have a defined path to resolution
- (+) Merge conflicts have clear ownership
- (+) Competing approaches are compared on criteria, not authority
- (+) An admin decision is the final step (no infinite loops)
- (-) Escalation takes time and may slow delivery
- (-) Level 3 (written trade-off) requires effort
- (!) Must not become a veto mechanism for slow contributors

## References

- Issue #142, the full RFC with open questions
- ADR-003, governance (issue body as resolution record)
- ADR-005, the feedback loop (reviewer disagreements feed into this protocol)
- ADR-009, security (authority levels for decisions)
