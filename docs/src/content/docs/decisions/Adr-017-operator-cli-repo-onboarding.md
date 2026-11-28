---
title: "ADR-017: Operator CLI repo onboarding"
---

**Status:** accepted
**Date:** 2026-06-22 · amended 2026-11-26

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

## Amendment (2026-11-26): the CLI writes every per-repo setting that is plain data

Under decision 1 the CLI set six settings (compute type, runtime ARN, model, token secret, turn limit, poll interval) and left the rest to a `Blueprint` and a deploy. Most of the rest is plain data in the repository's `RepoTable` record: it creates no AWS resource, yet changing it took a deploy. The CLI now writes it. The amendment has two points, so that the second can be withdrawn on its own:

1. **Plain settings.** `bgagent repo onboard` also sets the cost budget, the memory token budget, the approval-gate cap, the build and lint commands, the system prompt additions, and the MCP server and skill pins, and it refuses a turn limit outside 1 to 500. `--unset <column>` removes a setting, so that the platform default applies again. Both writers of the record make the same merging write: an `UpdateItem` that changes only the attributes it names and leaves the rest of the record as it is. A setting that a Blueprint declares is written again by every deploy, and a Blueprint no longer removes a registry asset list that it leaves out: it detaches one by declaring it as `[]`.
2. **Cedar.** `bgagent repo onboard` also sets a repository's Cedar policies (`--cedar-policy-file`) and its Cedar policy module pins (`--cedar-policy-module`). Neither writer parses the policy text: the agent's engine does when a task starts, and a task whose policies it cannot load fails. This point stands on its own: without it the two flags go, and `--unset` still removes both columns.

**What stays with a deploy.** Egress domains, which only a Blueprint declares (`networking.egressAllowlist`), and IAM for a custom runtime or token secret: the CLI stores the ARN, the grant is made in CDK.

**Audit records.** Decision 3 accepted the audit gap for v1 and tied structured audit records to the moment the operator write path "graduates from expedient to primary". This amendment makes that path the documented default ([REPO_ONBOARDING.md](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding#onboarding-mechanism)). The follow-up is therefore due, and it is still open: this amendment adds no audit record.
