# ABCA Terraform bootstrap

Creates the single S3 bucket that stores ABCA's Terraform state.

**Run this once per AWS account + region, before the first `terraform init` in
`terraform/`.** It is the Terraform sibling of `cdk bootstrap` — a configuration
cannot store its state in a bucket it is itself creating, so one bucket has to
exist first.

Skip this entirely if you use HCP Terraform / Terraform Enterprise: replace
`terraform/backend.tf` with a `cloud {}` block and the platform holds your state.

## Usage

```bash
cd terraform/bootstrap
terraform init
terraform apply
```

Then take the `backend_config_hint` output and use it in the root module:

```bash
cd ..
terraform init \
  -backend-config="bucket=abca-tfstate-<account-id>-<region>" \
  -backend-config="key=abca/terraform.tfstate" \
  -backend-config="region=<region>"
```

Or edit `terraform/backend.tf` in place — see the comments in that file.

### Variables

| Variable | Default | Notes |
|---|---|---|
| `aws_region` | `us-east-1` | Use the same region you deploy ABCA into. |
| `state_bucket_name` | `null` | Leave unset to derive `abca-tfstate-<account-id>-<region>`. |

## Safe to re-run

`terraform apply` here is idempotent. Re-running against an already-bootstrapped
account is a no-op plan.

If you are bootstrapping an account where the bucket already exists but this
module has never tracked it (a colleague ran the bootstrap, or you lost the
state file), adopt it rather than fighting `BucketAlreadyOwnedByYou`:

```bash
terraform init
terraform import aws_s3_bucket.tfstate abca-tfstate-<account-id>-<region>
terraform apply     # reconciles versioning/encryption/policy on the adopted bucket
```

The bucket sub-resources (`aws_s3_bucket_versioning`, `..._server_side_encryption_configuration`,
`..._public_access_block`, `..._ownership_controls`, `..._policy`) all import by
bucket name too, if you want them tracked rather than re-applied:

```bash
terraform import aws_s3_bucket_versioning.tfstate abca-tfstate-<account-id>-<region>
```

## Its local state is DISPOSABLE

This module uses `backend "local"`, so `terraform.tfstate` lands on disk next to
`main.tf`. That file is gitignored (`*.tfstate`) and **must never be committed** —
but unlike ABCA's real state, **losing it is not a problem**. The module manages
exactly one bucket, is idempotent, and adopts an existing bucket via
`terraform import`. Worst case you re-import and re-apply.

This is unusual enough to state plainly: do not build backup tooling around this
state file. The bucket it creates is precious; the record of having created it is
not.

## IAM the bootstrap needs

Minimal, and worth scoping separately from the deploy role (relates to
[#120](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/120)):

- `s3:CreateBucket`
- `s3:PutBucketVersioning`
- `s3:PutBucketPolicy`
- `s3:PutEncryptionConfiguration`
- `s3:PutBucketPublicAccessBlock`
- `s3:PutBucketOwnershipControls`
- `s3:PutBucketTagging`
- `sts:GetCallerIdentity` (for the derived bucket name)
- the matching `Get*`/`s3:HeadBucket` reads, so re-runs can refresh

## Why not the CDK bootstrap bucket

The CDK bootstrap `StagingBucket` sets
`LifecycleConfiguration → NoncurrentVersionExpiration → NoncurrentDays: 30`.
Terraform state version history is the recovery path from a corrupted or
mis-applied state, and silently expiring it after 30 days is a failure you only
discover at the moment you need to roll back. Reuse would also couple the two
IaC paths' IAM (CDK scopes bucket writes to its `FilePublishingRole`) and make a
Terraform-only deployment depend on a CDK bootstrap having been run — defeating
the point of offering a CDK-free path.

That is why **this module intentionally has no lifecycle rule at all**. Do not
add one.

See ADR sub-decision 4c ([`docs/decisions/`](../../docs/decisions/)) for the
full comparison.
