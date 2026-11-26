# ADR-007: Knowledge acquisition through progressive failure

**Status:** proposed
**Date:** 2026-05-19

## Context

Agents with fresh context (tabula rasa) attempt to follow documentation and hit gaps that they cannot resolve. These gaps are silently worked around (the agent asks a human) instead of systematically fixed. The system cannot improve its own onboarding, because failures are not captured.

Knowledge acquisition starts from zero. Each iteration creates the roadmap to better knowledge by discovering gaps through actual failures.

## Decision

### Zero-context execution attempts

Periodically, an agent with no project memory attempts to follow guides end-to-end. The agent follows ONLY what is written. It does not infer, use knowledge from training data, or ask colleagues.

### Failure capture protocol

At each failure point, the agent:
1. **Stops.** It does not attempt to work around the gap or to guess.
2. **Documents.** It creates an issue that names the document, the step, and what was missing.
3. **Continues.** It attempts the next step (if possible) to find additional gaps.

### Retrospectives

After completing a task, project milestone, or sprint, agents produce a retrospective artifact:
- What worked well (patterns to repeat)
- What failed or caused friction (patterns to avoid)
- Actionable experiments for future workflows

Retrospectives are a first-class knowledge artifact. They feed into documentation improvements, inform ADR amendments, and surface systemic issues that individual task failures cannot.

### Knowledge artifacts (interim)

Until documentation meets ADR-004, agents may create ephemeral artifacts:
- Semantic indices of the codebase (call graphs, dependency maps)
- Annotated walkthroughs of successful executions
- "What I learned" summaries after completing a task
- Retrospectives (see above)

These artifacts are temporary aids that inform documentation improvements. They are not documentation themselves.

### Maturity model

| Level | State | Agent capability |
|-------|-------|-----------------|
| 0 | No docs | Cannot start. Files an issue for missing docs |
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

The loop runs continuously, because code changes outpace documentation and different agent implementations fail at different points.

## Consequences

- (+) Documentation gaps become bugs with reproduction steps
- (+) Priority ordering emerges by itself (the most common failures surface first)
- (+) The system self-improves without human identification of gaps
- (+) Creates a definition of "docs are done" (Level 2 achieved)
- (-) Generates issue volume that needs triage
- (-) Requires periodic investment in zero-context test runs
- (!) The gap between Level 1 and Level 2 may be large, so patience is required

## References

- Issue #138, the full RFC with open questions
- ADR-004, which defines the quality target (tabula rasa test)
- ADR-003, governance for issues filed by failing agents
- ADR-008, whose Level 4 Definition of Done depends on this protocol
