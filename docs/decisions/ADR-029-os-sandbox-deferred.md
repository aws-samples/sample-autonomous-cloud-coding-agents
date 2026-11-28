# ADR-029: OS-level sandbox (Strands Box) deferred

**Status:** proposed
**Date:** 2026-11-26

Per the [ADR lifecycle](./README.md#lifecycle), this decision remains proposed while the PR that adds this record is in review and becomes accepted when that PR merges.

When this record was written, open work held the numbers 025 (the draft [#1086](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1086)) and 027 (the pull request [#1032](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1032) and the RFC [#1085](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1085)), and 028 was proposed in the same change. So it takes 029.

## Context

The agent's tool calls are governed inside the agent process: a hook evaluates each call with Cedar and allows it, denies it, or holds it until a person decides ([CEDAR_HITL_GATES.md](../design/CEDAR_HITL_GATES.md)). Outside the process, the boundary is the isolated runtime of the session ([SECURITY.md](../design/SECURITY.md#blast-radius)).

[Strands Box](https://github.com/strands-agents/box) runs a coding agent in an operating-system sandbox. A process outside the sandbox checks each shell command, network request and MCP call against a default-deny policy, and puts credentials into requests as they leave, so that the agent holds placeholders. Version 0.3.2 (pre-1.0, in preview) was evaluated in two roles: as a replacement for the Cedar gates and our own policy code, and as a layer under them. Nothing was run. The facts below are from its documentation.

## Decision

No OS-level sandbox for now, in either role. Against a replacement there are three reasons, each sufficient:

1. **No approval verdict.** A Box decision is allow or deny, made locally. No rule can hold a request for a person, and a protocol for pending decisions is an open issue ([strands-agents/box#646](https://github.com/strands-agents/box/issues/646)). A replacement would remove human approval.
2. **Backends.** To start, Box creates namespaces and mounts. It did not start under Docker's default configuration; the run that worked had an adjusted system-call filter, AppArmor profile and system-path restrictions. ECS Fargate has no setting for any of the three, so by documentation Box cannot be made to start there. For an AgentCore Runtime customer container, and for Lambda MicroVM as we configure it (no added OS capabilities, a non-root user), its documentation lists what to check and records no tested configuration.
3. **The file tools are outside its policy.** Claude Code's Write and Edit tools write through the agent's own system calls, which reach a granted path with no decision and no record. Its checks on native file operations are experimental. Our rules on file paths would have no counterpart.

With Box as a layer under the gates, human approval and our rules on file paths would stay, so reasons 1 and 3 do not apply. Reason 2 still applies, and the layer would add a second policy language and tests to qualify it on each backend, and remove almost none of our code.

Revisit when all of these hold:

- Box has a pending decision that a remote approver can answer, with a timeout that denies.
- Its policy sees the writes of the file tools, or we decide that agents write through the shell only.
- It starts on every [backend](../design/COMPUTE.md#compute-options) we keep.
- A release has a stated support window for security fixes.

When the four conditions above hold, whoever reopens this decision shall first probe start-up on those backends, with no product code.

## Consequences

- (+) No second policy language and no new dependency.
- (-) Egress and credentials stay as documented: the blast radius in [SECURITY.md](../design/SECURITY.md#blast-radius) and the limitations of the DNS allowlist in [COMPUTE.md](../design/COMPUTE.md#dns-firewall).
- (!) Claude Code's own Bash sandbox (`ClaudeAgentOptions.sandbox` in the Claude Agent SDK) was not evaluated.

## References

- Strands Box [v0.3.2](https://github.com/strands-agents/box/tree/v0.3.2): [no approval verdict](https://github.com/strands-agents/box/blob/v0.3.2/docs/design/decisions.md#there-is-no-approval-verdict), [Linux requirements and tested configurations](https://github.com/strands-agents/box/blob/v0.3.2/docs/user/linux-requirements.md), [cloud deployment profiles](https://github.com/strands-agents/box/blob/v0.3.2/docs/user/cloud-deployments.md), [when the box asks policy](https://github.com/strands-agents/box/blob/v0.3.2/docs/user/policy.md#when-the-box-asks-policy), [supported versions](https://github.com/strands-agents/box/blob/v0.3.2/SECURITY.md)
- [Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html) and `dockerSecurityOptions` in the [container definition reference](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html), for what a Fargate task cannot configure
