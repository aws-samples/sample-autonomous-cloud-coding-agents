---
title: "ADR-003: Contribution governance for async agents and humans"
---

**Status:** accepted
**Date:** 2026-05-19
**Last-updated:** 2026-11-26

## Context

ABCA is designed for multiple autonomous agents to work concurrently on the codebase. Without explicit governance rules, agents duplicate effort, start unapproved work, ignore priority order, miss predecessors, and create merge conflicts that a human must resolve.

The rules below define how any contributor, human or AI, picks up, owns, and delivers work. They prevent priority inversion, wasted rework, unauthorized scope creep, and silent conflicts at scale.

## Decision

### No branches without an Issue

Every feature branch references an issue in its name (for example, `feat/123-short-description` or `fix/456-bug-name`). A branch without an issue reference is unauthorized work. This rule prevents the failure mode where someone starts work "just to explore" and the work then grows into a PR without governance.

### No PRs without an Issue

Every PR references an issue. The issue provides the rationale, enough context to make the solution obvious, and verifiable acceptance criteria.

### Issue quality bar

An issue is "ready for work" when the body, together with its linked context, gives the implementer enough to proceed without ambiguity. The linked context is the comments, replies, predecessor issues, related PRs (open and merged), and downstream goals. The body is the primary directive. Comments and threads add solution-space context. Predecessors establish environmental architecture. Downstream issues inform alignment.

### Priority alignment

Issues are prioritized with GitHub labels such as `P0` and `P1`. Issues without a clear priority require explicit approval from a permitted user.

### Gated approval

Only permitted users can mark an issue `approved`. A GitHub Actions workflow validates that the user who applies the label is authorized. An issue is not workable until it is both approved and assigned. After approval, the scope of the issue is frozen. Further revisions that change deliverables require re-approval.

### Assignments

Unassigned means available. Assignment may happen through self-assignment, directed assignment by another agent or human, or priority-based pickup (inspect open tasks for the highest priority and the earliest predecessor). More than one assignee requires a check that the multiple assignment is intentional.

### Issue body as primary directive

The issue body provides the primary directive for implementation. Comments, replies, and clarifying answers add context to the solution space. Ideally the body is sufficient, but it need not be the only source. The reviewer for implementation readiness should combine comments and replies with the body, to surface inconsistencies and resolve ambiguities before work starts.

Unresolved conflicts are marked explicitly:
- `**UNRESOLVED:** <question>` blocks implementation.
- `**DEFERRED:** <question> — tracked in #N` does not block.

### Pre-start review

Before implementation, the assigned contributor must:

**Synthesize context.** Read all comments and replies. Review predecessor issues and PRs (both merged and in-flight). Consider downstream goals and adjacent state (other open PRs, recent merges, dependency changes). Surface inconsistencies between body and thread before proceeding.

**Priority evaluation.** Identify the priority (`p0`, `p1`, or `p2`). If you are asked to work on a lower-priority item while higher-priority items are unassigned, challenge the request: "Should I work on #X (p0) instead?"

**Predecessor validation (GraphQL dependency graph is authoritative):**
- Query the issue's `blockedBy` field through GraphQL. If any blocking issue is open, this issue is **not ready** (hard gate).
- Check the `parent` and `subIssues` ordering. Verify that prior siblings are complete or in-flight.
- Reconcile the graph with the prose. The graph is authoritative for enforcement. The prose explains the rationale.
- If predecessors are incomplete, unassigned, and not in a stacked PR, challenge: "Steps 1-3 are incomplete. Starting step 4 may cause rework."

**Cross-reference audit.** Search open issues for duplicates. Search open PRs (including drafts) for conflicts. Flag overlaps. Check the full dependency graph. Look ahead at downstream actions to make sure that the work aligns with them.

**Dependency graph maintenance.** When you create or modify issues with dependencies, use GraphQL mutations (`addBlockedBy`, `addSubIssue`) to maintain the machine-enforceable graph. Update the prose to explain the rationale. If the graph and the prose diverge, fix the wrong one. The wrong one is usually the prose, because the graph is set programmatically.

**Final gate.** If all checks pass, comment "Starting implementation."

### Identity and attribution

Agents use identifiable credentials. The prompting user and the acting agent must be distinguishable. PRs include `Co-Authored-By` for AI contributors.

### Work-in-progress discipline

Provide progress signals at checkpoints. If you are blocked or you abandon the work, comment and unassign yourself. Do not start multiple issues at the same time unless they are explicitly parallelizable, or serializable with a declared ordering (where context from one directly informs the next).

### Completion and handoff

Request review only after CI passes. After the merge, verify the acceptance criteria and close the issue. Create follow-up issues for discovered work before you close it.

### Conversational approval is NOT issue approval

A user saying "yes, do it" or "go ahead" in a conversation does NOT satisfy the governance gate. The correct response to conversational approval is:

1. Create an issue with acceptance criteria
2. Request the `approved` label from an admin
3. Self-assign once approved
4. Then begin implementation

**Known failure mode.** Agents interpret conversational momentum ("Yes start with X") as authorization to skip issue creation. This is the most common governance bypass. It looks like permission because the user explicitly directed the work, but the governance requires a *durable, reviewable artifact* (the issue), not a transient conversation.

**Why this matters.** Conversations are ephemeral. Issues are auditable. If an agent creates work based on a conversation and that conversation is lost (through context compaction or the end of the session), no record exists of what was authorized, what the acceptance criteria were, or why the work was started.

### Enforcement mechanisms (planned)

Prose governance is necessary but insufficient. The following enforcement points are planned to prevent bypass progressively. The mechanisms are deployed incrementally. See #186 for implementation tracking.

| Mechanism | Layer | What it catches | Status |
|-----------|-------|-----------------|--------|
| AGENTS.md directive | Agent prompt | Explicit instruction: "Do NOT begin implementation without an approved issue, even if the user says 'go ahead' in conversation" | Implemented |
| Branch name convention | Git workflow | Branch must match `(feat\|fix\|chore\|docs)/<issue-number>-*`. Rejects branches without an issue reference | Planned |
| Commit-msg hook (Tier 0) | Pre-commit | Rejects commits without `Refs #N` or `Fixes #N` | Planned |
| Pre-push hook (Tier 1) | Pre-push | Validates that the referenced issue exists and has the `approved` label, through the `gh` API | Planned |
| Claude Code hook (`PreToolUse: Write`) | Agent runtime | Blocks file creation in governed paths without a declared issue context | Planned |
| Skill gate: `pickup-issue` | Agent workflow | Agent must invoke it before implementation. Hard-fails without a valid issue | Planned |

**Transition.** Branch naming and commit-msg rules apply to branches created after the corresponding hooks are deployed. Existing branches (including this PR's) pre-date enforcement.

**Progressive enforcement.** Start with the commit-msg hook (cheapest, catches all contributors). Add pre-push validation next. Skill gates enforce at the agent-workflow level (see ADR-012, proposed, for the skill model).

## Consequences

- (+) Prevents duplicate effort, because assignment signals ownership
- (+) Prevents priority inversion, because agents challenge low-priority requests
- (+) Prevents rework, because predecessor validation catches out-of-order work
- (+) Issue body stays current, because threads are folded back
- (+) Cross-reference audit catches duplicates early
- (+) Enforcement mechanisms catch bypass at multiple points
- (-) Pre-start overhead for small tasks
- (-) Requires discipline to fold threads into body
- (-) Commit-msg hook adds friction for rapid iteration on approved work
- (!) Assumes priority labels exist and are maintained
- (!) Self-assignment is not atomic, so concurrent agents may race. Mitigate by verifying the assignment with a refresh after claiming
- (!) Conversational approval bypass is the most common failure, so enforcement must be structural, not behavioral

## References

- Issue #134, the full RFC with open questions and automation requirements
- ADR-001, the delivery methodology that the completion rules reference
- ADR-012 (proposed), the operational knowledge stack, for the planned enforcement through skill gates
- ADR-013 (proposed), tiered validation, for the planned enforcement hooks at Tier 0 and Tier 1

## Changelog

- 2026-11-10 — Escaped the `|` characters in the branch-name pattern of the enforcement table. Unescaped, each one ended the table cell: the row rendered as `(feat`, `fix` and nothing else, losing the rest of the rule and its status (decision unchanged).
- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
