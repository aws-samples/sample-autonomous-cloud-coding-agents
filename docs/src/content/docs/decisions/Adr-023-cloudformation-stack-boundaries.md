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
6. Keep one deployment-profile product for the census and normal build tests. Apply resource, byte, parameter, output and retention checks to every parent and nested template. The default budgets are 490 resources and 800,000 bytes per template; the normal build does not relax those limits for a particular backend.

## Implementation status

The branch contains exclusive compute selection, stateful retention, optional NetworkStack extraction and a 90-profile build gate covering both topologies. The retention aspect also covers the nested Blueprint ownership ledger, registry and consent-page resources. The standalone census measures each Blueprint handoff mode and can check repeatability in independent processes.

The 2026-09-21 offline census synthesized all 90 profiles twice in independent processes with managed Blueprint provisioning, fixed account/AZ inputs, metadata enabled and bundling/staging disabled. Every template passed the default budgets and retention checks, with zero assembly differences and no source changes during the run. The largest application template for each backend was:

| Backend | Inline resources | Split resources | Split headroom to 500 | Inline bytes | Split bytes |
|---|---:|---:|---:|---:|---:|
| AgentCore | 482 | 427 | 73 | 691,368 | 637,324 |
| ECS | 483 | 428 | 72 | 689,867 | 636,074 |
| Lambda MicroVMs | 489 | 434 | 66 | 709,799 | 655,784 |

Every split network template has 58 resources, four exports and at most 59,926 bytes. Moving networking removes 55 resources from the application and adds three across the assembly: the duplicated AWS custom-resource provider's function/role and network stack metadata. The widest MicroVM profile includes a managed image, Gateway, Registry, the Linear vault, alert email and a fork Blueprint. Its application has 56 resources of margin against the 490-resource build budget after extraction, compared with one before extraction.

These are measured maxima across the actual profile product, including the supplemental email/fork and external-consent profiles. They describe unbundled structure, not deployed resource identity or a bundled release's exact byte count. The census uses CDK's `DISABLE_ASSET_STAGING_CONTEXT`; a regression test verifies that assets are not copied into each profile directory.

`networkTopology=split` creates `${stackName}-network` and leaves the application name unchanged. Pure Blueprint definitions feed DNS policy and repository provisioning before either stack exists. The network interface is limited to VPC and runtime security-group references. Explicit VPC, private-subnet and runtime-security-group exports stay present for every backend, so a backend switch does not attempt to remove an in-use export. Generated Name tags and endpoint security-group descriptions keep their inline values, avoiding replacement-sensitive property changes. Network logs retain their lifecycle protections, and solution attribution covers CDK's generic provider Lambdas as well as L2 functions. ECS subnet environment expressions change from local references to imports, so CDK publishes a new orchestrator Lambda version and updates its existing alias. JSON is compact across parent and nested templates.

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
