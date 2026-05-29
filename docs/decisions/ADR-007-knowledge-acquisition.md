# ADR-007: Knowledge acquisition through progressive failure

**Status:** proposed
**Date:** 2026-05-19

## Context

Agents with fresh context (tabula rasa) attempt to follow documentation and hit gaps they cannot resolve. These gaps are silently worked around (agent asks a human) rather than systematically fixed. The system cannot self-improve its onboarding because failures are not captured.

Knowledge acquisition starts from zero. Each iteration creates the roadmap to better knowledge by discovering gaps through actual failures.

## Decision

### Zero-context execution attempts

Periodically, an agent with no project memory attempts to follow guides end-to-end. The agent follows ONLY what is written — no inference, no training data knowledge, no asking colleagues.

### Failure capture protocol

At each failure point, the agent:
1. **Stops** — does not attempt to work around or guess
2. **Documents** — creates an issue: which document, which step, what was missing
3. **Continues** — attempts the next step (if possible) to find additional gaps

### Retrospectives

After completing a task, project milestone, or sprint, agents produce a retrospective artifact:
- What worked well (patterns to repeat)
- What failed or caused friction (patterns to avoid)
- Actionable experiments for future workflows

Retrospectives are a first-class knowledge artifact — they feed into documentation improvements, inform ADR amendments, and surface systemic issues that individual task failures cannot.

### Knowledge artifacts (interim)

Until documentation meets ADR-004, agents may create ephemeral artifacts:
- Semantic indices of the codebase (call graphs, dependency maps)
- Annotated walkthroughs of successful executions
- "What I learned" summaries after completing a task
- Retrospectives (see above)

These are scaffolding that informs documentation improvements, not documentation themselves.

### Maturity model

| Level | State | Agent capability |
|-------|-------|-----------------|
| 0 | No docs | Cannot start; files issue for missing docs |
| 1 | Partial docs | Follows docs, stops at gaps, files issues |
| 2 | Complete docs (ADR-004) | Completes end-to-end without help |
| 3 | Self-improving | Detects drift between docs and code, auto-files issues |

### The self-improvement loop

```
Agent starts fresh → follows docs → hits failure →
  files issue → issue gets fixed → next agent goes further →
    hits next failure → files issue → ...
      until end-to-end works from zero context
```

This runs continuously because code changes outpace documentation and different agent implementations fail at different points.

## Consequences

- (+) Documentation gaps become bugs with reproduction steps
- (+) Priority ordering emerges naturally (most common failures surface first)
- (+) The system self-improves without human identification of gaps
- (+) Creates a natural definition of "docs are done" (Level 2 achieved)
- (-) Generates issue volume that needs triage
- (-) Requires periodic investment in zero-context test runs
- (!) The gap between Level 1 and Level 2 may be large — patience required

## References

- Issue #138 — full RFC with open questions
- ADR-004 — defines the quality target (tabula rasa test)
- ADR-003 — governance for issues filed by failing agents
- ADR-008 — Level 4 Definition of Done depends on this protocol
