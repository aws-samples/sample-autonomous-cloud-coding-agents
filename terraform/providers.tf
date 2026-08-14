# AWS provider configuration for the ABCA root module.
#
# Tag parity with CDK
# -------------------
# CDK applies tags in two layers (cdk/src/main.ts):
#
#   1. `compute_type` — stable, derived from the `compute_type` CDK context
#      value (default `agentcore`). Mirrored here.
#   2. `github:*` (13 keys: sha, ref, actor, run-id, …) — injected per-deploy by
#      CI from GitHub Actions context, defaulting to the string `none` locally.
#      DELIBERATELY NOT mirrored: they are provenance for a specific CI run, not
#      a property of the infrastructure, and hard-coding `none` for all 13 would
#      add noise without adding information. An operator who wants them can pass
#      them through their own `default_tags` in a wrapper configuration.
#
# Also note `cdk/src/constructs/lambda-microvm-compute.ts` applies
# `abca:compute-backend` per-construct, and `operational-alerts.ts` applies
# `ABCA=operational-alerts` to one KMS key. Those are resource-scoped, not
# stack-wide, so they belong on the individual resources in later PRs — not
# here.
#
# Known divergence to handle when Route53 Resolver resources land: CDK excludes
# `AWS::Route53Resolver::ResolverQueryLoggingConfig` and its Association from
# tagging, because that service treats ANY property change (tags included) as
# requiring replacement, and the Association's one-per-VPC constraint then makes
# the update fail. `default_tags` has no per-type exclusion, so those resources
# will need an explicit `tags = {}` plus a `lifecycle { ignore_changes = [tags] }`
# or a provider alias with `default_tags` omitted.
provider "aws" {
  region = var.aws_region

  # Credential-free plan support for the CI parity census (PR 6), OFF by default.
  #
  # These must live HERE, not in examples/parity-check/, and that is not obvious:
  # a `provider` block in a CALLING module does not configure a child module's
  # provider. The census plans `module.abca`, so the provider instance that
  # actually contacts STS is this one — confirmed by the error, which named
  # `module.abca.provider[...] on providers.tf`. Setting the skip flags only in
  # the example left `plan` failing on `InvalidClientTokenId` from
  # GetCallerIdentity. There are also no `AWS_SKIP_*` environment variables to
  # fall back on (tested: not recognized by the provider).
  #
  # Gated on a variable defaulting to false so a real deployment keeps full
  # credential validation — silently skipping it would turn a clear
  # bad-credentials error at plan time into a confusing mid-apply failure.
  skip_credentials_validation = var.credential_free_plan
  skip_requesting_account_id  = var.credential_free_plan
  skip_metadata_api_check     = var.credential_free_plan
  skip_region_validation      = var.credential_free_plan

  default_tags {
    tags = {
      compute_type = "agentcore"
    }
  }
}
