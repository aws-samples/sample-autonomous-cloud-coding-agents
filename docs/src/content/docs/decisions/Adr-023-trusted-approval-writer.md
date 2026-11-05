---
title: Adr 023 trusted approval writer
---

# ADR-023: Trusted approval writer and retained human decisions

**Status:** proposed
**Date:** 2026-09-21

## Context

Workers previously had direct write access to approval records. Restricting a
worker to its own task did not prevent it from replacing a pending request with
an approved record. MicroVM continuation makes the distinction between worker
authority and human consent especially important, but the same defect affects
ECS and AgentCore.

A short approval deadline also couples human response time to compute lifetime.
Someone taking time to consider a request should not lose it merely because the
worker should stop consuming resources.

## Decision

Use a small IAM-authenticated API and Lambda as the worker-facing approval
writer. Its interface creates a pending request or closes one after a worker
timeout/failure. It cannot record human approval or denial, notification markers,
or retention TTLs. Human decisions remain in the owner-authenticated decision
handlers. Workers retain approval reads and transaction condition checks.

The session role can invoke only the task path named by its `task_id` tag.
Creation atomically writes the request and transitions its task from running to
awaiting approval. The transaction checks the task owner/state and, for MicroVM,
the coordinator-owned worker lease. A stale worker cannot use its old lease to
create or close a request.

Unanswered requests have no decision deadline by default. Explicit positive
timeouts remain available. Task cancellation, terminal failure and invalidated
worker execution can close requests independently. Compute lifetime is separate:
MicroVM can checkpoint and release a worker while retaining a request; ECS and
AgentCore currently cannot restore that waiting execution into a replacement.
Their task execution limits still apply.

This implementation is included in the P3 review because retaining approvals
without protecting their decision records would preserve the security defect.
The ADR remains proposed for maintainer review.

## Consequences

- Existing deployments must pause submissions, drain old workers and deploy
  matching infrastructure and images. Old images still attempt direct writes,
  which the new IAM policy denies. See the
  [upgrade procedure](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#upgrading-approval-permissions).
- The service adds one signed request per creation/closure and becomes an
  availability dependency. Failure denies permission to proceed; it never
  becomes human consent.
- The service validates record shape, not the truth of worker-supplied policy
  descriptions. A preview can be truncated and is not a proof of the full tool
  input. `TIMED_OUT` currently also represents a worker polling failure; it is
  not proof that a human deadline elapsed. Human `DENIED` remains distinct.
- The compute role still chooses session tags when assuming the session role.
  This API protects the decision-writing boundary but does not provide full
  isolation from a compromised worker retaining ambient compute credentials.
- Linear consent is read back from Linear and must come from the mapped owner,
  excluding bots and the saved OAuth token's own identity. Other webhook paths
  still need a separate review of the legacy shared OAuth/signing-secret bundle.

## References

- [MicroVM backend, issue #645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645)
- [Implementation and security review, PR #904](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/904)
- [Approval trust boundaries](/sample-autonomous-cloud-coding-agents/architecture/cedar-hitl-gates#121-trust-boundaries)
- [ADR-021: Lambda MicroVM compute backend](/sample-autonomous-cloud-coding-agents/decisions/adr-021-lambda-microvms-compute-backend)
