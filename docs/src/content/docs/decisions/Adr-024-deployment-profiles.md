---
title: "ADR-024: Deployment profiles and regional capability validation"
---

**Status:** proposed
**Date:** 2026-10-25
**Issue:** [#836](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/836)

Per the [ADR lifecycle](/sample-autonomous-cloud-coding-agents/decisions/readme#lifecycle), this decision remains proposed until its implementing PR merges.

## Context

The application stack deploys Slack, Linear, Jira, deploy-preview screenshots and the Agent Registry whether or not an operator uses them. Each adds Lambdas, tables, secrets, IAM grants, API routes and alarms, so unused integrations cost money, slow deploys, add to what a security review must cover and consume the root stack's 490-resource budget ([ADR-023](/sample-autonomous-cloud-coding-agents/decisions/adr-023-cloudformation-stack-boundaries)). Some depend on Region-limited services. AWS Agent Registry is available in nine Regions, and AgentCore Memory, which every deployment uses, is available in sixteen. A deployment to an unsupported Region fails late, inside CloudFormation, with an opaque service error.

Issue #836 also suggests moving substantial optional modules into nested stacks. Slack, Linear, Jira and screenshots each attach methods to the shared Task API `RestApi`. ADR-023 §1 and the #852 proof of concept record that extracting such integrations loses deployment dependencies, CORS, attribution and tags even when synthesis passes. Moving their tables and secrets would replace them.

## Decision

1. **One validated selection.** `main.ts` resolves `DeploymentFeatures` (`cdk/src/deployment/features.ts`) once and passes it to `AgentStack`. Constructs read the selection and never read feature context directly. The optional features are `slack`, `linear`, `jira`, `deployPreviewScreenshots`, `agentRegistry` and `toolGateway`. Authentication, Cedar HITL, secure egress, task state, admission control, GitHub workflow, alarms and diagnostics are core and not selectable.
2. **Persistent profile.** `abca.deployment.json` at the repository root is the shared input for local and CI synthesis. The file has `schemaVersion: 1`, every feature is an explicit boolean, and unknown keys are rejected. The order of precedence is the per-feature context switch (`enableSlack`, `enableLinear`, `enableJira`, `enableDeployPreviewScreenshots`, `enableAgentRegistry`, `enableToolGateway`), then the profile, then the legacy topology. `-c deploymentProfile=<path>` selects another file. `-c deploymentProfile=none` ignores the profile. The synthesis census uses that setting so that a developer's profile cannot change the census results.
3. **An absent profile means the legacy topology.** Without a profile, everything that deploys today still deploys, and Tool Gateway stays opt-in. Shipping profiles deletes nothing from existing installations.
4. **Omit, do not relocate.** A disabled feature synthesizes no routes, WAF body-size exemptions, Lambdas, grants, tables, secrets, wiring, alarms or outputs. Enabled features stay in the application stack, with the existing Registry nested stacks unchanged. Headroom comes from omission, which is safe. Relocation is not safe without the populated migration rehearsal that ADR-023 defers. The stranded-orchestration sweep and the iteration heartbeat deploy only with Linear or Jira. The wiring from screenshots to Linear or Jira exists only when screenshots and that tracker are both enabled. Two parts of the issue's "shared orchestration" scope stay core. The orchestration table and the live reconciler remain because the reconciler also owns the per-task budget rollup. The task table's `LinearIssueIndex` and `JiraIssueIndex` remain because removing a GSI is a schema change outside this decision. A `DeploymentFeatures` output records the selection so that tools can read it back.
5. **Regional capability catalog.** `contracts/deployment-capabilities.json` records, per capability, the required services, supported Regions, remediation, maturity, footprint and statefulness, with the source URL and last-verified date. CDK reads the JSON directly. The CLI keeps a package-safe literal mirror that a parity test enforces (the `contracts/constants.json` pattern). `AgentStack` rejects an unsupported concrete Region during synthesis, so the CLI is not the only enforcement point. Environment-agnostic synthesis is not checked.
6. **`bgagent setup`.** The wizard runs these steps in order:
   - It resolves the Region first and checks core availability.
   - It lists every feature but marks unavailable ones as unselectable.
   - It preselects features already deployed, which it reads from `DeploymentFeatures` or infers for older stacks.
   - It recommends the minimal profile for new stacks.
   - It diffs a temporary candidate profile, so cancelling leaves the repository untouched.
   - It asks for explicit confirmation before deleting or replacing state-bearing resources, then writes the profile and deploys through the existing mise task.

   Non-interactive runs fail on an unsupported feature. To remove state-bearing resources, they require `--accept-data-loss` in addition to `--yes`. Operator subcommands for an omitted feature fail early with a pointer to `bgagent setup` when they can identify the stack, either from `--stack-name` or as the stack the CLI was configured from.

7. **First-install compute and account preparation.** Issue #836 kept compute out of the first wizard. This record extends the wizard for new installations only, where no backend can be removed.
   - The wizard asks where agents run (AgentCore, ECS, or both) and records the ordered list as the profile's optional `compute`. The `compute_types` or `compute_type` context still wins.
   - On existing stacks the wizard reads the deployed backends from `ComputeTypes`. Stacks from before #912 publish only `ComputeSubstrate`. If `ComputeSubstrate` names a backend other than AgentCore, the wizard requires `--compute` and does not guess. Adding a backend is allowed. Removing one is refused in favour of the COMPUTE.md transition procedure.
   - After confirmation and before the deploy, the wizard installs or updates ABCA's least-privilege CDK bootstrap and sets the bootstrap `ComputeTypes` parameter, which always includes AgentCore. The wizard never modifies a standard CDK bootstrap that other apps may share.

8. **Several deployments per checkout and account.** The wizard confirms the caller's account through STS, lists the existing ABCA stacks in the Region, and offers to update one or to create a new, named one. Each non-default stack reads only `abca.deployment.<stackName>.json`. It never reads the shared file, which belongs to the default stack. A stack without its own file therefore keeps the legacy topology (rule 3), and one checkout can drive several deployments without one profile deleting another's modules. When the account uses ABCA's least-privilege bootstrap, whose deploy role is scoped to `backgroundagent-dev` and `backgroundagent-dev-*`, the wizard creates stacks only with those names. A create outside that scope fails and cannot roll back its IAM roles. A bootstrap parameter for other prefixes is a follow-up.

## Consequences

- (+) The minimal profile synthesizes 317 root resources against 463 for the legacy topology (−146), with the corresponding IAM, secrets and routes, and fails fast in unsupported Regions.
- (+) The shared census grows to 142 profiles. The new cells cover minimal, each single feature, the paired trackers/screenshots and all features in both topologies. They assert that disabled features leave nothing behind and that catalogued footprints track synthesis.
- (+) One input file feeds local deploys, CI and the wizard. Existing context switches keep working.
- (-) Disabling a stateful feature deletes its tables and secrets (`RemovalPolicy.DESTROY` today). Re-enabling the feature creates empty resources, and operators must re-run the feature's setup command. No import path is provided.
- (-) Regional data is a maintained copy of AWS documentation and can go stale. A stale entry fails closed and blocks a newly supported Region until the catalog is updated. The update process is in the [deployment guide](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#deployment-profiles).
- (!) Strict boolean parsing now rejects malformed `enableToolGateway`, `enableAgentRegistry` (unchanged) and the new switches. Values that were previously treated as `false`, such as `enableToolGateway=yes`, now fail synthesis. `enableLinearIdentityVault` keeps its lenient reading.
- (!) Legacy-default stacks in core Regions without AWS Agent Registry (7 of 16) now fail at synthesis instead of at the registry custom resource. Such stacks could never deploy the registry. The error names the profile key and the context switch that disable the registry.
- (!) Enabling every feature leaves the root stack where it is today. Nested-stack extraction of route-owning integrations remains out of scope until ADR-023's migration criteria are met.

## References

- [#836](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/836), [#735](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/735), [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)
- [ADR-023: Optional network stack and deployment budgets](/sample-autonomous-cloud-coding-agents/decisions/adr-023-cloudformation-stack-boundaries)
- [Supported AgentCore Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
- [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
