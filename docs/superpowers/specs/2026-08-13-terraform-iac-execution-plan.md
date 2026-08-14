# Terraform IaC — stacked-PR execution plan (#644)

**Date:** 2026-08-13
**Status:** prepared, NOT dispatched — no branches pushed, no PRs opened, no issues commented
**Companions:** [research facts](./2026-08-13-terraform-iac-research-facts.md) · [proposed ADR](../../decisions/ADR-XXX-terraform-additive-deploy-path.md)

## Purpose

A stack of small, independently reviewable PRs implementing the Terraform MVP. Sized for **consumable review** — each PR has one job, its own test, and a stated review focus. This document is the dispatch plan; nothing here has been executed.

## Governance status (read before dispatching)

- [#644](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/644) is `RFC-proposal`, **not `approved`**. Per [ADR-003](../../decisions/ADR-003-contribution-governance.md), PR 0 must land (or the label must be applied) before PRs 1+ are legitimate.
- This plan was produced out-of-band deliberately, to test a hypothesis with evidence before requesting approval. Everything below is local.
- **Prerequisite before any dispatch:** `git fetch origin main` and re-run the §1 census. The measured numbers below age quickly — three registry PRs merged in the two days before this was written.

## Stack shape

```
PR 0  ADR + research findings          (docs only, no code)      ← governance gate
  │
PR 1  terraform/ skeleton + CI validate/fmt                      ← no AWS resources
  │
PR 2  Data layer: DynamoDB + secrets                             ← 21 tables
  │
PR 3  Compute: AgentCore Runtime + Memory                        ← the 1:1 mapping
  │
PR 4  Control plane: API Gateway + Lambdas                       ← largest; needs image URI
  │
PR 5  Blueprint equivalent: repo config writer                   ← deploy-time side effect
  │
PR 6  Parity census harness (CI, blocking)                       ← credential-free
  │
PR 7  Operator docs: install / upgrade / teardown / gaps
  ┊
PR 8  Real-state drift detection (follow-up)                     ← needs read-only role
```

PR 8 is dashed: it needs credentials, a backend, and a new IAM role, so it may land after the MVP is declared complete.

Strictly sequential: each PR bases on its predecessor. PRs 2 and 3 could parallelize after 1, at the cost of a rebase conflict in `variables.tf`.

---

## PR 0 — ADR + research findings

**Branch:** `docs/644-terraform-adr`
**Type:** docs only
**Contents:** the proposed ADR (numbered at this point) + research facts document.
**Review focus:** Is hand-authored HCL the right call given CDKTF is archived? Is behavioral parity the right bar? Is deferring the registry correct?
**Exit criteria:** ADR merged as `proposed`; #644 labeled `approved`.
**Blocks:** everything.

> This is the honest decision point. If reviewers reject the mechanism, PRs 1-7 are never written — which is the entire value of putting the ADR first.

---

## PR 1 — `terraform/` skeleton + CI

**Branch:** `feat/644-terraform-skeleton`
**Creates:**

```
terraform/
  versions.tf        # required_version >= 1.5, aws ~> 6.60, provider_meta
  providers.tf       # provider config + default_tags
  backend.tf         # opinionated S3 + DynamoDB lock, overridable
  variables.tf       # region, env name, agent_image_uri, blueprint repo
  outputs.tf         # empty, populated by later PRs
  main.tf            # module wiring only
  README.md
  examples/minimal/
  examples/parity-check/   # mock-cred provider for PR 6
```

**Also:** `mise.toml` — pin `terraform = "1.15.8"` under `[tools]` (decision 2026-08-13; `provider_meta` needs ≥ 0.13, and a pinned version keeps CI and local runs identical). Add tasks `//terraform:fmt`, `//terraform:validate`; wire into `mise run build`.

### Which files are committed — three different "lock" files, three answers

The word "lock" is overloaded in Terraform. These are distinct artifacts and only one is committed:

| File | What it is | Committed? |
|---|---|---|
| `.terraform.lock.hcl` | **Dependency lock** — provider versions + checksums, the analogue of `yarn.lock` | ✅ **YES — commit it** |
| `terraform.tfstate` / `*.tfstate.backup` | **State** — may contain secrets in plaintext | 🚫 **NEVER** |
| `<key>.tflock` (S3 object) | **Concurrency lock** from `use_lockfile` — lives in the S3 bucket, never on disk | n/a — not a repo file |

**`.terraform.lock.hcl` must be committed.** It pins provider versions *and* checksums, so CI and every operator resolve byte-identical providers — the same reason `yarn.lock` is committed here. Without it, `~> 6.60` silently floats and a provider release can change plan output between runs, which would make the parity harness (PR 6) flaky in a way that looks like real drift.

One wrinkle: it records checksums per platform. Generate for both CI and dev architectures so a Linux-x86 runner and an arm64 laptop both verify:

```bash
terraform providers lock \
  -platform=linux_amd64 \
  -platform=linux_arm64 \
  -platform=darwin_arm64
```

**`.gitignore` additions required — the repo currently has NO terraform patterns** (verified 2026-08-13):

```gitignore
# Terraform
**/.terraform/*
*.tfstate
*.tfstate.*
*.tfplan
tfplan.bin
plan.json
crash.log
crash.*.log
*.tfvars
*.tfvars.json
override.tf
override.tf.json
*_override.tf
*_override.tf.json
.terraformrc
terraform.rc
# NOT ignored (intentionally committed): .terraform.lock.hcl
```

Two rationales worth stating in review:

- **`*.tfvars` is ignored** because it is the conventional home for operator-supplied values, including tokens. `examples/` must therefore ship `*.tfvars.example` files instead, or CI will not see the inputs it needs. This mirrors how the repo already gitignores `cdk.context.json` while committing `cdk.json`.
- **`tfplan.bin` / `plan.json` are ignored** for the same reason PR 8 must not upload plan artifacts: a plan can embed values read during refresh.

**`terraform/bootstrap/` uses local state**, so its `terraform.tfstate` lands on disk. It is covered by `*.tfstate` above and must never be committed. Note the consequence: bootstrap state is *disposable* — the bootstrap is idempotent and adopts an existing bucket, so losing the local state file is recoverable rather than fatal. Say this explicitly in the operator docs (PR 7), because "local state you can throw away" is unusual enough that operators will ask.

### State backend: opinionated but trivially replaceable

**Decision (2026-08-13):** ABCA ships an **opinionated** default — S3 bucket + DynamoDB lock table — while making relocation a single-file edit. Rationale: most adopters run HashiCorp Cloud Platform / Terraform Enterprise, so the default must not fight a remote backend.

Isolate the backend in its own `backend.tf` so a consumer replaces exactly one file:

```hcl
# backend.tf — ABCA default. Replace this file wholesale for HCP/TFE.
terraform {
  backend "s3" {
    bucket       = "abca-tfstate-<account>-<region>"
    key          = "abca/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true   # S3-native locking; no DynamoDB lock table
  }
}
```

**`use_lockfile` support CONFIRMED at Terraform 1.15.8** (tested 2026-08-13). `terraform init` with backend validation active failed only on credentials (`InvalidClientTokenId` from STS), not on schema. Negative control: renaming the argument to `use_lockfile_typo_xyz` produced `Error: Unsupported argument — An argument named "use_lockfile_typo_xyz" is not expected here`, proving backend schema validation was live during the positive test. **Decision: S3-native locking, no DynamoDB lock table.**

Docs (PR 7) must show the HCP/TFE swap explicitly:

```hcl
terraform {
  cloud {
    organization = "your-org"
    workspaces { name = "abca-prod" }
  }
}
```

### Bootstrap: idempotent prerequisite, NOT the CDK staging bucket

The state bucket cannot be created by the configuration that stores its state in it. CDK has the same prerequisite (`cdk bootstrap`), so a Terraform bootstrap step is an accepted-shape solution, not an anomaly.

**Decision (2026-08-13): a dedicated, idempotent `terraform/bootstrap/` — do NOT reuse the CDK bootstrap `StagingBucket`.**

Reusing the CDK bucket was considered and **rejected on inspection of `cdk/bootstrap/bootstrap-template.yaml`**:

| CDK `StagingBucket` property | Consequence for Terraform state |
|---|---|
| `LifecycleConfiguration` → `NoncurrentVersionExpiration: NoncurrentDays: 30` | **Disqualifying.** State history is the recovery path for a corrupted or mis-applied state. Silently expiring noncurrent versions after 30 days destroys it — and the failure is invisible until you need to roll back. |
| `AbortIncompleteMultipartUpload: DaysAfterInitiation: 1` | Benign for small state files, but tuned for CDK assets, not state. |
| Bucket policy `Deny s3:* unless aws:SecureTransport` | Fine — desirable for state too. |
| Write path scoped to `FilePublishingRole` (`s3:PutObject*`) | Terraform would need adding to a role designed for CDK asset publishing — coupling the two IaC paths' IAM. |
| `DeletionPolicy: Retain` on the bucket, `Delete` on the KMS key alias | Asymmetric lifecycle not designed around state durability. |

Beyond the lifecycle rule, the coupling is the deeper objection: a Terraform-only deployment would need a **CDK** bootstrap to exist first, which defeats the purpose of offering a CDK-free path. And `cdk bootstrap` could legitimately change its bucket policy or lifecycle without anyone considering Terraform state.

**Shape of `terraform/bootstrap/`:**
- Local state (`backend "local"`), or no backend at all — it manages one bucket and is re-runnable.
- Creates: the state bucket with versioning **enabled**, encryption, public-access block, TLS-only policy, and **no expiring lifecycle rule**.
- **Idempotent**: safe to re-run; use `terraform import` guidance or a `data` lookup so an existing bucket is adopted rather than duplicated.
- Documented as a one-time-per-account/region prerequisite, exactly parallel to `cdk bootstrap`.
- `DeletionPolicy`-equivalent: `prevent_destroy` lifecycle on the bucket.

Relates to [#120](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/120) (least-privilege bootstrap) — the Terraform bootstrap's own IAM needs are minimal (`s3:CreateBucket`, `PutBucketVersioning`, `PutBucketPolicy`, `PutEncryptionConfiguration`) and should be documented alongside the CDK bootstrap policies.

**Note:** `examples/parity-check/` must **not** configure a remote backend — PR 6 runs credential-free and a remote backend would require AWS access at `init` time, defeating the whole arrangement.
**Tests:** `terraform fmt -check`, `terraform validate` in CI. No AWS credentials needed — mirrors how `build.yml` runs credential-free today.
**Review focus:** provider version pinning; **solution UA enforcement** (below).
**Size:** ~150 lines. Deliberately provisions nothing.

### Solution user-agent — REQUIRED, mechanism confirmed

ABCA requires every outbound AWS call to carry `md/uksb-wt64nei4u6#{component}` (AGENTS.md, [#319](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/319)). The AWS provider documents **three** ways to append User-Agent info:

| Mechanism | Scope | Fit for ABCA |
|---|---|---|
| `provider_meta "aws" { user_agent = [...] }` | **Module-scoped** — only resources in the module where declared | ✅ **Correct choice.** Purpose-built for module authors; survives consumer-supplied `provider` blocks |
| `user_agent` provider argument | All resources on that provider instance | ⚠️ Lives in the *consumer's* `provider` block — a module cannot guarantee it |
| `TF_APPEND_USER_AGENT` env var | All resources | ⚠️ Operator-supplied; not enforceable by the module |

**Decision: use `provider_meta`.** It is the only mechanism a *module* can enforce regardless of how the consumer configures the provider — exactly mirroring how `SolutionUaAspect` applies repo-wide in CDK rather than per-call.

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.60"
    }
  }

  provider_meta "aws" {
    user_agent = [
      "md/uksb-wt64nei4u6#terraform",
    ]
  }
}
```

Constraints, from the docs:

- `provider_meta` goes **inside the `terraform` block**, and the `provider` block is **inherited from the root module** — so the module declares metadata without owning provider config.
- Terraform **≥ 0.13** required (`required_version` must reflect this).
- **Functions cannot be used in the `terraform` block** — so `provider::aws::user_agent(...)` is unavailable here; the string must be literal. This is why the value is hardcoded rather than composed.
- `provider_meta` is documented as **experimental**; requires provider support (the AWS provider has it).
- One `provider_meta` block per module — nested modules each need their own if they are to be attributed.

**Wire-format parity:** CDK emits `md/uksb-wt64nei4u6#{component}` where `#` comes from the SDK's own `name#value` join (`cdk/src/handlers/shared/ua.ts:100`, `SOLUTION_ID = 'uksb-wt64nei4u6'`). Terraform appends the string verbatim, so the `#` must be written literally. Keep the component label consistent with the three existing `ua` modules' vocabulary.

**Review must verify:** the literal string matches `SOLUTION_ID` exactly; every nested module carries its own `provider_meta`; `required_version` is ≥ 0.13. **Additionally:** decide whether the census harness (PR 6) should assert `provider_meta` presence in every module — a missing block is silent attribution loss, exactly the failure mode AGENTS.md flags as a common mistake.

---

## PR 2 — Data layer

**Branch:** `feat/644-terraform-data-layer`
**Scope:** 21 `aws_dynamodb_table` + 7 `aws_secretsmanager_secret`.
**Parity notes:**
- Use `force_destroy` / lifecycle rather than porting `Custom::S3AutoDeleteObjects` (3 CFN resources → 1 argument). This is the ADR's behavioral-parity principle in its most concrete form.
- Match billing mode, PITR, TTL, and GSI definitions against `cdk synth` output per table.
**Tests:** `terraform validate`; plan fixture asserting table count and key schemas.
**Review focus:** GSI parity; PITR/TTL flags; encryption at rest.
**Size:** moderate but repetitive — good candidate for `for_each` over a table definition map.

---

## PR 3 — AgentCore compute

**Branch:** `feat/644-terraform-agentcore`
**Scope:** `aws_bedrockagentcore_memory` + 2 `aws_bedrockagentcore_memory_strategy` + `aws_bedrockagentcore_agent_runtime`.
**The critical parity assertion** — must match `cdk/src/constructs/agent-memory.ts` exactly:

| CDK | Terraform |
|---|---|
| `usingSemantic`, `namespaces: ['/{actorId}/knowledge/']` | `type = "SEMANTIC"`, `namespace_templates = ["/{actorId}/knowledge/"]` |
| `usingEpisodic`, `['/{actorId}/episodes/{sessionId}/']` | `type = "EPISODIC"`, same template |
| `reflectionConfiguration.namespaces: ['/{actorId}/episodes/']` | `reflection_configuration.namespace_templates` |
| `expirationDuration: Duration.days(365)` | equivalent expiry argument |
| `LifecycleConfiguration` idle/max | `lifecycle_configuration.idle_runtime_session_timeout` / `max_lifetime` |

**Use `namespace_templates`, not `namespaces`** — the latter is deprecated in-provider. Do not set `memory_execution_role_arn` (also deprecated).
**Constraint to honor:** max 6 strategies/memory, one per built-in type. ABCA uses 2.
**Tests:** plan fixture asserting the exact namespace template strings.
**Review focus:** **This is the security-relevant PR.** Namespace templates are the entire multi-repo isolation boundary — one shared Memory resource, separated only by `actorId`. A wrong template silently leaks one repo's learnings into another's context. Review the strings character-by-character.

### CDK-default parity: derived, never hand-maintained

A hand-written "CDK defaults → HCL arguments" table would rot on the first CDK upgrade. It is not needed, because **`cdk synth` output already is that table** — CDK resolves every default before emitting CloudFormation. Verified: all **539/539** resources carry fully-resolved `Properties` in `cdk.out`.

Worked example, the one `terraform validate` caught during the 2026-08-13 spike:

| Layer | Value |
|---|---|
| CDK source | `expirationDuration: props?.expirationDuration ?? Duration.days(DEFAULT_EXPIRATION_DAYS)` — `agent-memory.ts:78`, const `365` at line 27. **No literal in the construct call.** |
| `cdk synth` | `"EventExpiryDuration": 365` — default resolved and materialized |
| Terraform | `event_expiry_duration` is **required**; omitting it fails `validate` |

So the rule for authors and reviewers is: **read the property values out of `cdk/cdk.out/*.template.json`, never out of the TypeScript.** The construct source hides defaults behind `??`; synth output states them. This makes the comparison mechanical and self-updating — regenerate synth, re-read.

**Where it lives:** nowhere as prose. Each PR's plan fixture asserts the values it ported, and the fixture's expected values are lifted from synth output. A CDK default change surfaces as a fixture mismatch on the next `mise run build`, not as a stale doc.

**Extractor for reviewers** (also useful in PR 6):

```bash
python3 -c "
import json,sys
d=json.load(open('cdk/cdk.out/backgroundagent-dev.template.json'))
want=sys.argv[1]
for lid,r in d['Resources'].items():
    if r['Type']==want: print(lid, json.dumps(r.get('Properties',{}), indent=2))
" AWS::BedrockAgentCore::Memory
```

**Follow-up worth considering (not MVP):** promote this from convention to a check — assert scalar property equality for a curated allowlist of security-relevant fields (memory namespaces, expiry, IAM policy documents) between synth output and `plan.json`. Stronger than the type census, narrower than full resource-graph identity. Deferred because choosing the field list is itself a design decision.

---

## PR 4 — Control plane

**Branch:** `feat/644-terraform-control-plane`
**Scope:** the largest slice — 58 Lambda functions, API Gateway (68 methods / 39 resources / 7 authorizers), 66 IAM roles, 63 policies, VPC + 9 endpoints, 6 EventBridge rules, 4 SQS queues, 4 alarms.
**Consumes:** `var.agent_image_uri` (built out-of-band per ADR sub-decision 6).
**Parity notes:**
- `Custom::VpcRestrictDefaultSG` → `aws_default_security_group` with no rules.
- IAM is the risk surface. Port policy documents statement-by-statement from synth output; do **not** paraphrase.
**Tests:** plan fixture asserting resource counts per type; a focused IAM assertion that no role carries `Action: "*"` or `Resource: "*"` beyond documented exceptions.
**Review focus:** IAM scope equivalence. The census harness (PR 6) checks types, **not** policy breadth — this review is the only defense against a silently over-broad grant.
**Recommendation:** if this PR exceeds ~800 lines, split by service boundary (4a Lambda+IAM, 4b API Gateway, 4c VPC, 4d events/queues/alarms). Reviewability is the goal.

---

## PR 5 — Blueprint equivalent

**Branch:** `feat/644-terraform-repo-config`
**Scope:** the deploy-time side effect from `cdk/src/constructs/blueprint.ts:321` — `AwsCustomResource` `PutItem` of repo config.
**Terraform:** `aws_dynamodb_table_item`, driven by a `var.repos` map. Arguably **more** idiomatic than the CDK original, whose own comment (line 199) flags an `AwsCustomResource` limitation.
**Must mirror:** `status = 'active'`, all config fields, and the registry-asset-ref fields that `onCreate`/`onUpdate` both write (line 395 warns a mismatch causes a redeploy to drop fields).
**Tests:** plan fixture asserting item shape for a sample repo.
**Review focus:** field-for-field equality with the CDK item. A missing field means a silently broken onboarding, not a failed apply.

---

## PR 6 — Parity census harness

**Branch:** `feat/644-terraform-parity-check`
**Scope:** `scripts/check-terraform-parity.mjs` + mise task + CI wiring.
**Algorithm:**
1. Census resource *types* from `cdk/cdk.out/*.template.json`.
2. Census provider resource types from `terraform show -json tfplan.bin`.
3. Load `terraform/PARITY_ALLOWLIST.md` — CFN types intentionally not ported, each with a reason.
4. Fail when a CDK type is in neither the module nor the allowlist.
5. Assert every module declares `provider_meta "aws"` with the solution UA string (PR 1).
**Seed allowlist:** `Custom::S3AutoDeleteObjects` (native `force_destroy`), `Custom::VpcRestrictDefaultSG` (native default-SG), `AWS::CDK::Metadata` (CDK-specific), `Custom::AgentCoreRegistry` (deferred — blocked on `agent-registry` migration), ECS/MicroVM types (deferred per ADR).
**Tests:** unit tests for the differ — a synthetic "CDK grew a new type" case must fail the check.
**Review focus:** Is this blocking or advisory? The ADR says **blocking**; contrast with the advisory `knip` ratchet.

### Credential question — RESOLVED by experiment 2026-08-13

Measured with Terraform 1.15.8 + AWS provider 6.60.0 in a stripped environment (`HOME` redirected, all `AWS_*` unset, `AWS_EC2_METADATA_DISABLED=true`):

| Command | Credential-free? |
|---|---|
| `terraform init` | ✅ yes |
| `terraform validate` | ✅ yes — `Success! The configuration is valid.` |
| `terraform plan` (no creds) | ❌ `Error: No valid credential sources found` |
| `terraform plan` (**mock creds + skip flags**) | ✅ yes — full plan, zero AWS contact |
| `terraform show -json` → type census | ✅ yes |

**So the harness needs no AWS access.** It runs in credential-free `build.yml` alongside `cdk synth`, using:

```hcl
# terraform/examples/parity-check/provider.tf — CI only, never for real deploys
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock_access_key"
  secret_key                  = "mock_secret_key"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}
```

```bash
terraform plan -refresh=false -input=false -out=tfplan.bin
terraform show -json tfplan.bin > plan.json   # census input
```

`-refresh=false` is what makes this work — Terraform never contacts AWS to reconcile state.

**Limitation to state plainly:** this proves *structural* parity (does the module declare the resource types CDK does). It cannot detect **drift between HCL and deployed reality**, because `-refresh=false` never reads reality. That is PR 8's job.

---

## PR 8 — Real-state drift detection (follow-up; may land after MVP)

**Branch:** `feat/644-terraform-drift-check`
**Why separate:** needs AWS credentials, a state backend, and a new IAM role — each an independent review concern. Bundling it into PR 6 would make a credential-free check depend on credentialed infrastructure. Sized as a follow-up per the 2026-08-13 scoping decision.

**Scope:** a `terraform plan` against **real deployed state**, surfacing drift in the step summary — the Terraform sibling of the existing `cdk diff` job.

**Reuses the existing `diff` environment** (`.github/workflows/deploy.yml:125-157`) — same environment, additional matrix step or sibling job, no new GitHub Environment. Its design intent transfers exactly:
- read-only IAM role, **no deploy/mutate permissions**
- `environment: diff`, no required reviewers so it auto-runs
- runs *before* any approval gate, so reviewers see changes first
- `permissions: id-token: write, contents: read, actions: read`

**IAM: attach the AWS-managed `ReadOnlyAccess` policy to the existing `diff` role — do not create a second environment.**

**Decision (2026-08-13).** A separate `terraform-diff` environment was considered and rejected: a new GitHub Environment does not compose cleanly with the existing job graph (`resolve-targets` → `diff` → approval → deploy), and would need its own secrets, reviewers, and matrix wiring for no security gain. `terraform plan` needs `Describe*`/`Get*`/`List*` across ~69 resource types, which is broad enough that enumerating it by hand would be error-prone *and* end up approximating `ReadOnlyAccess` anyway — with worse failure modes (a plan that errors mid-refresh on a missing permission looks like drift).

Reuse `environment: diff` and add the managed policy. The security property that matters is preserved: **read-only, no mutate**.

Trade-off to state honestly in review: `ReadOnlyAccess` is broader than what `cdk diff --method=template` needs today, so this **widens the `diff` role for both jobs**. Accepted because the role has no mutate permissions either way and the operational simplicity is worth it. `cdk-nag`/reviewers may flag the wildcard breadth — the justification belongs in the PR description, not a suppression.

### Secrets: `Deny` the value, keep the metadata

**Decision (2026-08-13): layer an explicit `Deny` on `secretsmanager:GetSecretValue` over `ReadOnlyAccess`. Drift detection keeps full metadata visibility and loses nothing it needs.**

This works cleanly because the Terraform provider already splits value from metadata:

| Resource | Contents | In ABCA's Terraform module? |
|---|---|---|
| `aws_secretsmanager_secret` | "secret **metadata**" — name, description, KMS key, rotation config, policy, tags | ✅ Yes — this is what drift detection cares about |
| `aws_secretsmanager_secret_version` | "including its secret **value**" | ❌ No — ABCA secrets are provisioned empty and populated out-of-band |

So an IAM `Deny` on `GetSecretValue` costs the drift check nothing: refreshing `aws_secretsmanager_secret` calls `DescribeSecret`, not `GetSecretValue`. You still detect a renamed secret, a changed KMS key, an altered rotation schedule, a modified resource policy, or a deleted secret — **everything except the value**, which is exactly the intent.

Verified this matches ABCA's actual pattern: 7 secrets across `slack-integration.ts`, `jira-integration.ts`, `linear-integration.ts`, `github-screenshot-integration.ts`, and `agent.ts`, all provisioned as shells populated later (e.g. `'Jira webhook signing secret — populate via bgagent jira setup'`). The one `generateSecretString` (jira webhook, line 205) has CloudFormation generate the value at deploy time — meaning **the value never exists in the repo or in any template**, and Terraform has no reason to read it.

Policy sketch for PR 8:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenySecretValueReads",
    "Effect": "Deny",
    "Action": [
      "secretsmanager:GetSecretValue",
      "secretsmanager:BatchGetSecretValue"
    ],
    "Resource": "*"
  }]
}
```

An explicit `Deny` beats a permissions boundary here: it always wins over `ReadOnlyAccess`'s `Allow`, it is visible in the role's own policy list rather than a separate boundary object, and it survives future `ReadOnlyAccess` revisions that might add value-read actions. Include `BatchGetSecretValue` — the newer bulk API is easy to overlook.

**Defense in depth (still do both):** never upload the plan file as a workflow artifact, and scrub the step summary. The `Deny` removes the main exposure; artifact hygiene covers anything else a refresh surfaces (e.g. SSM parameter values, if any are added later).

**Review must verify:** the `Deny` is attached alongside `ReadOnlyAccess`; a drift run still reports secret **metadata** changes; and `terraform plan` does not error on the denied action (it should not, since `aws_secretsmanager_secret` never calls it — confirm in the first real run).

**Strictly no mutation.** No `plan -out` + `apply`. With S3-native `use_lockfile`, a plan needs no lock write, so no write exception is required (this is a bonus of the `use_lockfile` decision).

**Review focus:** Is `GetSecretValue` denied? Is the plan output kept out of artifacts and logs? Does drift fail the build or only annotate the summary?

---

## PR 7 — Operator documentation

**Branch:** `docs/644-terraform-operator-guide`
**Scope:** `docs/guides/TERRAFORM_DEPLOY.md` — init/plan/apply, required provider versions, state backend expectations, image build prerequisite, repo onboarding via `var.repos`, upgrade, teardown, and an explicit **known gaps** table (registry, ECS, MicroVM).
**Must run:** `mise //docs:sync` (guide edits require regenerated Starlight mirrors; never hand-edit `docs/src/content/docs/`).
**Review focus:** Can an operator who has never seen ABCA follow this end-to-end? Is the gaps table honest?

---

## Cross-cutting requirements

Every code PR must:

1. Run `mise run build` credential-free (CI parity — `build.yml` has no `configure-aws-credentials` step).
2. Run `mise //cdk:eslint` + `//cli:eslint` after any merge from `main` and commit auto-fixes (CI "Fail build on mutation" rejects uncommitted lint output).
3. Add no dependency without ADR-003 "ask first" clearance.
4. Use branch naming `(feat|fix|chore|docs)/<issue>-description`.

## Verification ladder

| Level | Mechanism | Cost | Credentials | Confidence |
|---|---|---|---|---|
| 1 | `terraform fmt -check` + `validate` | seconds | none | syntax + **required-argument** errors (caught the `event_expiry_duration` gap) |
| 2 | Plan fixtures (counts, key strings, values from synth) | seconds | mock | structural + CDK-default parity |
| 3 | Type-census parity check (PR 6) | seconds | mock | anti-drift vs. CDK source |
| 4 | Real-state `plan` (PR 8) | ~1 min | **read-only role** | drift vs. deployed reality |
| 5 | **Deploy smoke: apply → submit task → PR opened → destroy** | ~30 min | **full deploy** | **the only real behavioral-parity proof** |

Levels 1-3 run credential-free (mock creds contact no AWS) and belong in `build.yml`. Level 4 needs the `diff`-style read-only role. Level 5 is the actual acceptance test in the ADR's terms — levels 1-4 prove structure and consistency but nothing about whether the platform *works*. Run level 5 manually against a burner account before claiming MVP success; gate it in CI like the existing integ work if it proves stable.

`terraform validate` earning a real finding at level 1 is worth noting: it is not merely a syntax check, it enforces provider-schema required arguments, which is exactly where CDK-default divergence shows up.

## Explicitly out of scope

Agent asset registry (blocked — see ADR Risks), ECS compute, Lambda MicroVM, EKS, Terraform Registry publication, rewriting agent/orchestrator logic, CDK-path changes of any kind.

## Question log

### Resolved 2026-08-13

| # | Question | Resolution |
|---|---|---|
| 1 | Solution UA — Terraform equivalent of `SolutionUaAspect`? | **`provider_meta "aws" { user_agent = [...] }`** — module-scoped, the only mechanism a module can enforce. REQUIRED. Syntax validated against provider 6.60.0. PR 6 also asserts its presence. (PR 1) |
| 2 | Can `terraform plan` run credential-free in CI? | **No for real creds, yes with mock creds + skip flags + `-refresh=false`.** Measured. Census harness therefore needs no AWS access. (PR 6) |
| 3 | State backend — opinionated or operator-supplied? | **Opinionated** S3 + lock in an isolated `backend.tf`, one-file swap for HCP/TFE. Most adopters use HCP/TFE, so relocation must be trivial. (PR 1) |
| 4 | Pin Terraform in `mise.toml`? | **Yes** — `terraform = "1.15.8"` under `[tools]`. (PR 1) |
| 5 | Where does the CDK-defaults table live and who updates it? | **Nowhere — it is derived, not maintained.** `cdk synth` resolves every default; all 539/539 resources carry resolved `Properties`. Authors read values from `cdk.out`, never from TypeScript. Plan fixtures encode them, so a CDK default change fails a fixture instead of rotting a doc. (PR 3) |
| 6 | Drift-vs-reality in MVP scope? | **Yes in principle, deferred by size** → **PR 8**, using a read-only role modeled on the `diff` environment. (PR 8) |

### Resolved 2026-08-13 (second round)

| # | Question | Resolution |
|---|---|---|
| 7 | New `terraform-diff` environment vs. widen existing role? | **Add AWS-managed `ReadOnlyAccess` to the existing `diff` role.** A second GitHub Environment does not fit the job graph cleanly, and hand-enumerating ~69 resource types' read actions would approximate `ReadOnlyAccess` with worse failure modes. Accepts that this widens the role for the CDK `diff` job too; no mutate permissions either way. (PR 8) |
| 8 | S3-native locking at 1.15.8? | **Confirmed supported.** `init` with backend validation failed only on credentials; negative control (`use_lockfile_typo_xyz`) produced `Unsupported argument`, proving schema validation was active. **No DynamoDB lock table.** (PR 1) |
| 9 | State bucket chicken-and-egg — reuse CDK's `StagingBucket`? | **No — dedicated idempotent `terraform/bootstrap/`.** The CDK staging bucket sets `NoncurrentVersionExpiration: 30 days`, which would silently destroy state history (the recovery path). Reuse would also make a Terraform-only deploy depend on a CDK bootstrap. (PR 1) |

### Resolved 2026-08-13 (third round)

| # | Question | Resolution |
|---|---|---|
| 10 | `ReadOnlyAccess` + `secretsmanager:GetSecretValue` | **Explicit `Deny` on `GetSecretValue` + `BatchGetSecretValue`, layered over `ReadOnlyAccess`.** Costs drift detection nothing: `aws_secretsmanager_secret` is *metadata only* (name, KMS key, rotation, policy, tags); the value lives in `aws_secretsmanager_secret_version`, which ABCA's module does not manage. Metadata drift stays fully visible. (PR 8) |
| 11 | Is the local/lock file committed? | **`.terraform.lock.hcl` YES** (dependency lock, like `yarn.lock`; multi-platform via `terraform providers lock`). **`*.tfstate` NEVER.** The `use_lockfile` concurrency lock is an S3 object, not a repo file. Repo has **no** terraform `.gitignore` patterns today — PR 1 adds them. (PR 1) |

### Still open

1. **Registry** — deferred; confirm no MVP component transitively requires it.
2. **Root stack headroom** — 479/500. Does any CFN-wrap fallback consume the margin?
3. **Bootstrap parity breadth** — `cdk/bootstrap/` also ships least-privilege *policies* and `BOOTSTRAP_HASH`/`BOOTSTRAP_VERSION` drift detection. `terraform/bootstrap/` covers only the state bucket; whether Terraform needs an equivalent policy/versioning story is a separate decision. Relates to [#120](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/120).
4. **Property-equality check** (post-MVP) — promote the derived-defaults convention into a check over a curated allowlist of security-relevant fields. Deferred because choosing the field list is a design decision.
