# ADR-003: Contribution governance for async agents and humans

**Status:** accepted
**Date:** 2026-05-19

## Context

ABCA is designed for multiple autonomous agents to work concurrently on the codebase. Without explicit governance rules, agents duplicate effort, start unapproved work, ignore priority order, miss predecessors, and create merge conflicts that require human intervention to untangle.

The rules below define how any contributor — human or AI — picks up, owns, and delivers work. They prevent priority inversion, wasted rework, unauthorized scope creep, and silent conflicts at scale.

## Decision

### No branches without an Issue

Every feature branch references an issue in its name (e.g., `feat/123-short-description` or `fix/456-bug-name`). A branch without an issue reference is unauthorized work. This prevents the failure mode where work is started "just to explore" and then snowballs into a PR without governance.

### No PRs without an Issue

Every PR references an issue. The issue provides rationale, sufficient context for the solution to be obvious, and verifiable acceptance criteria.

### Issue quality bar

An issue is "ready for work" when the body, together with its linked context — comments, replies, predecessor issues, related PRs (open and merged), and downstream goals — gives the implementer enough to proceed without ambiguity. The body is the primary directive; comments and threads add solution-space context; predecessors establish environmental architecture; downstream issues inform alignment.

### Roadmap alignment

Issues align to the [product roadmap](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/guides/ROADMAP.md). Issues that do not align require explicit approval from a permitted user.

### Gated approval

Only permitted users can mark an issue `approved` — a GitHub Actions workflow validates that the label applicant is authorized. An issue is not workable until it is both approved and assigned. After approval, the issue is considered scope-frozen: further revisions that change deliverables require re-approval.

### Assignments

Unassigned means available. Assignment may happen via self-assignment, directed assignment by another agent/human, or priority-based pickup (inspect open tasks for highest priority + earliest predecessor). Multiple assignees (>1) require intentionality verification.

### Issue body as primary directive

The issue body provides the primary directive for implementation. Comments, replies, and clarifying answers add context to the solution space. Ideally the body is sufficient, but it need not be the exclusive source — the reviewer for implementation readiness should synthesize comments and replies with the body to surface inconsistencies and resolve ambiguities before commencing work.

Unresolved conflicts are marked explicitly:
- `**UNRESOLVED:** <question>` — blocks implementation
- `**DEFERRED:** <question> — tracked in #N` — does not block

### Pre-start review

Before implementation, the assigned contributor must:

**Synthesize context:** Read all comments and replies. Review predecessor issues and PRs (both merged and in-flight). Consider downstream goals and adjacent state (other open PRs, recent merges, dependency changes). Surface inconsistencies between body and thread before proceeding.

**Priority evaluation:** Identify priority (`p0`/`p1`/`p2`). If asked to work a lower-priority item while higher-priority items are unassigned, challenge: "Should I work on #X (p0) instead?"

**Predecessor validation (GraphQL dependency graph is authoritative):**
- Query the issue's `blockedBy` field via GraphQL — if any blocking issue is open, this issue is **not ready** (hard gate)
- Check `parent`/`subIssues` ordering — verify prior siblings are complete or in-flight
- Reconcile graph vs. prose — graph is authoritative for enforcement; prose explains rationale
- If predecessors are incomplete, unassigned, and not in a stacked PR — challenge: "Steps 1-3 are incomplete. Starting step 4 may cause rework."

**Cross-reference audit:** Search open issues for duplicates. Search open PRs (including drafts) for conflicts. Flag overlaps. Check the full dependency graph. Forward-look into downstream actions to ensure alignment.

**Dependency graph maintenance:** When creating/modifying issues with dependencies, use GraphQL mutations (`addBlockedBy`, `addSubIssue`) to maintain the machine-enforceable graph. Update prose to explain rationale. If they diverge, fix the wrong one (usually prose — graph is set programmatically).

**Final gate:** If all checks pass, comment "Starting implementation."

### Identity and attribution

Agents use identifiable credentials. The prompting user and acting agent must be distinguishable. PRs include `Co-Authored-By` for AI contributors.

### Work-in-progress discipline

Provide progress signals at checkpoints. If blocked or abandoning, comment and unassign. Do not start multiple issues simultaneously unless explicitly parallelizable or serializable with declared ordering (where context from one directly informs the next).

### Completion and handoff

CI passes before requesting review. After merge, verify acceptance criteria and close. Create follow-up issues for discovered work before closing.

### Conversational approval is NOT issue approval

A user saying "yes, do it" or "go ahead" in a conversation does NOT satisfy the governance gate. The correct response to conversational approval is:

1. Create an issue with acceptance criteria
2. Request the `approved` label from an admin
3. Self-assign once approved
4. Then begin implementation

**Known failure mode:** Agents interpret conversational momentum ("Yes start with X") as authorization to skip issue creation. This is the most common governance bypass — it feels like permission because the user explicitly directed the work, but the governance requires a *durable, reviewable artifact* (the issue), not a transient conversation.

**Why this matters:** Conversations are ephemeral. Issues are auditable. If an agent creates work based on a conversation and that conversation is lost (context compaction, session end), no record exists of what was authorized, what the acceptance criteria were, or why the work was started.

### Enforcement mechanisms (planned)

Prose governance is necessary but insufficient. The following enforcement points are planned to prevent bypass progressively. Mechanisms are deployed incrementally — see #186 for implementation tracking.

| Mechanism | Layer | What it catches | Status |
|-----------|-------|-----------------|--------|
| AGENTS.md directive | Agent prompt | Explicit instruction: "Do NOT begin implementation without an approved issue, even if the user says 'go ahead' in conversation" | Implemented |
| Branch name convention | Git workflow | Branch must match `(feat|fix|chore|docs)/<issue-number>-*` — rejects branches without issue reference | Planned |
| Commit-msg hook (Tier 0) | Pre-commit | Rejects commits without `Refs #N` or `Fixes #N` | Planned |
| Pre-push hook (Tier 1) | Pre-push | Validates referenced issue exists and has `approved` label via `gh` API | Planned |
| Claude Code hook (`PreToolUse: Write`) | Agent runtime | Blocks file creation in governed paths without declared issue context | Planned |
| Skill gate: `pickup-issue` | Agent workflow | Agent must invoke before implementation — hard-fails without valid issue | Planned |

**Transition:** Branch naming and commit-msg rules apply to branches created after the corresponding hooks are deployed. Existing branches (including this PR's) pre-date enforcement.

**Progressive enforcement:** Start with the commit-msg hook (cheapest, catches all contributors). Add pre-push validation next. Skill gates enforce at the agent-workflow level (see ADR-012, proposed, for the skill model).

## Consequences

- (+) Prevents duplicate effort — assignment signals ownership
- (+) Prevents priority inversion — agents challenge low-priority requests
- (+) Prevents rework — predecessor validation catches out-of-order work
- (+) Issue body stays current — threads are folded back
- (+) Cross-reference audit catches duplicates early
- (+) Enforcement mechanisms catch bypass at multiple points
- (-) Pre-start overhead for small tasks
- (-) Requires discipline to fold threads into body
- (-) Commit-msg hook adds friction for rapid iteration on approved work
- (!) Assumes priority labels exist and are maintained
- (!) Self-assignment is not atomic — concurrent agents may race; mitigate by verifying assignment after claiming via refresh
- (!) Conversational approval bypass is the most common failure — enforcement must be structural, not behavioral

## References

- Issue #134 — full RFC with open questions and automation requirements
- Roadmap: Scale and collaboration (Agent swarm, Multi-user and teams)
- ADR-001 — delivery methodology referenced by completion rules
- ADR-012 (proposed) — operational knowledge stack; planned enforcement via skill gates
- ADR-013 (proposed) — tiered validation; planned enforcement hooks at Tier 0 and Tier 1
