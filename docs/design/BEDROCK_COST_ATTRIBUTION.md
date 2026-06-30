# Bedrock cost attribution

Design for [#215](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/215). Adds AWS-native, per-user/per-repo attribution of **Bedrock model-inference spend** on top of the in-app `cost_usd` meter and the #211 per-session tenant-data isolation.

## TL;DR

Bedrock is invoked by the **Claude Code CLI subprocess** (`CLAUDE_CODE_USE_BEDROCK=1`), not by the agent's boto3. So neither track can be built by extending `agent/src/aws_session.py` (which scopes DynamoDB/S3 tenant data only). Both levers live in **Claude Code's own configuration**, set by the agent before it spawns the subprocess:

| Track | Mechanism | Surfaces in | AC |
|---|---|---|---|
| 1. IAM session-tag attribution | Claude Code `awsCredentialExport` → `bedrock_creds_helper.py` does `sts:AssumeRole --tags {user_id,repo,task_id}` against the existing **`AgentSessionRole`** (now also granted `bedrock:InvokeModel*`) | CUR 2.0 / Cost Explorer (`iamPrincipal/` prefix), aggregated per usage-type/day | #1, #2 |
| 2. Per-request metadata | `ANTHROPIC_CUSTOM_HEADERS: X-Amzn-Bedrock-Request-Metadata: {...}` on the subprocess env | Model-invocation logs (`requestMetadata` field), per call | #3 |
| 3. Operator docs | `COST_ATTRIBUTION.md` + cross-links | — | #5 |

The two tracks are **complementary** (per AWS docs): session tags give aggregated chargeback in billing; request metadata gives per-call forensics in logs. Session tags are *not* written to invocation logs, and request metadata is *not* a cost-allocation tag — you need both.

> **`cost_usd` is a client-side estimate, not billing.** The in-app `cost_usd` is the SDK's `total_cost_usd` (`runner.py`), computed from a build-time price table; it drifts from the real bill on pricing changes, unrecognized models, cache rates, and AWS discounts. It is for per-task guardrails only — the authoritative source is AWS Cost Explorer / CUR 2.0 (Track 1). This is the same caveat the [Claude Agent SDK cost-tracking docs](https://code.claude.com/docs/en/agent-sdk/cost-tracking) raise, adapted for Bedrock (authoritative source is the AWS bill, not the Claude Console). Both this design and the operator guide surface it.

## Why the issue's original approach doesn't apply

The issue proposed extending `aws_session.py` / the `DeferredRefreshableCredentials` pattern to route `InvokeModel` through tagged creds. That pattern governs the agent's **boto3** clients for tenant data. But:

```
agent/src/runner.py::_setup_agent_env
  → os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
  → ClaudeSDKClient spawns the `claude` CLI subprocess
      → subprocess calls bedrock-runtime InvokeModel using the AWS SDK default
        credential chain (today: the ambient compute role)
```

The agent never makes the `InvokeModel` call, so it cannot attach creds or headers to it directly. The control point is **how Claude Code resolves credentials and headers**, configured before `client.connect()`.

Verified Claude Code behavior (code.claude.com/docs/en/amazon-bedrock, /env-vars, /settings):

- **Credentials:** default AWS SDK chain. Mutating the parent process's `AWS_*` env vars mid-session is **not** re-read. For refresh, Claude Code supports `awsCredentialExport` — a settings-only key (no env/flag equivalent) naming a helper command run at session start and re-run ~5 min before the `Expiration` the helper returns (≥ CLI 2.1.176). This beats the **1 h role-chaining cap** on an 8 h task.
- **Request metadata:** Claude Code uses the **Invoke API and does not support Converse**, so the Converse `requestMetadata` field is unreachable. The only lever is `ANTHROPIC_CUSTOM_HEADERS` (static per process), which **is read from the process environment** and process-env wins over any settings `env` block. Because ABCA runs **one task per container per Claude Code session**, "static per process" == "per task" — sufficient. No proxy/gateway needed.
- **Settings precedence (security-critical):** under `setting_sources=["project"]` Claude Code loads **only the cloned repo's `.claude/settings.json`** (user settings are dropped) — but the **managed-settings layer is loaded in all cases and outranks everything**, so the untrusted repo cannot override it.

## Track 1 — IAM session-tag attribution

### Reuse `AgentSessionRole` (no new role)

`AgentSessionRole` is *already* assumed by the compute roles with `{user_id, repo, task_id}` STS session tags, and `AGENT_SESSION_ROLE_ARN` is already injected into the container. A second "BedrockInvokeRole" would duplicate that entire trust/grant surface for an identical principal. Instead we add a single grant to it:

- New optional prop `invokableModels: IBedrockInvokable[]`. For each, the construct calls `invokable.grantInvoke(this.role)` — **the same grant the compute role receives**. Reusing `grantInvoke` (rather than hand-building ARNs) is load-bearing: a cross-region inference profile fans out to the foundation-model ARN in *every routed region*; replicating that by hand would risk an `AccessDenied` on a cross-region route. No `aws:PrincipalTag` condition — the tags are for billing attribution, not access scoping.
- `agent.ts` passes the six existing invokables (Sonnet 4.6 / Opus 4 / Haiku 4.5 models + their cross-region profiles). The ECS path reuses the same `AgentSessionRole` instance, so it is covered automatically.

### The compute role KEEPS its Bedrock grant

The #211 comment "Bedrock intentionally stays on the compute role to avoid 1 h expiry" is *resolved* by `awsCredentialExport`'s pre-expiry refresh — but we still leave `InvokeModel` on the compute role, because Track 1 **fails open** (below) and the compute-role grant is exactly the fallback path. The SessionRole grant is parallel, not a replacement.

### Credential helper + Claude Code wiring

`agent/src/bedrock_creds_helper.py` (invoked by `awsCredentialExport`):

1. Reads a 0600 JSON file (`/home/agent/.bedrock-attribution.json`) the agent writes at startup, carrying the SessionRole ARN + STS tags. Read from a file, not the environment, so tenant identifiers don't leak into the untrusted repo subprocesses the agent spawns (matching `aws_session.py` discipline).
2. `sts:AssumeRole` with those tags and emits `{"Credentials":{...,"Expiration":<ISO>}}`. The real `Expiration` drives Claude Code's pre-cap refresh.
3. Tag building reuses `aws_session.build_session_tags` (one definition of the `{user_id,repo,task_id}` tags + 256-char clamp).

`runner._setup_bedrock_cost_attribution` writes the attribution file when `AGENT_SESSION_ROLE_ARN` is set, and always sets the metadata header (Track 2).

### Where `awsCredentialExport` lives (RCE boundary)

`awsCredentialExport` runs an arbitrary command. It is baked into the **managed-settings layer** at `/etc/claude-code/managed-settings.json` (root-owned, copied in the Dockerfile before `USER agent`). This is the only repo-proof location: it loads regardless of `setting_sources=["project"]` and outranks the cloned repo's project `.claude/settings.json`, so a malicious repo cannot define or override it. Putting it anywhere the target repo can influence would be RCE with the compute role.

### Fail-open (not fail-closed)

Unlike #211 tenant isolation (fail **closed** — a scoping failure means cross-tenant exposure), Bedrock attribution is a **billing/observability** control. If the attribution file is absent or the assume fails, the helper emits the **ambient compute-role credentials** so Bedrock keeps working untagged — losing chargeback granularity is not a security incident. When `AGENT_SESSION_ROLE_ARN` is unset (local/dev), the helper fails open and behavior matches today.

## Track 2 — per-request metadata

In `_setup_bedrock_cost_attribution`, set on the process env:

```python
os.environ["ANTHROPIC_CUSTOM_HEADERS"] = (
    "X-Amzn-Bedrock-Request-Metadata: "
    + json.dumps({"user_id": ..., "repo": ..., "task_id": ...})  # 256-char clamp, ≤16 keys
)
```

Set via the process env (not project settings) so the untrusted repo can't alter it. Surfaces under `requestMetadata` in `/aws/bedrock/model-invocation-logs/<stack>` (logging already enabled in `agent.ts`).

> **Note — a deliberate exception to the "tenant ids out of `os.environ`" rule.** The tenant-data path keeps `{user_id, repo, task_id}` out of `os.environ` so spawned (untrusted) repo subprocesses don't inherit them. This header *must* live on `os.environ` because Claude Code reads `ANTHROPIC_CUSTOM_HEADERS` from the process env. The exposure is acceptable: the values are the task's *own* identifiers (self-referential, non-secret) — a subprocess learns only who it is already running for. `json.dumps` escaping prevents a crafted slug from injecting an extra (newline-separated) header.

> **Open risk to validate against a live endpoint:** Bedrock rejects `X-Amzn-Bedrock-Request-Metadata` with `InvalidSignatureException` if the header is omitted from the SigV4 `SignedHeaders`. Whether Claude Code signs custom headers is unverified. AC#3 explicitly permits "or documented blocker if Claude Code cannot pass metadata." If it fails, per-call attribution falls back to invocation-log `identity.arn` + `RoleSessionName` (`abca-bedrock-<task_id>`) that Track 1's tagged session already provides.

## Version alignment

The agent runs Claude Code two ways that must agree on the control protocol: the `claude-agent-sdk` Python wheel **bundles** a CLI, and the Dockerfile also installs the CLI via npm. Both are pinned in lockstep — `claude-agent-sdk==0.2.110` (bundles CLI 2.1.191) and npm `@anthropic-ai/claude-code@2.1.191`. 2.1.191 also satisfies the ≥2.1.176 `awsCredentialExport`-with-`Expiration` requirement.

## Track 3 — operator documentation

New `docs/guides/COST_ATTRIBUTION.md`:

- The three meters (in-app `cost_usd`, CUR session-tag chargeback, invocation-log per-call) and when to use each.
- FinOps checklist: activate `iamPrincipal/{user_id,repo}` cost-allocation tags in Billing; create a CUR 2.0 export **with caller-identity ARN** (existing exports don't backfill); set budgets.
- Note: tags aren't retroactive and take ≤24 h to appear.

Cross-link from `COST_MODEL.md#cost-attribution` and `DEPLOYMENT_GUIDE.md`. (Roadmap links from the issue are stale — removed in #505.)

## Out of scope (unchanged from issue)

Bedrock Projects/Workspaces (`bedrock-mantle`, not the Claude Code path); replacing in-app `cost_usd`; org-level CUR/Budgets setup (operator responsibility). Application inference profiles per repo → follow-up #489.

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

- **CDK:** assert `AgentSessionRole` grants `bedrock:InvokeModel*` on the model/profile ARNs (no `Resource:'*'`) when `invokableModels` is set, and grants none when omitted. (#211 trust/grant/tenant-scope tests unchanged.)
- **Agent:** `bedrock_creds_helper` — assume-role carries the tenant tags + tagged session name; **fails open** to ambient creds when the attribution file is missing, when assume raises, and emits `{}` when no creds resolve at all; 0600 file mode. `runner._setup_bedrock_cost_attribution` — writes the file when the role ARN is set, skips it when unset, always sets the metadata header.
- **Live validation (pre-merge, manual):** confirm `X-Amzn-Bedrock-Request-Metadata` is honored (no `InvalidSignatureException`) and lands in invocation logs; confirm `iamPrincipal/user_id` appears in Cost Explorer after tag activation.
