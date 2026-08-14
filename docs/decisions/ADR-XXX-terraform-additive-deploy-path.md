# ADR-XXX: Terraform as an additive deploy path

**Status:** proposed
**Date:** 2026-08-13

> **Draft — unnumbered by design.** This ADR was produced by an out-of-band local exploration (worktree `feat/terraform-iac`) to test a hypothesis with evidence before requesting governance. It has **no ADR number** and is **not** a claim on the next sequence slot; assign a number when [#644](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/644) carries the `approved` label. Supporting measurements: [`docs/superpowers/specs/2026-08-13-terraform-iac-research-facts.md`](../superpowers/specs/2026-08-13-terraform-iac-research-facts.md).

## Context

ABCA is a **CDK-only** deployable application. Operators standardized on Terraform cannot adopt the platform without introducing CDK into their organization or reverse-engineering the CloudFormation output. [#644](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/644) asks for a supported Terraform path *in addition to* CDK, and explicitly requests an ADR recording the source-of-truth decision as its first acceptance criterion.

### Measured surface

Synthesized from `main` at `5d6da09c`, credential-free:

| Metric | Value |
|---|---|
| Total resources | **539** (69 distinct types) |
| Root stack | 479 resources — within ~4% of the CloudFormation 500 hard limit |
| Nested stacks | 2 (registry catalog, registry API) |
| Constructs | 54 files |
| Custom resources | 8 |
| Assets | 59 files + 1 Docker image |

The 8 custom resources split into two classes with opposite implications:

- **CFN gap-fillers** (`Custom::S3AutoDeleteObjects` ×3, `Custom::VpcRestrictDefaultSG` ×1) exist only because CloudFormation lacks behavior Terraform has natively. 7 CFN resources collapse to ~2 HCL arguments (`force_destroy`, `aws_default_security_group`).
- **Business logic** (`Custom::AgentCoreRegistry`, `Custom::AWS` ×3) encodes real orchestration.

There are also **deploy-time side effects that are not resources**: `cdk/src/constructs/blueprint.ts:321` uses `AwsCustomResource` to `PutItem` repo config into DynamoDB. A resource-graph diff would never surface this as a gap, yet an operator whose repo config is missing has a broken platform.

### Forces

1. **CDK is positioned as a deployable application, not a construct library** ([ARCHITECTURE.md](../design/ARCHITECTURE.md)). There is no stable published interface for Terraform to target — only an internal resource graph that changes weekly (three registry PRs merged in the two days before this ADR).
2. **Dual maintenance is the dominant long-run cost**, not initial authoring. 66 IAM roles and 63 policies mean a subtle scope difference between the two trees is a silent security divergence, not a cosmetic drift.
3. **Two definitions of "parity" conflict.** Resource-graph identity is mechanically checkable but forces unidiomatic HCL. Behavioral parity is what operators need but is not diff-checkable.

## Decision

**Terraform becomes an additive, hand-authored HCL deploy path. CDK remains canonical. Parity is defined behaviorally and defended by a resource-type census check in CI.**

### Sub-decisions

**1. Mechanism: hand-authored HCL (CDK canonical).** Rejected alternatives, on evidence:

| Mechanism | Verdict | Determining evidence |
|---|---|---|
| **CDKTF** | Rejected | `hashicorp/terraform-cdk` is **archived** (`archived: true`); last release v0.21.0, 2025-06-04; 389 open issues. Theoretically ideal — one source of truth, no hand-porting — and unavailable. |
| **`cdk synth` → HCL transform** | Rejected | Emits Lambda-backed shims for the 4 gap-filler custom resources where idiomatic HCL wants one argument; no mapping for `Custom::AgentCoreRegistry`; requires reimplementing CDK's content-hashed asset pipeline (59 assets + 1 image); generated HCL over 69 types is machine-shaped and unreviewable. |
| **`aws_cloudformation_stack` wrap** | Escape hatch only | Parity exact by construction, but Terraform holds one opaque state entry: no per-resource `plan`, no OPA/Sentinel visibility, nested drift invisible. Terraform-flavored CDK, not a Terraform module. Retained as a bounded fallback (sub-decision 5). |

**2. Parity is behavioral.** Success is: an operator provisions with Terraform, submits a task, the agent runs, a PR opens. Idiomatic HCL may use different — usually fewer — resources than CDK. Resource-graph identity is explicitly **not** the bar.

**3. Feasibility is established for the hardest part.** Terraform AWS provider 6.60.0 ships **21 `bedrockagentcore_*` resources**. ABCA's most platform-specific construct maps exactly: `aws_bedrockagentcore_memory_strategy.namespace_templates` supports the same `{actorId}`/`{sessionId}` templating that per-repo memory isolation depends on, and `reflection_configuration` mirrors `reflectionConfiguration`. `Runtime` (incl. `lifecycle_configuration`, `network_configuration`), `Gateway`, and credential providers all map.

**4. Anti-drift: two tiers, split by credential requirement.**

*Tier 1 — structural census (MVP, blocking, credential-free).* Compare a resource-**type** census from `cdk synth` against `terraform show -json`; fail when CDK introduces a type the module neither implements nor lists on an explicit `not-covered` allowlist. Types, not counts, because a count diff fails on every legitimate idiomatic substitution and gets muted within a week. Verified 2026-08-13 that this runs with **no AWS access**: `terraform plan` rejects absent credentials, but mock credentials plus `skip_*` flags and `-refresh=false` produce a complete plan without contacting AWS. So it belongs in credential-free `build.yml` beside `cdk synth`. **Blocking**, unlike the advisory `knip` ratchet.

*Tier 2 — real-state drift (follow-up, credentialed).* Tier 1 cannot see divergence between HCL and deployed reality, because `-refresh=false` never reads reality. A `terraform plan` against real state closes that gap, reusing the **existing** read-only `diff` environment (`.github/workflows/deploy.yml:125-157`) with the AWS-managed **`ReadOnlyAccess`** policy added to its role. A second GitHub Environment was rejected: it does not compose cleanly with the existing job graph, and hand-enumerating read actions across ~69 resource types would approximate `ReadOnlyAccess` anyway, with worse failure modes (a permission gap mid-refresh presents as drift). This widens the role for the CDK `diff` job too — accepted, since it carries no mutate permissions either way. Deferred to a follow-up by size.

*Secret values are denied, metadata is not.* `ReadOnlyAccess` may permit `secretsmanager:GetSecretValue`, and ABCA provisions 7 secrets, so a refresh could pull values into CI logs or artifacts — an exposure `cdk diff --method=template` does not have. Mitigation: an explicit `Deny` on `secretsmanager:GetSecretValue` and `BatchGetSecretValue` layered over `ReadOnlyAccess`. This costs drift detection **nothing**, because the provider already separates the concerns: `aws_secretsmanager_secret` manages *metadata* (name, description, KMS key, rotation, policy, tags) and refreshes via `DescribeSecret`, while the value lives in `aws_secretsmanager_secret_version`, which ABCA's module does not manage — its secrets are provisioned as shells and populated out-of-band by operator tooling. So drift on a renamed secret, changed KMS key, altered rotation, modified policy, or deletion all remain visible; only the value is unreadable. An explicit `Deny` is preferred over a permissions boundary: it always defeats the managed policy's `Allow`, it is visible in the role's own policy list, and it survives future `ReadOnlyAccess` revisions. Plan output must additionally never be uploaded as a workflow artifact.

**4a. CDK defaults are compared via synth output, not documentation.** CDK resolves defaults before emitting CloudFormation — verified, all 539/539 resources carry fully-resolved `Properties`. Terraform frequently makes *required* what CDK defaults silently: `agent-memory.ts:78` never states an expiry (`?? Duration.days(365)`), synth emits `"EventExpiryDuration": 365`, and Terraform's `event_expiry_duration` is required — omitting it fails `validate`. Therefore **authors and reviewers read property values from `cdk/cdk.out/*.template.json`, never from the TypeScript**, and plan fixtures encode those values. A CDK default change surfaces as a fixture mismatch, so no hand-maintained mapping table exists to rot.

**4b. State backend is opinionated but isolated.** ABCA ships an S3 backend with **S3-native locking** (`use_lockfile = true` — confirmed supported at Terraform 1.15.8, so no DynamoDB lock table), confined to its own `backend.tf` so relocation is a one-file replacement. Most adopters run HCP/Terraform Enterprise; the default must not fight a remote backend, and docs show the `cloud {}` swap explicitly. The parity-check example deliberately configures **no** remote backend, since that would require AWS access at `init` and break tier 1's credential-free property.

**4c. State bucket comes from a dedicated idempotent bootstrap, not the CDK staging bucket.** A Terraform bootstrap prerequisite is the same shape as `cdk bootstrap`, so it is an accepted pattern rather than an anomaly. Reusing the CDK bootstrap `StagingBucket` was considered and **rejected on inspection**: it sets `NoncurrentVersionExpiration: NoncurrentDays: 30`, which would silently expire the state version history that is the recovery path for a corrupted apply — a failure invisible until rollback is needed. Reuse would also couple the two IaC paths' IAM (write access is scoped to `FilePublishingRole`) and make a Terraform-only deployment depend on a CDK bootstrap having been run, defeating the CDK-free premise. `terraform/bootstrap/` therefore manages one versioned, encrypted, TLS-only, **non-expiring** bucket with local state, is safe to re-run, and carries `prevent_destroy`.

**4d. `.terraform.lock.hcl` is committed; state never is.** The dependency lock file pins provider versions *and* checksums, exactly as `yarn.lock` does for the JS workspaces, so CI and every operator resolve byte-identical providers. Without it a `~> 6.60` constraint floats and a provider release can change plan output between runs — which would make the tier-1 census harness flaky in a way that mimics real drift. It must be generated for every platform in use (`terraform providers lock -platform=...`) so Linux CI and arm64 laptops both verify. Distinct from two other "lock" artifacts: `terraform.tfstate` (may contain plaintext secrets — never committed) and the `use_lockfile` concurrency lock (an S3 object, not a repo file). The repo currently has no Terraform `.gitignore` patterns; adding them is part of the skeleton PR, including `*.tfvars` (operator inputs, potentially tokens — ship `*.tfvars.example` instead) and plan outputs.

**5. MVP scope.** In: REST API, orchestrator, DynamoDB, auth, secrets wiring, AgentCore Runtime + Memory. Deferred, each with a reason:

| Deferred | Reason |
|---|---|
| **Agent asset registry** | No successor `aws_agentregistry_*` provider resource exists, and the CDK side is mid-migration (see Risks). Porting now = porting code with a ~5-week half-life. Blocked dependency, not a gap. |
| ECS compute (`ComputeTypes=ecs`) | Optional variant; AgentCore is the default path |
| Lambda MicroVM compute | [#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) / [ADR-021](./ADR-021-lambda-microvms-compute-backend.md) still landing |
| Future substrates (EKS, etc.) | Not yet designed for CDK either |
| Terraform Registry publication | Post-MVP stability |

**6. Asset pipeline is out-of-band.** The Docker image and 59 file assets are built and pushed by a documented prerequisite step; the Terraform module consumes an image URI as an input variable. Terraform does not attempt to replicate CDK's asset bundling.

**7. Solution user-agent attribution is enforced via `provider_meta`.** ABCA requires every outbound AWS call to carry `md/uksb-wt64nei4u6#{component}` (AGENTS.md, [#319](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/319)); in CDK this is `SolutionUaAspect` + the `makeClient` factory. Terraform has an equivalent, and the module MUST use it:

```hcl
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.60" }
  }

  provider_meta "aws" {
    user_agent = ["md/uksb-wt64nei4u6#terraform"]
  }
}
```

Of the provider's three User-Agent mechanisms — the `user_agent` provider argument, the `TF_APPEND_USER_AGENT` environment variable, and `provider_meta` — only `provider_meta` is **module-scoped** and therefore enforceable by the module rather than dependent on how a consumer configures their `provider` block or environment. This mirrors the CDK aspect's repo-wide guarantee. Constraints: the block lives inside `terraform` (the `provider` block is inherited from the root module), requires Terraform ≥ 0.13, is documented as experimental, and **cannot use functions** — so the string is literal, not composed via `provider::aws::user_agent()`. Every nested module needs its own block; a missing one is silent attribution loss.

## Consequences

- (+) Operators get idiomatic, reviewable HCL that composes with existing landing zones, state backends, and OPA/Sentinel gates.
- (+) CDK path is untouched; Terraform is purely additive. No existing user is affected.
- (+) The census harness converts drift from an invisible risk into a build failure.
- (+) Deferring registry avoids porting code with a known short half-life.
- (−) Permanent dual-maintenance cost. Every new CDK resource *type* requires a Terraform decision (implement or allowlist).
- (−) Behavioral parity is not provable by diff. Real confidence requires a deploy smoke test, which costs CI time and an AWS account.
- (−) MVP is visibly incomplete: no registry, no ECS, no MicroVM. Documentation must be explicit so operators are not surprised.
- (!) **Registry namespace migration (highest urgency, ~5 weeks).** AWS Agent Registry went **GA under `agent-registry` on 2026-08-06**, retiring the `bedrock-agentcore` preview ABCA is built on. The old namespace is **already closed to accounts without pre-existing registries**, and shuts down entirely **2026-09-17**. The break is an incompatible **API schema change**, not a rename: ABCA's client uses `inlineContent` (×11 → `data`), `descriptors` (×7, union → flat keyed), `descriptorType` (×4, **removed** → top-level `recordType`), `agentSkills` (×4). Also new *required* record fields, `GET`→`POST` list ops, and a managed-policy swap AWS will not backport. **This affects the CDK path independently of Terraform** and belongs on [ADR-022](./ADR-022-agent-asset-registry.md) / [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246). Note workload identity and OAuth providers intentionally **stay** on `bedrock-agentcore`, so a blind find-and-replace breaks `CreateRegistry` (which provisions a workload identity implicitly — `cdk/src/constructs/registry.ts:96`).
- (!) **Root stack headroom.** 479/500 CFN resources. A CFN-wrap escape hatch must not consume the remaining margin.
- (!) **IAM divergence risk.** 66 roles / 63 policies. The census harness checks types, not policy *scope* — a Terraform role that is subtly broader than its CDK counterpart passes. Policy-equivalence checking is an open follow-up.
- (!) **Provider deprecations already present.** `memory_execution_role_arn` and `namespaces` are deprecated on `aws_bedrockagentcore_memory_strategy`; prefer `namespace_templates`.
- (!) **Undocumented service limits.** Max 6 memory strategies per memory, one per built-in type. ABCA uses 2. Not visible in the CDK API and not catchable by any resource diff — only by authoring against provider docs.
- (!) **`provider_meta` is experimental and per-module.** Solution attribution (sub-decision 7) depends on a feature HashiCorp documents as experimental, and it must be repeated in every nested module. There is no aspect-like traversal to enforce it globally as CDK has. Recommend the parity harness assert its presence.

## References

- [#644](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/644) — Terraform support RFC (`RFC-proposal`, **not `approved`**)
- [#377](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/377) — separate infra deploy from app/runtime updates
- [#120](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/120) — least-privilege bootstrap
- [#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) / [ADR-021](./ADR-021-lambda-microvms-compute-backend.md) — MicroVM compute
- [ADR-022](./ADR-022-agent-asset-registry.md) / [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246) — agent asset registry; carries the pre-existing cutover gate
- [ADR-003](./ADR-003-contribution-governance.md) — contribution governance
- [Research facts, 2026-08-13](../superpowers/specs/2026-08-13-terraform-iac-research-facts.md) — measurements and reproduction commands
- [AWS Agent Registry migration guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-faq.html) — 2026-08-06 GA / 2026-09-17 shutdown
- [hashicorp/terraform-cdk](https://github.com/hashicorp/terraform-cdk) — archived
- [Terraform AWS provider 6.60.0](https://registry.terraform.io/providers/hashicorp/aws/latest/docs) — 21 `bedrockagentcore_*` resources; "Custom User-Agent Information" section
- [Terraform `provider_meta` block](https://developer.hashicorp.com/terraform/internals/provider-meta) — module-scoped provider metadata (sub-decision 7)
- [#319](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/319) — solution UA attribution requirement; `cdk/src/constructs/solution-ua-aspect.ts`, `cdk/src/handlers/shared/ua.ts`
