# Secrets Manager secrets — behavioral mirror of the 7
# `AWS::SecretsManager::Secret` resources in `cdk/cdk.out/*.template.json`.
#
# METADATA ONLY — NO `aws_secretsmanager_secret_version` HERE
# -----------------------------------------------------------
# ABCA's secrets are provisioned as containers and populated OUT OF BAND by
# operator tooling, never by IaC:
#
#   github-token             `bgagent github token set`  (cli/src/github-token.ts)
#   jira-webhook-secret      `bgagent jira setup`        (cli/src/commands/jira.ts)
#   linear-webhook-secret    `bgagent linear setup`
#   slack-*                  copied from the Slack App config page
#   github-screenshot-*      copied from the GitHub webhook config page
#
# Managing the VALUE in Terraform would put credentials into state (state is
# plaintext) and into any plan artifact. It is also what lets PR 8's drift check
# run with an explicit `Deny` on `secretsmanager:GetSecretValue`: refreshing
# `aws_secretsmanager_secret` calls `DescribeSecret` only, so metadata drift
# stays visible while values stay unreadable. Adding a
# `aws_secretsmanager_secret_version` resource here would break that property.
#
# ── KNOWN DIVERGENCE FROM CDK: `GenerateSecretString` HAS NO TERRAFORM ANALOGUE ─
#
# Synth output shows `"GenerateSecretString": {}` on ALL SEVEN secrets — not
# just the Jira one. Six of them never ask for it in TypeScript; CDK's `Secret`
# construct inserts it by default whenever no explicit value is supplied
# (`generateSecretString: props.generateSecretString ?? (secretString ? undefined : {})`,
# aws-cdk-lib/aws-secretsmanager/lib/secret.js). The seventh, Jira, asks
# explicitly (`cdk/src/constructs/jira-integration.ts:202-210`) and synth shows
# the extra fields:
#
#     "GenerateSecretString": {
#       "GenerateStringKey": "value",
#       "SecretStringTemplate": "{\"abca_jira_webhook_placeholder\":true}"
#     }
#
# So on the CDK path every secret is created WITH an initial version holding a
# CloudFormation-generated random string. On the Terraform path they are created
# with NO VERSION AT ALL. The AWS provider has no generate-at-deploy argument;
# the only way to produce one is `random_password` + an
# `aws_secretsmanager_secret_version`, which would land the generated value in
# state — the exact thing this file avoids. **We deliberately accept the
# divergence rather than add `random_password`.**
#
# Why this is safe (traced through every reader, not assumed):
#   * The generated values are never USED. Nothing derives meaning from them:
#     they exist only so the secret is non-empty before an operator populates
#     it. The Jira placeholder key `abca_jira_webhook_placeholder` has no reader
#     anywhere in cdk/, cli/, or agent/ — its only occurrences are the constant
#     and the comment that defines it.
#   * A random value in an HMAC-verification secret is not "working" — it just
#     fails verification differently. `getJiraSecret`
#     (cdk/src/handlers/shared/jira-verify.ts:63) returns `null` on
#     `ResourceNotFoundException` and logs "secret not found"; the same
#     unverifiable outcome as HMAC-ing with a random string, and with a clearer
#     log line. `slack-verify.ts`, `linear-verify.ts`, and
#     `github-webhook-verify.ts` follow the same shape.
#   * For the GitHub token, the Terraform behavior is strictly BETTER:
#     `context-hydration.ts:371-386` maps `ResourceNotFoundException` to a typed
#     `MissingSecretError` carrying the canonical `missing_secret` blocker
#     (#251), so the task fails with a precise remedy. Under CDK the secret
#     exists holding a random string, which is a valid-looking but useless
#     token, and the failure surfaces later as a GitHub 401.
#
# Operator-visible consequence to carry into PR 7's docs: after a Terraform
# apply, `aws secretsmanager get-secret-value` on these ARNs returns
# `ResourceNotFoundException` until setup runs. That is expected, not a failed
# apply. The `bgagent` setup commands use CreateSecret-then-PutSecretValue
# upserts (cli/src/commands/jira.ts:196-247), so they populate a versionless
# secret without any change.
#
# ── OTHER PROPERTIES ─────────────────────────────────────────────────────────
#
#   * NAMES are not ported. CDK sets no `Name`, so CloudFormation generates
#     `backgroundagent-dev-JiraIntegrationWebhookSecretBBD6D649-<random>`.
#     Handlers receive ARNs through environment variables (e.g.
#     `JIRA_WEBHOOK_SECRET_ARN`, jira-integration.ts:353), never a hardcoded
#     name, so a derived name is safe. `/`-separated rather than `-` because a
#     Secrets Manager name ending in `-` plus six characters is
#     indistinguishable from the six-character suffix AWS appends, and ABCA's
#     own name parser strips exactly that shape
#     (`parseSecretName`, aws-cdk-lib).
#   * `KmsKeyId` is absent from all 7 synth resources — the AWS-managed
#     `aws/secretsmanager` key. Omitting `kms_key_id` here means the same. A
#     customer-managed key would also require KMS grants for every reader
#     Lambda, so do not add one on one path only.
#   * `recovery_window_in_days = 30` mirrors `DeletionPolicy: Delete`
#     (RemovalPolicy.DESTROY): CloudFormation's DeleteSecret leaves the default
#     30-day recovery window, it does not force-delete. Stated explicitly so a
#     reviewer does not have to know the provider default is also 30. Note the
#     operational consequence, which is identical on both paths: destroy then
#     immediately re-apply fails with `InvalidRequestException ... scheduled for
#     deletion` until the window elapses or the secret is force-deleted.
#   * No `RotationRules` in synth. `cdk/src/stacks/agent.ts:247-252` suppresses
#     cdk-nag `AwsSolutions-SMG4` on the GitHub token with the reason that the
#     PAT is managed externally, so rotation is not applicable. Same reasoning
#     applies to the webhook signing secrets, which are shared with a
#     third-party sender and cannot be rotated unilaterally.
#   * Tags come from the provider's `default_tags` (see providers.tf).

locals {
  # `key` becomes `${var.env_name}/<key>`. Descriptions are copied VERBATIM from
  # synth output, em dashes included, so a reviewer can string-match them.
  secretsmanager_secrets = {
    # CDK: GitHubTokenSecret09BC4210 — backgroundagent-dev/GitHubTokenSecret/Resource
    # Source: cdk/src/stacks/agent.ts:241. Read by the agent at startup via
    # `GITHUB_TOKEN_SECRET_ARN`; a missing value is a `missing_secret` blocker.
    "github-token" = {
      description = "GitHub personal access token for the background agent"
    }

    # CDK: SlackIntegrationSigningSecretFBE3D363
    #      backgroundagent-dev/SlackIntegration/SigningSecret/Resource
    # Source: cdk/src/constructs/slack-integration.ts:142.
    "slack-signing-secret" = {
      description = "Slack App signing secret — populate after creating the Slack App"
    }

    # CDK: SlackIntegrationClientSecret79EEB782
    #      backgroundagent-dev/SlackIntegration/ClientSecret/Resource
    # Source: cdk/src/constructs/slack-integration.ts:146.
    "slack-client-secret" = {
      description = "Slack App client secret (OAuth) — populate after creating the Slack App"
    }

    # CDK: SlackIntegrationClientIdSecret3C1950BB
    #      backgroundagent-dev/SlackIntegration/ClientIdSecret/Resource
    # Source: cdk/src/constructs/slack-integration.ts:150. The client ID is not
    # itself sensitive, but it lives in Secrets Manager alongside the client
    # secret so the OAuth pair is configured and rotated as one unit. Kept as a
    # secret here for parity — moving it to an SSM parameter would be a CDK-side
    # design change, not a Terraform porting decision.
    "slack-client-id" = {
      description = "Slack App client ID — populate after creating the Slack App"
    }

    # CDK: LinearIntegrationWebhookSecret830B9E0E
    #      backgroundagent-dev/LinearIntegration/WebhookSecret/Resource
    # Source: cdk/src/constructs/linear-integration.ts:197.
    "linear-webhook-secret" = {
      description = "Linear webhook signing secret — populate via `bgagent linear setup`"
    }

    # CDK: JiraIntegrationWebhookSecretBBD6D649
    #      backgroundagent-dev/JiraIntegration/WebhookSecret/Resource
    # Source: cdk/src/constructs/jira-integration.ts:202. THIS is the one with an
    # explicit `generateSecretString` — see the divergence note in the header.
    # The `{"abca_jira_webhook_placeholder":true,"value":"<random>"}` shape is
    # not reproduced: no code reads that key, and reproducing it would require
    # putting a value in state.
    "jira-webhook-secret" = {
      description = "Jira webhook signing secret — populate via `bgagent jira setup`"
    }

    # CDK: GitHubScreenshotIntegrationWebhookSecretA2898A93
    #      backgroundagent-dev/GitHubScreenshotIntegration/WebhookSecret/Resource
    # Source: cdk/src/constructs/github-screenshot-integration.ts:158.
    "github-screenshot-webhook-secret" = {
      description = "GitHub deployment-status webhook signing secret — populate manually after configuring the GitHub webhook"
    }
  }
}

resource "aws_secretsmanager_secret" "abca" {
  for_each = local.secretsmanager_secrets

  name        = "${var.env_name}/${each.key}"
  description = each.value.description

  # All 7 synth resources omit `KmsKeyId` -> AWS-managed aws/secretsmanager key.
  # `kms_key_id` intentionally unset; see the header.

  # Mirrors DeletionPolicy/UpdateReplacePolicy "Delete" (RemovalPolicy.DESTROY).
  recovery_window_in_days = 30
}
