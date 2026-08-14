# Parity notes — AgentCore compute (`agentcore.tf`)

Reviewer-facing evidence for the CDK → Terraform port of the AgentCore Memory,
its two extraction strategies, and the Agent Runtime.

**Every value in the "CDK synth" column below was read out of
`cdk/cdk.out/backgroundagent-dev.template.json`, not out of the TypeScript.** CDK
resolves defaults behind `??` only when it emits CloudFormation, so the construct
source under-reports what is deployed. Regenerate with:

```bash
python3 -c "
import json
d=json.load(open('cdk/cdk.out/backgroundagent-dev.template.json'))
for lid,r in d['Resources'].items():
    if 'AgentCore' in r['Type']:
        print('===',r['Type'],lid); print(json.dumps(r['Properties'],indent=2))
"
```

The "verified?" column means: the value was observed in a real
`terraform show -json` plan (Terraform 1.15.8, AWS provider 6.60.0, mock
credentials, `-refresh=false`) and compared programmatically against synth — not
that it was eyeballed.

---

## 1. THE ISOLATION BOUNDARY — read this first

ABCA runs **one** shared AgentCore Memory for **all** onboarded repositories.
Events are written with `actorId = "owner/repo"` and `sessionId = taskId`. The
namespace templates below are the **only** thing keeping repository A's learnings
out of repository B's agent context. There is no per-repo Memory, no IAM
condition on `actorId`, and no runtime-side filter — the runtime's own memory
grant is scoped to the memory ARN, i.e. all actors and all sessions (see §5,
statements 10-11). A wrong template does not fail loudly: extraction still
succeeds and records still land, just in a namespace another repository reads.

Diff these four strings character by character. Left column is `cdk synth`, right
column is what `terraform show -json tfplan.bin` actually reported.

| Strategy | Field | CDK synth (`AgentMemory1601EF79`) | plan.json (`namespace_templates`) | Match |
|---|---|---|---|---|
| SEMANTIC `SemanticKnowledge` | namespaces | `/{actorId}/knowledge/` | `/{actorId}/knowledge/` | ✅ byte-identical |
| EPISODIC `TaskEpisodes` | namespaces | `/{actorId}/episodes/{sessionId}/` | `/{actorId}/episodes/{sessionId}/` | ✅ byte-identical |
| EPISODIC `TaskEpisodes` | reflection namespaces | `/{actorId}/episodes/` | `/{actorId}/episodes/` | ✅ byte-identical |
| SEMANTIC `SemanticKnowledge` | reflection namespaces | *(absent)* | *(absent — empty block list)* | ✅ |

Raw observed output, both sides, unedited:

```
======================= PLAN.JSON (terraform, provider 6.60.0) =======================
semantic_knowledge   type=SEMANTIC
  namespace_templates      = ["/{actorId}/knowledge/"]
  reflection_configuration = []
task_episodes        type=EPISODIC
  namespace_templates      = ["/{actorId}/episodes/{sessionId}/"]
  reflection_configuration = [{"namespace_templates": ["/{actorId}/episodes/"]}]

======================= CDK SYNTH (cdk.out/backgroundagent-dev.template.json) =========
SemanticMemoryStrategy: Name=SemanticKnowledge Type=SEMANTIC
  Namespaces               = ["/{actorId}/knowledge/"]
EpisodicMemoryStrategy: Name=TaskEpisodes Type=EPISODIC
  Namespaces               = ["/{actorId}/episodes/{sessionId}/"]
  ReflectionConfiguration  = {"Namespaces": ["/{actorId}/episodes/"]}
```

Byte-level assertion (not a visual comparison):

```
MATCH  SEMANTIC.ns:   synth=[b'/{actorId}/knowledge/']            tf=[b'/{actorId}/knowledge/']
MATCH  EPISODIC.ns:   synth=[b'/{actorId}/episodes/{sessionId}/'] tf=[b'/{actorId}/episodes/{sessionId}/']
MATCH  EPISODIC.refl: synth=[b'/{actorId}/episodes/']             tf=[b'/{actorId}/episodes/']
MATCH  SEMANTIC.name / EPISODIC.name
ALL NAMESPACE/NAME ASSERTIONS PASS
```

**Two things a reviewer should NOT "fix":**

1. The reflection namespace is deliberately **one level shallower** than the
   episode namespace — `{sessionId}` is absent by design, because reflections
   summarize *across* a repository's tasks. It is still scoped by `{actorId}`,
   which is the property that matters. The provider documents this explicitly:
   "Can be less nested than episode namespaces."
2. Both the **leading and trailing slash** are load-bearing, and `{actorId}`
   expands to a value that itself contains a slash (`owner/repo`), so
   `/{actorId}/knowledge/` becomes `/awslabs/agent-plugins/knowledge/`.

**Deprecated-argument note:** the provider mirrors `namespaces` and
`namespace_templates` in both directions, so the plan shows the deprecated
`namespaces` attribute populated with the same value as computed drift. That is
expected and is why `namespace_templates` is the argument actually set —
`namespaces` is marked `DEPRECATED` in the provider schema and exactly one of the
two must be configured.

---

## 2. Memory — `aws_bedrockagentcore_memory.agent`

CDK logical ID `AgentMemory1601EF79`, path
`backgroundagent-dev/AgentMemory/Memory/Resource`, source
`cdk/src/constructs/agent-memory.ts:75-92` (instantiated at
`cdk/src/stacks/agent.ts:322`).

| CDK synth property / value | Terraform argument / value | verified? |
|---|---|---|
| `Description: "Cross-task interaction memory for background coding agents"` | `description` — same string | ✅ byte-identical in plan.json |
| `EventExpiryDuration: 365` | `event_expiry_duration = 365` | ✅ plan.json `event_expiry_duration=365` |
| `MemoryExecutionRoleArn: GetAtt AgentMemoryServiceRole0B12E4A3.Arn` | `memory_execution_role_arn = aws_iam_role.agent_memory_service.arn` | ✅ known-after-apply reference |
| `Name: "backgroundagentdevAgentMemory2EB404A5"` | `name = "abca_${slug}_memory"` → `abca_dev_memory` | ⚠️ **deliberately different** — see §7 |
| `MemoryStrategies: [ … ]` (nested array) | two separate `aws_bedrockagentcore_memory_strategy` resources | ⚠️ structural — see §6 |
| `Tags: {compute_type, 13 × github:*}` | provider `default_tags` (`compute_type` only) | ⚠️ intentional — see §7 |
| `EncryptionKeyArn` — **absent** | `encryption_key_arn` omitted → AWS-managed encryption | ✅ absence is the faithful mirror |
| `IndexedKey` / `StreamDeliveryResources` — **absent** | omitted | ✅ |

`event_expiry_duration` is the worked example of why synth is authoritative: the
construct writes `props?.expirationDuration ?? Duration.days(DEFAULT_EXPIRATION_DAYS)`
(`agent-memory.ts:78`, constant `365` at line 27) with **no literal at the call
site**, synth materializes `365`, and the Terraform argument is **required** —
omitting it fails `terraform validate`. It is in **days** (range 7-365), and 365
is also the API maximum, so it cannot be raised on either path.

---

## 3. Memory strategies

Namespace strings are covered in §1 and not repeated.

| CDK synth | Terraform | verified? |
|---|---|---|
| `MemoryStrategies[0].SemanticMemoryStrategy.Name = "SemanticKnowledge"` | `name = "SemanticKnowledge"` | ✅ |
| `MemoryStrategies[0].…Type = "SEMANTIC"` | `type = "SEMANTIC"` | ✅ plan.json `type=SEMANTIC` |
| `MemoryStrategies[1].EpisodicMemoryStrategy.Name = "TaskEpisodes"` | `name = "TaskEpisodes"` | ✅ |
| `MemoryStrategies[1].…Type = "EPISODIC"` | `type = "EPISODIC"` | ✅ plan.json `type=EPISODIC` |
| `MemoryStrategies[1].…ReflectionConfiguration.Namespaces` | `reflection_configuration { namespace_templates }` | ✅ |
| *(no extraction/consolidation model overrides in synth)* | no `configuration` block | ✅ — the block is *required* for `type = "CUSTOM"` and must be *omitted* otherwise; both paths therefore use AgentCore service-default extraction models |
| n/a (nested in CFN) | `memory_id = aws_bedrockagentcore_memory.agent.id` | ✅ — changing it forces replacement |
| n/a | `memory_execution_role_arn` **not set** on strategies | ✅ deliberate — DEPRECATED on this resource; it belongs on the memory, which is where CDK puts it |

Provider limits honored: **max 6 strategies per memory**, and **at most one of
each built-in type** (`SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE`, `EPISODIC`).
ABCA uses 2, so there is headroom — but a second `SEMANTIC` strategy would fail at
**apply**, not at plan.

---

## 4. Agent Runtime — `aws_bedrockagentcore_agent_runtime.agent`

CDK logical ID `Runtime99E3DDFA`, source `cdk/src/stacks/agent.ts:529-548`.

| CDK synth property / value | Terraform argument / value | verified? |
|---|---|---|
| `AgentRuntimeName: "backgroundagentdevRuntimeCC6E3A5A"` | `agent_runtime_name = "abca_${slug}_runtime"` | ⚠️ deliberately different — §7 |
| `RoleArn: GetAtt RuntimeExecutionRole304CF3D8.Arn` | `role_arn = aws_iam_role.runtime_execution.arn` | ✅ |
| `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri` = `Fn::Sub` over the CDK container-asset ECR repo + asset hash `ad4e0e37…` | `agent_runtime_artifact { container_configuration { container_uri = var.agent_image_uri } }` | ⚠️ by design — ADR sub-decision 6, §7 |
| `LifecycleConfiguration.IdleRuntimeSessionTimeout: 28800` | `lifecycle_configuration { idle_runtime_session_timeout = 28800 }` | ✅ plan.json `28800` |
| `LifecycleConfiguration.MaxLifetime: 28800` | `lifecycle_configuration { max_lifetime = 28800 }` | ✅ plan.json `28800` |
| `NetworkConfiguration.NetworkMode: "VPC"` | `network_configuration { network_mode = "VPC" }` | ✅ plan.json `"VPC"` |
| `NetworkConfiguration.NetworkModeConfig.SecurityGroups: [GetAtt AgentVpcRuntimeSG…]` | `network_mode_config { security_groups = var.agent_runtime_security_group_ids }` | ⚠️ input until PR 4 — §8 |
| `NetworkConfiguration.NetworkModeConfig.Subnets: [AgentVpcPrivateSubnet1, …2]` | `network_mode_config { subnets = var.agent_runtime_subnet_ids }` | ⚠️ input until PR 4 — §8 |
| `ProtocolConfiguration: "HTTP"` (bare string) | `protocol_configuration { server_protocol = "HTTP" }` (block) | ✅ plan.json `{"server_protocol":"HTTP"}` |
| `FilesystemConfigurations: [{SessionStorage: {MountPath: "/mnt/workspace"}}]` | `filesystem_configuration { session_storage { mount_path = "/mnt/workspace" } }` | ✅ plan.json `/mnt/workspace` |
| `EnvironmentVariables` (22 keys) | `environment_variables` (12 keys) | ⚠️ partial — §5 |
| `Tags` | provider `default_tags` | ⚠️ §7 |
| `AuthorizerConfiguration` — **absent** | omitted | ✅ |
| n/a | `require_service_s3_endpoint` **not set** | ✅ read-only in the provider — rejected on create *and* update |

**The unit conversion is the trap here.** CDK writes
`Duration.hours(RUNTIME_SESSION_TIMEOUT_HOURS)` with
`RUNTIME_SESSION_TIMEOUT_HOURS = 8` (`agent.ts:83,520-523`). Reading the
TypeScript suggests `8`; synth resolves it to **28800 seconds**, which is what the
provider wants. 8h is the AgentCore maximum, and both timers are pinned to it so
long-running tasks (approval waits, heavy builds) are not evicted mid-flight.

`AGENTCORE_MAX_LIFETIME_S = "28800"` **must equal** `max_lifetime`: the agent's
session hook reads it to compute remaining lifetime (`agent.ts:467`). If they
diverge the agent misjudges its remaining budget and is killed mid-turn.

`mount_path = "/mnt/workspace"` is likewise load-bearing — `CLAUDE_CONFIG_DIR`
and `npm_config_cache` are paths *under* it, so changing one without the others
breaks config/cache persistence across invocations in a session.

`network_mode = "VPC"` is hardcoded and **must not become a variable**. `"PUBLIC"`
would move the agent's egress outside the VPC and outside every control the
`AgentVpc` construct applies.

---

## 5. IAM

### Memory service role — `aws_iam_role.agent_memory_service`

CDK `AgentMemoryServiceRole0B12E4A3`. Synth shows **only**
`AssumeRolePolicyDocument` and `Tags` — no `ManagedPolicyArns`, and no
`AWS::IAM::Policy` lists it in `Roles`:

```bash
python3 -c "
import json; d=json.load(open('cdk/cdk.out/backgroundagent-dev.template.json'))
R=d['Resources']; t='AgentMemoryServiceRole0B12E4A3'
print(list(R[t]['Properties'].keys()))
print([l for l,r in R.items() if r['Type']=='AWS::IAM::Policy'
       and t in json.dumps(r['Properties'].get('Roles',[]))])
"
# -> ['AssumeRolePolicyDocument', 'Tags']
# -> []
```

So Terraform attaches **no** permissions policy either. Both confused-deputy
conditions are ported verbatim; note `aws:SourceArn` uses **`ArnLike`**, not
`StringEquals`, because the trailing `*` covers the id suffix AgentCore appends.

Observed in plan.json:
`arn:aws:bedrock-agentcore:us-east-1:<account>:memory/abca_dev_memory*`

> **⚠️ Possible upstream CDK bug — flagged, not silently fixed.** The provider
> docs attach
> `AmazonBedrockAgentCoreMemoryBedrockModelInferenceExecutionRolePolicy` to this
> role, and the cdk-nag suppression at `agent-memory.ts:94-99` justifies
> "wildcard permissions for Bedrock model invocation used by memory extraction
> strategies" — describing permissions synth does **not** actually grant. If
> extraction silently no-ops in production, this is the first place to look.
> Adding the policy only on the Terraform side would make the two paths diverge,
> which is the one thing this module must not do. **Fix CDK first, then mirror.**

### Runtime execution role — `aws_iam_role.runtime_execution`

CDK `RuntimeExecutionRole304CF3D8`.

| CDK synth | Terraform | verified? |
|---|---|---|
| `Description: "Execution role for Bedrock Agent Core Runtime"` | `description` — same string | ✅ plan.json |
| `MaxSessionDuration: 28800` | `max_session_duration = 28800` | ✅ plan.json `28800` |
| `AssumeRolePolicyDocument` (`StringEquals aws:SourceAccount` + `ArnLike aws:SourceArn` on `runtime/<name>*`) | ported verbatim | ✅ plan.json `arn:aws:bedrock-agentcore:us-east-1:<account>:runtime/abca_dev_runtime*` |

A shorter `max_session_duration` would expire the role's credentials mid-task on
a long build or approval wait.

### Runtime policy — `aws_iam_role_policy.runtime_execution`

Synth's `RuntimeExecutionRoleDefaultPolicy2B020CFC` has **29 statements**
(counted, not estimated). Terraform renders **24** — verified by evaluating the
same `concat`/`flatten` shape in `terraform console`: `stmt_count = 24`. The
policy body is `known after apply` in the plan because it embeds the memory ARN,
so the count was checked structurally rather than read out of plan.json.

Statement order and `Sid` values follow synth so the two documents diff
top-to-bottom. Wildcards are reproduced **exactly** as CDK emits them — this port
must neither widen nor narrow the deployed permission set.

Ported (24):

| # | Sid / actions | Notes |
|---|---|---|
| 0-2 | `LogGroupAccess`, `DescribeLogGroups`, `LogStreamAccess` | AgentCore-managed log groups under `/aws/bedrock-agentcore/runtimes/*` |
| 3 | `XRayAccess` | `Resource: "*"` — X-Ray write APIs are not resource-scopable |
| 4 | `CloudWatchMetrics` | `Resource: "*"` **plus** `cloudwatch:namespace = bedrock-agentcore` condition. The condition is what makes the `*` acceptable; dropping it silently widens the grant to every namespace |
| 5 | `GetAgentAccessToken` | workload-identity-directory ARNs |
| 10-11 | memory read (7 actions) + `CreateEvent` | **scoped to the memory ARN, i.e. all actors/sessions.** The runtime's IAM does *not* enforce per-repo isolation — §1 is the whole boundary |
| 12-23 | Bedrock invoke, 3 per model × 4 models | in-region FM ARN, all-regions FM ARN, `us.`-prefixed inference-profile ARN — mirroring how `grantInvoke` fans out. Per-model, **not** `Resource: "*"`; that hardening (`bedrock-models.ts:29-33`) survives the port |
| 25-26 | Linear + Jira OAuth secrets | name-pattern scoped (`bgagent-{linear,jira}-oauth-*`), created out-of-band per tenant — which is *why* these are portable now |
| 27-28 | ECR pull + `GetAuthorizationToken` | repository parsed from `var.agent_image_uri`; `GetAuthorizationToken` is `Resource: "*"` because the API is account-scoped |

**Omitted (5) — must land with PR 4 or the agent gets AccessDenied:**

| # | Synth statement | Blocked on |
|---|---|---|
| 6 | 10 × `dynamodb:*` on `UserConcurrencyTable48C3732F.Arn` | user-concurrency table |
| 7 | `dynamodb:GetRecords`, `GetShardIterator` on the same table | same |
| 8 | `secretsmanager:GetSecretValue`, `DescribeSecret` on `GitHubTokenSecret09BC4210` | GitHub token secret |
| 9 | `logs:CreateLogStream`, `PutLogEvents` on `RuntimeApplicationLogGroupCCD512EC.Arn` | application log group |
| 24 | `sts:AssumeRole`, `sts:TagSession` on `AgentSessionRoleB6C61074.Arn` | agent session role |

The four model IDs in `local.bedrock_model_ids` mirror
`DEFAULT_BEDROCK_MODEL_IDS` (`cdk/src/constructs/bedrock-models.ts:34`) and are
**bare** foundation-model IDs; the `us.` inference-profile ARN is derived, exactly
as CDK does it. Keep this list in lockstep with that constant **and** with the
agent's fallback model in `agent/src/config.py` — a fallback the role cannot
invoke fails every task at turn 0.

> Note the one place a region-prefixed ID is correct:
> `ANTHROPIC_DEFAULT_HAIKU_MODEL = "us.anthropic.claude-haiku-4-5-…"` is an
> *inference-profile* ID and is prefixed in synth too. Both forms are right in
> their own place (`bedrock-models.ts:57-59`).

---

## 6. What CDK expresses that the provider cannot

| CDK / CloudFormation | Provider situation | Consequence |
|---|---|---|
| `MemoryStrategies` nested inside the Memory resource | No strategies argument on `aws_bedrockagentcore_memory`; strategies are separate resources joined by `memory_id` | **1 CFN resource → 3 Terraform resources.** PR 6's type census must not read this as a count mismatch. It also means a first `apply` can create the runtime while extraction is unconfigured — any event written in that window is extracted under the *service default* namespace, not the `actorId`-scoped one. Mitigated with an explicit `depends_on` from the runtime to both strategies. **This is a real behavioral difference from CFN, which configures strategies atomically with the memory.** |
| `loggingConfigs` on `agentcore.Runtime` (`agent.ts:534-543`) auto-creating 6 resources: 2 × `AWS::Logs::DeliverySource`, 2 × `DeliveryDestination`, 2 × `Delivery` for `APPLICATION_LOGS` + `USAGE_LOGS` | `aws_bedrockagentcore_agent_runtime` has **no** `logging_configs` argument | Log delivery must be declared explicitly as `aws_cloudwatch_log_delivery_source` / `_destination` / `_delivery`. Deferred to PR 4 with the log groups they target. **Until then the Terraform runtime emits no application or usage logs to CloudWatch.** |
| `AgentRuntimeArtifact.fromAsset(repoRoot, {file: 'agent/Dockerfile'})` — builds the image, pushes to the CDK asset ECR repo, injects the digest | No asset pipeline | Image is built out-of-band; `var.agent_image_uri` is a required input (ADR sub-decision 6). Pass a `@sha256:` digest, not a mutable tag, or the image a plan describes is not necessarily the image an apply deploys. |
| CDK's logical-ID-derived resource names, and the stable-logical-ID comments at `agent.ts:525-528` explaining that renaming the `Runtime` construct triggers `UPDATE_ROLLBACK` via AgentCore's account-level name uniqueness | No logical IDs; Terraform addresses are `type.name` | The same uniqueness constraint still bites: two deployments in one account+region **must** use different `var.env_name`. Renaming a Terraform resource address is a state `mv`, not a replace, so the CFN-specific create-before-delete hazard does not apply — but changing `agent_runtime_name` does force a replace and will collide with the live runtime. |
| `NagSuppressions` (`agent-memory.ts:94-99`) | No cdk-nag equivalent | Suppression rationale lives in comments only. |
| Per-type tag exclusions | `default_tags` has no per-type exclusion | Not an issue for these resources; noted in `providers.tf` for Route53 Resolver later. |
| `require_service_s3_endpoint` | Read-only in the provider — rejected on create *and* update | Cannot be set from either path; service-managed. |

---

## 7. Deliberate divergences (not defects)

| Thing | CDK | Terraform | Why |
|---|---|---|---|
| Memory name | `backgroundagentdevAgentMemory2EB404A5` | `abca_dev_memory` | Trailing hash is a CDK logical-ID artifact. Nothing reads either resource by hardcoded name — the agent gets `MEMORY_ID` via env var, the runtime is addressed by ARN. Pinning CDK's hash would tie Terraform to CDK's construct tree. AgentCore names allow only `[a-zA-Z0-9_]` and must start with a letter (memory ≤ 48 chars), so `var.env_name`'s hyphens are transliterated to `_` — interpolating raw would produce a name that only fails at apply. |
| Runtime name | `backgroundagentdevRuntimeCC6E3A5A` | `abca_dev_runtime` | Same. |
| IAM role names | CFN-generated | `${env_name}-abca-agentcore-{memory-service,runtime-execution}` | Same reasoning; roles are referenced by ARN. |
| Tags | `compute_type` + 13 × `github:*` = `"none"` | `compute_type` only, via `default_tags` | The `github:*` keys are per-CI-run provenance, not a property of the infrastructure. Hard-coding `"none"` for 13 keys adds noise, not information. Decision recorded in `providers.tf`. |
| Container URI | CDK asset digest | `var.agent_image_uri` | ADR sub-decision 6. |
| Account ID in ARNs | `Ref AWS::AccountId` | `data.aws_caller_identity`, **gated** on `var.credential_free_plan` | An explicit `aws_caller_identity` data source calls STS `GetCallerIdentity`, which fails under mock credentials — `skip_requesting_account_id` suppresses the *provider's* internal lookup, not an explicit data source. Verified: it returns `403 InvalidClientTokenId`. Gating keeps PR 6's census credential-free (placeholder `000000000000`, only ever in a plan that is thrown away) while real deployments read the true account. |

---

## 8. Temporary inputs — delete, do not promote

`variable "agent_runtime_subnet_ids"` and
`variable "agent_runtime_security_group_ids"` are declared in `agentcore.tf`
rather than `variables.tf` **on purpose**: they are scaffolding. PR 4 creates the
`AgentVpc` equivalent, at which point `network_mode_config` should reference those
resources directly and these two variables should be **deleted**, not moved to
`variables.tf`. They default to `[]` so the credential-free parity plan runs
without fixture subnet ids.

An empty set passes `plan` (the provider marks both arguments required but sets no
minimum item count), so the guard is *not* at plan time. `network_mode = "VPC"`
with no subnets is expected to be rejected by AgentCore at apply — **not verified
here**, since that needs a real apply. Treat the defaults as CI scaffolding only;
a real deployment must pass both.

---

## 9. Verification performed

Terraform 1.15.8, AWS provider 6.60.0, in a scratch directory outside the repo
with the mock-credential provider from the PR 6 spec (`skip_*` flags,
`-refresh=false`, no AWS contact).

| Step | Result |
|---|---|
| `terraform init` | ✅ provider 6.60.0 installed |
| `terraform validate` | ✅ `Success! The configuration is valid.` |
| `terraform plan -refresh=false -input=false -out=tfplan.bin` | ✅ `Plan: 7 to add, 0 to change, 0 to destroy.` — no warnings, no deprecation notices |
| `terraform show -json tfplan.bin` | ✅ namespace templates extracted and compared against synth |
| Namespace byte-comparison | ✅ `ALL NAMESPACE/NAME ASSERTIONS PASS` (§1) |
| Rendered policy statement count | ✅ 24 = 29 synth − 5 omitted (§5) |
| `agent_image_uri` repo regex | ✅ `…/abca-agent@sha256:…` → `abca-agent`; `…/team/abca-agent:v1` → `team/abca-agent`; `…/abca-agent:latest` → `abca-agent` |
| `terraform fmt` | ✅ clean |

7 planned resources: 1 memory, 2 strategies, 1 runtime, 2 IAM roles, 1 role
policy.

**What this does not prove.** `-refresh=false` with mock credentials never
contacts AWS, so this is *structural* verification only. It cannot show that
AgentCore accepts these namespace templates at runtime, that extraction actually
files records where the templates say, or that the memory service role has the
permissions extraction needs (see the §5 warning). Those need a real apply against
a burner account — the ADR's level-5 acceptance test.
