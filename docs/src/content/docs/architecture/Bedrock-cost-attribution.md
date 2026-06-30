---
title: Bedrock cost attribution
---

# Bedrock cost attribution

Design for [#215](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/215). Adds AWS-native, per-user/per-repo attribution of **Bedrock model-inference spend** on top of the in-app `cost_usd` meter and the #211 per-session tenant-data isolation.

## TL;DR

Bedrock is invoked by the **Claude Code CLI subprocess** (`CLAUDE_CODE_USE_BEDROCK=1`), not by the agent's boto3. So neither track can be built by extending `agent/src/aws_session.py` (which scopes DynamoDB/S3 tenant data only). Both levers live in **Claude Code's own configuration**, set by the agent before it spawns the subprocess:

| Track | Mechanism | Surfaces in | AC |
|---|---|---|---|
| 1. IAM session-tag attribution | Claude Code `awsCredentialExport` → helper does `sts:AssumeRole --tags {user_id,repo,task_id}` against a new **BedrockInvokeRole** | CUR 2.0 / Cost Explorer (`iamPrincipal/` prefix), aggregated per usage-type/day | #1, #2 |
| 2. Per-request metadata | `ANTHROPIC_CUSTOM_HEADERS: X-Amzn-Bedrock-Request-Metadata: {...}` env var | Model-invocation logs (`requestMetadata` field), per call | #3 |
| 3. Operator docs | `COST_ATTRIBUTION.md` + cross-links | — | #5 |

The two tracks are **complementary** (per AWS docs): session tags give aggregated chargeback in billing; request metadata gives per-call forensics in logs. Session tags are *not* written to invocation logs, and request metadata is *not* a cost-allocation tag — you need both.

## Why the issue's original approach doesn't apply

The issue proposed extending `aws_session.py` / the `DeferredRefreshableCredentials` pattern to route `InvokeModel` through tagged creds. That pattern governs the agent's **boto3** clients for tenant data. But:

```
agent/src/runner.py::_setup_agent_env
  → os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
  → ClaudeSDKClient spawns the `claude` CLI subprocess
      → subprocess calls bedrock-runtime InvokeModel using the AWS SDK default
        credential chain (today: the ambient compute role)
```

The agent never makes the `InvokeModel` call, so it cannot attach creds or headers to it directly. The control point is **how Claude Code resolves credentials and headers**, configured via Claude Code settings/env before `client.connect()`.

Verified Claude Code behavior (code.claude.com/docs/en/amazon-bedrock, /env-vars):

- **Credentials:** default AWS SDK chain. Mutating the parent process's `AWS_*` env vars mid-session is **not** re-read. For refresh, Claude Code supports `awsCredentialExport` — a helper command run at session start and re-run ~5 min before the `Expiration` it returns. This is exactly what an 8 h task needs to survive the **1 h role-chaining cap**.
- **Request metadata:** Claude Code uses the **Invoke API and does not support Converse**, so the Converse `requestMetadata` field is unreachable. The only lever is `ANTHROPIC_CUSTOM_HEADERS` (static per process). Because ABCA runs **one task per container per Claude Code session**, "static per process" == "per task" — sufficient for `{task_id, user_id, repo}` attribution. No proxy/gateway needed.

## Track 1 — IAM session-tag attribution

### New construct: `BedrockInvokeRole`

A dedicated role the agent assumes *only* to mint tagged credentials for Claude Code's Bedrock calls. Kept separate from `AgentSessionRole` (tenant data) so the trust/grant surfaces stay independent and auditable.

- **Trust:** same compute roles as `AgentSessionRole` (AgentCore ExecutionRole, ECS task role), with `sts:AssumeRole` + `sts:TagSession`.
- **Grants:** `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream` on the **exact** foundation-model + cross-region inference-profile ARNs already enumerated in `agent.ts` / `ecs-agent-cluster.ts` (Sonnet 4.6, Opus 4, Haiku 4.5). No wildcards — reuses the existing ARN allowlist.
- **`maxSessionDuration`: 1 h** (documents the role-chaining cap; refresh handles longevity).
- Exposes `admitComputeRole()` mirroring `AgentSessionRole`, so ECS wiring is symmetric.

Once this exists, **the compute role drops `bedrock:InvokeModel`** — model invocation moves entirely onto the tagged BedrockInvokeRole. (The #211 comment "Bedrock intentionally stays on the compute role to avoid 1 h expiry" is resolved by `awsCredentialExport`'s refresh.)

### Credential helper + Claude Code wiring

A small helper script (shipped in the agent image) that `awsCredentialExport` invokes:

```
assume-role --role-arn $BEDROCK_INVOKE_ROLE_ARN \
  --tags user_id=$USER_ID repo=$REPO task_id=$TASK_ID
→ emits {"Credentials":{AccessKeyId,SecretAccessKey,SessionToken,Expiration}}
```

- Reuses the **same STS `assume_role` + tag-truncation logic** already in `aws_session.py` (factor the tag-building + 256-char clamp into a shared helper; don't duplicate).
- `Expiration` is the real STS expiry, so Claude Code re-runs the helper before the 1 h cap.
- `_setup_agent_env` writes Claude Code's `awsCredentialExport` setting (and `BEDROCK_INVOKE_ROLE_ARN` / tag values) **into a trusted, agent-controlled settings location** — *not* the cloned repo's `.claude/settings.json`.

> **Security note (must not be skipped):** `awsCredentialExport` runs an arbitrary shell command. `setting_sources=["project"]` currently reads the **untrusted cloned target repo's** `.claude/settings.json`. We must inject `awsCredentialExport` via a location the target repo **cannot override** (user-level settings or an explicit `--settings` file the agent owns), and confirm Claude Code's precedence makes project settings unable to redefine it. A repo that could set `awsCredentialExport` would get arbitrary code execution with the compute role. This is the single highest-risk item in the design and gets a dedicated test.

### Fail-open vs fail-closed

Unlike #211 tenant isolation (fail **closed** — a scoping failure means cross-tenant exposure), Bedrock attribution is a **billing/observability** control. If the helper can't assume the role, the correct failure mode is to **fall back to the compute role and emit a warning**, not to abort the task — losing chargeback granularity is not a security incident. When `BEDROCK_INVOKE_ROLE_ARN` is unset (local/dev), behavior is identical to today.

## Track 2 — per-request metadata

In `_setup_agent_env`, set:

```python
os.environ["ANTHROPIC_CUSTOM_HEADERS"] = (
    "X-Amzn-Bedrock-Request-Metadata: "
    + json.dumps({"task_id": ..., "user_id": ..., "repo": ...})  # 256-char clamp, ≤16 keys
)
```

Gated on invocation logging being enabled (it already is — `agent.ts` configures the CloudWatch destination). Surfaces under the `requestMetadata` field in `/aws/bedrock/model-invocation-logs/<stack>`.

> **Open risk to validate before merge:** Bedrock rejects `X-Amzn-Bedrock-Request-Metadata` with `InvalidSignatureException` if the header is omitted from the SigV4 `SignedHeaders`. AWS SDKs that expose metadata as a parameter sign it automatically; a custom header injected via `ANTHROPIC_CUSTOM_HEADERS` may **not** be in Claude Code's signed-headers list. **This must be tested against a live Bedrock endpoint.** If it fails, this track is a documented blocker (AC#3 explicitly allows "or documented blocker if Claude Code cannot pass metadata"), and per-call attribution falls back to correlating invocation-log `identity.arn` + `RoleSessionName` (`abca-<task_id>`) — which Track 1's tagged session already provides.

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
| #1 Bedrock uses session-tagged creds (AgentCore + ECS); dev unchanged when unset | Track 1: BedrockInvokeRole + `awsCredentialExport`; fall back to compute role when `BEDROCK_INVOKE_ROLE_ARN` unset |
| #2 Session tags documented as billable; operator Billing steps | Track 3 |
| #3 Per-request metadata `{task_id,user_id,repo}` when logging enabled (or documented blocker) | Track 2 + SigV4 validation gate |
| #4 Tests: CDK Bedrock grant on role; cred routing; no #211 regression | New `bedrock-invoke-role.test.ts`; helper unit test; #211 tests untouched (orthogonal path) |
| #5 `COST_ATTRIBUTION.md` + accurate shipped/planned | Track 3 |
| #6 Starlight mirrors synced | `mise //docs:sync` |

## Test plan

- **CDK:** assert `BedrockInvokeRole` grants `InvokeModel`/`InvokeModelWithResponseStream` on the model+profile ARN allowlist (no wildcard); assert trust admits both compute roles with `TagSession`; assert compute role **no longer** has `bedrock:InvokeModel`.
- **Security test:** assert the agent injects `awsCredentialExport` in a location the cloned repo cannot override (the highest-risk item above).
- **Agent:** unit-test the credential helper (tag building reuses `aws_session` logic; 256-char clamp; JSON shape with `Expiration`); unit-test `ANTHROPIC_CUSTOM_HEADERS` assembly.
- **Live validation (pre-merge, manual):** confirm `X-Amzn-Bedrock-Request-Metadata` is honored (no `InvalidSignatureException`) and lands in invocation logs; confirm `iamPrincipal/user_id` appears in Cost Explorer after tag activation.
