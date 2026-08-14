# Input variables for the ABCA root module.
#
# Later PRs add variables as they add resources (data layer, AgentCore compute,
# control plane, repo config). Keep declarations here, not scattered per-file,
# so `terraform-docs` and reviewers have one place to look.

variable "aws_region" {
  description = "AWS region to deploy ABCA into. Must be a region where Bedrock AgentCore is available."
  type        = string
  default     = "us-east-1"
}

variable "env_name" {
  description = "Environment name used in resource names and tags (e.g. dev, staging, prod). CDK's equivalent is the stack name suffix in `backgroundagent-dev`."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,30}$", var.env_name))
    error_message = "env_name must be 1-31 chars of lowercase letters, digits, or hyphens, and must not start with a hyphen."
  }
}

# No default — this is a required input. ABCA's Terraform path does NOT replicate
# CDK's asset pipeline (ADR sub-decision 6): the agent container image is built
# and pushed to ECR by a documented out-of-band step, and its immutable URI is
# handed to Terraform. Prefer a digest (`...@sha256:...`) over a mutable tag so
# the image a plan describes is the image an apply deploys.
variable "agent_image_uri" {
  description = "Fully-qualified ECR URI of the pre-built ABCA agent container image, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/abca-agent@sha256:<digest>. Built out-of-band; Terraform does not build it."
  type        = string

  validation {
    condition     = length(trimspace(var.agent_image_uri)) > 0
    error_message = "agent_image_uri must not be empty; build and push the agent image first, then pass its URI."
  }
}

# Mirrors the CDK default at cdk/src/stacks/agent.ts:187, where the value comes
# from `process.env.BLUEPRINT_REPO ?? context('blueprintRepo') ?? 'awslabs/agent-plugins'`.
variable "blueprint_repo" {
  description = "GitHub repository (owner/name) supplying agent blueprint plugins. Matches the CDK default resolved in cdk/src/stacks/agent.ts."
  type        = string
  default     = "awslabs/agent-plugins"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-_.]*/[A-Za-z0-9][A-Za-z0-9-_.]*$", var.blueprint_repo))
    error_message = "blueprint_repo must be in `owner/name` form, e.g. awslabs/agent-plugins."
  }
}

# CI-only escape hatch, consumed by the `skip_*` arguments in providers.tf.
# Leave false for every real deployment: it disables the provider's credential
# and region validation, so a genuine misconfiguration would surface as a
# confusing mid-apply failure instead of a clear error at plan time.
#
# Set true ONLY by terraform/examples/parity-check, which runs
# `plan -refresh=false` with mock credentials and no AWS access. It has to be a
# module input rather than a provider block in that example, because a calling
# module's provider block does not configure the child module's provider.
variable "credential_free_plan" {
  description = "CI ONLY. Skip provider credential/region validation so the parity census can plan without AWS access. Must remain false for real deployments."
  type        = bool
  default     = false
}
