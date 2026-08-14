# ABCA root module — module wiring.
#
# Intentionally empty in this PR. The skeleton deliberately provisions nothing:
# its job is to establish version constraints, solution-UA attribution
# (versions.tf), provider/tag conventions (providers.tf), the state backend
# contract (backend.tf), and the CI fmt/validate gate.
#
# Later PRs in the stack wire submodules here:
#   - data layer        (DynamoDB tables + Secrets Manager shells)
#   - AgentCore compute (Memory + strategies + Runtime)
#   - control plane     (API Gateway, Lambdas, IAM, VPC, events, queues, alarms)
#   - repo config       (the DynamoDB PutItem side effect CDK does via
#                        AwsCustomResource in cdk/src/constructs/blueprint.ts)
#
# REMINDER for whoever adds the first `module` block: `provider_meta` is
# per-module and does NOT inherit. Every submodule needs its own
# `provider_meta "aws"` block or it silently loses solution attribution (#319).
# The parity harness asserts this.
