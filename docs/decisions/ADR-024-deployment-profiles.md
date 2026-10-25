# ADR-024: Deployment profiles and regional capability validation

**Status:** proposed
**Date:** 2026-10-25
**Issue:** [#836](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/836)

Per the [ADR lifecycle](./README.md#lifecycle), this decision remains proposed until its implementing PR merges.

## Context

The application stack deploys Slack, Linear, Jira, deploy-preview screenshots and the Agent Registry whether or not an operator uses them. Each adds Lambdas, tables, secrets, IAM grants, API routes and alarms, so unused integrations cost money, slow deploys, widen the security-review surface and consume the root stack's 490-resource budget ([ADR-023](./ADR-023-cloudformation-stack-boundaries.md)). Some depend on Region-limited services: AWS Agent Registry is available in five Regions, and AgentCore Memory, which every deployment uses, in sixteen. An unsupported Region fails late, inside CloudFormation, with an opaque service error.

Issue #836 also suggests moving substantial optional modules into nested stacks. Slack, Linear, Jira and screenshots each attach methods to the shared Task API `RestApi`. ADR-023 §1 and the #852 proof of concept record that extracting such integrations loses deployment dependencies, CORS, attribution and tags even when synthesis passes, and moving their tables and secrets would replace them.

## Decision

1. **One validated selection.** `DeploymentFeatures` (`cdk/src/deployment/features.ts`) is resolved once in `main.ts` and passed to `AgentStack`. Constructs read the selection, never feature context directly. Optional features: `slack`, `linear`, `jira`, `deployPreviewScreenshots`, `agentRegistry`, `toolGateway`. Authentication, Cedar HITL, secure egress, task state, admission control, GitHub workflow, alarms and diagnostics are core and not selectable.
2. **Persistent profile.** `abca.deployment.json` at the repository root (`schemaVersion: 1`, every feature an explicit boolean, unknown keys rejected) is the shared input for local and CI synthesis. Precedence: per-feature context switch (`enableSlack`, `enableLinear`, `enableJira`, `enableDeployPreviewScreenshots`, `enableAgentRegistry`, `enableToolGateway`) → profile → legacy topology. `-c deploymentProfile=<path>` selects another file; `-c deploymentProfile=none` ignores it (used by the synthesis census so a developer's profile cannot change its results).
3. **Absent profile = legacy topology.** Without a profile, everything that deploys today still deploys (Tool Gateway stays opt-in). Shipping profiles deletes nothing from existing installations.
4. **Omit, do not relocate.** A disabled feature synthesizes no routes, WAF body-size exemptions, Lambdas, grants, tables, secrets, wiring, alarms or outputs. Enabled features stay in the application stack, with the existing Registry nested stacks unchanged. Headroom comes from omission, which is safe; relocation is not safe without the populated migration rehearsal that ADR-023 defers. The stranded-orchestration sweep and iteration heartbeat deploy only with Linear or Jira. Screenshot-to-Linear/Jira wiring exists only when screenshots and that tracker are both enabled. Two parts of the issue's "shared orchestration" scope stay core. The orchestration table and live reconciler remain because the reconciler also owns the per-task budget rollup. The task table's `LinearIssueIndex`/`JiraIssueIndex` remain because removing a GSI is a schema change outside this decision. A `DeploymentFeatures` output records the selection so tools can read it back.
5. **Regional capability catalog.** `contracts/deployment-capabilities.json` records, per capability, the required services, supported Regions, remediation, maturity, footprint and statefulness, with the source URL and last-verified date. CDK reads the JSON directly; the CLI keeps a package-safe literal mirror enforced by a parity test (the `contracts/constants.json` pattern). `AgentStack` rejects an unsupported concrete Region during synthesis, so the CLI is not the only enforcement point. Environment-agnostic synthesis is not checked.
6. **`bgagent setup`.** The wizard runs these steps in order:
   - resolves the Region first and checks core availability;
   - lists every feature but marks unavailable ones as unselectable;
   - preselects features already deployed, read from `DeploymentFeatures` or inferred for older stacks;
   - recommends the minimal profile for new stacks;
   - diffs a temporary candidate profile, so cancelling leaves the repository untouched;
   - asks for explicit confirmation before deleting or replacing state-bearing resources, then writes the profile and deploys through the existing mise task.

   Non-interactive runs fail on an unsupported feature, and require `--accept-data-loss` in addition to `--yes` to remove state-bearing resources. Operator subcommands for an omitted feature fail early with a pointer to `bgagent setup`.

## Consequences

- (+) The minimal profile synthesizes 317 root resources against 463 for the legacy topology (−146), with the corresponding IAM, secrets and routes, and fails fast in unsupported Regions.
- (+) The shared census grows to 142 profiles. The new cells cover minimal, each single feature, the paired trackers/screenshots and all features in both topologies. They assert that disabled features leave nothing behind and that catalogued footprints track synthesis.
- (+) One input file feeds local deploys, CI and the wizard; existing context switches keep working.
- (-) Disabling a stateful feature deletes its tables and secrets (`RemovalPolicy.DESTROY` today). Re-enabling creates empty resources; operators must re-run the feature's setup command. No import path is provided.
- (-) Regional data is a maintained copy of AWS documentation and can go stale. A stale entry blocks a newly supported Region until the catalog is updated (fail closed); the update process is in the [deployment guide](../guides/DEPLOYMENT_GUIDE.md#deployment-profiles).
- (!) Strict boolean parsing now rejects malformed `enableToolGateway`, `enableAgentRegistry` (unchanged) and the new switches; values that were previously treated as `false`, such as `enableToolGateway=yes`, now fail synthesis. `enableLinearIdentityVault` keeps its lenient reading.
- (!) Legacy-default stacks in core Regions without AWS Agent Registry (11 of 16) now fail synthesis rather than at the registry custom resource; such stacks could never deploy the registry. The error names the profile key and context switch that disable it.
- (!) Enabling every feature leaves the root stack where it is today; nested-stack extraction of route-owning integrations remains out of scope until ADR-023's migration criteria are met.

## References

- [#836](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/836), [#735](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/735), [#852](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/852)
- [ADR-023: Optional network stack and deployment budgets](./ADR-023-cloudformation-stack-boundaries.md)
- [Supported AgentCore Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
- [CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
