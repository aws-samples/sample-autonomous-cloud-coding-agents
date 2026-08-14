# ABCA Terraform bootstrap — creates the S3 bucket that holds ABCA's Terraform
# state. One-time per account/region. Exactly parallel to `cdk bootstrap`.
#
# This is a SEPARATE ROOT MODULE with LOCAL state, on purpose: a configuration
# cannot store its state in a bucket it is itself creating. Its local
# `terraform.tfstate` is DISPOSABLE — see README.md.
#
# Why not reuse the CDK bootstrap StagingBucket (ADR sub-decision 4c): that
# bucket sets `NoncurrentVersionExpiration: NoncurrentDays: 30`. State version
# history IS the recovery path from a corrupted or mis-applied state, and losing
# it is invisible until the moment you need to roll back. It would also couple
# the two IaC paths' IAM and make a Terraform-only deploy depend on a CDK
# bootstrap having been run.
#
# NOTE the deliberate absence of any lifecycle_configuration below. Do not add
# a version-expiry rule here.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.60"
    }
  }

  # Solution attribution (#319) is per-module and does not inherit, so this
  # separate root module declares its own. Literal must match SOLUTION_ID in
  # cdk/src/handlers/shared/ua.ts; functions are not allowed in this block.
  provider_meta "aws" {
    user_agent = [
      "md/uksb-wt64nei4u6#terraform",
    ]
  }

  # Local state, by necessity. Kept explicit rather than implicit so it is
  # obvious to a reader that this is not a mistake.
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region to create the Terraform state bucket in. Use the same region you deploy ABCA into."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "Override the state bucket name. Leave null to use the derived default `abca-tfstate-<account-id>-<region>`."
  type        = string
  default     = null
}

data "aws_caller_identity" "current" {}

locals {
  bucket_name = coalesce(
    var.state_bucket_name,
    "abca-tfstate-${data.aws_caller_identity.current.account_id}-${var.aws_region}",
  )
}

resource "aws_s3_bucket" "tfstate" {
  bucket = local.bucket_name

  tags = {
    Name    = local.bucket_name
    Purpose = "abca-terraform-state"
  }

  # Equivalent of CloudFormation `DeletionPolicy: Retain`. Deleting the state
  # bucket destroys the record of every resource ABCA manages, so `terraform
  # destroy` here must fail loudly rather than succeed quietly. To decommission,
  # remove this block deliberately in a dedicated change.
  lifecycle {
    prevent_destroy = true
  }
}

# Versioning ENABLED is the whole point of this module: every state write keeps
# the previous version, which is how you recover from a corrupted or partially
# applied state.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 (AES256). Deliberately not SSE-KMS: a customer-managed key adds a
# second bootstrap dependency and a key policy that must grant every principal
# running Terraform. Operators who require CMK encryption can change
# `sse_algorithm` to `aws:kms` and set `kms_master_key_id`.
resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# TLS-only, mirroring the CDK bootstrap bucket's one desirable policy statement.
data "aws_iam_policy_document" "tfstate_tls_only" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.tfstate.arn,
      "${aws_s3_bucket.tfstate.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  policy = data.aws_iam_policy_document.tfstate_tls_only.json

  # The public-access block must be in place before a bucket policy is attached,
  # otherwise `block_public_policy` can race the PutBucketPolicy call.
  depends_on = [aws_s3_bucket_public_access_block.tfstate]
}

output "state_bucket_name" {
  description = "Name of the Terraform state bucket. Use as the `bucket` value in terraform/backend.tf."
  value       = aws_s3_bucket.tfstate.id
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state bucket, for scoping operator IAM policies."
  value       = aws_s3_bucket.tfstate.arn
}

output "backend_config_hint" {
  description = "Ready-to-paste `terraform init -backend-config` arguments for the ABCA root module."
  value       = "-backend-config=\"bucket=${aws_s3_bucket.tfstate.id}\" -backend-config=\"key=abca/terraform.tfstate\" -backend-config=\"region=${var.aws_region}\""
}
