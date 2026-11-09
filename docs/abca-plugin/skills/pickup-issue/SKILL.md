---
name: pickup-issue
description: >-
  ADR-003 governance gate — verify an approved, assigned GitHub issue exists
  BEFORE writing any code. Invoke before starting implementation. Hard-fails if
  there is no valid `approved` issue. Use when the user says "start work",
  "implement this", "pick up an issue", "begin the task", "let's build X",
  "go ahead and code", "start coding", "claim issue", or directs implementation
  without first pointing to an approved issue.
argument-hint: <issue-number>
---

# Pick Up an Issue (ADR-003 Governance Gate)

You are enforcing the ABCA contribution-governance gate defined in
[ADR-003](../../../decisions/ADR-003-contribution-governance.md). **No code is
written until a durable, approved, assigned issue exists.** This is a hard gate,
not advice — if any check below fails, STOP and do not begin implementation.

> **Why this exists:** The most common governance bypass is treating
> conversational momentum ("yes, go ahead") as authorization. Conversations are
> ephemeral; issues are auditable. This skill forces the check that the branch
> and commit hooks cannot: that the issue is *approved* and *assigned* before a
> single file changes. See ADR-003 "Conversational approval is NOT issue
> approval".

## When to hard-fail (STOP — do not implement)

- No issue number was provided and none can be identified.
- The referenced issue does not exist.
- The issue lacks the `approved` label.
- The issue is closed.
- The issue is unassigned, or is assigned to someone other than the acting
  identity without declared intentionality (multiple assignees need
  intentionality per ADR-003 "Assignments").
- The governance repository resolves to a **fork** (see Step 0) — a fork's
  issue tracker is writable by the contributor, so its `approved` label is
  self-grantable and gates nothing.

In any of these cases, respond with the specific failure and the remediation
(create the issue / request the `approved` label from an admin / self-assign),
then STOP. Do NOT create branches, write files, or run implementation commands.

## Step 0: Resolve the governance repository

**Every `gh` call below must be pinned with `--repo`.** CONTRIBUTING tells
contributors to "push to a fork and open a PR against `main`", so in the normal
workflow the local `origin` is the contributor's own fork. An unpinned
`gh issue view`/`edit`/`comment` resolves the repository from the git remotes,
which on a fork can land on the contributor's copy — where they can add the
`approved` label themselves and self-bypass this entire gate.

```bash
# Source of truth for issues and the `approved` label. Override to reuse this
# skill in another repository (see "Adapting this skill" at the end).
REPO="${ABCA_GOVERNANCE_REPO:-aws-samples/sample-autonomous-cloud-coding-agents}"

# Hard-fail if the governance repo is a fork — its `approved` label is
# self-grantable, so the gate would be decorative. This also stops
# ABCA_GOVERNANCE_REPO from being used as a bypass.
gh repo view "$REPO" --json isFork,nameWithOwner \
  --jq 'if .isFork then error("governance repo \(.nameWithOwner) is a fork") else .nameWithOwner end'
```

## Step 1: Identify the issue

Determine the target issue number from the user's request or the current branch
name (which, per ADR-003, encodes it as `(feat|fix|chore|docs)/<issue-number>-*`).

```bash
# From an explicit number the user gave, or extract from the branch:
git rev-parse --abbrev-ref HEAD   # e.g. feat/186-adr003-hooks -> 186
```

If no issue number can be determined, **hard-fail**: ask the user to create an
issue with acceptance criteria and obtain the `approved` label first.

## Step 2: Verify the issue is approved and workable

Query GitHub. The issue must exist, be OPEN, carry the `approved` label, and be
assigned.

```bash
gh issue view <N> --repo "$REPO" --json number,title,state,labels,assignees \
  --jq '{number,title,state,labels:[.labels[].name],assignees:[.assignees[].login]}'
```

Validate the response:

| Field | Required | Hard-fail if |
|-------|----------|--------------|
| `state` | `OPEN` | closed |
| `labels` | contains `approved` | missing `approved` |
| `assignees` | contains the acting identity | empty (unassigned) or assigned only to others |

If `assignees` is empty, self-assign before proceeding:

```bash
gh issue edit <N> --repo "$REPO" --add-assignee @me
# then re-read to confirm sole ownership (self-assignment is not atomic —
# ADR-003 warns concurrent agents may race; verify after claiming)
gh issue view <N> --repo "$REPO" --json assignees --jq '[.assignees[].login]'
```

## Step 3: Pre-start synthesis (ADR-003 "Pre-start review")

Before implementing, synthesize context so the body + thread are unambiguous:

- **Read the full thread** — body, comments, replies. Surface any inconsistency
  between the body (primary directive) and later clarifications.
- **Check for blockers** — any `**UNRESOLVED:** <question>` in the body or
  thread blocks implementation. `**DEFERRED:** <question> — tracked in #N` does
  not block.
- **Predecessor validation** — the dependency graph is authoritative:

  ```bash
  gh api graphql -f query='
    query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        issue(number:$num){
          title
          trackedInIssues(first:20){ nodes{ number title state } }   # blockedBy
        }
      }
    }' -f owner="${REPO%%/*}" -f repo="${REPO##*/}" -F num=<N>
  ```

  If any blocking issue is OPEN, this issue is **not ready** — hard-fail.
- **Priority evaluation** — if asked to work a lower-priority item while higher
  `p0`/`p1` items are unassigned, challenge before proceeding.
- **Cross-reference audit** — search open issues/PRs (including drafts) for
  duplicates or conflicts; flag overlaps.

## Step 4: Final gate

Only if ALL checks pass:

1. Comment "Starting implementation." on the issue (the durable start signal).
2. Confirm to the user that the gate passed and implementation may begin.

```bash
gh issue comment <N> --repo "$REPO" --body "Starting implementation."
```

If any check failed, you have already stopped at that step. Do not reach Step 4.

## Relationship to the git hooks

This skill is the **agent-workflow** layer of ADR-003 enforcement. It complements
but does not replace the git hooks (which every contributor, human or agent,
also gets):

- **commit-msg hook** (`scripts/hooks/check-commit-msg.mjs`) — rejects commits
  with no `Refs #N` / `Fixes #N` / `Closes #N` reference.
- **branch-name hook** (`scripts/hooks/check-branch-name.mjs`, pre-push) —
  rejects branches not matching `(feat|fix|chore|docs)/<issue-number>-*`.

The hooks catch *unreferenced* work mechanically; this skill catches
*unapproved* work before it starts (the hooks cannot query the `approved` label
without network access at commit time).

## Adapting this skill to another repository

The gate itself is generic — only the policy it enforces is ABCA-specific. To
reuse it elsewhere, set one environment variable:

```bash
export ABCA_GOVERNANCE_REPO=<owner>/<repo>
```

That repointing is deliberately the *only* runtime knob, because it is the one
with a security consequence: point it at a repository whose labels the
contributor cannot grant themselves (Step 0 hard-fails on a fork for exactly
this reason). Everything else below is policy a forking project edits once in
its own copy of this file:

| Assumption | Where it appears | ABCA value |
|------------|------------------|------------|
| Governance repo | Step 0 (`$REPO`) | `aws-samples/sample-autonomous-cloud-coding-agents` |
| Approval label | Steps 2, 4 | `approved` |
| Branch-name pattern | Step 1 | `(feat\|fix\|chore\|docs)/<issue-number>-<desc>` |
| Blocker markers | Step 3 | `**UNRESOLVED:**` blocks; `**DEFERRED:** … tracked in #N` does not |
| Blocking-dependency source | Step 3 | GraphQL `trackedInIssues` (the dependency graph, not prose) |
| Start signal | Step 4 | a `Starting implementation.` issue comment |
| Governing document | throughout | [ADR-003](../../../decisions/ADR-003-contribution-governance.md) |

Keep the branch-name pattern in sync with `scripts/hooks/check-branch-name.mjs`
and the issue-reference keywords with `scripts/hooks/check-commit-msg.mjs` — the
skill and the hooks enforce two halves of the same policy.
