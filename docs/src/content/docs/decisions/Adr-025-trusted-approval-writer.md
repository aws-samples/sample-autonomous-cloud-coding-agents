---
title: Adr 025 trusted approval writer
---

# ADR-025: Trusted approval writer

**Status:** proposed
**Date:** 2026-11-05

## Context

When a Cedar soft-deny gate fires, the agent records a `PENDING` approval row and moves its task to `AWAITING_APPROVAL`. Until now it wrote that row **directly** to the approvals DynamoDB table, using its task-scoped session credentials. The session role granted item-level read **and write** on the table, limited only by a `dynamodb:LeadingKeys` condition on the task's own ID.

Those credentials live in the same container that runs the repository's code: builds, tests, scripts. Malicious or prompt-injected repository code can therefore use them to write any approval record for its own task. That includes replacing a pending request with an approved one. The defect affects every backend: AgentCore, ECS and Lambda MicroVMs.

## Decision

Use a small IAM-authenticated API and Lambda as the **only** worker-facing approval writer.

- **Interface.** `POST /tasks/{task_id}` accepts exactly two operations: `create` (a `PENDING` request) and `timeout` (close a still-`PENDING` request as `TIMED_OUT`). It cannot record a human approval or denial, a decision source, notification markers, scope, or retention.
- **Binding.** The session role may invoke only `POST /tasks/${aws:PrincipalTag/task_id}`, so a worker can reach only its own task's path. Direct Lambda invocation is not granted, because Lambda does not expose caller session tags.
- **Validation.** The handler accepts only a fixed field set. It requires the row's owner and repository to match the task, and checks that `deadline_epoch` equals `created_at + timeout_s`. The writer itself sets the row's TTL from the validated deadline (plus the agent's 120 s cleanup margin), or from the task retention period when there is no automatic deadline. Workers no longer choose retention.
- **Atomicity.** `create` writes the request and transitions the task `RUNNING → AWAITING_APPROVAL` in one transaction, conditioned on the task's owner and state, and on no existing row with that ID. `timeout` updates only a `PENDING` row owned by the task's user, conditioned on the task still awaiting that request. A human decision that won the race leaves the transaction cancelled, and the worker re-reads and honors it.
- **Session role.** The approvals table leaves the session role's read/write task-scoped tables. The role keeps task-scoped **read-only** access (`GetItem`, `BatchGetItem`, `Query`, `ConditionCheckItem`), which is enough to poll decisions. Listing the table in both places fails synth.
- **Human decisions** remain exclusive to the owner-authenticated approve/deny handlers.
- **Wiring.** Every backend receives the API URL: the AgentCore runtime env, the ECS task env, and the Lambda MicroVM platform config (a required `approval_requests_api_url` contract key). The service is a nested stack, so it does not consume root-stack resource budget.

## Consequences

- **Upgrade order.** Images built before this change still write the table directly, and the new IAM policy denies that. Deploy matching infrastructure and images together, with in-flight tasks drained. A worker with a session role but no API URL fails closed at its first gate (`APPROVAL_REQUESTS_API_URL is required`). It does not fall back to direct writes.
- **Availability.** The service adds one signed request per creation and per closure, and becomes an availability dependency. A failure denies permission to proceed; it never becomes consent.
- **Limits of validation.** The service validates record shape and ownership, not the truth of worker-supplied policy descriptions. A preview can be truncated and is not proof of the full tool input. `TIMED_OUT` also covers a worker polling failure, so it is not proof that a human deadline elapsed.
- **Residual trust.** The compute role still chooses session tags when assuming the session role. This API protects the decision-writing boundary. It does not isolate a compromised worker from its ambient compute credentials.
- **Local and legacy paths.** Unscoped local runs with no session role keep the direct-table path for development.

## References

- [Issue #1000](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1000)
- [Approval trust boundaries](/sample-autonomous-cloud-coding-agents/architecture/cedar-hitl-gates)
- [ADR-021: Lambda MicroVM compute backend](/sample-autonomous-cloud-coding-agents/architecture/adr-021-lambda-microvms-compute-backend)
