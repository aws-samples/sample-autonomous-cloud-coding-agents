# ADR-003: Contribution governance for async agents and humans

**Status:** accepted
**Date:** 2026-05-19

## Context

ABCA is designed for multiple autonomous agents to work concurrently on the codebase. Without explicit governance rules, agents duplicate effort, start unapproved work, ignore priority order, miss predecessors, and create merge conflicts that require human intervention to untangle.

The rules below define how any contributor — human or AI — picks up, owns, and delivers work. They prevent priority inversion, wasted rework, unauthorized scope creep, and silent conflicts at scale.

## Decision

### No PRs without an Issue

Every PR references an issue. The issue provides rationale, sufficient context for the solution to be obvious, and verifiable acceptance criteria.

### Issue quality bar

An issue is "ready for work" when the body, together with its linked context — comments, replies, predecessor issues, related PRs (open and merged), and downstream goals — gives the implementer enough to proceed without ambiguity. The body is the primary directive; comments and threads add solution-space context; predecessors establish environmental architecture; downstream issues inform alignment.

### Roadmap alignment

Issues align to the [product roadmap](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/guides/ROADMAP.md). Issues that do not align require explicit approval from a permitted user.

### Gated approval

Only permitted users can mark an issue `approved` — a GitHub Actions workflow validates that the label applicant is authorized. An issue is not workable until it is both approved and assigned. After approval, the issue is considered scope-frozen: further revisions that change deliverables require re-approval.

### Self-assignment on start

Unassigned means available. On starting work, self-assign. Multiple assignees (>1) require intentionality verification.

### Issue body as primary directive

The issue body provides the primary directive for implementation. Comments, replies, and clarifying answers add context to the solution space. Ideally the body is sufficient, but it need not be the exclusive source — the reviewer for implementation readiness should synthesize comments and replies with the body to surface inconsistencies and resolve ambiguities before commencing work.

Unresolved conflicts are marked explicitly:
- `**UNRESOLVED:** <question>` — blocks implementation
- `**DEFERRED:** <question> — tracked in #N` — does not block

### Pre-start review

Before implementation, the assigned contributor must:

**Synthesize context:** Read all comments and replies. Review predecessor issues and PRs (both merged and in-flight). Consider downstream goals and adjacent state (other open PRs, recent merges, dependency changes). Surface inconsistencies between body and thread before proceeding.

**Priority evaluation:** Identify priority (`p0`/`p1`/`p2`). If asked to work a lower-priority item while higher-priority items are unassigned, challenge: "Should I work on #X (p0) instead?"

**Predecessor validation:** If predecessors are incomplete, unassigned, and not in a stacked PR — challenge: "Steps 1-3 are incomplete. Starting step 4 may cause rework."

**Cross-reference audit:** Search open issues for duplicates. Search open PRs (including drafts) for conflicts. Flag overlaps. Check the full dependency graph. Forward-look into downstream actions to ensure alignment.

**Final gate:** If all checks pass, comment "Starting implementation."

### Identity and attribution

Agents use identifiable credentials. The prompting user and acting agent must be distinguishable. PRs include `Co-Authored-By` for AI contributors.

### Work-in-progress discipline

Provide progress signals at checkpoints. If blocked or abandoning, comment and unassign. Do not start multiple issues simultaneously unless explicitly parallelizable or serializable with declared ordering (where context from one directly informs the next).

### Completion and handoff

CI passes before requesting review. After merge, verify acceptance criteria and close. Create follow-up issues for discovered work before closing.

## Consequences

- (+) Prevents duplicate effort — assignment signals ownership
- (+) Prevents priority inversion — agents challenge low-priority requests
- (+) Prevents rework — predecessor validation catches out-of-order work
- (+) Issue body stays current — threads are folded back
- (+) Cross-reference audit catches duplicates early
- (-) Pre-start overhead for small tasks
- (-) Requires discipline to fold threads into body
- (!) Assumes priority labels exist and are maintained
- (!) Self-assignment is not atomic — concurrent agents may race; mitigate by verifying assignment after claiming via refresh

## References

- Issue #134 — full RFC with open questions and automation requirements
- Roadmap: Scale and collaboration (Agent swarm, Multi-user and teams)
- ADR-001 — delivery methodology referenced by completion rules
