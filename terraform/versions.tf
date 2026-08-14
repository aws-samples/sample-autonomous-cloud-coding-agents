# Terraform + provider version constraints and ABCA solution attribution.
#
# `provider_meta` is the Terraform equivalent of CDK's `SolutionUaAspect`
# (#319, ADR sub-decision 7). It appends `md/uksb-wt64nei4u6#terraform` to the
# User-Agent of every AWS API call made by resources declared in THIS module.
#
# Why `provider_meta` and not the alternatives:
#   - `user_agent` provider argument  -> lives in the CONSUMER's provider block;
#                                       a module cannot guarantee it is set.
#   - `TF_APPEND_USER_AGENT` env var  -> operator-supplied; not enforceable.
#   - `provider_meta`                 -> module-scoped, declared by the module
#                                       author, survives any consumer-supplied
#                                       provider configuration. <- correct choice
#
# Constraints that shape this file (from the Terraform docs):
#   - The block MUST live inside `terraform {}`; the `provider` block itself is
#     inherited from the root module.
#   - Requires Terraform >= 0.13 (satisfied by required_version below).
#   - Functions are NOT allowed inside the `terraform` block, so the string is a
#     hard-coded literal — `provider::aws::user_agent(...)` is unavailable here.
#   - `provider_meta` is documented as experimental and is ONE-PER-MODULE:
#     every nested module needs its own block, or it silently loses attribution.
#
# The literal below must stay byte-identical to `SOLUTION_ID` in
# cdk/src/handlers/shared/ua.ts (`uksb-wt64nei4u6`) and
# cdk/src/constructs/solution-ua-aspect.ts. The `#` separator is written
# literally because CDK gets it from the AWS SDK's own `name#value` join, while
# Terraform appends this string verbatim.
terraform {
  required_version = ">= 1.5.0"

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
