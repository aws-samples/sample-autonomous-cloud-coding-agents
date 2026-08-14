# ABCA on Terraform

An **additive** Terraform deploy path for ABCA. The AWS CDK app in [`cdk/`](../cdk/)
remains canonical; this tree exists so operators standardized on Terraform can
adopt ABCA without introducing CDK into their organization.

Parity is defined **behaviorally**, not as resource-graph identity: idiomatic HCL
uses different — usually fewer — resources than CloudFormation. See the ADR for
what that means and what it does not promise.

> **Status: skeleton.** This directory currently provisions **nothing**. It
> establishes version constraints, solution-UA attribution, provider and tagging
> conventions, the state-backend contract, and the CI `fmt`/`validate` gate.
> Resources land in subsequent PRs (data layer, AgentCore compute, control
> plane, repo config). Do not expect a working deployment from this state.

## Prerequisites

1. **Terraform ≥ 1.5.0.** Pinned to `1.15.8` in the repo's `mise.toml`, so
   `mise run install` gives you the version CI uses. Ad hoc:
   `MISE_EXPERIMENTAL=1 mise x terraform@1.15.8 -- terraform version`.
2. **AWS credentials** for the target account, in a region where Bedrock
   AgentCore is available.
3. **The agent container image, already built and pushed.** Terraform does not
   replicate CDK's asset pipeline (ADR sub-decision 6). Build and push the image
   out-of-band, then pass its URI as `agent_image_uri` — prefer an
   `@sha256:<digest>` reference over a mutable tag.
4. **A state bucket**, created by [`bootstrap/`](./bootstrap/README.md). Not
   needed if you use HCP Terraform / Terraform Enterprise.

## Two steps

### 1. Bootstrap (once per account + region)

Creates the versioned, encrypted, TLS-only S3 bucket that holds ABCA's state.
Same prerequisite shape as `cdk bootstrap`.

```bash
cd terraform/bootstrap
terraform init
terraform apply
```

Full detail, including how to adopt a bucket that already exists and why its own
local state is disposable: [`bootstrap/README.md`](./bootstrap/README.md).

### 2. Deploy

```bash
cd terraform
terraform init \
  -backend-config="bucket=abca-tfstate-<account-id>-<region>" \
  -backend-config="key=abca/terraform.tfstate" \
  -backend-config="region=<region>"

terraform plan  -var="agent_image_uri=<ecr-uri>"
terraform apply -var="agent_image_uri=<ecr-uri>"
```

Backends cannot read variables, so `bucket`/`key`/`region` come from
`-backend-config` or from editing [`backend.tf`](./backend.tf) directly. To use
HCP/TFE instead, replace that one file with a `cloud {}` block — the swap is
documented in its header comment.

## Layout

| Path | Role |
|---|---|
| `versions.tf` | Terraform + provider constraints, and `provider_meta` solution attribution (#319) |
| `providers.tf` | Provider config and `default_tags` mirroring CDK's stable tags |
| `backend.tf` | S3 backend with S3-native locking. **Replace this one file** to relocate state |
| `variables.tf` | Inputs: region, env name, agent image URI, blueprint repo |
| `outputs.tf` | Empty; populated by later PRs |
| `main.tf` | Module wiring; empty by design in this PR |
| `bootstrap/` | Separate root module creating the state bucket |
| `examples/parity-check/` | **CI only.** Credential-free plan for the parity census |

## Committed vs. ignored

`.terraform.lock.hcl` **is committed** — it pins provider versions *and*
checksums, exactly as `yarn.lock` does for the JS workspaces, so CI and every
operator resolve byte-identical providers. Regenerate it for all supported
platforms when the constraint moves:

```bash
terraform providers lock \
  -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
```

State (`*.tfstate`) is **never** committed — it can contain plaintext secrets.
Neither are `*.tfvars` (the conventional home for operator-supplied values,
including tokens; ship `*.tfvars.example` instead) or plan files (`tfplan.bin`,
`plan.json`) — a plan can embed values read during refresh. See the `# Terraform`
section of the root [`.gitignore`](../.gitignore).

The `use_lockfile` concurrency lock is a third, unrelated thing: an S3 object in
the state bucket, never a file in this repo.

## Local checks

```bash
MISE_EXPERIMENTAL=1 mise run terraform:fmt        # check formatting
MISE_EXPERIMENTAL=1 mise run terraform:fmt:fix    # rewrite in place
MISE_EXPERIMENTAL=1 mise run terraform:validate   # init -backend=false, then validate
```

Both run in `mise run build` and are credential-free, matching how `build.yml`
runs today. `terraform validate` is more than a syntax check — it enforces
provider-schema **required arguments**, which is exactly where CDK-default
divergence shows up (a CDK construct's `?? Duration.days(365)` is invisible in
TypeScript but required in HCL).

## Reading CDK property values

When porting a resource, read its properties from `cdk/cdk.out/*.template.json`,
**never from the TypeScript**. CDK resolves every default before emitting
CloudFormation, so synth output states values the construct source hides behind
`??`. This keeps the comparison mechanical and self-updating.

## Known gaps

Deferred from the MVP, each with a reason in the ADR: the agent asset registry
(no successor provider resource; CDK side mid-migration), ECS compute, Lambda
MicroVM compute, and Terraform Registry publication.

## Reference

- ADR: **Terraform as an additive deploy path** — [`docs/decisions/`](../docs/decisions/)
- [#644](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/644) — Terraform support RFC
- [#319](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/319) — solution UA attribution
