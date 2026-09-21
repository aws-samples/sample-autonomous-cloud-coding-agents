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
2. Deploy one compute backend per environment. Shared services such as Memory, Gateway, Registry and the Linear vault remain independently configurable. Existing additive deployments require a drained transition; see [Compute](../design/COMPUTE.md#selecting-and-changing-the-backend).
3. Install retention on stateful resources and destructive cleanup helpers before any ownership move. Preserve logical IDs, properties and helper resources while adding `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. Apply and verify this prerequisite on the currently deployed topology before deploying a release that removes resources.
4. Use a top-level `NetworkStack` as the first candidate for extraction: AgentVpc and DnsFirewall share a network lifecycle. Resolve Blueprint egress configuration before constructing either stack, and keep references from application to network only. Propagate solution attribution, provenance tags and applicable cdk-nag suppressions to both stacks.
5. Gate that extraction on a populated, disposable AWS rehearsal. Validate resource-type eligibility and execute `cdk refactor --unstable=refactor`, or a rehearsed retain/import fallback, against the exact candidate topology. Compare physical IDs, data, dependencies, routes and rollback behavior. A successful local synth is insufficient evidence.
6. Keep one deployment-profile product for the census and normal build tests. Apply resource, byte, parameter, output and retention checks to every parent and nested template. The default budgets are 490 resources and 800,000 bytes per template; the normal build does not relax those limits for a particular backend.

## Implementation status

The branch contains exclusive compute selection, stateful retention and a 43-profile build gate. The retention aspect also covers the nested Blueprint ownership ledger, registry and consent-page resources. The standalone census measures each Blueprint handoff mode and can check repeatability in independent processes.

The 2026-09-21 offline census synthesized all 43 profiles twice in independent processes with managed Blueprint provisioning, fixed account/AZ inputs, metadata enabled and bundling disabled. Every template passed the default budgets and retention checks, with zero assembly differences and no source changes during the run. The largest parent template for each backend was:

| Backend | Parent resources | Headroom to 500 | Parent bytes |
|---|---:|---:|---:|
| AgentCore | 480 | 20 | 690,065 |
| ECS | 483 | 17 | 689,691 |
| Lambda MicroVMs | 487 | 13 | 708,496 |

These are measured maxima across the actual profile product, including the supplemental email/fork and external-consent profiles. They describe unbundled structure, not deployed resource identity or a bundled release's exact byte count. The widest MicroVM profile includes a managed image, Gateway, Registry and the Linear vault. Its parent has only three resources of margin against the 490-resource build budget, so the network boundary remains relevant.

There is still one top-level application stack. NetworkStack extraction and a live refactor/import rehearsal are **not implemented or validated**. No stateful resource has been moved by this change. The intended boundary remains conditional on the live rehearsal above.

## Consequences

- Retention adds no CloudFormation resources and does not change service properties. Tests compare resource identities/properties and check S3 helper retention.
- Deleting a stack or disabling a protected optional service leaves retained resources that need explicit recovery or cleanup. TTLs and lifecycle expiry still run. Retention does not preserve running compute sessions or automatically reattach application roles.
- Managed Blueprint deletion still soft-deletes repository rows. The controller handoff remains a separate staged migration; retaining its table is not a substitute for that process.
- CloudFormation exports constrain later network updates. The eventual split needs a deployment and rollback procedure, not only a constructor refactor.
- Full-profile tests catch quota and retention regressions during the normal build, while the census retains reproducible evidence. Neither proves live AWS service compatibility.

## References

- [Developer guide: retention and decomposition](../guides/DEVELOPER_GUIDE.md#stateful-retention-and-stack-decomposition)
- [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [CloudFormation quotas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html)
- [Issue #852: measured alternatives and migration prerequisite](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)
