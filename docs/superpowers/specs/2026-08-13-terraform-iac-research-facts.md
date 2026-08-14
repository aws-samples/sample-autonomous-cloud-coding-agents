# Terraform IaC enablement — research facts (#644)

**Date:** 2026-08-13
**Status:** research only — no implementation, no ADR proposed yet
**Scope:** mechanism evaluation for issue [#644](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/644) "support Terraform as an alternative to CDK for deployments"
**Provenance:** every number below was measured or fetched on 2026-08-13, not recalled. Commands are included so each claim is re-runnable.

---

## TL;DR

1. **CDK for Terraform (CDKTF) is archived.** It cannot be the mechanism. This is the single most consequential finding.
2. **The Terraform AWS provider has full, current AgentCore coverage** — 21 `bedrockagentcore_*` resources in v6.60.0, including a 1:1 match for ABCA's hardest construct (per-repo memory namespacing).
3. **AWS Agent Registry went GA under a new `agent-registry` namespace on 2026-08-06**, retiring the `bedrock-agentcore` preview ABCA is built on. The old namespace is **already closed to accounts without pre-existing registries**, and shuts down entirely **2026-09-17** (~5 weeks). The break includes an incompatible API schema change, not just a rename. Highest-urgency finding; affects the CDK path independently of Terraform.
4. The CDK surface to mirror is **539 resources / 69 distinct types**, plus 8 custom resources and an asset pipeline (59 file assets + 1 Docker image).
5. On a *behavioral* parity bar, hand-authored HCL is the only mechanism that clears it; a CFN wrap is a viable bounded escape hatch.

---

## 1. Measured CDK surface

Synthesized from `main` at `5d6da09c`, credential-free (CI-parity mode).

```bash
mise run //cdk:synth:quiet
python3 -c "
import json,glob,collections
c=collections.Counter()
for f in glob.glob('cdk/cdk.out/*.template.json'):
    for r in json.load(open(f)).get('Resources',{}).values(): c[r['Type']]+=1
print('TOTAL',sum(c.values()),'TYPES',len(c))
"
```

| Metric | Value |
|---|---|
| Total resources | **539** |
| Distinct resource types | **69** |
| Stacks | 1 root (`agent.ts`) + **2 nested** |
| Constructs | 54 files in `cdk/src/constructs/` |
| File assets | 59 |
| Docker images | 1 (`agent/Dockerfile`, via `AgentRuntimeArtifact.fromAsset`) |

Top resource types:

| Count | Type |
|---|---|
| 76 | `AWS::Lambda::Permission` |
| 68 | `AWS::ApiGateway::Method` |
| 66 | `AWS::IAM::Role` |
| 63 | `AWS::IAM::Policy` |
| 58 | `AWS::Lambda::Function` |
| 39 | `AWS::ApiGateway::Resource` |
| 21 | `AWS::DynamoDB::Table` |
| 9 | `AWS::Logs::LogGroup` / `AWS::EC2::VPCEndpoint` |

**Note:** `cdk-nag` reports "Number of resources: 479 is approaching allowed maximum of 500" for the *root* stack; 539 is the total including nested stacks. The root stack is within ~4% of the hard CloudFormation 500-resource limit — relevant to any mechanism that adds resources to the CFN path.

### Custom resources (8 total)

| Count | Type | Class | Terraform implication |
|---|---|---|---|
| 3 | `Custom::S3AutoDeleteObjects` | CFN gap-filler | Native: `force_destroy = true` |
| 3 | `Custom::AWS` (`AwsCustomResource`) | Mixed | Case-by-case |
| 1 | `Custom::VpcRestrictDefaultSG` | CFN gap-filler | Native: `aws_default_security_group` |
| 1 | `Custom::AgentCoreRegistry` | Business logic | `aws_bedrockagentcore_registry` exists but is **deprecated**; no successor resource yet — see §3.3 |

The two gap-fillers exist *only* because CloudFormation lacks behavior Terraform has natively — 7 CFN resources collapse to ~2 HCL arguments. This is the clearest evidence that resource-count parity and behavioral parity are different tests.

### Deploy-time side effects (not resources)

`cdk/src/constructs/blueprint.ts:321` uses `AwsCustomResource` to `PutItem` repo config into DynamoDB at deploy time. Its own comment (line 199) flags this as "an inherent limitation of AwsCustomResource." In Terraform this is `aws_dynamodb_table_item` — arguably *more* idiomatic than the CDK original. Behavioral parity requires reproducing this; a resource-graph diff would not surface it as a gap.

---

## 2. Mechanism evaluation

| Mechanism | Verdict | Evidence |
|---|---|---|
| **A. Hand-authored HCL** (CDK canonical) | **Viable — recommended** | Only path to idiomatic, reviewable, composable HCL. Cost: drift (see §5) |
| **B. `cdk synth` → HCL transform** | **Rejected** | Would emit Lambda-backed shims for the 4 gap-filler custom resources where HCL wants one argument; no clean mapping for `Custom::AgentCoreRegistry`; must reimplement CDK's asset pipeline (59 assets + 1 image, content-hashed); generated HCL across 69 types is machine-shaped and fails an operator-review bar |
| **C. `aws_cloudformation_stack` wrap** | **Escape hatch only** | Parity exact by construction (same CFN → same 539 resources, all 8 custom resources work untouched). But one opaque state entry: no per-resource `plan`, no OPA/Sentinel visibility, nested drift invisible. Terraform-flavored CDK, not a Terraform module |
| **D. CDKTF** | **Rejected — dependency is dead** | See §2.1 |

### 2.1 CDKTF is archived (blocking)

```bash
curl -sL https://api.github.com/repos/hashicorp/terraform-cdk
curl -sL https://api.github.com/repos/hashicorp/terraform-cdk/releases/latest
```

| Field | Value |
|---|---|
| `archived` | **`true`** |
| Latest release | **v0.21.0, 2025-06-04** |
| Last push | 2025-12-10 |
| Open issues | 389 |
| Stars | 5,075 |

CDKTF was the theoretically ideal mechanism — same TypeScript constructs, Terraform output, one source of truth, no hand-porting. It is not available. Any proposal built on it should be closed on this fact alone.

---

## 3. Terraform AWS provider AgentCore coverage

Provider `hashicorp/aws` latest = **6.60.0**. Search for `bedrockagentcore` resources returns **21**:

`agent_runtime`, `agent_runtime_endpoint`, `api_key_credential_provider`, `browser`, `browser_profile`, `code_interpreter`, `evaluator`, `gateway`, `gateway_rule`, `gateway_target`, `harness`, `memory`, `memory_strategy`, `oauth2_credential_provider`, `online_evaluation_config`, `policy`, `policy_engine`, `registry`, `resource_policy`, `token_vault_cmk`, `workload_identity`

### 3.1 ABCA constructs in use → provider mapping

From `grep -rhoE 'agentcore\.[A-Z][A-Za-z]+' cdk/src`:

| ABCA (CDK) | Terraform (6.60.0) | Status |
|---|---|---|
| `agentcore.Memory` | `aws_bedrockagentcore_memory` | ✅ |
| `MemoryStrategy.usingSemantic` | `..._memory_strategy` `type = "SEMANTIC"` | ✅ |
| `MemoryStrategy.usingEpisodic` | `..._memory_strategy` `type = "EPISODIC"` | ✅ |
| `namespaces: ['/{actorId}/knowledge/']` | `namespace_templates` — same `{actorId}`/`{sessionId}` templating | ✅ exact |
| `reflectionConfiguration.namespaces` | `reflection_configuration.namespace_templates` | ✅ |
| `agentcore.Runtime` | `aws_bedrockagentcore_agent_runtime` | ✅ |
| `AgentRuntimeArtifact.fromAsset` | `agent_runtime_artifact.container_configuration.container_uri` | ⚠️ needs external image build/push |
| `LifecycleConfiguration` (`idleRuntimeSessionTimeout`, `maxLifetime`) | `lifecycle_configuration.idle_runtime_session_timeout`, `max_lifetime` | ✅ |
| `RuntimeNetworkConfiguration` | `network_configuration.network_mode` (`PUBLIC`\|`VPC`) + `network_mode_config` | ✅ |
| `agentcore.Gateway` / `GatewayAuthorizer` | `..._gateway` + `authorizer_configuration` | ✅ |
| `GatewayCredentialProvider` | `..._api_key_credential_provider` / `..._oauth2_credential_provider` | ✅ |
| `ToolSchema` / `SchemaDefinitionType` | `..._gateway_target` | ✅ likely |
| `Custom::AgentCoreRegistry` | `aws_bedrockagentcore_registry` | ⚠️ deprecated — §3.3 |

**The `namespace_templates` match is the headline result.** ABCA's multi-repo isolation model — one shared Memory resource, `actorId = "owner/repo"`, `sessionId = taskId`, records at `/{actorId}/knowledge/` and `/{actorId}/episodes/{sessionId}/` — is expressible verbatim in Terraform with the same template variables. The most ABCA-specific, hardest-to-port part of the platform ports 1:1.

### 3.2 Constraint the CDK API hides

`aws_bedrockagentcore_memory_strategy` docs state limits not surfaced by the CDK L2:

- Max **6 strategies per memory**
- Only **one** strategy of each built-in type (`SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE`, `EPISODIC`) per memory
- Multiple `CUSTOM` strategies allowed, within the 6 total

ABCA currently uses 2 (Semantic + Episodic) — comfortably within limits. Recorded because a resource-graph diff would never surface this class of constraint, whereas a human authoring HCL against the docs would.

Also deprecated on this resource: `memory_execution_role_arn` and `namespaces` (prefer `namespace_templates`).

### 3.3 Time-critical: registry namespace migration (⚠️ blocking, ~5 weeks)

**The `agent-registry` namespace launched (GA) on 2026-08-06.** The AgentCore Registry *public preview* under `bedrock-agentcore` is what is being retired. Source: [registry-faq](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-faq.html), fetched 2026-08-13.

Timeline, verbatim from the FAQ:

| Date | Event |
|---|---|
| **2026-08-06** | New `agent-registry` namespace "officially launches." Existing customers get simultaneous access to both namespaces. Migration tooling available in `awslabs/agentcore-samples`. |
| **2026-09-17** | "Migration window closes. The old `bedrock-agentcore` namespace shuts down on this date. You lose read/write access to the service and any remaining data in the old namespace." |

**The grandfathering clause is the critical detail:**

> "if you do not have existing registries or records as of August 6, 2026, you cannot access the `bedrock-agentcore` namespace for AWS Agent Registry from August 6, 2026."

So the old namespace is **already closed to new accounts** — not on 2026-09-17, but as of 2026-08-06. Any ABCA deployment into a *fresh* account today cannot use the `bedrock-agentcore` registry path at all. This is not a future deadline; for new deployments it is a present failure.

**Migration is not automatic:** "No. You must initiate the migration yourself using the migration tooling that we provide."

#### Scope of the break for ABCA

This is **more than a namespace rename** — the API data model changed incompatibly. ABCA's registry client uses old-model fields throughout (`cdk/src/handlers/shared/registry/agentcore-client.ts`):

| ABCA usage (count) | Old model | New model |
|---|---|---|
| `inlineContent` ×11 | `inlineContent` | `data` |
| `descriptors` ×7 | discriminated union | flat keyed structure |
| `descriptorType` ×4 | `descriptorType` | **removed** → top-level `recordType` |
| `agentSkills` ×4 | `descriptors.agentSkills.skillDefinition` | `descriptors.agentSkillsDefinition` |

Additional breaks: new **required** fields `name` + `recordType` on records; `name` → `displayName`; `schemaVersion`/`protocolVersion` → `dataSchemaVersion`; `synchronizationConfiguration` → per-descriptor `source`; `SearchRegistryRecords` → `SearchDiscoverableRegistryRecords`; List ops move `GET` → `POST` with structured `filters`; `approvalConfiguration.autoApproval` (bool) → `autoApprovalRules` (enum array); auth config nests under `discoveryConfiguration`.

Infrastructure surfaces that change: endpoints (`.amazonaws.com` → `.api.aws`), IAM action prefix (`bedrock-agentcore:*` → `agent-registry:*`), service principal, resource ARNs, SDK client classes (`BedrockAgentCoreControlClient` → `AgentRegistryControlClient`), CLI namespace, CloudTrail source, EventBridge source, CloudWatch namespace, and the managed policy (`BedrockAgentCoreFullAccess` → **`AgentRegistryFullAccess`**; the old policy will *not* be updated).

**Note one exception:** workload identity and OAuth credential providers intentionally **stay** on `bedrock-agentcore`. `cdk/src/constructs/registry.ts:96` observes that `CreateRegistry` "ALSO provisions a workload identity under the hood" — so ABCA will need *both* namespaces in its IAM policy, not a blind find-and-replace.

#### Current ABCA + tooling state (measured)

- ABCA targets the old namespace: `agentcore-client.ts:43` imports `@aws-sdk/client-bedrock-agentcore-control`; `registry.ts:102` grants `bedrock-agentcore:CreateRegistry`.
- Terraform provider 6.60.0 `aws_bedrockagentcore_registry` is **deprecated**, pointing at this migration. No successor `aws_agentregistry_*` resource exists; a search of `hashicorp/terraform-provider-aws` issues for `agent_registry` returns **0 results**.
- Local `aws-cli/2.33.15` does **not** yet expose `agent-registry-control` (`Found invalid choice`), nor `list-registries` under `bedrock-agentcore-control`.
- [ADR-022](../../decisions/ADR-022-agent-asset-registry.md) anticipated this and set a **hard gate**: "do not take a production dependency on AgentCore Registry until the `bedrock-agentcore` → `agent-registry` namespace migration is complete and GA in every target region." The new namespace *is* now GA — so the gate's condition is arguably met, but the migration work it implies has not been done, and ADR-022 also requires the design PR to "record which target regions have GA before merging a production dependency."

**This is not a Terraform finding.** It affects the CDK path (#664/#665, merged 2026-08-12) independently of whether Terraform is ever adopted. It is the highest-urgency item this research surfaced and belongs on ADR-022 / [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246), not #644.

**For the Terraform path specifically:** since no `aws_agentregistry_*` resource exists yet, the registry is the one part of the MVP with no viable idiomatic-HCL option. Options: CFN-wrap it (mechanism C, but the CDK custom resource has the same old-namespace problem), keep it CDK-managed, or defer registry from the Terraform MVP.

---

## 4. Definition of parity (decided)

**Behavioral parity**, not resource-graph identity: an operator can provision ABCA with Terraform, submit a task, have the agent run, and get a PR opened. Idiomatic HCL is permitted to use different (usually fewer) resources than CDK.

Rejected: **resource-graph identity** (same 539 resources, 1:1 diffable). Mechanically checkable and maximally anti-drift, but it forces unidiomatic HCL and Lambda shims that a Terraform shop will not accept ownership of — defeating the purpose of offering a Terraform path.

---

## 5. Anti-drift proposal: resource-type census harness

Hand-authored HCL (mechanism A) has no built-in drift protection. Proposed CI check:

1. Extract a **resource-type census** from `cdk synth` output (see §1 command).
2. Extract the same from `terraform plan -json`.
3. **Fail when CDK introduces a resource _type_** the TF module neither implements nor lists on an explicit `not-covered` allowlist.

Census-of-types, not count-of-resources, because:

- Count diffs fail on every legitimate idiomatic substitution (1 `force_destroy` vs 3 auto-delete resources) and get muted within a week — the standard fate of an over-strict gate.
- Type census fires only on genuinely **new capability**, which is what humans actually forget to port.
- The allowlist makes gaps **declared** rather than discovered in production.

Precedent note: this repo already treats one ratchet (`knip` dead-code) as advisory/non-blocking. A parity harness should be explicit about which side of that line it sits on.

---

## 6. Recommended MVP scope

**In scope** — control plane + AgentCore compute (per #644 item 3): REST API, orchestrator, DynamoDB tables, auth, secrets wiring, AgentCore Runtime + Memory.

**Explicitly deferred** (decision recorded 2026-08-13):

- **Agent asset registry** — no successor `aws_agentregistry_*` provider resource exists, and the CDK side is mid-migration (§3.3). Porting it now means porting code with a known ~5-week half-life. Recorded as a blocked dependency, not a gap.
- ECS compute variant (`ComputeTypes=ecs`)
- Lambda MicroVM compute backend ([#645](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/645) / [ADR-021](../../decisions/ADR-021-lambda-microvms-compute-backend.md))
- Any future compute substrate (EKS, etc.)
- Terraform Registry publication
- Feature-complete parity with every optional construct

---

## 6.1 Solution user-agent attribution — mechanism exists (verified)

ABCA requires every outbound AWS call to carry `md/uksb-wt64nei4u6#{component}` (AGENTS.md, [#319](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/319)). CDK enforces this via `cdk/src/constructs/solution-ua-aspect.ts` + the `makeClient` factory; `SOLUTION_ID = 'uksb-wt64nei4u6'` at `cdk/src/handlers/shared/ua.ts:59`.

**Terraform has an equivalent.** The AWS provider documents three ways to append User-Agent information:

| Mechanism | Scope | Enforceable by a module? |
|---|---|---|
| `provider_meta "aws" { user_agent = [...] }` | **Module only** — "applies only to resources in the module in which it is configured" | ✅ **Yes** |
| `user_agent` provider argument | All resources on the provider instance | ❌ Lives in the consumer's `provider` block |
| `TF_APPEND_USER_AGENT` env var | All resources | ❌ Operator-supplied |

`provider_meta` is the correct choice: it is the only one a module author can guarantee. Per the [provider_meta docs](https://developer.hashicorp.com/terraform/internals/provider-meta), it is intended precisely for "official modules developed by the same vendor that produced the provider."

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

Constraints (verbatim from docs):

- Declared **inside the module's `terraform` block**; "The `provider` block is inherited from the root module."
- "Any module taking advantage of this functionality should specify a minimum Terraform version of 0.13.0 or higher."
- Provider must define a `ProviderMeta` schema — the AWS provider does.
- "Functions … cannot be used in the `terraform` block" — so `provider::aws::user_agent()` is unavailable; the string must be literal.
- Documented as **experimental**.
- Per-module: nested modules each need their own block, and there is no aspect-like traversal to enforce it globally as CDK has.

Wire-format note: CDK's `#` separator comes from the SDK's own `name#value` join (`ua.ts:100` passes the pair `['md/uksb-wt64nei4u6', component]`). Terraform appends the string verbatim, so `#` must be written literally.

## 7. Open questions

1. **Asset pipeline.** CDK bundles + content-hashes 59 file assets and 1 Docker image, then uploads to S3/ECR — `cdk deploy` does this for free. The Terraform path needs an explicit answer (external `docker build`/push, `terraform-provider-docker`, or a prerequisite CI step). Unresolved.
2. **Registry successor resource.** No `aws_agentregistry_*` visible in-provider yet; 2026-09-17 hard stop. What happens to the Terraform path if the successor is unavailable — CFN-wrap that piece, keep it CDK-managed, or defer registry from MVP? (Note this blocks the *CDK* path too — see §3.3.)
3. **Bootstrap / least-privilege.** `cdk/bootstrap/` (template + policies + `BOOTSTRAP_HASH`/`BOOTSTRAP_VERSION`) has no Terraform equivalent. Relates to [#120](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/120).
4. **Root stack resource headroom.** Root stack is at 479/500 CFN resources. Does a CFN-wrap escape hatch (mechanism C) worsen this?
5. **Nested stacks.** 2 nested stacks (registry catalog + registry API) — wrap as separate `aws_cloudformation_stack`s, or port to HCL modules?

---

## 8. Governance status

- #644 is labeled `enhancement, RFC-proposal, infra-cdk, P2` — **not `approved`**. Per [ADR-003](../../decisions/ADR-003-contribution-governance.md) implementation is gated on the `approved` label.
- No assignees, no comments as of 2026-08-13.
- This document is **local research only** — no ADR proposed, no code written, nothing committed to a shared branch.
- #644's first acceptance criterion ("ADR records the IaC dual-support decision") remains the natural next artifact.

## 9. Reproducing these findings

```bash
# CDK surface census
mise run //cdk:synth:quiet
python3 -c "
import json,glob,collections
c=collections.Counter()
for f in glob.glob('cdk/cdk.out/*.template.json'):
    for r in json.load(open(f)).get('Resources',{}).values(): c[r['Type']]+=1
print('TOTAL',sum(c.values()),'TYPES',len(c))
for t,n in c.most_common(25): print(f'{n:4}  {t}')
"

# Custom resources
grep -ohE '"Type": "(Custom::[A-Za-z0-9]+|AWS::CloudFormation::CustomResource)"' cdk/cdk.out/*.template.json | sort | uniq -c

# Assets
python3 -c "
import json,glob
for f in glob.glob('cdk/cdk.out/*.assets.json'):
    d=json.load(open(f)); print(f,'files:',len(d.get('files',{})),'dockerImages:',len(d.get('dockerImages',{})))
"

# AgentCore constructs in use
grep -rhoE 'agentcore\.[A-Z][A-Za-z]+' cdk/src | sort | uniq -c | sort -rn

# CDKTF archived status
curl -sL https://api.github.com/repos/hashicorp/terraform-cdk | python3 -c "import json,sys; d=json.load(sys.stdin); print('archived:',d['archived'])"
```

Provider coverage was retrieved via the Terraform MCP server (`search_providers` / `get_provider_details` against `hashicorp/aws` 6.60.0).
