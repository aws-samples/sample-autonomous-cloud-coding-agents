---
title: Adr 017 operator cli repo onboarding
---

# ADR-017: Operator CLI repo onboarding

**Status:** accepted
**Date:** 2026-06-22

## Context

Issue [#378](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/378) filed `bgagent repo onboard` / `offboard` under P2 with a dependency on `POST /v1/repos`. Operators still need a way to register repos without a full CDK redeploy for the common case (platform-default runtime ARN and GitHub token secret). PR [#385](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/385) ships the CLI write path first.

`REPO_ONBOARDING.md` previously stated that onboarding is CDK-only with no runtime repo CRUD. That remains true for **task submitters** (no REST API), but is incomplete for **operators** who can mutate `RepoTable` with IAM credentials.

Vision tenet 7 (observable, attributable) expects config-changing operations to leave an audit trail. `onboard` / `offboard` change `runtime_arn`, `github_token_secret_arn`, and related fields with no platform audit event today.

## Decision

1. **Allow operator CLI writes to `RepoTable`.** `bgagent repo onboard` and `offboard` are supported day-2 paths that reuse the same `RepoConfig` schema and soft-delete semantics as the `Blueprint` construct (`status=removed` + 30-day TTL). They do not replace CDK for repos that need Cedar policies, egress rules, pipeline customization, or orchestrator IAM for custom runtime/token ARNs.

2. **Defer `POST /v1/repos`.** A REST API for repo CRUD remains future work. The CLI path is intentionally out-of-band (operator IAM, not Cognito task credentials) until an API design lands.

3. **Accept the audit gap for v1; track follow-up.** Operator onboard/offboard mutations are attributable only via CloudTrail DynamoDB API calls and local CLI output — not via `TaskEventsTable` or an equivalent platform audit stream. A follow-up issue should add structured audit records (actor, repo, before/after diff, timestamp) when the operator write path graduates from expedient to primary.

## Consequences

### Positive

- Operators can onboard a repo and submit a task in minutes without editing CDK and redeploying.
- Same gate behavior: non-onboarded repos still return `422 REPO_NOT_ONBOARDED`.
- Honest onboard notes warn when CDK deploy is still required for custom ARNs.

### Negative

- Two onboarding paths (CDK vs CLI) require documentation discipline; `REPO_ONBOARDING.md` now describes both.
- No first-class platform audit event on CLI mutations until follow-up work ships.
- CLI cannot express full Blueprint surface area (Cedar, egress, pipeline).

### Follow-up

- Structured audit events for `repo onboard` / `offboard` (and eventual `POST /v1/repos`).
- REST API for repo CRUD when operator IAM is not the desired control plane.
