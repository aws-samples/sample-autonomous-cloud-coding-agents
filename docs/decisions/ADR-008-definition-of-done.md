# ADR-008: Definition of Done (progressive maturity)

**Status:** proposed
**Date:** 2026-05-19

## Context

"Done" is implicit and varies by contributor. Some consider a passing build sufficient. Others expect documentation, tests, and deployment verification. Agents have no unambiguous checklist that tells them when work is complete. Over-engineering "done" early blocks velocity. Under-defining it ships incomplete work.

The definition must be progressive. It must rise as the project matures, so that it does not block early momentum but ensures quality at scale.

## Decision

### Progressive levels

**Level 1, Basic (minimum viable):**
- Code compiles without errors
- Existing tests pass (no regressions)
- New code has tests (unit level minimum)
- Linting passes
- PR description explains what and why
- Linked issue exists

**Level 2, Standard (current project default):**
- All of Level 1
- Pre-commit hooks pass
- CDK synth succeeds (if infrastructure changes)
- Security scans pass (no new HIGH or CRITICAL findings)
- Documentation updated if behavior changes
- Starlight mirrors synced (if docs changed)

**Level 3, Rigorous (critical paths):**
- All of Level 2
- Integration or E2E test covers the happy path
- Error paths tested
- Reviewer approved (human or qualified agent)
- Deployed to ephemeral stack and smoke-tested (if infrastructure)
- ADR written (if architectural decision made)

**Level 4, Self-verifying (future target):**
- All of Level 3
- A tabula rasa agent can replicate the outcome using only the docs
- CI includes behavioral verification
- Documentation drift detection passes

### Default level by issue type

| Issue type | Default level |
|-----------|---------------|
| Bug fix | Level 2 |
| New feature | Level 2-3 (based on blast radius) |
| Infrastructure/IAM change | Level 3 |
| Documentation only | Level 1 |
| Security fix | Level 3 |
| RFC/ADR implementation | Level 2 + ADR written |

An issue may override the default by specifying `Done: Level N` in its body.

### Verification responsibility

| Level | Who verifies |
|-------|-------------|
| 1 | CI (automated) |
| 2 | CI + self-check by implementor |
| 3 | CI + reviewer + implementor |
| 4 | CI + reviewer + independent agent |

## Consequences

- (+) Agents have an unambiguous completion checklist
- (+) Quality bar rises as the project matures
- (+) Over-engineering is prevented (Level 1 for simple docs changes)
- (+) Critical paths get rigorous verification (Level 3)
- (-) Requires labeling or explicit level assignment per issue
- (-) Level 4 is aspirational and depends on ADR-007 (knowledge acquisition)
- (!) The project must eventually move from a Level 2 default to a Level 3 default

## References

- Issue #139, the full RFC with open questions
- ADR-003, governance (ADR-003 defines when to start, and this ADR defines when to stop)
- ADR-007, knowledge acquisition (Level 4 depends on tabula rasa verification)
