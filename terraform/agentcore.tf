# AgentCore compute — Memory (+ extraction strategies) and Agent Runtime.
#
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  SECURITY-CRITICAL FILE — READ `namespace_templates` CHARACTER BY         ║
# ║  CHARACTER BEFORE APPROVING.                                             ║
# ║                                                                          ║
# ║  ABCA runs ONE shared AgentCore Memory for ALL onboarded repositories.    ║
# ║  Events are written with `actorId = "owner/repo"` and                    ║
# ║  `sessionId = taskId`; the extraction strategies below are the ONLY thing ║
# ║  that keeps repository A's learnings out of repository B's agent context. ║
# ║  There is no second barrier — no per-repo Memory, no IAM condition on     ║
# ║  actorId, no runtime filter. A namespace template that drops `{actorId}`  ║
# ║  or misplaces a `/` silently cross-contaminates every repo on the         ║
# ║  deployment, and the failure is invisible: extraction still succeeds,     ║
# ║  records still land, they just land in a namespace another repo reads.    ║
# ║                                                                          ║
# ║  The authoritative strings are in `cdk/src/constructs/agent-memory.ts`    ║
# ║  (lines 82, 86, 88) and are restated in the doc comment at lines 57-64.   ║
# ║  `terraform/PARITY_NOTES-agentcore.md` has them side by side with the     ║
# ║  values observed in a real `terraform show -json` plan.                   ║
# ╚═══════════════════════════════════════════════════════════════════════════╝
#
# HOW TO REVIEW THIS FILE
# -----------------------
# Every value below was lifted from SYNTH OUTPUT, never from the CDK
# TypeScript. CDK hides defaults behind `??` and resolves them only when it
# emits CloudFormation, so the construct source under-reports what actually
# gets deployed. `event_expiry_duration` is the worked example: the construct
# writes `props?.expirationDuration ?? Duration.days(DEFAULT_EXPIRATION_DAYS)`
# with no literal at the call site, synth emits `"EventExpiryDuration": 365`,
# and the Terraform argument is REQUIRED — omitting it fails `validate`.
#
# Regenerate the authoritative values with:
#
#   python3 -c "
#   import json
#   d=json.load(open('cdk/cdk.out/backgroundagent-dev.template.json'))
#   for lid,r in d['Resources'].items():
#       if 'AgentCore' in r['Type']:
#           print('===',r['Type'],lid); print(json.dumps(r['Properties'],indent=2))
#   "
#
# STRUCTURAL DIVERGENCE: ONE CFN RESOURCE -> THREE TERRAFORM RESOURCES
# --------------------------------------------------------------------
# CloudFormation nests the strategies inside the Memory resource as a
# `MemoryStrategies` array. The Terraform provider has NO strategies argument on
# `aws_bedrockagentcore_memory`; strategies are separate
# `aws_bedrockagentcore_memory_strategy` resources joined by `memory_id`. So the
# single synth resource `AgentMemory1601EF79` becomes three resources here. The
# type census (PR 6) must not read that as a count mismatch.
#
# Provider constraints honored below (aws 6.60.0, verified against
# `terraform providers schema -json`, not from memory):
#   * `event_expiry_duration` is REQUIRED, range 7-365.
#   * `namespace_templates` is used, NOT `namespaces` — the latter is marked
#     DEPRECATED in the schema. Exactly one of the two must be set.
#   * `memory_execution_role_arn` is NOT set on the strategy resources — also
#     DEPRECATED there. It belongs on the memory, which is where CDK puts it.
#   * Max 6 strategies per memory and at most one of each built-in type. ABCA
#     uses 2 (SEMANTIC + EPISODIC), so there is headroom, but adding a second
#     SEMANTIC strategy will fail at apply, not at plan.
#   * `memory_id` forces replacement when it changes.
#
# WHAT IS DELIBERATELY NOT HERE
# -----------------------------
#   * `tags` — the `compute_type = agentcore` tag arrives through the provider's
#     `default_tags` (providers.tf). The 13 `github:*` tags are CI provenance
#     and are intentionally not mirrored; providers.tf explains that decision.
#   * The `AWS::Logs::DeliverySource` / `DeliveryDestination` / `Delivery`
#     triples that CDK's `loggingConfigs` auto-creates (6 resources). The
#     Terraform provider's agent-runtime resource has no `logging_configs`
#     argument, so those must be declared as explicit `aws_cloudwatch_log_*` /
#     delivery resources alongside the log groups they target — which land with
#     the control plane in PR 4. See PARITY_NOTES-agentcore.md.
#   * Most of the runtime's `environment_variables`, and the IAM statements that
#     reference DynamoDB tables, Secrets Manager secrets, the session role, the
#     artifacts bucket and the application log group. Those resources are owned
#     by other PRs in this stack. THE RUNTIME AS DECLARED HERE WILL NOT RUN A
#     TASK SUCCESSFULLY until PR 4 supplies them — this file is a structural
#     port, not a working deployment on its own. Every omission is enumerated in
#     PARITY_NOTES-agentcore.md so the gap is reviewable rather than implicit.

# ---------------------------------------------------------------------------
# Derived identifiers
# ---------------------------------------------------------------------------
# AgentCore Memory and Runtime names are constrained to `[a-zA-Z0-9_]` and must
# start with a letter (memory: <= 48 chars). `var.env_name` permits hyphens, so
# it is transliterated rather than interpolated raw — an env_name of `my-dev`
# would otherwise produce an invalid name that only fails at apply time.
#
# CDK's names (`backgroundagentdevAgentMemory2EB404A5`,
# `backgroundagentdevRuntimeCC6E3A5A`) are NOT reproduced: the trailing hash is
# a CDK logical-ID artifact, and nothing reads either resource by a hardcoded
# name — the agent receives `MEMORY_ID` through an environment variable and the
# runtime is addressed by ARN. Pinning CDK's hashes here would tie Terraform to
# CDK's construct tree.
#
# Consequence to know: these names are deterministic and AgentCore runtime names
# are unique per account+region, so two deployments in one account MUST use
# different `var.env_name` values.
locals {
  name_slug = replace(var.env_name, "-", "_")

  memory_name  = "abca_${local.name_slug}_memory"
  runtime_name = "abca_${local.name_slug}_runtime"

  # Mirrors DEFAULT_BEDROCK_MODEL_IDS in cdk/src/constructs/bedrock-models.ts:34.
  # BARE foundation-model IDs only — the `us.`-prefixed inference-profile ARN is
  # derived below, exactly as CDK's grantInvoke does. Keep this list in lockstep
  # with that constant AND with the agent's fallback model in agent/src/config.py:
  # a fallback the role cannot invoke fails every task at turn 0, not just an
  # edge case.
  bedrock_model_ids = [
    "anthropic.claude-sonnet-4-6",
    "anthropic.claude-opus-4-20250514-v1:0",
    "anthropic.claude-opus-4-8",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
  ]

  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region

  # `aws_caller_identity` calls STS GetCallerIdentity, which fails under the
  # credential-free parity plan (`skip_requesting_account_id` suppresses the
  # provider's own account lookup but not an explicit data source). Gating the
  # read on `var.credential_free_plan` keeps PR 6's census credential-free while
  # real deployments still get the true account id. The placeholder is only ever
  # substituted in a plan that is thrown away, never in one that is applied.
  account_id = var.credential_free_plan ? "000000000000" : one(data.aws_caller_identity.current[*].account_id)
}

data "aws_partition" "current" {}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {
  count = var.credential_free_plan ? 0 : 1
}

# ---------------------------------------------------------------------------
# Memory service role
# CDK: AgentMemoryServiceRole0B12E4A3 (AWS::IAM::Role)
#      backgroundagent-dev/AgentMemory/Memory/ServiceRole
#      created implicitly by aws-cdk-lib/aws-bedrockagentcore Memory, referenced
#      from cdk/src/constructs/agent-memory.ts:75
# ---------------------------------------------------------------------------
# Synth shows this role with `AssumeRolePolicyDocument` and `Tags` and NOTHING
# ELSE — no `ManagedPolicyArns`, and no `AWS::IAM::Policy` names it in `Roles`.
# Verified:
#
#   python3 -c "
#   import json; d=json.load(open('cdk/cdk.out/backgroundagent-dev.template.json'))
#   R=d['Resources']; t='AgentMemoryServiceRole0B12E4A3'
#   print(list(R[t]['Properties'].keys()))
#   print([l for l,r in R.items() if r['Type']=='AWS::IAM::Policy'
#          and t in json.dumps(r['Properties'].get('Roles',[]))])
#   "
#   -> ['AssumeRolePolicyDocument', 'Tags']
#   -> []
#
# So NO permissions policy is attached here, and none is attached here either.
# This is a faithful port, and it is worth flagging in review as a possible CDK
# bug rather than quietly "fixing": the provider docs attach
# `AmazonBedrockAgentCoreMemoryBedrockModelInferenceExecutionRolePolicy` to this
# role, and the cdk-nag suppression at agent-memory.ts:94-99 says the role
# "requires wildcard permissions for Bedrock model invocation used by memory
# extraction strategies" — describing permissions that synth does not actually
# grant. Adding them ONLY here would make Terraform diverge from CDK, which is
# the one thing this module must not do. Fix it on the CDK side first, then
# mirror it. Tracked in PARITY_NOTES-agentcore.md.
resource "aws_iam_role" "agent_memory_service" {
  name = "${var.env_name}-abca-agentcore-memory-service"

  # Ported statement-for-statement from synth, including both confused-deputy
  # conditions. `aws:SourceArn` is `ArnLike` (not `StringEquals`) because the
  # trailing `*` covers the id suffix AgentCore appends to the memory name.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:memory/${local.memory_name}*"
          }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Memory
# CDK: AgentMemory1601EF79 (AWS::BedrockAgentCore::Memory)
#      backgroundagent-dev/AgentMemory/Memory/Resource
#      cdk/src/constructs/agent-memory.ts:75-92, instantiated at
#      cdk/src/stacks/agent.ts:322
# ---------------------------------------------------------------------------
resource "aws_bedrockagentcore_memory" "agent" {
  name = local.memory_name

  # Byte-identical to synth's "Description" and to agent-memory.ts:77.
  description = "Cross-task interaction memory for background coding agents"

  # synth: "EventExpiryDuration": 365 — the resolved value of
  # `?? Duration.days(DEFAULT_EXPIRATION_DAYS)` (agent-memory.ts:27,78). Days,
  # not seconds. REQUIRED by the provider; 365 is also the API maximum, so this
  # cannot be raised without changing behavior on both paths.
  event_expiry_duration = 365

  memory_execution_role_arn = aws_iam_role.agent_memory_service.arn

  # Absent from synth, therefore absent here:
  #   * `encryption_key_arn`      -> AWS-managed encryption (CDK sets no KMS key)
  #   * `indexed_key`             -> no metadata indexing
  #   * `stream_delivery_resources` -> no Kinesis fan-out
}

# ---------------------------------------------------------------------------
# Semantic extraction strategy
# CDK: AgentMemory1601EF79.MemoryStrategies[0].SemanticMemoryStrategy
#      cdk/src/constructs/agent-memory.ts:80-83
#      (agentcore.MemoryStrategy.usingSemantic)
# ---------------------------------------------------------------------------
# Factual knowledge distilled from task episodes — repo conventions, build
# quirks, testing patterns (agent-memory.ts:52-55).
resource "aws_bedrockagentcore_memory_strategy" "semantic_knowledge" {
  memory_id = aws_bedrockagentcore_memory.agent.id

  # synth: "Name": "SemanticKnowledge" (agent-memory.ts:81 `strategyName`).
  name = "SemanticKnowledge"

  # synth: "Type": "SEMANTIC"
  type = "SEMANTIC"

  # ┌───────────────────────────────────────────────────────────────────────┐
  # │ ISOLATION BOUNDARY. synth: "Namespaces": ["/{actorId}/knowledge/"]    │
  # │ CDK source: agent-memory.ts:82                                        │
  # │ Resolves to e.g. /awslabs/agent-plugins/knowledge/ because            │
  # │ actorId == "owner/repo". Leading AND trailing slash are both load-    │
  # │ bearing; `{actorId}` is what separates repositories.                  │
  # └───────────────────────────────────────────────────────────────────────┘
  namespace_templates = ["/{actorId}/knowledge/"]

  # No `configuration` block: that is required only for type = "CUSTOM" and must
  # be omitted otherwise. CDK likewise passes no model overrides, so extraction
  # uses the AgentCore service defaults on both paths.
}

# ---------------------------------------------------------------------------
# Episodic extraction strategy
# CDK: AgentMemory1601EF79.MemoryStrategies[1].EpisodicMemoryStrategy
#      cdk/src/constructs/agent-memory.ts:84-90
#      (agentcore.MemoryStrategy.usingEpisodic)
# ---------------------------------------------------------------------------
# Summarized interaction slices — task outcome, cost, duration, self-feedback —
# for cross-task pattern recognition (agent-memory.ts:53-55).
resource "aws_bedrockagentcore_memory_strategy" "task_episodes" {
  memory_id = aws_bedrockagentcore_memory.agent.id

  # synth: "Name": "TaskEpisodes" (agent-memory.ts:85 `strategyName`).
  name = "TaskEpisodes"

  # synth: "Type": "EPISODIC"
  type = "EPISODIC"

  # ┌───────────────────────────────────────────────────────────────────────┐
  # │ ISOLATION BOUNDARY.                                                   │
  # │ synth: "Namespaces": ["/{actorId}/episodes/{sessionId}/"]             │
  # │ CDK source: agent-memory.ts:86                                        │
  # │ sessionId == taskId, so this is per-task WITHIN a repository. Both     │
  # │ placeholders are required: dropping {sessionId} collapses every task   │
  # │ into one namespace, dropping {actorId} merges every repository.        │
  # └───────────────────────────────────────────────────────────────────────┘
  namespace_templates = ["/{actorId}/episodes/{sessionId}/"]

  # ┌───────────────────────────────────────────────────────────────────────┐
  # │ ISOLATION BOUNDARY.                                                   │
  # │ synth: "ReflectionConfiguration": {"Namespaces":                      │
  # │            ["/{actorId}/episodes/"]}                                  │
  # │ CDK source: agent-memory.ts:87-89                                     │
  # │ Deliberately ONE LEVEL SHALLOWER than the episode namespace above —   │
  # │ reflections summarize ACROSS a repository's tasks, so `{sessionId}`   │
  # │ is absent BY DESIGN. Still scoped by `{actorId}`, which is what keeps │
  # │ cross-task summaries inside one repository. The provider documents    │
  # │ this shallower nesting as expected ("Can be less nested than episode  │
  # │ namespaces"). Do not "fix" the missing {sessionId}.                    │
  # └───────────────────────────────────────────────────────────────────────┘
  reflection_configuration {
    namespace_templates = ["/{actorId}/episodes/"]
  }
}

# ---------------------------------------------------------------------------
# Runtime execution role
# CDK: RuntimeExecutionRole304CF3D8 (AWS::IAM::Role)
#      backgroundagent-dev/Runtime/ExecutionRole — created implicitly by
#      agentcore.Runtime at cdk/src/stacks/agent.ts:529
# ---------------------------------------------------------------------------
resource "aws_iam_role" "runtime_execution" {
  name = "${var.env_name}-abca-agentcore-runtime-execution"

  # synth: "Description": "Execution role for Bedrock Agent Core Runtime"
  description = "Execution role for Bedrock Agent Core Runtime"

  # synth: "MaxSessionDuration": 28800 — 8h, matching
  # RUNTIME_SESSION_TIMEOUT_HOURS (cdk/src/stacks/agent.ts:83) and the
  # lifecycle timers below. A shorter value would expire the role's credentials
  # mid-task on a long build or approval wait.
  max_session_duration = 28800

  # Same confused-deputy conditions as the memory role, with the ARN pattern
  # pointing at the runtime instead. Ported verbatim from synth.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "bedrock-agentcore.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:runtime/${local.runtime_name}*"
          }
        }
      },
    ]
  })
}

# CDK: RuntimeExecutionRoleDefaultPolicy2B020CFC (AWS::IAM::Policy)
#
# PARTIAL PORT — READ THIS BEFORE APPROVING.
# Synth's policy has 29 statements (counted, not estimated — see the extractor in
# PARITY_NOTES-agentcore.md). The 24 below are the ones whose resources exist in
# this PR or are derivable from account/region/partition and a name pattern. The
# 5 omitted statements point at resources owned by other PRs in this stack and
# are enumerated in PARITY_NOTES-agentcore.md with their synth text. They must be
# added when PR 4 lands, or the agent gets AccessDenied on DynamoDB, the GitHub
# token secret, its application log group, and the session-role assumption.
#
# Statement order and `Sid` values follow synth so a reviewer can diff the two
# documents top-to-bottom. Wildcards are reproduced exactly as CDK emits them
# (`bedrock:InvokeModel*`, `Resource: "*"` for X-Ray / ECR auth) — this port must
# neither widen nor narrow the deployed permission set.
resource "aws_iam_role_policy" "runtime_execution" {
  name = "RuntimeExecutionRoleDefaultPolicy"
  role = aws_iam_role.runtime_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "LogGroupAccess"
          Effect   = "Allow"
          Action   = ["logs:DescribeLogStreams", "logs:CreateLogGroup"]
          Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"
        },
        {
          Sid      = "DescribeLogGroups"
          Effect   = "Allow"
          Action   = "logs:DescribeLogGroups"
          Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:*"
        },
        {
          Sid      = "LogStreamAccess"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"
        },
        {
          Sid    = "XRayAccess"
          Effect = "Allow"
          Action = [
            "xray:PutTraceSegments",
            "xray:PutTelemetryRecords",
            "xray:GetSamplingRules",
            "xray:GetSamplingTargets",
          ]
          # synth: Resource "*". X-Ray's write APIs are not resource-scopable.
          Resource = "*"
        },
        {
          Sid      = "CloudWatchMetrics"
          Effect   = "Allow"
          Action   = "cloudwatch:PutMetricData"
          Resource = "*"
          # The namespace condition is what makes the "*" resource acceptable.
          # Dropping it would silently widen the grant to every metric namespace.
          Condition = {
            StringEquals = {
              "cloudwatch:namespace" = "bedrock-agentcore"
            }
          }
        },
        {
          Sid    = "GetAgentAccessToken"
          Effect = "Allow"
          Action = [
            "bedrock-agentcore:GetWorkloadAccessToken",
            "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
            "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
          ]
          Resource = [
            "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
            "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/*",
          ]
        },
        # Memory read — synth grants these against the memory ARN only, i.e. all
        # actors and all sessions. Note what this means and do not misread it:
        # the runtime's IAM does NOT enforce per-repository isolation. Namespace
        # templates are the whole boundary. (agent-memory.ts:106-109 grantRead)
        {
          Effect = "Allow"
          Action = [
            "bedrock-agentcore:GetEvent",
            "bedrock-agentcore:ListEvents",
            "bedrock-agentcore:ListActors",
            "bedrock-agentcore:ListSessions",
            "bedrock-agentcore:GetMemoryRecord",
            "bedrock-agentcore:RetrieveMemoryRecords",
            "bedrock-agentcore:ListMemoryRecords",
          ]
          Resource = aws_bedrockagentcore_memory.agent.arn
        },
        # Memory write (agent-memory.ts:108 grantWrite). Kept as its own
        # statement to mirror synth exactly.
        {
          Effect   = "Allow"
          Action   = "bedrock-agentcore:CreateEvent"
          Resource = aws_bedrockagentcore_memory.agent.arn
        },
      ],
      # Bedrock model invocation — three statements per model, exactly as
      # grantInvoke fans out in synth: the in-region foundation-model ARN, the
      # all-regions foundation-model ARN (cross-region inference profiles route
      # to peer regions), and the `us.`-prefixed inference-profile ARN. Scoped
      # per model ID, NOT `Resource: "*"` — that hardening is deliberate
      # (bedrock-models.ts:29-33) and must survive this port.
      flatten([
        for model_id in local.bedrock_model_ids : [
          {
            Effect   = "Allow"
            Action   = ["bedrock:InvokeModel*", "bedrock:GetFoundationModel"]
            Resource = "arn:${local.partition}:bedrock:${local.region}::foundation-model/${model_id}"
          },
          {
            Effect   = "Allow"
            Action   = ["bedrock:InvokeModel*", "bedrock:GetFoundationModel"]
            Resource = "arn:${local.partition}:bedrock:*::foundation-model/${model_id}"
          },
          {
            Effect   = "Allow"
            Action   = ["bedrock:GetInferenceProfile", "bedrock:InvokeModel*"]
            Resource = "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:inference-profile/us.${model_id}"
          },
        ]
      ]),
      [
        # Per-tenant Linear / Jira OAuth tokens. synth statements 25 and 26,
        # scoped by NAME PATTERN rather than by a CDK-managed secret ARN — the
        # secrets are created out-of-band per tenant (`bgagent-jira-oauth-<cloudId>`,
        # see cdk/src/constructs/jira-integration.ts:294-305), which is exactly
        # why these two are portable in this PR while the GitHub-token statement
        # is not. Kept as two separate statements to mirror synth.
        {
          Effect   = "Allow"
          Action   = "secretsmanager:GetSecretValue"
          Resource = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:bgagent-linear-oauth-*"
        },
        {
          Effect   = "Allow"
          Action   = "secretsmanager:GetSecretValue"
          Resource = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:bgagent-jira-oauth-*"
        },
        # ECR pull of the agent image. synth scopes this to the CDK container
        # asset repository; here it is `var.agent_image_uri`'s repository, parsed
        # out of the URI (everything after the registry host, before `:tag` or
        # `@sha256:`). ADR sub-decision 6: the image is built out-of-band, so the
        # repository name is an input rather than a CDK-managed asset repo.
        {
          Effect = "Allow"
          Action = [
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
          ]
          Resource = "arn:${local.partition}:ecr:${local.region}:${local.account_id}:repository/${local.agent_image_repository}"
        },
        {
          # synth: Resource "*". ecr:GetAuthorizationToken is account-scoped by
          # the API and cannot be narrowed to a repository.
          Effect   = "Allow"
          Action   = "ecr:GetAuthorizationToken"
          Resource = "*"
        },
      ],
    )
  })
}

locals {
  # `123456789012.dkr.ecr.us-east-1.amazonaws.com/abca-agent@sha256:...`
  #   -> `abca-agent`
  # Strip the registry host, then the `:tag` or `@digest` suffix. Nested repo
  # paths (`team/abca-agent`) survive because only the FIRST path segment is
  # removed and `/` is not a separator in the suffix split.
  agent_image_repository = regex(
    "^[^/]+/(?P<repository>[^:@]+)",
    var.agent_image_uri,
  ).repository
}

# ---------------------------------------------------------------------------
# Agent Runtime
# CDK: Runtime99E3DDFA (AWS::BedrockAgentCore::Runtime)
#      backgroundagent-dev/Runtime/Resource
#      cdk/src/stacks/agent.ts:529-548
# ---------------------------------------------------------------------------
resource "aws_bedrockagentcore_agent_runtime" "agent" {
  agent_runtime_name = local.runtime_name
  role_arn           = aws_iam_role.runtime_execution.arn

  # synth: AgentRuntimeArtifact.ContainerConfiguration.ContainerUri, a Fn::Sub
  # over the CDK container-asset repository and the asset hash
  # (`AgentRuntimeArtifact.fromAsset(repoRoot, {file: 'agent/Dockerfile'})` —
  # cdk/src/stacks/agent.ts:100-102). Terraform does not replicate CDK's asset
  # pipeline (ADR sub-decision 6): the image is built and pushed out-of-band and
  # its immutable URI is an input. Pass a digest, not a mutable tag, so the image
  # a plan describes is the image an apply deploys.
  agent_runtime_artifact {
    container_configuration {
      container_uri = var.agent_image_uri
    }
  }

  # synth: "NetworkConfiguration": {"NetworkMode": "VPC", "NetworkModeConfig":
  #   {"SecurityGroups": [...], "Subnets": [...]}}
  # from `RuntimeNetworkConfiguration.usingVpc` (cdk/src/stacks/agent.ts:512-516)
  # over PRIVATE_WITH_EGRESS subnets and the AgentVpc runtime security group.
  #
  # `network_mode` is hardcoded "VPC" and MUST NOT become a variable: "PUBLIC"
  # would put the agent's egress outside the VPC and outside every control the
  # AgentVpc construct applies (endpoint policies, egress rules). The subnets and
  # security groups are inputs only because the VPC itself lands in PR 4; when it
  # does, replace them with direct references and drop the variables.
  #
  # `require_service_s3_endpoint` is read-only in the provider (rejected on
  # create AND update), so it is not set.
  network_configuration {
    network_mode = "VPC"

    network_mode_config {
      security_groups = var.agent_runtime_security_group_ids
      subnets         = var.agent_runtime_subnet_ids
    }
  }

  # synth: "ProtocolConfiguration": "HTTP" — a bare string in CloudFormation, a
  # block with `server_protocol` in the provider.
  protocol_configuration {
    server_protocol = "HTTP"
  }

  # synth: "FilesystemConfigurations": [{"SessionStorage": {"MountPath":
  # "/mnt/workspace"}}]. The path is load-bearing: CLAUDE_CONFIG_DIR and
  # npm_config_cache below live under it, so changing it breaks the agent's
  # config and cache persistence across invocations within a session.
  filesystem_configuration {
    session_storage {
      mount_path = "/mnt/workspace"
    }
  }

  # synth: "LifecycleConfiguration": {"IdleRuntimeSessionTimeout": 28800,
  #                                   "MaxLifetime": 28800}
  # Both are SECONDS. CDK writes `Duration.hours(RUNTIME_SESSION_TIMEOUT_HOURS)`
  # with RUNTIME_SESSION_TIMEOUT_HOURS = 8 (cdk/src/stacks/agent.ts:83,520-523)
  # and synth resolves that to 28800 — the unit conversion is exactly the kind of
  # thing reading the TypeScript would get wrong. 8h is the AgentCore maximum;
  # both timers are pinned to it so long-running tasks (approval waits, heavy
  # builds) are not evicted mid-flight.
  lifecycle_configuration {
    idle_runtime_session_timeout = 28800
    max_lifetime                 = 28800
  }

  # PARTIAL PORT. synth carries 22 environment variables: 11 literal strings and
  # 11 Ref/GetAtt to other resources. All 11 literals are below, plus MEMORY_ID
  # (this PR's memory), for 12 total. The 10 missing keys are the remaining
  # Ref/GetAtt ones, listed in PARITY_NOTES-agentcore.md — the agent reads them at
  # startup, so the runtime is not functional until PR 4 supplies them.
  environment_variables = {
    # Bedrock wiring — synth values verbatim.
    CLAUDE_CODE_USE_BEDROCK = "1"
    ANTHROPIC_LOG           = "debug"
    # Bare region string in synth (CDK resolved the stack region), computed here.
    AWS_REGION = local.region
    # A region-prefixed inference-profile ID, unlike bedrock_model_ids above
    # which are bare. Both forms are correct in their own place; see
    # bedrock-models.ts:57-59.
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

    # synth: "28800" — the agent's session hook reads this to compute remaining
    # max-lifetime (cdk/src/stacks/agent.ts:467). It MUST equal
    # lifecycle_configuration.max_lifetime above or the agent misjudges how much
    # time it has left and gets killed mid-turn.
    AGENTCORE_MAX_LIFETIME_S = tostring(28800)

    MAX_TURNS = "100"

    # Writable paths — /tmp for tool caches, session storage for anything that
    # must survive across invocations in a session.
    MISE_DATA_DIR     = "/tmp/mise-data"
    UV_CACHE_DIR      = "/tmp/uv-cache"
    CLAUDE_CONFIG_DIR = "/mnt/workspace/.claude-config"
    npm_config_cache  = "/mnt/workspace/.npm-cache"

    # Solution attribution (#319). synth emits
    # "uksb-wt64nei4u6#backgroundagent-dev" — the `#` and the id must stay
    # byte-identical to SOLUTION_ID in cdk/src/handlers/shared/ua.ts and to the
    # `provider_meta` literal in versions.tf. The suffix is the CDK stack name;
    # its Terraform analogue is the env-scoped module name.
    AWS_SDK_UA_APP_ID = "uksb-wt64nei4u6#abca-${var.env_name}"

    # From this PR's memory. synth: Fn::GetAtt AgentMemory1601EF79.MemoryId
    # (cdk/src/stacks/agent.ts:485). The agent uses it for every CreateEvent and
    # RetrieveMemoryRecords call.
    MEMORY_ID = aws_bedrockagentcore_memory.agent.id
  }

  # The strategies are separate resources, so Terraform does not know the memory
  # is not fully configured until they exist. Without this the runtime can be
  # created while extraction is unconfigured, and any event written in that
  # window is extracted under the service default namespace rather than the
  # actorId-scoped one above — a silent isolation hole during a first apply.
  depends_on = [
    aws_bedrockagentcore_memory_strategy.semantic_knowledge,
    aws_bedrockagentcore_memory_strategy.task_episodes,
  ]
}

# ---------------------------------------------------------------------------
# Inputs owned by PR 4 (VPC), declared here so this file plans on its own.
# ---------------------------------------------------------------------------
# These are NOT in variables.tf on purpose: they are temporary. PR 4 creates the
# AgentVpc equivalent, at which point `network_mode_config` should reference
# those resources directly and these two variables should be deleted rather than
# promoted. They default to empty so the credential-free parity plan (PR 6) still
# runs without being handed fixture subnet ids.
variable "agent_runtime_subnet_ids" {
  description = "TEMPORARY (PR 4 removes this). Private-with-egress subnet IDs for the AgentCore Runtime's VPC attachment. Mirrors the PRIVATE_WITH_EGRESS selection in cdk/src/stacks/agent.ts:512-516. Leave empty only for credential-free parity plans."
  type        = set(string)
  default     = []
}

variable "agent_runtime_security_group_ids" {
  description = "TEMPORARY (PR 4 removes this). Security group IDs for the AgentCore Runtime. Mirrors AgentVpc.runtimeSecurityGroup in cdk/src/stacks/agent.ts:515."
  type        = set(string)
  default     = []
}
