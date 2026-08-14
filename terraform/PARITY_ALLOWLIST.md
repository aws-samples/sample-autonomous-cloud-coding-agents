# Terraform parity allowlist

CloudFormation resource **types** that the ABCA CDK app emits and this Terraform
module deliberately does **not** port. Each row is a decision on the record, not
a gap.

Read alongside `scripts/check-terraform-parity.mjs`, which parses this file, and
[ADR-XXX sub-decision 4](../docs/decisions/ADR-XXX-terraform-additive-deploy-path.md)
(tier 1, structural census), which motivates it.

## How the check uses this file

The parity harness censuses resource **types** — never counts — on both sides:
CloudFormation types from `cdk/cdk.out/*.template.json`, provider types from
`terraform show -json`. It maps between them via
[`scripts/terraform-parity-map.json`](../scripts/terraform-parity-map.json), and
**fails** when a CFN type is in neither the module nor this table.

Types, not counts, because idiomatic HCL legitimately uses a different *number*
of resources for identical behavior — three `Custom::S3AutoDeleteObjects` become
one `force_destroy = true` argument, while one `AWS::S3::Bucket` becomes six or
more `aws_s3_bucket_*` resources. A count diff would be red on day one for
reasons that are all correct, and would be muted within a week.

So an entry here means exactly one thing: **ABCA knows about this capability and
has decided not to implement it in Terraform, for the stated reason.** It does
not mean the resource does not matter.

## Format contract — strict, machine-parsed

The parser recognizes a row **only** when its first cell is a backticked
CloudFormation type. Prose, headings, and the header/separator rows are ignored,
so this document can be read by humans without special-casing.

1. Exactly **three** pipe-delimited columns: `` `CFN::Type` `` | reason not ported | revisit when.
2. Column 1 is a **single backticked** type matching `AWS::*` or `Custom::*`. No
   wildcards, no ranges, no multiple types per row — one type, one decision.
3. Column 2 is a **real reason** of at least 15 characters. `TBD`, `TODO`, `n/a`,
   `-` and friends are **rejected** (exit 2, malformed file). A placeholder is
   strictly worse than no row: it launders an undecided gap as a decided one,
   which is the failure this gate exists to prevent.
4. Column 3 is a **revisit-when** — name the event that would make this worth
   reconsidering, or say `never` and why. Also rejected if it is a placeholder.
5. No `|` inside a cell (it would split the row). No duplicate rows for a type.

A malformed row is a **hard error**, not a skipped line: silently dropping it
would turn a declared gap back into an undeclared one without telling anyone.

## Not ported — structurally impossible or a native equivalent

These have no provider resource to implement, because the behavior collapses into
an argument or is CDK-internal plumbing. They are **permanent**, not deferred.

| CFN type | Reason not ported | Revisit when |
|---|---|---|
| `Custom::S3AutoDeleteObjects` | Native `force_destroy = true` on `aws_s3_bucket` does exactly this. CDK needs a Lambda-backed custom resource because CloudFormation cannot empty a bucket before delete; the AWS provider empties it in-process. Implementing a resource here would be strictly worse than the argument. | Never — a provider argument replaces it fully. Revisit only if `force_destroy` is removed. |
| `Custom::VpcRestrictDefaultSG` | Native `aws_default_security_group` adopts the VPC's default SG and, declared with no ingress or egress blocks, strips every rule — the same end state CDK reaches via a custom resource. The module may also leave the default SG unmanaged; both are correct, so this is not a capability gap. | If a compliance control requires the default SG to be explicitly managed rather than merely rule-free, add `aws_default_security_group` and drop this row. |
| `AWS::CDK::Metadata` | CDK-internal construct-library telemetry. It has no runtime effect, provisions nothing, and there is nothing for a provider to create. Terraform's analogue is the `provider_meta` user-agent string, which this module already declares. | Never. |
| `AWS::CloudFormation::Stack` | Nested-stack plumbing, a CloudFormation-only decomposition CDK uses to stay under the 500-resource limit. Terraform's equivalent is a `module` block, which is not a resource and therefore never appears in a plan's resource census. The nested stacks' *contents* are censused normally. | Never — the mechanism does not exist in Terraform. |
| `AWS::Lambda::Version` | No provider resource exists; `publish = true` on `aws_lambda_function` produces the version and exposes it as the `version` attribute. Same behavior, expressed as an argument. | Never, unless the provider adds a standalone version resource. |

## Not ported — deferred, with a blocking reason

These are real capabilities the module could grow. Each is deferred for a stated
cause, and each names what would unblock it.

| CFN type | Reason not ported | Revisit when |
|---|---|---|
| `Custom::AgentCoreRegistry` | `aws_bedrockagentcore_registry` **does** exist in AWS provider 6.60.0 (verified 2026-08-14), but the provider itself marks it deprecated: AWS Agent Registry moved from the `bedrock-agentcore` namespace to `agent-registry` on 2026-08-06, and `bedrock-agentcore` shuts down 2026-09-17. No successor `aws_agentregistry_*` resource has shipped. Porting to the deprecated resource means writing code with a roughly five-week half-life, against an API whose schema is changing incompatibly (ADR-022, issue #246), not merely being renamed. | A successor `aws_agentregistry_*` resource ships **and** the CDK side (issue #246) has completed its namespace migration, so both paths target one API. |
| `Custom::AWS` | `AwsCustomResource` is an escape hatch that performs an arbitrary AWS SDK call, not a resource type, so there is no single provider resource it maps to. Each of the three instances needs its own decision. The blueprint repo-config `PutItem` has a clean equivalent in `aws_dynamodb_table_item` and is scheduled for a later PR in this stack. | Each instance is decided individually. Remove this row once every `Custom::AWS` in `cdk.out` has either a Terraform equivalent or its own narrower entry. |
| `AWS::ECS::Cluster` | ECS is an **optional** compute variant, synthesized only under `-c compute_type=ecs`; AgentCore Runtime is the default and only MVP substrate (ADR sub-decision 5). `aws_ecs_cluster` exists and is unblocked — this is scope, not capability. | An operator needs the ECS substrate under Terraform, or ECS becomes a default rather than an opt-in. |
| `AWS::ECS::TaskDefinition` | Same scope decision as `AWS::ECS::Cluster`. The port is non-trivial beyond the resource itself: CDK builds the container image as a `DockerImageAsset`, and Terraform consumes a pre-built image URI out-of-band (ADR sub-decision 6), so the two task definitions would need the asset pipeline reworked as well. | Together with `AWS::ECS::Cluster` — the two are useless apart. |
| `AWS::Lambda::MicrovmImage` | **No `aws_lambda_microvm_image` resource exists** in AWS provider 6.60.0 (full `lambda` resource list checked 2026-08-14). Unimplementable today, independent of the fact that the CDK backend is itself still landing (issue #645 / ADR-021). Blocked dependency, not deferred scope. | The AWS provider ships a MicroVM image resource **and** ADR-021 has landed on the CDK side. |
| `AWS::Lambda::NetworkConnector` | **No `aws_lambda_network_connector` resource exists** in AWS provider 6.60.0 (checked 2026-08-14). The MicroVM egress and build connectors have no HCL expression at all, so the MicroVM substrate cannot be ported even in part. | The AWS provider ships a network-connector resource. Track with `AWS::Lambda::MicrovmImage`. |

## Adding a row

Do not add one to make a red build green. The check's message offers two
remedies and they are not equivalent:

- **Implement it** in `terraform/` — correct whenever a provider resource exists
  and the capability is in MVP scope.
- **Add a row here** — correct only when the capability is genuinely out of
  scope, has no provider resource, or is blocked on something nameable.

If you cannot write column 2 without hedging, that is the signal the answer is
"implement it". Editing `scripts/check-terraform-parity.mjs` or
`scripts/terraform-parity-map.json` to make the gate pass is never a remedy.
