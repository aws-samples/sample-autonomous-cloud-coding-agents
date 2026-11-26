# Bedrock cost attribution

This is the design for [#215](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/215). It adds AWS-native attribution of Bedrock model-inference spend per user and per repo, on top of the in-app `cost_usd` meter and the #211 per-session tenant-data isolation.

## TL;DR

The Claude Code CLI subprocess (`CLAUDE_CODE_USE_BEDROCK=1`) invokes Bedrock, not the agent's boto3. So neither track can be built by extending `agent/src/aws_session.py`, which scopes only DynamoDB and S3 tenant data. Both mechanisms belong to Claude Code's own configuration, which the agent sets before it spawns the subprocess:

| Track | Mechanism | Appears in | AC |
|---|---|---|---|
| 1. IAM session-tag attribution | Claude Code `awsCredentialExport` → `bedrock_creds_helper.py` does `sts:AssumeRole --tags {user_id,repo,task_id}` against the existing `AgentSessionRole` (now also granted `bedrock:InvokeModel*`) | CUR 2.0 / Cost Explorer (`iamPrincipal/` prefix), aggregated per usage-type/day | #1, #2 |
| 2. Per-request metadata | `ANTHROPIC_CUSTOM_HEADERS: X-Amzn-Bedrock-Request-Metadata: {...}` on the subprocess env | Model-invocation logs (`requestMetadata` field), per call | #3 |
| 3. Operator docs | `COST_ATTRIBUTION.md` + cross-links | — | #5 |

The two tracks are complementary, according to the AWS docs. Session tags give aggregated chargeback in billing. Request metadata gives per-call forensics in logs. Session tags are not written to invocation logs, and request metadata is not a cost-allocation tag, so you need both.

> **`cost_usd` is a client-side estimate, not billing.** The in-app `cost_usd` is the SDK's `total_cost_usd` (`runner.py`), which is computed from a build-time price table. It drifts from the real bill on pricing changes, unrecognized models, cache rates, and AWS discounts. Use it only for per-task guardrails. The authoritative source is AWS Cost Explorer or CUR 2.0 (Track 1). The [Claude Agent SDK cost-tracking docs](https://code.claude.com/docs/en/agent-sdk/cost-tracking) raise the same caveat. This design adapts it for Bedrock, where the authoritative source is the AWS bill, not the Claude Console. Both this design and the operator guide state the caveat.

## Why the issue's original approach doesn't apply

The issue proposed extending `aws_session.py` and its `DeferredRefreshableCredentials` pattern to route `InvokeModel` through tagged credentials. That pattern governs the agent's boto3 clients for tenant data. But the `InvokeModel` call is made elsewhere:

```
agent/src/runner.py::_setup_agent_env
  → os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
  → ClaudeSDKClient spawns the `claude` CLI subprocess
      → subprocess calls bedrock-runtime InvokeModel using the AWS SDK default
        credential chain (today: the ambient compute role)
```

The agent never makes the `InvokeModel` call, so the agent cannot attach credentials or headers to the call directly. The control point is how Claude Code resolves credentials and headers, which is configured before `client.connect()`.

The following Claude Code behavior is verified (code.claude.com/docs/en/amazon-bedrock, /env-vars, /settings):

- **Credentials.** Claude Code uses the default AWS SDK chain. It does not re-read the parent process's `AWS_*` environment variables when they change mid-session. For refresh, Claude Code supports `awsCredentialExport`, a settings-only key with no environment-variable or flag equivalent. The key names a helper command that Claude Code runs at session start and re-runs about 5 minutes before the `Expiration` that the helper returns (CLI 2.1.176 or later). The refresh lets an 8 h task run past the 1 h role-chaining cap.
- **Request metadata.** Claude Code uses the Invoke API and does not support Converse, so the Converse `requestMetadata` field is unreachable. The only mechanism is `ANTHROPIC_CUSTOM_HEADERS`, which is static per process. Claude Code reads it from the process environment, and the process environment wins over any settings `env` block. ABCA runs one task per container per Claude Code session, so "static per process" means "per task". A per-task header is sufficient. No proxy or gateway is needed.
- **Settings precedence (security-critical).** Under `setting_sources=["project"]`, Claude Code loads only the cloned repo's `.claude/settings.json` and drops user settings. But Claude Code loads the managed-settings layer in all cases, and that layer outranks everything, so the untrusted repo cannot override it.

## Track 1 — IAM session-tag attribution

### Reuse `AgentSessionRole` (no new role)

The compute roles already assume `AgentSessionRole` with `{user_id, repo, task_id}` STS session tags, and `AGENT_SESSION_ROLE_ARN` is already injected into the container. A second "BedrockInvokeRole" would duplicate all of that trust and grant configuration for an identical principal. Instead, this design adds a single grant to `AgentSessionRole`:

- The construct has a new optional prop `invokableModels: IBedrockInvokable[]`. For each entry, the construct calls `invokable.grantInvoke(this.role)`, the same grant that the compute role receives. Reusing `grantInvoke` instead of hand-building ARNs is essential. A cross-region inference profile fans out to the foundation-model ARN in every routed region, and a hand-built copy of those ARNs would risk an `AccessDenied` on a cross-region route. The grant has no `aws:PrincipalTag` condition, because the tags are for billing attribution, not access scoping.
- `agent.ts` passes the invokables derived from `DEFAULT_BEDROCK_MODEL_IDS` (each model plus its cross-Region profile), so the count follows that list and is not restated here. The ECS path reuses the same `AgentSessionRole` instance, so the grant also applies to the ECS path.

### The compute role KEEPS its Bedrock grant

`awsCredentialExport`'s pre-expiry refresh resolves the #211 comment "Bedrock intentionally stays on the compute role to avoid 1 h expiry". We still leave `InvokeModel` on the compute role, because Track 1 fails open, as described below, and the compute-role grant is the fallback path. The SessionRole grant is added alongside the compute-role grant and does not replace it.

### Credential helper + Claude Code wiring

`awsCredentialExport` invokes `agent/src/bedrock_creds_helper.py`, which does the following:

1. Reads a 0600 JSON file (`/home/agent/.bedrock-attribution.json`) that the agent writes at startup. The file carries the SessionRole ARN and the STS tags. The helper reads from a file, not the environment, so that tenant identifiers don't leak into the untrusted repo subprocesses that the agent spawns. `aws_session.py` follows the same rule.
2. Calls `sts:AssumeRole` with those tags and emits `{"Credentials":{...,"Expiration":<ISO>}}`. Claude Code schedules its pre-cap refresh from the real `Expiration`.
3. Reuses `aws_session.build_session_tags` to build the tags. That function is the one definition of the `{user_id,repo,task_id}` tags and the 256-char clamp.

`runner._setup_bedrock_cost_attribution` writes the attribution file when `AGENT_SESSION_ROLE_ARN` is set, and always sets the metadata header (Track 2).

### Where `awsCredentialExport` lives (RCE boundary)

`awsCredentialExport` runs an arbitrary command. The key is set in the managed-settings layer at `/etc/claude-code/managed-settings.json`. That file is root-owned, and the Dockerfile copies it before `USER agent`. The managed-settings layer is the only location that the repo cannot affect. Claude Code loads it regardless of `setting_sources=["project"]`, and it outranks the cloned repo's project `.claude/settings.json`, so a malicious repo cannot define or override the key. Setting the key anywhere that the target repo can influence would allow remote code execution (RCE) with the compute role.

### Fail-open (not fail-closed)

#211 tenant isolation fails closed, because a scoping failure means cross-tenant exposure. Bedrock attribution is different. It is a billing and observability control. If the attribution file is absent or the role assumption fails, the helper emits the ambient compute-role credentials, so Bedrock keeps working untagged. Losing chargeback granularity is not a security incident. When `AGENT_SESSION_ROLE_ARN` is unset (local or dev), the helper fails open and behavior is unchanged.

## Track 2 — per-request metadata

`_setup_bedrock_cost_attribution` sets the header on the process environment:

```python
os.environ["ANTHROPIC_CUSTOM_HEADERS"] = (
    "X-Amzn-Bedrock-Request-Metadata: "
    + json.dumps({"user_id": ..., "repo": ..., "task_id": ...})  # 256-char clamp, ≤16 keys
)
```

The header is set in the process environment, not in project settings, so the untrusted repo can't alter it. The metadata appears under `requestMetadata` in `/aws/bedrock/model-invocation-logs/<stack>`. `agent.ts` already enables that logging.

> **Note.** The header is a deliberate exception to the "tenant ids out of `os.environ`" rule. The tenant-data path keeps `{user_id, repo, task_id}` out of `os.environ` so that spawned, untrusted repo subprocesses don't inherit them. This header must be in `os.environ` because Claude Code reads `ANTHROPIC_CUSTOM_HEADERS` from the process environment. The exposure is acceptable because the values are the task's own identifiers, which are self-referential and not secret. A subprocess learns only who it is already running for. `json.dumps` escaping prevents a crafted slug from injecting an extra, newline-separated header.

> **Open risk to validate against a live endpoint.** Bedrock rejects `X-Amzn-Bedrock-Request-Metadata` with `InvalidSignatureException` if the header is omitted from the SigV4 `SignedHeaders`. Whether Claude Code signs custom headers is unverified. AC#3 permits "or documented blocker if Claude Code cannot pass metadata." If it fails, per-call attribution falls back to the invocation-log `identity.arn` and the `RoleSessionName` (`abca-bedrock-<task_id>`), which Track 1's tagged session already provides.

## Version alignment

The agent runs Claude Code two ways, and both must agree on the control protocol. The `claude-agent-sdk` Python wheel bundles a CLI, and the Dockerfile also installs the CLI with npm. Both are pinned to the same CLI version: `claude-agent-sdk==0.2.179`, which bundles CLI 2.1.319, and npm `@anthropic-ai/claude-code@2.1.319`. `agent/tests/test_claude_cli_lockstep.py` fails the build when the CLI version that the SDK bundles differs from the version on the Dockerfile's `npm install -g` line. CLI 2.1.319 also meets two minimum versions: 2.1.176, which `awsCredentialExport` with `Expiration` requires, and 2.1.280, which the Claude 5.5 default models need.

## Track 3 — operator documentation

The new guide `docs/guides/COST_ATTRIBUTION.md` covers:

- The three meters (in-app `cost_usd`, CUR session-tag chargeback, invocation-log per-call) and when to use each.
- A FinOps checklist. Activate the `iamPrincipal/{user_id,repo}` cost-allocation tags in Billing. Create a CUR 2.0 export with caller-identity ARN (existing exports don't backfill). Set budgets.
- A note that tags aren't retroactive and take up to 24 h to appear.

Cross-link the guide from `COST_MODEL.md#cost-attribution` and `DEPLOYMENT_GUIDE.md`. The roadmap links from the issue are stale. #505 removed the roadmap.

## Out of scope (unchanged from issue)

The following are out of scope: Bedrock Projects/Workspaces (`bedrock-mantle`, which is not the Claude Code path), replacing the in-app `cost_usd`, and org-level CUR and Budgets setup (an operator responsibility). Application inference profiles per repo are deferred to follow-up #489.

## Acceptance-criteria mapping

| AC | Met by |
|---|---|
| #1 Bedrock uses session-tagged creds (AgentCore + ECS); dev unchanged when unset | Track 1: `AgentSessionRole` Bedrock grant + `awsCredentialExport`; helper fails open to compute role when `AGENT_SESSION_ROLE_ARN` unset |
| #2 Session tags documented as billable; operator Billing steps | Track 3 |
| #3 Per-request metadata `{task_id,user_id,repo}` when logging enabled (or documented blocker) | Track 2 + SigV4 validation gate |
| #4 Tests: CDK Bedrock grant on role; cred routing; no #211 regression | `agent-session-role.test.ts` (Bedrock grant present/absent); `test_bedrock_creds_helper.py` (assume + fail-open); `test_runner.py` (file + header wiring); #211 tests untouched |
| #5 `COST_ATTRIBUTION.md` + accurate shipped/planned | Track 3 |
| #6 Starlight mirrors synced | `mise //docs:sync` |

## Test plan

- **CDK.** Assert that `AgentSessionRole` grants `bedrock:InvokeModel*` on the model and profile ARNs (no `Resource:'*'`) when `invokableModels` is set, and grants none when `invokableModels` is omitted. The #211 trust, grant, and tenant-scope tests are unchanged.
- **Agent.** For `bedrock_creds_helper`, test that the assume-role call carries the tenant tags and the tagged session name. Test that the helper fails open to ambient credentials when the attribution file is missing and when the assume-role call raises, and that the helper emits `{}` when no credentials resolve at all. Test the 0600 file mode. For `runner._setup_bedrock_cost_attribution`, test that it writes the file when the role ARN is set, skips the file when the role ARN is unset, and always sets the metadata header.
- **Live validation (pre-merge, manual).** Confirm that Bedrock accepts `X-Amzn-Bedrock-Request-Metadata` (no `InvalidSignatureException`) and that the metadata appears in invocation logs. Confirm that `iamPrincipal/user_id` appears in Cost Explorer after tag activation.
