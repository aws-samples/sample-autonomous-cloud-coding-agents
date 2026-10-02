# ADR-023: Optional network stack and deployment budgets

**Status:** proposed
**Date:** 2026-09-21
**Last-updated:** 2026-10-02
**Issue:** [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)

Per the [ADR lifecycle](./README.md#lifecycle), this decision remains proposed while its implementing PR is in review and becomes accepted when that PR merges. This record does not approve or waive the existing-stack migration criteria in #852.

## Context

The application stack approaches CloudFormation's 500-resource limit. [#851](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/851) records the incident; approved issue #852 covers resource budgets, template bytes and stack boundaries. [#735](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/735) is related byte-limit evidence, not a separate approval for this implementation.

The Task API owns most resources, but its integrations share one API Gateway RestApi and deployment. The #852 proof of concept showed that extracting an integration can lose deployment dependencies, CORS, solution attribution and tags even when synthesis passes. Networking has a smaller interface and an independent lifecycle.

Live review of an earlier #912 revision found that broad retention blocks failed-create retries and same-name redeploys, while Blueprint ownership handoff can lose repository settings and orphan PITR-enabled ledger tables. Those changes are removed from this PR. The reviewed scope is the optional network stack, deployment budgets and compatible compute selection.

## Decision

1. Keep the Task API, authorizers, deployment, stage and route integrations together in the application stack. Preserve existing nested stacks for Registry, RegistryApi and hosted consent pages.
2. Offer `networkTopology=split` for new installations; `inline` remains the default. Move AgentVpc and DnsFirewall into `${stackName}-network`, resolve Blueprint egress definitions before either stack is constructed, and permit application-to-network references only. Keep VPC/subnet/security-group exports present across backend changes and preserve network properties, attribution and provenance tags.
3. Select one or more backends with `compute_types`; its first entry is the repository default. Preserve legacy `compute_type` behavior, including AgentCore alongside ECS or MicroVM. Removing a backend requires an explicit list that omits it. Publish the complete ordered list in `ComputeTypes` and `ComputeSubstrate`; the CLI and orchestrator enforce membership. Shared optional services remain independent.
4. Enforce CDK's `@aws-cdk/core:stackResourceLimit` at 490 before constructing stacks, including nested stacks and operator configurations outside the census. Operators may tighten but cannot raise it. Share the census profile product with the normal build, checking every template against resource, byte, parameter and output budgets and preserving method-scoped API permissions. Default byte budget: 800,000.
5. Keep current resource removal policies, Blueprint provisioning and guardrail versioning. Existing inline-to-split migration, broad retention and Blueprint controller handoff are deferred. Local template comparisons do not satisfy the populated refactor/import and rollback rehearsal required by #852.

## Validation scope

The 116-profile product covers all single-backend/service/image combinations in both topologies, supplemental alert/fork/consent options, explicit three-AZ pins, every multi-backend set at default and widest settings, and legacy additive selectors. Expected over-budget profiles must fail at the production 490-resource ceiling for the application stack; an unrelated error or unexpected success fails the gate. Real CDK metadata is included. The census records per-template measurements and source provenance with bundling and asset staging disabled; it does not measure a deployed stack.

Network tests compare moved logical IDs and service properties, the complete export interface, application data resources and lifecycle policies, shared API routes and permissions, attribution and one-way dependencies. Their comparisons control the clock and account for the existing alpha guardrail and orchestrator version IDs. The independent-process `--check-stability` diagnostic keeps timestamps, IDs and asset hashes intact and reports existing churn; passing budget checks does not imply deterministic synthesis.

`networkReservedAzs` preserves unused address slots when removing trailing AZs. Tests verify that the target application can use the old network, release the removed export, and keep every remaining subnet's properties. The [application-first procedure](../guides/DEPLOYMENT_GUIDE.md#reducing-azs-in-an-existing-split-network) is separate from moving an inline network into another stack. Physical-ID preservation and rollback in AWS still require live verification.

## Deferred migration work

The following remain under #852 and need separate review and releases before a supported existing-stack migration:

- **Retention lifecycle:** use appropriate per-resource policies, including `RetainExceptOnCreate` where retaining established data is needed without orphaning a failed first create. Verify fixed-name log groups and external registries can be recovered, imported or cleaned up before a same-name reinstall. Retaining an S3 bucket alone must not leave a destructive cleanup callback active.
- **Blueprint downgrade protection:** refuse an unsafe return from managed ownership to the legacy writer even when a context flag is omitted. Prove `max_turns`, `compute_type`, `onboarded_at` and other CLI overrides survive updates and rollback. A green deployment must not hide row replacement or tombstoning.
- **Ownership release and re-onboarding:** adoption must have a defined release path. Removing a repository must not block legitimate re-onboarding for the tombstone TTL. Test retries, owner changes and out-of-order callbacks.
- **Ledger lifecycle and bootstrap coverage:** establish a bounded cleanup/recovery plan for PITR-enabled ownership tables across mode changes, failures and destroy. Any future `Custom::BlueprintRepoConfig` must be represented in the bootstrap resource-action map and its coverage tests before it ships.
- **Guardrail and image normalization:** review stable version binding and Docker build-context changes separately from network ownership. They are not prerequisites for reporting truthful census differences.
- **Populated migration rehearsal:** verify refactor/import eligibility for each moved type and provider, preserve physical IDs and data, test networking and API behavior, and execute rollback. Retention must be installed on source resources before a transfer; an ordinary topology flag change is not a move. The criterion remains open, without an author-only waiver.

The [teardown guidance](../guides/DEPLOYMENT_GUIDE.md#teardown-blocked-by-agentcore-network-interfaces) covers the separately observed AgentCore ENI cleanup delay, which also occurs on `main`.

## Consequences

- New split installations gain application headroom without widening API Gateway permissions or changing repository ownership.
- Existing legacy compute contexts retain AgentCore. Ordered lists let repositories choose among deployed backends; older CLIs require AgentCore to remain present and first on additive stacks.
- Exports constrain later network changes. Application consumers must release an export before the network removes it.
- Resource and template budgets are checked locally; live deployment, migration and rollback remain separate evidence.

## References

- [Developer guide: synthesis budgets](../guides/DEVELOPER_GUIDE.md#stack-decomposition-and-synthesis-budgets)
- [Deployment guide: network topology](../guides/DEPLOYMENT_GUIDE.md#network-stack-topology)
- [Compute selection](../design/COMPUTE.md#selecting-and-changing-the-backend)
- [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [CloudFormation quotas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html)
