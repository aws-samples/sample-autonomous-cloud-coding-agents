# ADR-028: One Cedar engine, in the agent

**Status:** proposed
**Date:** 2026-11-26

Per the [ADR lifecycle](./README.md#lifecycle), this decision remains proposed while its implementing PR is in review and becomes accepted when that PR merges.

When this record was written, open work held two numbers: the draft [#1086](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1086) adds an ADR-025, and the pull request [#1032](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1032) and the RFC [#1085](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1085) each propose an ADR-027. So it takes 028.

## Context

The agent evaluates every tool call with Cedar. Its engine ([`agent/src/policy.py`](../../agent/src/policy.py), on `cedarpy`) loads the built-in rules ([`hard_deny.cedar`](../../agent/policies/hard_deny.cedar), [`soft_deny.cedar`](../../agent/policies/soft_deny.cedar)) and the repository's own rules, and answers allow, deny or require approval.

A second engine, `@cedar-policy/cedar-wasm`, ran in one Lambda function, which loaded it from a Lambda layer. With it came a TypeScript copy of the built-in rules and a contract of fixtures that compared the decisions of both engines. What it was used for:

- It never decided a request. Its one consumer was a listing of rule ids, `GET /v1/repos/{repo_id}/policies`, behind `bgagent policies`.
- The design ([CEDAR_HITL_GATES.md](../design/CEDAR_HITL_GATES.md#3-design-decisions-locked)) also planned it for the validation of `rule:` approval scopes when a task is submitted. That validation was not built: task creation checks the syntax of a scope.
- The listing showed the built-in rules and the rules written inline in the repository's Blueprint, not those of the registry modules attached to it, which the agent enforces too. Its `summary` field was derived from the parsed condition, since no built-in rule carries the `@summary` annotation that would replace it.
- The pair had a cost: the fix [#1005](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1005) had to change both sides.

## Decision

1. **One engine.** The platform shall depend on one Cedar engine, the agent's `cedarpy`. Removed are the route `GET /v1/repos/{repo_id}/policies`, the command `bgagent policies`, the Lambda layer, the dependency `@cedar-policy/cedar-wasm`, the copy of the built-in rules and the parity contract. This withdraws decisions 19 and 23 of the design, and the listing part of decision 5.
2. **A repository's rules stay data.** They are on the repository's record, where the Blueprint property `security.cedarPolicies` puts them, and in registry modules. Both reach the agent with the task, and the agent parses them when the task starts.
3. **Where rule ids are found.** The built-in rules are a table in the [user guide](../guides/USER_GUIDE.md#rule-ids). Every approval request names the rules that gated the call (`bgagent pending`). An operator reads a repository's inline rules with `bgagent repo show <owner/repo> --output json`.
4. **One pin.** The agent package shall pin `cedarpy` to one exact version. An agent test shall name that version. When a change moves the version, its author shall move the version in the test in the same change. So a bump is made by hand, and it is judged by [`test_policy_builtin_rules.py`](../../agent/tests/test_policy_builtin_rules.py), [`test_cedarpy_annotations_contract.py`](../../agent/tests/test_cedarpy_annotations_contract.py) and [`test_policy_three_outcome.py`](../../agent/tests/test_policy_three_outcome.py).

## Consequences

- (+) One engine and one pin, where there were two engines joined by a contract. About 3,000 lines of code, tests and fixtures, one npm dependency, one Lambda layer and one Lambda function fewer.
- (+) The root stack has 12 resources fewer, none of them stateful. That is room under the 490-resource limit of [ADR-023](./ADR-023-cloudformation-stack-boundaries.md).
- (-) No listing through the API. A user without AWS credentials learns a repository's own rule ids from its approval requests.
- (-) A breaking change inside `/v1`, although the [API contract](../design/API_CONTRACT.md#base-url) says that breaking changes increment the version. The removal of `task_type` ([#248](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/248)) was made the same way. API Gateway answers an unknown route with 403, so an older CLI's `bgagent policies list` and `bgagent policies show` print `HTTP 403: Forbidden`. The remedy is to upgrade the CLI, which no longer has the command, and to find rule ids as point 3 above says.
- (!) On a deployed stack the update deletes the route, the function, the layer and the stack output `CedarWasmLayerArn`. The function's log group was created by Lambda, is not part of the stack, and stays until it is deleted by hand.
- (!) What the update deletes was read from the synthesized templates, and the answer to an older CLI from API Gateway's documented default. Neither was exercised against a deployed stack.
- (!) A `cedarpy` bump is judged by the agent's suites alone.

## References

- [CEDAR_HITL_GATES.md](../design/CEDAR_HITL_GATES.md), the design whose decisions 5, 19 and 23 this record changes
- [Cedar policy guide](../guides/CEDAR_POLICY_GUIDE.md), for the authors of a repository's rules
- [Gateway response types](https://docs.aws.amazon.com/apigateway/latest/developerguide/supported-gateway-response-types.html) of API Gateway: `MISSING_AUTHENTICATION_TOKEN`, status 403, for a request to an unsupported method or resource
