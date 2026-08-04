---
title: Adr 019 agentcore gateway tool federation
---

# ADR-019: Unify agent tools behind an AgentCore Gateway

> Number: candidate ADR-019 (ADR-017 is the highest accepted on `main`; ADR-018 is claimed by open PR [#548](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/548), the central agent asset registry). Numbers are never reused. If a lower number frees before merge, renumber and coordinate with PR #548.

**Status:** proposed
**Date:** 2026-07-27

## Context

ABCA gives the agent tools by writing a per-thread `.mcp.json` into the cloned repo before each run. `agent/src/channel_mcp.py` maps an inbound channel to a hosted MCP server entry. **Today the agent holds zero functional platform-managed MCP servers:** the single `CHANNEL_MCP_BUILDERS` entry is `jira`, and it is a **non-functional placeholder** — the headless agent cannot complete Atlassian's interactive OAuth 2.1 flow, so the live outbound path is the REST shim in `jira_reactions.py` (see [ADR-015](/sample-autonomous-cloud-coding-agents/architecture/adr-015-jira-integration)). Linear is **deterministic by decision** ([ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth)): there is no Linear MCP entry — it was removed after it proved non-functional, and `strip_linear_mcp_servers()` scrubs any Linear MCP a repo commits to `.mcp.json` before the SDK loads it. When a real MCP tool *is* wired, its entry carries a credential the container holds for the whole task (e.g. a `Bearer ${...}` header), resolved by a per-integration `resolve_<integration>_token()` in `config.py`. This pattern — for any tool ABCA does adopt — has four structural costs:

1. **The tool credential lives in the container.** Every MCP entry injects a bearer token into the agent's environment. The token is in the blast radius of any prompt-injection or dependency compromise for the whole task. [ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth) is unifying the *resolution* of these tokens, but not the fact that the resolved token still lands in the container for MCP.

2. **Tool wiring is bespoke per server.** Adding a tool means editing `channel_mcp.py`, adding a `CHANNEL_MCP_BUILDERS` entry, threading a credential resolver, and redeploying. There is no declarative "add a tool" path for an operator.

3. **Every tool is a separate client connection.** The agent connects to each MCP server directly. There is no single catalog, no shared session management, and no place to do semantic tool selection as the tool count grows — the prompt carries the full `tools/list` of every server.

4. **Tool access is not substrate-portable by construction.** The `.mcp.json` + env-var pattern happens to work on both AgentCore microVM and ECS/Fargate because it is just files and environment, but nothing *guarantees* portability, and the credential path (Secrets Manager fetch) is re-solved per integration.

**Amazon Bedrock AgentCore Gateway is a fully managed service that addresses all four.** Gateway converts APIs, Lambda functions, Smithy models, OpenAPI specs, and remote MCP servers into MCP-compatible tools; aggregates multiple such **targets** behind **one virtual MCP server** (a single consolidated `tools/list`); and manages **both** inbound authentication (agent → gateway) and outbound authentication (gateway → target) as a managed concern. It is serverless and observable, supports **MCP session reuse** and **semantic tool search**, and — critically for ABCA — its inbound authorizer can be **AWS IAM (SigV4)** or a **CUSTOM_JWT** token, both of which are portable across compute substrates.

**This is the tool-plane complement to [ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth).** ADR-016 unifies *who is the principal* (inbound) and *how do we resolve an outbound credential* (the `resolve_<integration>_token()` seam) with AgentCore Identity as one backend. This ADR decides *where the agent's tools live and how it reaches them*: behind a single managed Gateway endpoint whose outbound leg is built **on** AgentCore Identity's credential providers — so the same vault ADR-016 adopts holds the tool credential, and it is injected gateway → target and **never enters the container**.

**A spike has already de-risked the mechanism.** The reference branch `feat/agentcore-gateway-mcp` (on the upstream remote; findings in `docs/design/AGENTCORE_GATEWAY_MCP_SPIKE.md`, F0–F16) took Gateway end-to-end against a hosted MCP server and reached a working federated endpoint — **verdict GO**, live-proven and torn down. That spike is Linear-coupled and, per [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641), **a reference for the mechanism, not a base** — this ADR does not continue off it. It reuses the proven *mechanism* — per-workspace provisioning shape, M2M inbound token minting, the CDK role/grant pattern, the registry → `.mcp.json` plumbing — while structuring it around a **provider-agnostic** target + config model rather than Linear-specific code, so tools onboard without new platform code. The originating issue is [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641).

**Near-term scope: lead with the simplest, most common target type — not the hardest.** [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) is explicit that OAuth is *one option among several* and that most targets ABCA would add never touch it; the prior spike's mistake was exercising only a single 3LO-OAuth MCP-server target. So P1 onboards a **Lambda tool target** — outbound auth is the gateway execution role (IAM), **no stored credential and no consent flow at all** — which proves the end-to-end path (provisioning, substrate-portable inbound, aggregation, agent routing) on the *easiest* outbound leg. Simpler-and-common target types (IAM-signed HTTP/OpenAPI, API-key) follow; the demanding 3LO-OAuth remote-MCP path is exercised **last**, once the general model is proven, not first.

Linear and Jira MCP are **explicitly not in near-term scope.** Linear is deterministic by decision ([ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth)) and stays that way — this ADR does not re-introduce an agent-side Linear MCP. Jira's live path is the REST shim ([ADR-015](/sample-autonomous-cloud-coding-agents/architecture/adr-015-jira-integration)); whether a gateway that owns the OAuth flow could *unbreak* the non-functional Jira MCP placeholder is recorded below as a **speculative later experiment**, explicitly not part of the deterministic reaction/orchestration paths.

> **Not to be confused with the input gateway.** [`INPUT_GATEWAY.md`](/sample-autonomous-cloud-coding-agents/architecture/input-gateway) describes ABCA's *inbound channel normalization* — turning CLI / Slack / webhook payloads into one internal message format on the way **in**. AgentCore Gateway here is the opposite direction: aggregating *outbound tool calls* the agent makes **out**. They share the word "gateway" and nothing else.

## Decision

Adopt **AgentCore Gateway as the single, managed entry point through which the agent reaches its tools**, regardless of compute substrate, with a **provider-agnostic target + config model** rather than per-server code.

Four sub-decisions:

### 1. Gateway is the tool plane; the agent connects once

The agent connects to **one** gateway MCP endpoint instead of N direct MCP servers. `channel_mcp.py` becomes a thin writer that points `.mcp.json` at the gateway URL (carried in `channel_metadata`, stamped by the orchestrator from the registry) and authenticates to the gateway — not to each tool. Targets are aggregated behind the gateway's single `tools/list`, namespaced `<targetName>___<tool>`. When no gateway is configured for a workspace, `channel_mcp.py` falls back to the existing direct-MCP path unchanged (additive, no cutover).

### 2. Inbound auth is substrate-portable; IAM SigV4 is the default

The inbound authorizer (agent → gateway) must work on **both** AgentCore microVM and ECS/Fargate. Two portable options, in preference order:

| Inbound authorizer | How the agent presents it | When |
|---|---|---|
| **AWS IAM (SigV4)** | The task role signs the request. No token minting, no OIDC setup. | **Default.** Simplest, portable, no extra infrastructure. |
| **CUSTOM_JWT** | The agent mints a Cognito **machine-to-machine** (`client_credentials`) bearer from a secret and presents it. | Required only when a target uses **3LO OAuth** outbound (AgentCore rejects `AWS_IAM` inbound for a 3LO target — it binds consent to a user identity). |

Both are portable: SigV4 is a task-role signature; the M2M JWT is minted from a Secrets Manager secret (`gateway_auth.py`), **not** an AgentCore-runtime-only workload-identity primitive. The required grant (`bedrock-agentcore:InvokeGateway` for SigV4, secret read for JWT) is added to whichever substrate's task role lacks it. This reuses ADR-016's inbound OIDC-descriptor seam: the gateway's `customJWTAuthorizer` is one more consumer of the same Cognito discovery URL + `allowedClients` shape.

### 3. Outbound auth branches by target type; OAuth is one option among several

The outbound credential (gateway → target) is a property of the **target**, not the platform. OAuth — and the interactive 3LO consent dance the spike documented — is **one option among several**, relevant only when a specific target demands it. Most targets ABCA would add never touch OAuth:

| Target type | Outbound credential | Onboarding cost |
|---|---|---|
| Lambda, Smithy | Gateway **execution role** (IAM) | None — no credential at all. |
| OpenAPI / HTTP, IAM-signed | **IAM SigV4** (gateway role) | None — no stored secret. |
| any, API key | **API-key credential provider** (vaulted once) | Vault the key once; no consent. |
| remote MCP / OpenAPI, OAuth 2LO | **OAuth client-credentials** provider | Gateway manages refresh; no interactive consent. |
| remote MCP, OAuth 3LO | **OAuth authorization-code** provider | One-time admin consent + provider-callback registration + `CompleteResourceTokenAuth` finalizer. |

Every credential path — even a static API key — is vaulted through **AgentCore Identity** (a `providerArn`, never a raw inline key), so the credential is injected gateway → target and never reaches the container. This is the tool-credential realization of ADR-016's outbound seam.

The **P1 exemplar is a Lambda target** — the top row: outbound auth is the gateway execution role, **no credential at all**. That deliberately exercises the *simplest* outbound leg first, so P1 proves the end-to-end path (provisioning, inbound auth, aggregation, agent routing) without the 3LO consent dance. The bottom row — **OAuth authorization-code** (per-workspace consent, callback registration, `CompleteResourceTokenAuth`) — is the most demanding path; the spike proved it works (F0–F16), but it is exercised **last**, not first.

### 4. Targets are declared in the registry, provisioned idempotently

A per-workspace (or per-deployment) **registry row** holds the gateway id/url plus, **per target**, its type, endpoint, inbound-authorizer type, and outbound-credential type — so a tool onboards declaratively, without bespoke code or a redeploy. This is the tool-target instance of the central asset registry ([#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246) / PR [#548](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/548))'s **MCP-server asset kind**; this ADR does not define a second registry. Provisioning is CLI-driven (`bgagent gateway …`), idempotent (re-running `add-target` updates in place; a stuck `*_PENDING_AUTH` target is detected and resumed/cleaned up), and preflight-validated before any AWS write.

### Why Gateway, not a hand-rolled aggregator

- **Managed, not built.** Protocol translation (REST/Lambda/Smithy ↔ MCP), credential injection, session reuse, and semantic search are the service's job. ABCA writes provisioning + a config seam, not an MCP multiplexer.
- **Credential out of the container.** The single largest security win: the tool credential lives in AgentCore Identity's vault, injected gateway → target. ADR-016 moves credential *resolution* into the vault; this ADR keeps the *tool* credential from ever landing in the agent's environment.
- **Consistent with ADR-016.** Gateway's outbound leg **is** AgentCore Identity credential providers; its inbound leg **is** the OIDC descriptor / SigV4 path ADR-016 already names. This ADR is the tool-plane consumer of both seams, not a parallel credential plane.
- **Substrate-agnostic by construction.** SigV4 / JWT inbound are portable primitives, satisfying the hard requirement that tool access work identically on microVM and ECS/Fargate.

## Consequences

- (+) **One tool endpoint, one catalog.** The agent connects once; targets aggregate behind a single `tools/list`. Semantic tool search becomes available as the catalog grows, keeping the prompt small.
- (+) **Tool credential never enters the container.** Injected gateway → target from the AgentCore Identity vault; the prompt-injection / dependency blast radius no longer includes tool tokens.
- (+) **Declarative tool onboarding.** Adding a tool is a registry row + one CLI command, not a `channel_mcp.py` edit + redeploy. Onboarding friction scales with the target's auth type, not with platform code.
- (+) **Substrate-portable by construction.** SigV4 (default) and M2M JWT inbound both work on microVM and ECS/Fargate; the requirement is met by the primitive choice, not by luck.
- (+) **Managed session reuse and observability.** MCP `Mcp-Session-Id` reuse (`sessionConfiguration`, default 3600s) avoids per-call re-initialization and AgentCore Runtime cold starts; auditing is built in.
- (−) **A managed dependency and per-call overhead.** Gateway adds one network hop + inbound-auth verification + protocol translation per call — roughly constant, small relative to real tool work, but not free for very fast tools. AWS publishes no fixed latency figure ("latency is largely determined by the underlying tools"); the "direct vs. gateway" delta must be **measured**, not assumed (see Testing).
- (−) **Vault fetch cost.** Outbound credential fetches (`GetResourceOauth2Token` / `GetResourceApiKey`) bill at `$0.010/1,000`, same line item ADR-016 already accepts.
- (−) **Provisioning surface to maintain.** Per-workspace gateway + credential-provider + target lifecycle (create, sync, cleanup, `*_PENDING_AUTH` recovery) is new operational surface, mitigated by CLI idempotency and preflight validation.
- (!) **1-click integration templates are Console-only.** AWS does not expose the Slack/Jira/Asana/Zendesk/Salesforce provider templates via API/CLI. `bgagent gateway` must print a console deep-link + `register-existing`, not pretend to provision them. The generic types (Lambda/OpenAPI/Smithy/MCP-server) **are** fully CLI-scriptable.
- (!) **Only 3LO OAuth needs the consent dance.** The spike's per-provider callback UUID registration, browser consent, and `CompleteResourceTokenAuth` finalizer apply **only** to authorization-code targets. The UX must not make API-key / IAM / 2LO targets pay that cost — the spike conflated them because it only did 3LO.
- (!) **aws-cli ≥ 2.35 for 3LO fields.** Older control-plane models silently omit `grantType` and default to client-credentials, producing a misleading `400` that reads as a capability limit (the spike's retracted NO-GO). Preflight must gate on CLI/SDK version for the 3LO path.

## Testing

Acceptance leads with the **simplest target type first** — a Lambda tool with no outbound credential — then broadens across the target × auth matrix, with the demanding 3LO-OAuth remote-MCP path exercised last. This is the inverse of the prior spike, which only ever ran a single 3LO-OAuth target.

**Near-term (P1–P2), on `backgroundagent-dev`:**

- **Lambda tool behind the gateway** — a task reaches a gateway Lambda target's tools; `tools/list` returns them namespaced; a tool call succeeds via the gateway execution role, with **no credential in the container env**.
- **Fallback intact** — a workspace with no gateway configured still writes the direct `.mcp.json` path unchanged (and Linear stays stripped / Jira stays a placeholder — no behavior change).
- **Substrate parity** — both run on **AgentCore microVM and ECS/Fargate**; the inbound credential (SigV4 or minted JWT) is accepted on each, and a wrong/expired credential is rejected.
- **Session reuse + failure modes** — `Mcp-Session-Id` reused across calls; target down / credential invalid / gateway unreachable → the agent surfaces the error and does not hang.
- **Latency capture** — cold `initialize` + `tools/list`; warm `tools/call` with vs. without session reuse; the **same tool through the gateway vs. called directly** (the delta that matters for adoption). Record p50/p90.

**Later (P3–P4), as the general target model lands** — a target × auth matrix so each onboarding branch is exercised once: OpenAPI or API Gateway / API-key; OpenAPI or HTTP / IAM-SigV4; MCP or OpenAPI / no-auth; remote MCP / OAuth 2LO; and finally remote MCP / OAuth 3LO (the hardest path, the spike's territory); plus aggregation (≥2 target types → one `tools/list`) and semantic tool search.

## Phasing

Implementation lands as **multiple PRs** after this ADR:

| Phase | Action | Gate |
|---|---|---|
| P0 (this ADR) | Record the decision: Gateway as the tool plane, its substrate-portable auth model, and the provider-agnostic target config. | This document. |
| P1 | **Lambda tool behind the gateway.** Reuse the spike mechanism, generalized off Linear-specific code: context-gated CDK gateway + service role + M2M substrate; CLI provisioning; `channel_mcp.py` routes to the gateway URL (from `channel_metadata`) with the direct-path fallback intact. Outbound = execution role, **no credential**. | Green on microVM; default synth byte-unchanged; direct fallback unchanged. |
| P2 | **Substrate parity + a credentialed target.** IAM-SigV4 / JWT inbound proven on **both** microVM and ECS/Fargate; add one credentialed simple target (IAM-signed HTTP/OpenAPI or API-key vaulted via AgentCore Identity). | Both substrates pass; credential never enters the container. |
| P3 | **Generalize to N targets.** Provider-agnostic target + config model keyed off the registry ([#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246)); `bgagent gateway add-target/list-targets/sync/remove-target`; remaining simpler target types (Smithy, no-auth, OAuth 2LO). | Onboarding branches green; idempotent re-run. |
| P4 | **Hardening, search, and the hard auth path.** Semantic tool search evaluation; lifecycle + cleanup + `*_PENDING_AUTH` recovery; aggregation of ≥2 target types behind one gateway; the 3LO-OAuth remote-MCP path (the spike's territory). *Speculative experiment, separately gated:* whether a gateway that owns the OAuth flow can make the non-functional Jira MCP placeholder reachable — explicitly **not** re-introducing agent-side Linear/Jira MCP into the deterministic reaction/orchestration paths ([ADR-015](/sample-autonomous-cloud-coding-agents/architecture/adr-015-jira-integration), [ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth)). | As needed by tool count / ops; Jira-MCP experiment records reachable-or-not. |

## Out of scope (this ADR)

- **The provisioning, CLI, and agent-routing code.** This ADR records the decision; the code is the P1–P4 follow-up PRs on [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641).
- **The registry schema and storage.** Owned by [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246) / PR [#548](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/548); this ADR consumes its MCP-server asset kind, it does not define a second registry.
- **Inbound principal verification and outbound credential resolution.** Owned by [ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth); this ADR is the tool-plane consumer of both seams.
- **The Linear/Jira deterministic reaction paths.** `linear_reactions.py` / `jira_reactions.py` stay as-is and authoritative. This ADR does **not** re-introduce an agent-side Linear or Jira MCP: Linear stays deterministic ([ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth), enforced by `strip_linear_mcp_servers()`), and Jira's live path stays the REST shim ([ADR-015](/sample-autonomous-cloud-coding-agents/architecture/adr-015-jira-integration)). The speculative Jira-MCP-via-gateway experiment (P4) is gated separately and touches neither path.

## References

- Issue [#641](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/641) — the feature this ADR records (AgentCore Gateway tool federation)
- Issue [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246) / PR [#548](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/548) — central agent asset registry (the MCP-server asset kind this ADR's targets are an instance of)
- [ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth) — pluggable identity and auth (the credential-plane seams this ADR consumes)
- [ADR-015](/sample-autonomous-cloud-coding-agents/architecture/adr-015-jira-integration) — Jira integration (the REST-shim precedent for a non-functional MCP placeholder)
- `docs/design/AGENTCORE_GATEWAY_MCP_SPIKE.md` (reference branch `feat/agentcore-gateway-mcp`) — the GO spike, findings F0–F16, and the provisioning recipe + gotchas
- [`INPUT_GATEWAY.md`](/sample-autonomous-cloud-coding-agents/architecture/input-gateway) — the *inbound channel* gateway, distinct from AgentCore Gateway
- AgentCore Gateway — [AWS Bedrock AgentCore developer guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html) and the [gateway target / outbound-auth references](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html) for target types, the inbound/outbound auth matrix, and session configuration
- [aal80/agentcore-samples](https://github.com/aal80/agentcore-samples) (owner @antonaws) — reference samples: `gateway-basics` (Lambda targets), `gateway-with-inbound-jwt` (Cognito client_credentials inbound), `identity-machine-to-machine-jwt` (M2M vault mediation), `gateway-with-policies` / `gateway-with-open-policy-agent` (hardening)
