# DynamoDB tables — behavioral mirror of the 21 `AWS::DynamoDB::Table` resources
# in `cdk/cdk.out/*.template.json`.
#
# HOW TO REVIEW THIS FILE
# -----------------------
# Every value below was lifted from SYNTH OUTPUT, not from the CDK TypeScript.
# CDK resolves defaults behind `??` before emitting CloudFormation, so the
# construct source under-reports what actually gets deployed. Regenerate and
# diff with:
#
#   python3 -c "
#   import json,glob
#   for f in glob.glob('cdk/cdk.out/*.template.json'):
#       d=json.load(open(f))
#       for lid,r in d['Resources'].items():
#           if r['Type']=='AWS::DynamoDB::Table':
#               print('===',f,lid); print(json.dumps(r['Properties'],indent=2))
#   "
#
# Each entry in `local.dynamodb_tables` carries the CDK logical ID and the
# `aws:cdk:path` of the resource it mirrors, so a reviewer can grep synth output
# for that ID and compare field-by-field.
#
# TABLE NAMES ARE NOT PORTED
# --------------------------
# CDK sets no `TableName`, so CloudFormation generates
# `backgroundagent-dev-TaskTable95FE7720-<random>`. Those names are an artifact
# of the CDK deployment, not a contract — nothing reads a table by a hardcoded
# name; handlers receive ARNs/names through environment variables. Reproducing
# them here would be both impossible (the random suffix) and wrong (it would
# pin Terraform to CDK's logical-ID hashes). Instead each table is named
# `${var.env_name}-<logical-purpose>`.
#
# Consequence to know: these names are deterministic, so two deployments in the
# same account+region MUST use different `var.env_name` values.
#
# PROPERTIES DELIBERATELY OMITTED, AND WHY
# ----------------------------------------
#   * `SSESpecification` — absent from all 21 synth resources, i.e. DynamoDB's
#     default encryption with an AWS-owned key. Omitting the
#     `server_side_encryption` block here means exactly the same thing. Adding
#     `server_side_encryption { enabled = false }` would ALSO mean AWS-owned,
#     but the empty form is unambiguous. Do not "improve" this to a
#     customer-managed key without doing the same on the CDK side — the two
#     paths must stay behaviorally identical, and a CMK changes both cost and
#     the IAM a reader needs.
#   * `TableClass` — absent from synth (= STANDARD), which is the provider
#     default.
#   * Read/write capacity — meaningless under PAY_PER_REQUEST.
#   * `Tags` — the `compute_type` tag arrives via the provider's `default_tags`
#     (see providers.tf). The 13 `github:*` tags are CI provenance and are
#     intentionally not mirrored; providers.tf explains that decision.
#
# `DeletionPolicy: Delete` / `UpdateReplacePolicy: Delete` on all 21 tables maps
# to `deletion_protection_enabled = false`, set explicitly below rather than
# left to the provider default so the parity is visible.

locals {
  # Shape of each entry:
  #   attributes   — mirrors `AttributeDefinitions`. Listed in synth order for
  #                  eyeball diffing; DynamoDB treats them as a set.
  #   hash_key     — `KeySchema` entry with KeyType HASH.
  #   range_key    — `KeySchema` entry with KeyType RANGE, or null.
  #   ttl_attribute— `TimeToLiveSpecification.AttributeName`, or null when the
  #                  table has no `TimeToLiveSpecification` at all.
  #   stream_view_type — `StreamSpecification.StreamViewType`, or null.
  #   global_secondary_indexes — mirrors `GlobalSecondaryIndexes`. `key_schema`
  #                  is a list mirroring the GSI's CFN `KeySchema` array
  #                  one-for-one (HASH first, then RANGE if present).
  #                  `non_key_attributes` is always present, set to null when
  #                  synth omits it, so the dynamic block below stays uniform.
  #
  # Every table below is PAY_PER_REQUEST with point-in-time recovery ENABLED,
  # matching all 21 synth resources; both are applied unconditionally in the
  # resource body rather than repeated 21 times here.
  dynamodb_tables = {
    # CDK: TaskTable95FE7720 — backgroundagent-dev/TaskTable/Table/Resource
    "tasks" = {
      attributes = {
        task_id             = "S"
        user_id             = "S"
        status_created_at   = "S"
        status              = "S"
        created_at          = "S"
        idempotency_key     = "S"
        linear_issue_id     = "S"
        jira_issue_identity = "S"
      }
      hash_key         = "task_id"
      range_key        = null
      ttl_attribute    = "ttl"
      stream_view_type = "NEW_IMAGE"
      global_secondary_indexes = [
        {
          name = "UserStatusIndex"
          key_schema = [
            { attribute_name = "user_id", key_type = "HASH" },
            { attribute_name = "status_created_at", key_type = "RANGE" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
        {
          name = "StatusIndex"
          key_schema = [
            { attribute_name = "status", key_type = "HASH" },
            { attribute_name = "created_at", key_type = "RANGE" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
        {
          name = "IdempotencyIndex"
          key_schema = [
            { attribute_name = "idempotency_key", key_type = "HASH" },
          ]
          projection_type    = "KEYS_ONLY"
          non_key_attributes = null
        },
        {
          name = "LinearIssueIndex"
          key_schema = [
            { attribute_name = "linear_issue_id", key_type = "HASH" },
            { attribute_name = "created_at", key_type = "RANGE" },
          ]
          projection_type = "INCLUDE"
          non_key_attributes = [
            "pr_url",
            "pr_number",
            "status",
            "repo",
            "user_id",
            "channel_metadata",
          ]
        },
        {
          name = "JiraIssueIndex"
          key_schema = [
            { attribute_name = "jira_issue_identity", key_type = "HASH" },
            { attribute_name = "created_at", key_type = "RANGE" },
          ]
          projection_type = "INCLUDE"
          non_key_attributes = [
            "pr_url",
            "pr_number",
            "status",
            "repo",
            "user_id",
            "channel_metadata",
          ]
        },
      ]
    }

    # CDK: TaskEventsTableDC157861 — backgroundagent-dev/TaskEventsTable/Table/Resource
    # Streams NEW_IMAGE: progress events fan out to the watch/notify path.
    "task-events" = {
      attributes = {
        task_id  = "S"
        event_id = "S"
      }
      hash_key                 = "task_id"
      range_key                = "event_id"
      ttl_attribute            = "ttl"
      stream_view_type         = "NEW_IMAGE"
      global_secondary_indexes = []
    }

    # CDK: TaskNudgesTable285CAD71 — backgroundagent-dev/TaskNudgesTable/Table/Resource
    "task-nudges" = {
      attributes = {
        task_id  = "S"
        nudge_id = "S"
      }
      hash_key                 = "task_id"
      range_key                = "nudge_id"
      ttl_attribute            = "ttl"
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: OrchestrationTableDD3F9D18 — backgroundagent-dev/OrchestrationTable/Table/Resource
    "orchestration" = {
      attributes = {
        orchestration_id  = "S"
        sub_issue_id      = "S"
        child_task_id     = "S"
        child_branch_name = "S"
      }
      hash_key         = "orchestration_id"
      range_key        = "sub_issue_id"
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "ChildTaskIndex"
          key_schema = [
            { attribute_name = "child_task_id", key_type = "HASH" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
        {
          name = "ChildBranchIndex"
          key_schema = [
            { attribute_name = "child_branch_name", key_type = "HASH" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
      ]
    }

    # CDK: TaskApprovalsTableV2TableB16FF537 — backgroundagent-dev/TaskApprovalsTableV2/Table/Resource
    # The `V2` is part of the CDK construct ID, not a table-name suffix; kept in
    # the Terraform key so the mapping back to synth is unambiguous.
    "task-approvals-v2" = {
      attributes = {
        task_id    = "S"
        request_id = "S"
        user_id    = "S"
        status     = "S"
      }
      hash_key         = "task_id"
      range_key        = "request_id"
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "user_id-status-index"
          key_schema = [
            { attribute_name = "user_id", key_type = "HASH" },
            { attribute_name = "status", key_type = "RANGE" },
          ]
          projection_type = "INCLUDE"
          non_key_attributes = [
            "task_id",
            "request_id",
            "tool_name",
            "tool_input_preview",
            "severity",
            "reason",
            "created_at",
            "timeout_s",
            "matching_rule_ids",
          ]
        },
      ]
    }

    # CDK: UserConcurrencyTable48C3732F — backgroundagent-dev/UserConcurrencyTable/Table/Resource
    # NO TimeToLiveSpecification in synth — counters are decremented explicitly,
    # not expired. Do not add a `ttl` block here.
    "user-concurrency" = {
      attributes = {
        user_id = "S"
      }
      hash_key                 = "user_id"
      range_key                = null
      ttl_attribute            = null
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: WebhookTable610F8307 — backgroundagent-dev/WebhookTable/Table/Resource
    "webhooks" = {
      attributes = {
        webhook_id = "S"
        user_id    = "S"
        created_at = "S"
      }
      hash_key         = "webhook_id"
      range_key        = null
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "UserIndex"
          key_schema = [
            { attribute_name = "user_id", key_type = "HASH" },
            { attribute_name = "created_at", key_type = "RANGE" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
      ]
    }

    # CDK: ApiKeyTable42AB1184 — backgroundagent-dev/ApiKeyTable/Table/Resource
    # UserIndex is INCLUDE, not ALL — the projection deliberately excludes the
    # key material so a list-keys query cannot return a hash. Changing this to
    # ALL would be a security regression, not a simplification.
    "api-keys" = {
      attributes = {
        key_id     = "S"
        user_id    = "S"
        created_at = "S"
      }
      hash_key         = "key_id"
      range_key        = null
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "UserIndex"
          key_schema = [
            { attribute_name = "user_id", key_type = "HASH" },
            { attribute_name = "created_at", key_type = "RANGE" },
          ]
          projection_type = "INCLUDE"
          non_key_attributes = [
            "name",
            "status",
            "scopes",
            "updated_at",
            "expires_at",
            "revoked_at",
          ]
        },
      ]
    }

    # CDK: RepoTable0D05C805 — backgroundagent-dev/RepoTable/Table/Resource
    # Populated at deploy time by the blueprint custom resource in CDK; PR 5
    # ports that to `aws_dynamodb_table_item` driven by `var.repos`.
    "repos" = {
      attributes = {
        repo = "S"
      }
      hash_key                 = "repo"
      range_key                = null
      ttl_attribute            = "ttl"
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: SlackIntegrationInstallationTableFEA78EC1
    #      backgroundagent-dev/SlackIntegration/InstallationTable/Table/Resource
    "slack-installations" = {
      attributes = {
        team_id = "S"
      }
      hash_key                 = "team_id"
      range_key                = null
      ttl_attribute            = "ttl"
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: SlackIntegrationUserMappingTable72394219
    #      backgroundagent-dev/SlackIntegration/UserMappingTable/Table/Resource
    "slack-user-mappings" = {
      attributes = {
        slack_identity   = "S"
        platform_user_id = "S"
        linked_at        = "S"
      }
      hash_key         = "slack_identity"
      range_key        = null
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "PlatformUserIndex"
          key_schema = [
            { attribute_name = "platform_user_id", key_type = "HASH" },
            { attribute_name = "linked_at", key_type = "RANGE" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
      ]
    }

    # CDK: SlackIntegrationChannelMappingTable498891AF
    #      backgroundagent-dev/SlackIntegration/ChannelMappingTable/Table/Resource
    # NO TTL in synth — channel mappings are durable configuration.
    "slack-channel-mappings" = {
      attributes = {
        channel_id = "S"
      }
      hash_key                 = "channel_id"
      range_key                = null
      ttl_attribute            = null
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: LinearIntegrationProjectMappingTableF152E008
    #      backgroundagent-dev/LinearIntegration/ProjectMappingTable/Table/Resource
    # NO TTL in synth.
    "linear-project-mappings" = {
      attributes = {
        linear_project_id = "S"
      }
      hash_key                 = "linear_project_id"
      range_key                = null
      ttl_attribute            = null
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: LinearIntegrationUserMappingTable0DA89F6E
    #      backgroundagent-dev/LinearIntegration/UserMappingTable/Table/Resource
    "linear-user-mappings" = {
      attributes = {
        linear_identity  = "S"
        platform_user_id = "S"
        linked_at        = "S"
      }
      hash_key         = "linear_identity"
      range_key        = null
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "PlatformUserIndex"
          key_schema = [
            { attribute_name = "platform_user_id", key_type = "HASH" },
            { attribute_name = "linked_at", key_type = "RANGE" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
      ]
    }

    # CDK: LinearIntegrationWorkspaceRegistryTableC954A5BC
    #      backgroundagent-dev/LinearIntegration/WorkspaceRegistryTable/Table/Resource
    # NO TTL in synth.
    "linear-workspaces" = {
      attributes = {
        linear_workspace_id = "S"
      }
      hash_key                 = "linear_workspace_id"
      range_key                = null
      ttl_attribute            = null
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: LinearIntegrationWebhookDedupTable1162175A
    #      backgroundagent-dev/LinearIntegration/WebhookDedupTable/Resource
    # TTL is load-bearing: the dedup key must expire or replay protection turns
    # into unbounded storage. Note the synth path has no `/Table/` segment —
    # this one is a bare `dynamodb.Table`, not the wrapped construct.
    "linear-webhook-dedup" = {
      attributes = {
        dedup_key = "S"
      }
      hash_key                 = "dedup_key"
      range_key                = null
      ttl_attribute            = "ttl"
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: JiraIntegrationProjectMappingTable2A2BCC03
    #      backgroundagent-dev/JiraIntegration/ProjectMappingTable/Table/Resource
    # NO TTL in synth.
    "jira-project-mappings" = {
      attributes = {
        jira_project_identity = "S"
      }
      hash_key                 = "jira_project_identity"
      range_key                = null
      ttl_attribute            = null
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: JiraIntegrationUserMappingTable50D682D2
    #      backgroundagent-dev/JiraIntegration/UserMappingTable/Table/Resource
    "jira-user-mappings" = {
      attributes = {
        jira_identity    = "S"
        platform_user_id = "S"
        linked_at        = "S"
      }
      hash_key         = "jira_identity"
      range_key        = null
      ttl_attribute    = "ttl"
      stream_view_type = null
      global_secondary_indexes = [
        {
          name = "PlatformUserIndex"
          key_schema = [
            { attribute_name = "platform_user_id", key_type = "HASH" },
            { attribute_name = "linked_at", key_type = "RANGE" },
          ]
          projection_type    = "ALL"
          non_key_attributes = null
        },
      ]
    }

    # CDK: JiraIntegrationWorkspaceRegistryTableFF87F094
    #      backgroundagent-dev/JiraIntegration/WorkspaceRegistryTable/Table/Resource
    # NO TTL in synth.
    "jira-workspaces" = {
      attributes = {
        jira_cloud_id = "S"
      }
      hash_key                 = "jira_cloud_id"
      range_key                = null
      ttl_attribute            = null
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: JiraIntegrationWebhookDedupTable06C09AAB
    #      backgroundagent-dev/JiraIntegration/WebhookDedupTable/Resource
    "jira-webhook-dedup" = {
      attributes = {
        dedup_key = "S"
      }
      hash_key                 = "dedup_key"
      range_key                = null
      ttl_attribute            = "ttl"
      stream_view_type         = null
      global_secondary_indexes = []
    }

    # CDK: GitHubScreenshotIntegrationWebhookDedupTableD057E562
    #      backgroundagent-dev/GitHubScreenshotIntegration/WebhookDedupTable/Resource
    "github-screenshot-webhook-dedup" = {
      attributes = {
        dedup_key = "S"
      }
      hash_key                 = "dedup_key"
      range_key                = null
      ttl_attribute            = "ttl"
      stream_view_type         = null
      global_secondary_indexes = []
    }
  }
}

resource "aws_dynamodb_table" "abca" {
  for_each = local.dynamodb_tables

  name = "${var.env_name}-${each.key}"

  # All 21 synth resources: "BillingMode": "PAY_PER_REQUEST".
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = each.value.hash_key
  range_key = each.value.range_key

  # All 21 synth resources: DeletionPolicy/UpdateReplacePolicy "Delete", i.e.
  # RemovalPolicy.DESTROY. Stated explicitly rather than left to the default.
  deletion_protection_enabled = false

  # `StreamSpecification` is present on exactly 2 tables (tasks, task-events),
  # both NEW_IMAGE.
  stream_enabled   = each.value.stream_view_type != null
  stream_view_type = each.value.stream_view_type

  dynamic "attribute" {
    for_each = each.value.attributes
    content {
      name = attribute.key
      type = attribute.value
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.value.global_secondary_indexes
    content {
      name               = global_secondary_index.value.name
      projection_type    = global_secondary_index.value.projection_type
      non_key_attributes = global_secondary_index.value.non_key_attributes

      # The GSI-level `hash_key`/`range_key` arguments are DEPRECATED in AWS
      # provider 6.60 ("hash_key is deprecated. Use key_schema instead."), so
      # this uses the nested `key_schema` block. Verified equivalent: a plan
      # comparing both forms produced the same DynamoDB configuration. The
      # nested form is also a closer mirror of CFN's own `KeySchema` array,
      # which makes the synth diff more direct.
      #
      # Note the deprecation applies ONLY at the GSI level. The TABLE-level
      # `hash_key`/`range_key` above are not deprecated (confirmed: a table with
      # only table-level keys plans warning-free) and there is no table-level
      # `key_schema` in the provider schema.
      dynamic "key_schema" {
        for_each = global_secondary_index.value.key_schema
        content {
          attribute_name = key_schema.value.attribute_name
          key_type       = key_schema.value.key_type
        }
      }
    }
  }

  # `TimeToLiveSpecification` present on 15 of 21 tables, always
  # `{AttributeName: "ttl", Enabled: true}`. The 6 without it are durable
  # configuration/counter tables — see the per-table comments above.
  dynamic "ttl" {
    for_each = each.value.ttl_attribute == null ? [] : [each.value.ttl_attribute]
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  # All 21 synth resources: "PointInTimeRecoveryEnabled": true.
  point_in_time_recovery {
    enabled = true
  }

  # `SSESpecification` is absent from all 21 synth resources — see the header
  # comment. No `server_side_encryption` block here is the faithful mirror.
}
