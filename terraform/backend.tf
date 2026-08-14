# backend.tf — ABCA's OPINIONATED DEFAULT. Replace this whole file to relocate
# state; nothing else in the module refers to it.
#
# Backends cannot interpolate variables, locals, or functions, so the values
# below are PLACEHOLDERS. Choose one of:
#
#   (a) Edit this file in place with your bucket/key/region, or
#   (b) Leave it and pass values at init time (partial configuration):
#
#         terraform init \
#           -backend-config="bucket=abca-tfstate-123456789012-us-east-1" \
#           -backend-config="key=abca/terraform.tfstate" \
#           -backend-config="region=us-east-1"
#
#       or `terraform init -backend-config=backend.hcl` with a file holding the
#       same key/value pairs. Note `*.tfvars` is gitignored but a `backend.hcl`
#       is not — do not put credentials in it.
#
# The bucket must exist BEFORE the first `init`: a configuration cannot create
# the bucket that stores its own state. Run `terraform/bootstrap/` first (see
# terraform/bootstrap/README.md). This is the same prerequisite shape as
# `cdk bootstrap`.
#
# `use_lockfile = true` is S3-NATIVE locking (a `<key>.tflock` object in the
# same bucket). There is intentionally NO `dynamodb_table` — support was
# confirmed at Terraform 1.15.8, so the lock table is dead weight.
#
# ── Using HCP Terraform / Terraform Enterprise instead ────────────────────────
# Replace everything below with a `cloud` block and delete the S3 settings:
#
#   terraform {
#     cloud {
#       organization = "your-org"
#       workspaces {
#         name = "abca-prod"
#       }
#     }
#   }
#
# In that case `terraform/bootstrap/` is unnecessary — HCP/TFE stores the state.
terraform {
  backend "s3" {
    # REPLACE: `abca-tfstate-<account-id>-<region>`, created by terraform/bootstrap/.
    bucket       = "REPLACE-ME-abca-tfstate-bucket"
    key          = "abca/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
