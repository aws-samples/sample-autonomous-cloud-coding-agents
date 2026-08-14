# ═══════════════════════════════════════════════════════════════════════════════
# CI ONLY — NEVER USE THIS FOR A REAL DEPLOYMENT.
#
# This root module exists solely so the resource-type parity census can run
# `terraform plan` with NO AWS credentials and NO AWS network access. The `skip_*`
# flags suppress every call the provider would otherwise make at configure time
# (STS GetCallerIdentity, the EC2 metadata endpoint, region validation), and the
# census runs `plan -refresh=false` so nothing is read from AWS either.
#
# The mock credentials are supplied through the ENVIRONMENT, not written here:
#
#   export AWS_ACCESS_KEY_ID=mock_access_key
#   export AWS_SECRET_ACCESS_KEY=mock_secret_key
#   export AWS_EC2_METADATA_DISABLED=true
#   terraform init
#   terraform plan -refresh=false -input=false -out=tfplan.bin
#   terraform show -json tfplan.bin > plan.json   # census input
#
# Verified end-to-end with all AWS_* unset except the mocks above: plan succeeds
# and `show -json` emits a format_version 1.2 document, which is the census input.
#
# `access_key`/`secret_key` are deliberately NOT set as provider arguments even
# though the values are fake. The `terraform.aws.security.aws-provider-static-credentials`
# semgrep rule in `mise run security:sast` is blocking, and it is right to be:
# a config file that CAN carry a static credential is the thing worth preventing,
# and a `nosemgrep` here would train reviewers to wave the rule through on files
# where the credential is real. Keeping the values in the environment removes the
# capability rather than annotating it. The provider reads them via the standard
# credential chain, so behavior is identical.
#
# There is deliberately NO `backend` block. A remote backend would require AWS
# access at `init` time, which is exactly the property this arrangement exists to
# avoid (ADR sub-decision 4b). Default local state is correct here, and the
# resulting `terraform.tfstate` is a throwaway CI artifact.
#
# Do not copy this file into an operator-facing example.
# ═══════════════════════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.60"
    }
  }

  # Present so the census harness's own assertion — "every module declares
  # provider_meta with the solution UA string" — holds for this module too, and
  # so this file stays a faithful copy of the real module's terraform block.
  # Per-module and non-inheriting (#319).
  provider_meta "aws" {
    user_agent = [
      "md/uksb-wt64nei4u6#terraform",
    ]
  }
}

# NOTE: this block configures the provider for THIS root module only. It does
# NOT configure the provider inside `module.abca` — a calling module's provider
# block never does. That is why the skip flags live in ../../providers.tf, gated
# on the `credential_free_plan` input set below, rather than here. Setting them
# only in this file leaves `plan` failing with `InvalidClientTokenId` from
# GetCallerIdentity against `module.abca.provider[...]`.
provider "aws" {
  region = "us-east-1"

  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

# The module under census. Later PRs give it inputs as it grows resources; the
# values here are plan-time fixtures, chosen to be obviously fake.
module "abca" {
  source = "../.."

  aws_region      = "us-east-1"
  env_name        = "parity"
  agent_image_uri = "000000000000.dkr.ecr.us-east-1.amazonaws.com/abca-agent:parity-check"

  credential_free_plan = true
}
