---
title: "ADR-023: Optional network stack and deployment budgets"
---

**Status:** proposed
**Date:** 2026-09-21
**Last-updated:** 2026-11-24
**Issue:** [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)

Per the [ADR lifecycle](/sample-autonomous-cloud-coding-agents/decisions/readme#lifecycle), this decision remains proposed while its implementing PR is in review and becomes accepted when that PR merges. This record does not approve or waive the existing-stack migration criteria in #852.

## Context

The application stack approaches CloudFormation's 500-resource limit. [#851](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/851) records the incident. Approved issue #852 covers resource budgets, template bytes and stack boundaries. [#735](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/735) is related byte-limit evidence, not a separate approval for this implementation.

The Task API owns most resources, but its integrations share one API Gateway RestApi and deployment. The #852 proof of concept showed that extracting an integration can lose deployment dependencies, CORS, solution attribution and tags even when synthesis passes. Networking has a smaller interface and an independent lifecycle.

Live review of an earlier #912 revision found two problems. Broad retention blocks failed-create retries and same-name redeploys. Blueprint ownership handoff can lose repository settings and orphan PITR-enabled ledger tables. Those changes are removed from this PR. The reviewed scope is the optional network stack, deployment budgets and compatible compute selection.

## Decision

1. Keep the Task API, authorizers, deployment, stage and route integrations together in the application stack. Preserve the existing nested stacks for Registry, RegistryApi and hosted consent pages.
2. Offer `networkTopology=split` for new installations. `inline` remains the default. Move AgentVpc and DnsFirewall into `${stackName}-network`. Resolve Blueprint egress definitions before either stack is constructed. Permit references only from the application stack to the network stack. Keep the VPC, subnet and security-group exports present across backend changes, and preserve network properties, attribution and provenance tags.
3. Select one or more backends with `compute_types`. Its first entry is the repository default. Preserve legacy `compute_type` behavior, including AgentCore alongside ECS or MicroVM. Removing a backend requires an explicit list that omits it. Publish the complete ordered list in `ComputeTypes` and `ComputeSubstrate`. The CLI and the orchestrator enforce membership. Shared optional services remain independent.
4. Enforce CDK's `@aws-cdk/core:stackResourceLimit` at 490 before constructing stacks, including nested stacks and operator configurations outside the census. Operators may tighten the limit but cannot raise it. Share the census profile product with the normal build, check every template against resource, byte, parameter and output budgets, and preserve method-scoped API permissions. The default byte budget is 800,000.
5. Keep the current resource removal policies, Blueprint provisioning and guardrail versioning. Migration of an existing stack from inline to split, broad retention and Blueprint controller handoff are deferred. Local template comparisons do not satisfy the populated rehearsal of refactor or import and of rollback that #852 requires.

## Validation scope

The 122-profile product covers all single-backend/service/image combinations in both topologies, the supplemental alert, fork and consent options, explicit three-AZ pins, expanded model grants, every multi-backend set at default and widest settings, and legacy additive selectors. The expanded-model profiles add synthetic model IDs to the platform defaults, enough for CDK to split the policy of the SessionRole and of each backend's compute role into overflow policies. They do not assert live model availability. The audit exceptions of each of those roles follow its generated overflow policies. The SessionRole's exceptions remain scoped to tenant object prefixes and literal model grants, and a compute role's overflow policies carry the exception of its base policy. A profile marked over budget must fail at the production 490-resource ceiling for the application stack. An unrelated error or an unexpected success fails the gate. Since the scheduled-maintenance and MicroVM subsystems moved into nested stacks, no sampled profile is over budget. Real CDK metadata is included. The census records per-template measurements and source provenance with bundling and asset staging disabled. It does not measure a deployed stack.

Network tests compare moved logical IDs and service properties, the complete export interface, application data resources and lifecycle policies, shared API routes and permissions, attribution and one-way dependencies. Their comparisons control the clock and account for the orchestrator version ID on ECS, which differs between the topologies with the subnet references in the function's environment. The independent-process `--check-stability` diagnostic keeps timestamps, IDs and asset hashes intact and reports existing churn. Passing the budget checks does not imply deterministic synthesis.

`networkReservedAzs` preserves unused address slots when an operator removes trailing AZs. Tests verify that the target application can use the old network, release the removed export, and keep every remaining subnet's properties. The [application-first procedure](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#reducing-azs-in-an-existing-split-network) is separate from moving an inline network into another stack. Physical-ID preservation and rollback in AWS still require live verification.

## Deferred migration work

The following items remain under #852. They need separate review and releases before the migration of an existing stack is supported:

- **Retention lifecycle.** Use appropriate per-resource policies, including `RetainExceptOnCreate` where established data must be retained without orphaning a failed first create. Verify that fixed-name log groups and external registries can be recovered, imported or cleaned up before a same-name reinstall. Retaining an S3 bucket alone must not leave a destructive cleanup callback active.
- **Blueprint downgrade protection.** Refuse an unsafe return from managed ownership to the legacy writer even when a context flag is omitted. Prove that `max_turns`, `compute_type`, `onboarded_at` and other CLI overrides survive updates and rollback. A green deployment must not hide row replacement or tombstoning.
- **Ownership release and re-onboarding.** Adoption must have a defined release path. Removing a repository must not block legitimate re-onboarding for the tombstone TTL. Test retries, owner changes and out-of-order callbacks.
- **Ledger lifecycle and bootstrap coverage.** Establish a bounded plan for cleanup and recovery of PITR-enabled ownership tables across mode changes, failures and destroy. Any future `Custom::BlueprintRepoConfig` must be represented in the bootstrap resource-action map and its coverage tests before it ships.
- **Image normalization.** Review Docker build-context changes separately from network ownership. They are not prerequisites for reporting truthful census differences. The stable version binding of the guardrail, deferred with them, shipped separately ([#1079](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1079)).
- **Populated migration rehearsal.** Verify refactor or import eligibility for each moved type and provider, preserve physical IDs and data, test networking and API behavior, and execute rollback. Retention must be installed on source resources before a transfer. An ordinary topology flag change is not a move. The criterion remains open, without an author-only waiver.

The [teardown guidance](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#teardown-blocked-by-agentcore-network-interfaces) covers the separately observed AgentCore ENI cleanup delay, which also occurs on `main`.

## Consequences

- New split installations gain application headroom without widening API Gateway permissions or changing repository ownership.
- Existing legacy compute contexts retain AgentCore. Ordered lists let repositories choose among deployed backends. Older CLIs require AgentCore to remain present and first on additive stacks.
- Exports constrain later network changes. Application consumers must release an export before the network removes it.
- Resource and template budgets are checked locally. Live deployment, migration and rollback remain separate evidence.

## References

- [Developer guide: synthesis budgets](/sample-autonomous-cloud-coding-agents/developer-guide/repository-preparation#stack-decomposition-and-synthesis-budgets)
- [Deployment guide: network topology](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#network-stack-topology)
- [Compute selection](/sample-autonomous-cloud-coding-agents/architecture/compute#selecting-and-changing-the-backend)
- [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [CloudFormation quotas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html)

## Changelog

- 2026-11-21 — The validation scope also covers the overflow policies of each backend's compute role, which carry the audit exception of the role's base policy (#916). The expanded-model profiles add enough synthetic model IDs for CDK to split the policy of the SessionRole and of each compute role (decision unchanged).
- 2026-11-24 — The version of the input guardrail now has a logical ID that contains a hash of the guardrail's configuration (#1079). That change is the stable version binding that decision 5 left as it was and that the deferred work listed for a separate review. The network tests no longer account for that ID and account only for the orchestrator version ID on ECS. The deferred item now names the image alone (decision unchanged).
