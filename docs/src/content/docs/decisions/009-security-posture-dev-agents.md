---
title: 009 security posture dev agents
---

# ADR-009: Security posture and blast radius for development-time agents

**Status:** proposed
**Date:** 2026-05-19

## Context

The existing `SECURITY.md` covers runtime agent execution (inside MicroVMs). It does not cover **development-time agents** — those writing code, creating PRs, and modifying infrastructure in this repository. A development-time agent operates with the credentials of whoever invoked it, creating a risk of self-approval, policy modification, and unbounded blast radius.

The core principle: **planners and implementors must be separated by context and ideally by identity. No self-approval.**

## Decision

### Role separation

| Role | Can do | Cannot do |
|------|--------|-----------|
| **Planner** | Create/edit issues, write RFCs/ADRs, define roadmap and revisit vision | Write code, push branches, approve PRs |
| **Implementor** | Write code, create PRs, push branches, run tests | Approve own PRs, merge own PRs, modify CI/security config |
| **Reviewer** | Approve PRs, request changes, merge, suggest code (no commits) | Write code on the same PR being reviewed |
| **Admin** | All of the above + modify policies, approve issues | Still requires 2P for policy changes |

### Blast radius classification

| Action | Risk | Gate |
|--------|------|------|
| Edit code in existing patterns | Low | CI + peer review |
| Add new dependency | Medium | Security scan + review |
| Modify IAM policy / security config | High | 2P review + admin approval |
| Modify CI/CD workflow | High | 2P review + admin approval |
| Modify branch protection / approval rules | Critical | Admin-only + audit trail |
| Modify governance ADRs | Critical | Admin-only + 2P review |
| Delete or force-push protected branches | Critical | Never automated; human-only |

### 2P (two-person) review

For High and Critical actions:
- The author cannot be one of the two approvers
- At least one approver must be a human
- Approvals reference the specific risk being accepted

### No self-approval (structural)

- Branch protection requires review from someone other than the pusher
- Approval cannot come from the last committer on the branch
- If an agent plans AND implements, review must come from an identity that did neither
- The identity that writes code cannot approve or merge it

### Credential scoping

| Agent context | Minimum credentials |
|---------------|-------------------|
| Planning (issues, RFCs) | GitHub Issues write, read-only repo |
| Implementation (code, PRs) | Repo write, PR create, no merge capability |
| Review | PR review write, no push capability |
| Deployment | Separate deploy key, environment approval gate |

## Consequences

- (+) Prevents self-approval of dangerous changes
- (+) Blast radius is explicit and enforceable
- (+) Role separation enables audit trail
- (+) 2P review catches compromised or confused agents
- (-) Credential management complexity increases
- (-) Small tasks require multi-identity orchestration
- (!) Personal PATs grant all permissions — structural enforcement requires GitHub Apps or fine-grained tokens

## References

- Issue #140 — full RFC with open questions
- `docs/design/SECURITY.md` — runtime agent security (complementary)
- Cedar HITL gates (PR #88) — runtime tool-call governance
- ADR-003 — governance (approval gates enforced here technically)
