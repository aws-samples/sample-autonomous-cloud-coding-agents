---
title: Adr 023 cloudformation stack boundaries
---

# ADR-023: CloudFormation stack boundaries and retention before decomposition

**Status:** proposed
**Date:** 2026-09-21
**Issue:** [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)

## Context

ABCA's application stack approaches CloudFormation's 500-resource limit. [#851](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/851) records the incident; #852 contains the measured alternatives. Template bytes are a separate limit tracked by [#735](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/735).

The Task API owns most resources, but its integrations share one API Gateway RestApi and deployment. The #852 proof of concept showed that moving an integration to another stack could lose deployment dependencies, CORS methods, solution attribution and tags even when synthesis succeeded. Networking has a more stable interface and a distinct deployment lifecycle.

Many data stores still used deletion policies that would destroy them when removed from a template. S3 adds another deletion path: retaining a bucket alone does not stop its cleanup custom resource from deleting objects. A stack move must address both resource ownership and these lifecycle callbacks.

## Decision

1. Keep the Task API, its authorizers, deployment, stage and all integrations attaching routes to that RestApi in the same application stack. A subsystem with its own API, such as RegistryApi, may keep its existing nested stack.
2. Deploy one compute backend per environment. Shared services such as Memory, Gateway, Registry and the Linear vault remain independently configurable. Existing additive deployments require a drained transition; see [Compute](/sample-autonomous-cloud-coding-agents/architecture/compute#selecting-and-changing-the-backend).
3. Install retention on stateful resources and destructive cleanup helpers before any ownership move. Preserve logical IDs, properties and helper resources while adding `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. Apply and verify this prerequisite on the currently deployed topology before deploying a release that removes resources.
4. Offer a top-level `NetworkStack` as the first extraction via `networkTopology=split` (default: `inline`): AgentVpc and DnsFirewall share a network lifecycle. Resolve Blueprint egress configuration before constructing either stack, and keep references from application to network only. Propagate solution attribution, provenance tags and applicable cdk-nag suppressions to both stacks.
5. Keep existing-resource migration explicit. Implementation continues without the populated AWS rehearsal requested in #852; it does not claim a validated migration path. Existing deployments must establish resource-type eligibility and an ownership-transfer plan using `cdk refactor --unstable=refactor` or retain/import. Compare physical IDs, data, dependencies, routes and rollback behavior before a production cutover. Changing topology in an ordinary deploy is not an ownership transfer.
6. Keep one deployment-profile product for the census and normal build tests. Apply resource, byte, parameter, output and retention checks to every parent and nested template. The production app also sets CDK's `@aws-cdk/core:stackResourceLimit` to 490, so actual operator configurations fail synthesis above the budget even when they are outside the sampled product. A context override can tighten that ceiling but cannot raise it. The census's `--max-resources` option also permits only a tighter audit ceiling. The byte budget remains 800,000 bytes per template.

## Implementation status

The branch contains exclusive compute selection, stateful retention, optional NetworkStack extraction and a 96-profile build gate covering both topologies. The original 90 profiles use two-zone auto-pin; six additional profiles pin three supported zones on the widest configuration for each backend and topology. With managed Blueprint provisioning, 93 profiles synthesize within budget and three must fail at the production resource ceiling. Legacy/prepare provisioning has four expected rejections because it adds one application resource. Expected failures must name the application stack and the 490-resource ceiling; an unrelated failure or unexpected synthesis success fails the gate. The retention aspect also covers the nested Blueprint ownership ledger, registry and consent-page resources. The standalone census measures each Blueprint handoff mode and can check repeatability in independent processes.

The 2026-09-21 offline census established repeatability for the earlier 90-profile implementation. A subsequent review found that removing retained, named AgentCore log groups would orphan their names and prevent a later backend switch back to AgentCore. Both groups now remain owned by the application stack for every backend, with stable logical IDs and retention policies. This adds two resources to ECS and MicroVM configurations.

The updated 2026-09-22 boundary measurements use managed Blueprint provisioning, fixed account/AZ inputs, metadata enabled and bundling/staging disabled. For the widest configurations with two-zone auto-pin:

| Backend | Inline resources | Split resources | Split headroom to 500 | Inline bytes | Split bytes |
|---|---:|---:|---:|---:|---:|
| AgentCore | 482 | 427 | 73 | 691,368 | 637,324 |
| ECS | 485 | 430 | 70 | 691,663 | 637,870 |
| Lambda MicroVMs | 491 (rejected) | 436 | 64 | — | 657,602 |

With two zones, each split network template has 58 resources, four exports and at most 59,926 bytes. Moving networking removes 55 resources from the application and adds three across the assembly: the duplicated AWS custom-resource provider's function/role and network stack metadata. The widest MicroVM profile includes a managed image, Gateway, Registry, the Linear vault, alert email and a fork Blueprint. Its application has 54 resources of margin against the 490-resource build budget after extraction; its inline counterpart is now rejected at 491. The corresponding two-zone MicroVM profile without the supplemental email and fork still passes at 489.

The 2026-09-22 three-zone boundary measurements expose the documented `agentcore:availabilityZones` override, which uses every requested zone even though auto-pin remains capped at two:

| Backend, widest managed profile | Inline resources | Production synthesis | Split application resources |
|---|---:|---|---:|
| AgentCore | 490 | Accepted at the ceiling | 427 |
| ECS | 493 | Rejected above 490 | 430 |
| Lambda MicroVMs | 499 | Rejected above 490 | 436 |

The third zone adds eight network resources. Every three-zone split network template has 66 resources and five exports; all split counterparts remain within budget. Legacy/prepare provisioning adds one application resource to each row, so its three-zone inline AgentCore case is rejected at 491 too. Adopt has the same resource counts as managed. Use split topology for these over-budget combinations; existing inline deployments still require the explicit ownership transfer below. The application never changes topology automatically to satisfy a budget.

These are measured configurations, including the supplemental email/fork and external-consent profiles, rather than an upper bound on every possible operator override. They describe unbundled structure, not deployed resource identity or a bundled release's exact byte count. The census uses CDK's `DISABLE_ASSET_STAGING_CONTEXT`; a regression test verifies that assets are not copied into each profile directory.

`networkTopology=split` creates `${stackName}-network` and leaves the application name unchanged. Pure Blueprint definitions feed DNS policy and repository provisioning before either stack exists. The network interface is limited to VPC and runtime security-group references. Explicit VPC, private-subnet and runtime-security-group exports stay present for every backend, so a backend switch does not attempt to remove an in-use export. Generated Name tags and endpoint security-group descriptions keep their inline values, avoiding replacement-sensitive property changes. Network logs retain their lifecycle protections, and solution attribution covers CDK's generic provider Lambdas as well as L2 functions. ECS subnet environment expressions change from local references to imports, so CDK publishes a new orchestrator Lambda version and updates its existing alias. JSON is compact across parent and nested templates.

AZ reductions require a separate staged update. `networkReservedAzs` preserves unused address slots so removing a trailing AZ does not shift the remaining private subnet CIDRs. Deploy the target application with `--exclusively` first, verify that removed exports have no consumers, then update the network. Synthesis tests compare the old network with the target application and verify stable remaining subnet properties for AgentCore, ECS and MicroVM. The [deployment procedure](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#reducing-azs-in-an-existing-split-network) keeps AZ order and total active/reserved slots fixed; it does not establish a live migration guarantee.

Local comparisons verify unchanged shared API resources, CORS, permissions and deployment dependencies; unchanged application service properties after resolving imports and the expected ECS orchestrator version references; identical moved network definitions apart from construct-path metadata; and a one-way application-to-network dependency. Live refactor/import eligibility, physical resource preservation and rollback remain **unvalidated**. No cloud deployment or physical resource move was performed.

## Consequences

- Retention adds no CloudFormation resources and does not change service properties. Tests compare resource identities/properties and check S3 helper retention.
- Deleting a stack or disabling a protected optional service leaves retained resources that need explicit recovery or cleanup. TTLs and lifecycle expiry still run. Retention does not preserve running compute sessions or automatically reattach application roles.
- Managed Blueprint deletion still soft-deletes repository rows. The controller handoff remains a separate staged migration; retaining its table is not a substitute for that process.
- CloudFormation exports constrain later network updates. The [deployment guide](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#network-stack-topology) distinguishes fresh split deployments from existing-resource ownership transfers and describes the remaining migration requirements.
- Full-profile tests catch quota and retention regressions during the normal build, while the census retains reproducible evidence. Neither proves live AWS service compatibility.

## References

- [Developer guide: retention and decomposition](/sample-autonomous-cloud-coding-agents/developer-guide/introduction#stateful-retention-and-stack-decomposition)
- [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [CloudFormation quotas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html)
- [Issue #852: measured alternatives and migration prerequisite](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)
