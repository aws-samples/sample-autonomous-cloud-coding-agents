---
title: Adr 016 pluggable identity and auth
---

# ADR-016: Pluggable identity and authentication

> Number: candidate ADR-016 (next free on main; ADR-015 is claimed by open PR [#302](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/302), the Jira integration). Numbers are never reused. If a lower number frees before merge, renumber and coordinate with PR #302 and the [#277](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/277) ADR-014 governance discussion.

**Status:** proposed
**Date:** 2026-06-11 (revised 2026-07-21)

> **2026-07-21 revision.** The outbound design was restructured to separate **execution semantics** (deterministic REST/GraphQL from Lambda) from **credential transport** (AgentCore Identity vault), and to make **MCP a first-class control plane** (registration + Gateway execution, fail-closed, no direct fallback) rather than a per-vendor transport toggle. Introduces three credential types (`ChannelCredential`, `McpCredential`, `McpRegistration`). This **rejects** the earlier two-flag (`lifecycleViaGateway`/`gatewayOAuthOk`) "derived transport" framing and the Linear Hybrid/two-app framing. **Further (later 2026-07-21, after live validation):** Linear MCP via Gateway was proven non-functional on one OAuth app (`actor=user` reads error; `actor=app` can't consent on an installed app), so **Linear MCP is removed entirely** — Linear becomes 100% deterministic on the one `@bgagent` `ChannelCredential`, and the Gateway is kept as the general MCP control plane for *other* registered servers only. See *Linear is fully deterministic* below. Rationale grounding: Engram observation #140 (not re-fetchable in the authoring session; the reviewing session should cross-check this revision against it).

## Context

ABCA propagates *who* as data but not as an enforceable credential. Issue [#245](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/245) threads the user identity through traces and logs (`cognito+<sub>`), so attribution is correct. The same identity does not yet gate a token. Two costs follow from that gap:

1. **Inbound identity is hardwired.** CLI and REST callers authenticate to an Amazon Cognito User Pool; webhooks (GitHub, Linear, now Jira) authenticate with HMAC-SHA256 shared secrets in Secrets Manager. Both verification paths are baked into handler code. An operator who runs their own Okta, Microsoft Entra, or Keycloak cannot swap the inbound provider without editing handlers.

2. **Outbound auth is N hand-rolled resolvers.** Each integration re-implements credential fetch, refresh, and refresh-race handling against Secrets Manager.

   - `resolve_github_token()` (`agent/src/config.py`): one shared PAT for all repos and users. No per-user or per-repo scoping.
   - `resolve_linear_api_token()` (`agent/src/config.py`) + `cdk/src/handlers/shared/linear-oauth-resolver.ts`: per-workspace OAuth token. Manual refresh inside 60s of expiry, one-shot rotation-race handling.
   - the Jira resolver added in PR [#302](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/302) (`cdk/src/handlers/shared/jira-oauth-resolver.ts`): the same per-tenant 3LO + Secrets Manager pattern, a second instance.

   A second provider arriving through the same `resolve_<integration>_token()` shape is live evidence the seam already exists; it just is not named or unified.

**The AgentCore path already exists but is dormant.** ABCA runs on AgentCore Runtime, and the Workload Access Token (WAT) propagation path is already wired:

- the orchestrator sets `runtimeUserId` on `InvokeAgentRuntimeCommand` (`agentcore-strategy.ts:56`);
- the dispatcher holds `InvokeAgentRuntimeForUser` (`task-orchestrator.ts:288-289`);
- the agent reads the `WorkloadAccessToken` header and re-injects it across the pipeline thread (`server.py:283-310, 387-413`).

`bedrock-agentcore` stays in `agent/pyproject.toml` as vestigial. The Phase-2.0a AgentCore Identity attempt parked on a USER_FEDERATION service-side bug, so Phase-2.0b reads Secrets Manager directly. The platform side has since moved: AgentCore Identity GA'd 2025-10-13 and the OBO (`ON_BEHALF_OF_TOKEN_EXCHANGE`) flow GA'd April 2026 across 14 regions. This ADR records the decision to resume that path rather than build a credential plane from scratch. The RFC behind it is issue [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249).

> **Phase 0 re-validation, executed 2026-06-14 (`us-east-1`): GO-LIKELY.** A throwaway spike confirmed the parked USER_FEDERATION bug does not reproduce in the current service build. The PAR (`request_uri`, RFC 9126) parameter that was the prime no-go suspect stays on AgentCore's own front-channel; AgentCore then redirects to the downstream provider with plain authorization-code + PKCE, so no `request_uri` reaches the provider. The production-shape JWT binding (`get_workload_access_token_for_jwt` on the IdP's `(iss, sub)`) and the substrate-independent path (vault calls from a non-Runtime boto3 context) both passed. The one step left for a full GO is a human OAuth-consent click, which cannot run headless. The recorded result is on [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249); it is what reopens Phase 1.

## Decision

Introduce a **pluggable identity-and-auth abstraction with two seams**: one for inbound principal verification, one for outbound credential resolution. The verification provider and the token backend each become swappable behind a contract, with AgentCore Identity as one implementation rather than the only path.

Four sub-decisions — one inbound, three outbound (execution semantics, deterministic-credential source, and the MCP control plane, kept deliberately separate):

1. **Inbound: an OIDC-descriptor seam.** Abstract "who is the inbound principal and how is it verified" into a descriptor so Cognito can be swapped for Okta, Microsoft Entra, Keycloak, or any OIDC provider without handler changes. The descriptor maps to a CUSTOM_JWT-style authorizer shape: a `discoveryUrl` (must end `/.well-known/openid-configuration`) plus `allowedAudience` / `allowedClients` / `customClaims` gates that all must pass. AgentCore Runtime's `customJWTAuthorizer` is **one** implementation behind the seam; ABCA's own Cognito authorizer plus the SigV4 user-header path (`X-Amzn-Bedrock-AgentCore-Runtime-User-Id`) is another. Adapters: Cognito (shipped), Okta, Entra, Keycloak.

   | Adapter | Discovery | Notes |
   |---|---|---|
   | Cognito | User Pool `/.well-known/openid-configuration` | Shipped today; the SigV4 path carries the user id as a header. |
   | Okta | Org or custom-auth-server discovery URL | Standard OIDC; `allowedClients` gates the app. |
   | Entra | v2 tenant discovery URL | Issue **plain** JWTs — Entra emits *encrypted* access tokens when an app registration has confidential optional claims, and the JWT authorizer cannot decrypt them (fails silently). Use v2 + a custom exposed-API scope, or v1 + `<application-id>/.default`. |
   | Keycloak | Realm discovery URL | Private-IdP reachable via a private endpoint where the realm is not internet-facing. |

2. **Separate execution semantics from credential transport.** Two questions that earlier drafts conflated must stay separate: *how an operation executes* (a deterministic REST/GraphQL call the platform must make reliably, vs. an LLM-driven MCP tool call) and *where its credential comes from* (the vault). The execution semantics are fixed by the operation's reliability requirement, not by the credential backend.

   - **Deterministic Linear operations remain direct GraphQL calls from Lambda.** The whole exactly-once, idempotent, structural surface — the iteration threaded-reply + epic status block, reactions (👀→✅/❌), state transitions, the #247 sub-issue DAG, the #299 decompose write-back — stays as direct `api.linear.app/graphql` calls in the Lambda tier. **We do NOT move these into MCP and we do NOT build a custom Linear MCP facade.** MCP is best-effort and LLM-driven; the platform UX cannot depend on it. Only the *credential source* under these calls changes (SM → vault); the call sites, GraphQL documents, and Lambda ownership do not.

3. **Lambda credentials come from AgentCore Identity — one shared channel workload identity, keyed per workspace.** The deterministic Lambda calls above resolve their token from the vault, not Secrets Manager.

   - **One shared workload identity `abca-linear-channel`** serves all Lambda consumers. The **six Lambda IAM roles do NOT each need their own workload identity** — they are distinct IAM principals that are all granted access to the same credential domain. (Correcting an earlier draft: per-role workload identities were never required.)
   - **The credential is keyed by `linear-workspace:<workspace_id>`** — a workspace-scoped platform credential, not a per-user one. This is the `user_id` component of the vault's `(workload_identity, user_id)` key, repurposed as a workspace subject. The triggering **user identity is retained only for audit attribution** (#245's `cognito+<sub>` in traces/logs), **not** for credential selection on the deterministic path.
   - **Multiple Lambda IAM roles may read that one credential domain** — IAM `Resource` scoping on `GetResourceOauth2Token` grants each of the six roles access to the `abca-linear-channel` workload identity + the Linear credential provider. They resolve the *same* workspace-keyed credential; there is no per-role consent. **Correcting an earlier draft:** the mechanism is *N IAM roles → 1 workload identity → 1 vault entry* (per `(abca-linear-channel, linear-workspace:<id>)`), **not** "multiple *workload identities* share one vault entry." Distinct workload identities key distinct vault entries; sharing comes from many IAM principals presenting the *same* workload identity, not from cross-workload-identity vault sharing.
   - **Secrets Manager refresh/write-back retires eventually.** Once the vault owns the token + refresh, the `PutSecretValue` grants on the five Lambda roles and the `tryRefreshOnce` write-back in `linear-oauth-resolver.ts` are removed. This is phased (SM fallback stays until the vault path is green), not a big-bang cutover.

   This is the **`ChannelCredential`** type (see *Credential types* below): a platform/workspace credential for deterministic vendor APIs. Linear's `ChannelCredential` keeps ABCA's existing `actor=app` OAuth application — that app-actor token is what the Lambda GraphQL calls already use, and it is exactly what belongs on the deterministic path.

   **Deterministic consumer inventory (verified 2026-07-21, file:line-exact) — the migration surface for the `ChannelCredential`:**

   | Plane | Where | Uses | Linear operations (all direct GraphQL) |
   |---|---|---|---|
   | **Lambda tier** ⭐ | `cdk/src/handlers/**` — 6 deployed functions (WebhookProcessor, Orchestrator, Reconciler, FanOut, Sweep, GitHub-screenshot), each its own IAM role; 7 direct `resolveLinearOauthToken` sites + a `resolveToken()` wrapper fanning to 13 feedback fns | `abca-linear-channel` WI, keyed `linear-workspace:<id>`; 5 of 6 hold `PutSecretValue` **today** (retires) | iteration-UX + orchestration: `CreateComment`/`UpdateComment`/`DeleteComment`/`ReplyToComment`/`upsertThreadedReply`, `ReactIssue`/`ReactComment`/`UnreactIssue`/swaps, `SetIssueState`/revert (`linear-feedback.ts`); `CreateSubIssue`/`CreateBlockingRelation`/`ParentState` (`orchestration-decomposition-writeback.ts`); `SubIssueGraph`/`IssueParent` (`linear-subissue-fetch.ts`); `IssueByIdentifier` (`linear-issue-lookup.ts`); `IssueContext`; `IssueText` |
   | **Agent container** | `agent/src/**` | runtime WI; WAT injected by Runtime SLR | reactions + forward-only status transitions (`linear_reactions.py`) — same `ChannelCredential` domain, resolved via the Runtime `WorkloadAccessToken` header |

   The same shape holds for **Jira** (`jira-oauth-resolver.ts`, 5 Lambda sites + `jira-feedback.ts`; agent `jira_reactions.py`) and a Lambda-only shape for **Slack** (`slack-notify.ts`, no agent token). The `ChannelCredential` domain is per-`(surface, workspace)`; the workload identity is shared per surface (`abca-<surface>-channel`).

4. **MCP is a separate, first-class control plane — every registered MCP executes through AgentCore Gateway.** MCP tool-use is not a per-surface transport toggle; it is its own registration + execution plane, independent of the deterministic credential above.

   - **Users/workspaces register MCP servers and bind their tools to agents/workflows.** Registration is explicit and first-class, not derived from vendor capability flags.
   - **Every registered MCP executes through AgentCore Gateway. There is NO direct-MCP fallback** — the agent never writes a `.mcp.json` pointing straight at a vendor MCP. If a registered MCP cannot be fronted by the Gateway, it is unavailable, full stop.
   - **Unsupported authentication fails closed.** If the Gateway cannot obtain a working credential for a registered MCP (e.g. the vendor's OAuth can't satisfy the Gateway's flow), that MCP does not load — it is not silently routed direct and not degraded to a weaker mode.

   This plane is described by the **`McpRegistration`** and **`McpCredential`** types (see *Credential types* below).

   > **Rejected: the capability-flag transport model.** An earlier draft derived a per-surface transport (`Identity-direct` / `Gateway-fronted` / `Hybrid`) from two coarse flags (`lifecycleViaGateway`, `gatewayOAuthOk`). That framing is **rejected**: it conflated execution semantics with credential transport, treated MCP as a fallback rather than a control plane, and is not a sufficient abstraction (two boolean flags cannot capture per-tool bindings, per-user grants, or fail-closed auth). Deterministic ops are always direct-GraphQL-from-Lambda (§2); MCP is always Gateway (§4). There is no "hybrid transport" toggle.

### Why a seam, not a rewrite

The abstraction is intentionally a contract, not a forklift of credential handling onto AgentCore:

- **Backend-agnostic.** One `resolve_<integration>_token()` contract serves both the AgentCore Runtime backend (token arrives via the `WorkloadAccessToken` header) and the parked ECS backend (in-process boto3). The backend decides how the token arrives; the seam does not care.
- **Incremental.** The rollout is phased and flag-gated, and the shared PAT fallback stays until the vault path is green. No big-bang cutover.
- **Consistent with ADR-014.** This is the credential-plane analog of [ADR-014](/sample-autonomous-cloud-coding-agents/architecture/adr-014-workflow-driven-tasks)'s provider-neutral `VcsProvider` seam: that one named GitHub-specific control-plane operations as instances of generic concepts; this one names the per-integration credential resolvers as instances of one outbound contract.

## Credential types

Three distinct types, deliberately not collapsed into one "token":

- **`ChannelCredential`** — a **platform/workspace** credential for the **deterministic** vendor APIs (§2, §3). Subject = `linear-workspace:<workspace_id>` (workspace-scoped, not per-user). Backed by AgentCore Identity under the `abca-<surface>-channel` shared workload identity. This is what the Lambda tier + the agent's `linear_reactions.py` use for direct GraphQL. For Linear it wraps ABCA's existing `actor=app` OAuth application.
- **`McpCredential`** — a **user/workspace** grant for **Gateway tools** (§4). This is the credential the Gateway presents outbound to a registered MCP server. Preferred subject is per-user so tool-use is attributable to the triggering user; workspace-scoped is a fallback where per-user is not meaningful. (Not used for Linear — Linear has no MCP leg; see *Linear is fully deterministic* below.)
- **`McpRegistration`** — the registration record for a Gateway-fronted MCP: `endpoint`, exposed `tools`, `scopes`, the credential `subject` (which `McpCredential` binds), and the `agent`/`workflow` bindings that say which agents may use which tools.

`ChannelCredential` and `McpCredential` are **separate credentials even for the same vendor** — different subjects (workspace vs user), different consumers (Lambda GraphQL vs Gateway), different lifecycles. They are not two views of one token.

## Linear is fully deterministic — no Linear MCP (decided 2026-07-21)

The Gateway remains ABCA's general MCP control plane (§4) for any MCP server a user/workspace registers. **Linear specifically is removed from the MCP path entirely** and done **100% deterministically** on the one `@bgagent` `ChannelCredential`.

**Why (live-validated 2026-07-21):** Linear MCP through the Gateway does not work on one OAuth app. A fresh `actor=user` Gateway target reached `READY` but **every data read failed** ("An internal error occurred" — `get_issue`/`list_issues`/`list_documents`, retried); an `actor=app` Gateway target **cannot even consent** (Linear's "already installed" dead-ends the authorization-code flow for an installed app). With a second Linear app rejected (identity fragmentation — the agent must present one Linear face, `@bgagent`), there is no viable Linear-MCP-via-Gateway path. Rather than carry an optional-but-broken leg, **retire Linear MCP.**

**What replaces the 9 `mcp__linear-server__*` tools** — nothing is lost; each collapses to a deterministic home:

| Removed MCP tool | Deterministic replacement |
|---|---|
| `save_comment`, `save_issue`, `list_issue_statuses` | Already deterministic in the Lambda tier (`linear-feedback.ts`: comment create/update, `SetIssueState`, `IssueTeamStates`). The agent's MCP writes were redundant best-effort — dropped; Lambda owns writes. |
| `get_issue`, `list_comments`, `list_documents` | Pre-hydrated at task-creation (extend #176 `context-hydration.ts` with Linear issue text/comments; Lambda already fetches `IssueText`/`IssueContext`). Agent receives context in-payload, no live MCP. |
| `get_attachment`, `extract_images`, `get_document` | Authenticated fetch on the `ChannelCredential` path — extend #176 `resolve-url-attachments.ts` to attach the `@bgagent` bearer for `uploads.linear.app` URLs (which #176 skips today precisely because its resolver is unauthenticated). One app, one identity, screened like every other attachment. |

**Consequences of removing Linear MCP:** remove `_build_linear_entry`/`_linear_server_entry` + the `"linear"` entry in `CHANNEL_MCP_BUILDERS` (`agent/src/channel_mcp.py`); strip the `mcp__linear-server__*` guidance from `prompt_builder.py`; the agent no longer needs any Linear token for MCP (the per-thread `LINEAR_API_TOKEN` for MCP retires — `linear_reactions.py`'s direct GraphQL keeps its own `ChannelCredential`). The Gateway substrate (`bgagent-linear-gw-*`, the M2M inbound, `gateway_auth.py`) is **not** wired for Linear; it stays available for the general MCP control plane.

**Rejected (corrections to earlier drafts):**
- **No Linear MCP at all** (supersedes the earlier "optional Linear MCP via `actor=user` Gateway grant" — that path is live-proven non-functional on one app).
- **No two Linear OAuth apps.** One app, `@bgagent`, deterministic.
- **No claim that two `actor=app` authorization-code prompts can coexist** — Linear's docs are explicit that non-`client_credentials` app tokens cannot exist in parallel; moot now that Linear has no MCP leg needing a second grant.
- The **general MCP Gateway control plane (§4) stands** — this decision is Linear-specific, not a retreat from Gateway-fronted MCP for other registered servers.

## Identity propagation for per-user MCP is UNRESOLVED

Per-user `McpCredential` selection requires the Gateway to know *which task-user* is invoking — and that is not yet solved:

- **Today the Gateway inbound auth uses an M2M JWT** (a Cognito client-credentials token the agent mints). An M2M token identifies the *workload*, not a user.
- **An M2M inbound JWT cannot select a per-user vaulted MCP credential** — there is no task-user subject in it for the vault to key on. So per-user MCP is not achievable on the current inbound path.
- **Before claiming per-user MCP support, this ADR requires a specified, trusted task-user identity propagation** from the triggering event → the agent → the Gateway inbound (e.g. a user-scoped JWT or a verified user-id claim the Gateway authorizer trusts). Until that is designed and validated, `McpCredential` is workspace-scoped at best, and per-user MCP tool attribution is out of reach. This is an explicit open item, not an assumed capability.

## Consequences

- (+) **One credential abstraction, not N resolvers.** New integrations register an adapter against one contract instead of re-implementing fetch + refresh + race handling per provider.
- (+) **Execution semantics and credential transport are separate axes.** Deterministic ops are always direct-GraphQL-from-Lambda; MCP is always Gateway. There is no per-vendor "transport mode" to special-case — the split is fixed by an operation's reliability requirement, not by the vendor. (Supersedes the rejected two-flag `lifecycleViaGateway`/`gatewayOAuthOk` derivation.)
- (+) **Three explicit credential types, not one token.** `ChannelCredential` (workspace-scoped, deterministic APIs), `McpCredential` (user-scoped, Gateway tools), `McpRegistration` (endpoint + tool/workflow bindings) keep the deterministic and MCP planes independently reasoned and independently failed-closed.
- (+) **Workspace-scoped `ChannelCredential` replaces the shared PAT / per-workspace SM secret with a vault-managed credential.** Deterministic APIs bind to `linear-workspace:<id>` (not per-user), and the vault owns refresh — retiring the SM refresh/write-back. Per-**user** scoping applies to `McpCredential` only, and is gated on identity propagation (below), not assumed.
- (+) **Cryptographic attribution is available on the MCP/OBO path where per-user identity reaches the Gateway.** OBO delegation carries an `act` claim (`user ← agent`) joinable to #245's `trace_id` / #237's `correlation`. NOTE: on the deterministic `ChannelCredential` path the acting identity is the workspace app-actor, so per-user *credential* attribution there is via #245 logs, not the token; cryptographic per-user attribution requires the unresolved task-user propagation (P5).
- (+) **Operators can bring their own IdP.** The inbound descriptor lets a deployment run on Okta, Entra, or Keycloak without forking handler code.
- (+) **Backend-agnostic.** The same seam serves the AgentCore Runtime and ECS backends, matching the design posture already documented for the SessionRole in [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security).
- (−) **A new abstraction plus an adapter registry to maintain.** Two seams and their adapter sets are added platform surface; mitigated by keeping the inbound descriptor a parameterization of a single verification path (see the risk below) and the outbound contract a thin selector over the existing flows.
- (−) **AgentCore Identity adds a managed dependency and token-vault cost.** Vault fetches (`GetResourceOauth2Token` / `GetResourceApiKey`) bill at `$0.010/1,000`. The ECS in-process resolver path remains available where that dependency is unwanted.
- (!) **Per-user MCP is not yet achievable — task-user identity propagation is unresolved.** The Gateway inbound is an M2M JWT that identifies the workload, not the user, so it cannot select a per-user `McpCredential`. This must be designed + validated (P5) before per-user MCP is claimed; until then MCP credentials are workspace-scoped at best.
- (−) **Linear loses MCP tool-use — replaced by deterministic paths.** The 9 `mcp__linear-server__*` tools retire: writes were already deterministic in Lambda; reads become pre-hydrated context (#176 `context-hydration.ts`) + authenticated attachment fetch (#176 `resolve-url-attachments.ts` + `@bgagent` bearer). Cost: the agent can no longer make *arbitrary* live Linear queries mid-task — it works from pre-hydrated context. Accepted: live-proven that Linear MCP via Gateway doesn't work on one app, and a second app is rejected. The general MCP Gateway control plane (§4) is unaffected — this is Linear-specific.
- (!) **The inbound seam must not become a second auth code path.** A descriptor that grew its own verification logic would drift from the shipped Cognito/HMAC path and create two implementations to keep in sync. That is the exact cedar-parity drift hazard ADR-014 calls out. Mitigation: exactly **one** inbound verification implementation; the descriptor only parameterizes it (discovery URL, audience, client list, claim gates), never reimplements it.

## Phasing

| Phase | Action | Gate |
|---|---|---|
| P0 ✅ | Re-validate `USER_FEDERATION` / OBO post-GA against the live service. | **Done 2026-06-14 (`us-east-1`): GO-LIKELY** — parked PAR bug does not reproduce (see [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)). Full GO pending one human consent click. |
| P1 | **`ChannelCredential` for Linear (deterministic path first).** Move the Lambda tier + agent `linear_reactions.py` off Secrets Manager onto the vault: one `abca-linear-channel` workload identity, credential keyed `linear-workspace:<id>`, the 6 Lambda roles + runtime role granted `GetResourceOauth2Token` on that domain. Deterministic ops stay direct GraphQL — only the token source changes. | Flag-gated; SM fallback retained until green; per-workspace isolation preserved. |
| P2 | **Retire SM refresh/write-back** once P1 is green: drop `PutSecretValue` from the 5 Lambda roles and delete `tryRefreshOnce` write-back in `linear-oauth-resolver.ts`; the vault owns refresh. | No SM writes remain on the Linear path. |
| P3 | **MCP control plane (registration + Gateway execution).** Build `McpRegistration`/`McpCredential`: users/workspaces register MCP servers + bind tools to agents/workflows; every registered MCP runs through the Gateway; unsupported auth fails closed; no direct-MCP fallback. | Registration API + Gateway execution; fail-closed verified. |
| P4 | **Remove Linear MCP; make Linear fully deterministic — mirror the Jira attachment pattern (PR #619).** #619 already solved the identical problem for Jira: because the vendor MCP can't run headlessly, attachments + recent comments are fetched **authenticated at task-admission time in the webhook processor** (`jira-attachments.ts` → `api.atlassian.com/.../attachment/content/{id}` with the 3LO token, refresh-retry on 401/403, magic-bytes + Bedrock-Guardrail screen, S3 upload) and injected via `create-task-core.ts`'s `preScreenedAttachments` seam — **bypassing `confirm-uploads`/Cognito entirely.** Build the Linear analog `linear-attachments.ts`: fetch `uploads.linear.app` + paperclip attachments with the `@bgagent` `ChannelCredential`, screen, inject as `preScreenedAttachments`; pre-hydrate issue text/recent comments (mirroring #619's `fetchRecentHumanComments`). Then delete the `"linear"` MCP builder in `channel_mcp.py` (`_build_linear_entry`/`_linear_server_entry`), rewrite `prompt_builder.py` to drop all `mcp__linear-server__*` guidance (agent works from pre-hydrated context; Lambda owns writes), and retire the per-thread `LINEAR_API_TOKEN` MCP env. **NOTE the `confirm-uploads` Cognito-only limitation (task-api.ts:834, verified) is IRRELEVANT to this path** — #619 proves webhook-sourced attachments don't touch the presigned/`confirm-uploads` flow at all. **Orchestration is NOT at risk (verified):** the #247/#299 sub-issue DAG, the live status panel (`upsertStatusComment`), the maturing threaded reply (`upsertThreadedReply`), reactions, and state transitions are ALL Lambda-tier deterministic GraphQL (`orchestration-reconciler.ts` + `linear-feedback.ts` + `orchestration-decomposition-writeback.ts`) on the `ChannelCredential` — zero MCP dependency, so removing Linear MCP cannot affect them (their only change is token source SM→vault, behavior-preserving with fallback). **One thing removing MCP DOES drop:** in the *default first-run* task mode the agent posts its own "🤖 Starting"/PR-URL courtesy comments via `mcp__linear-server__save_comment`. Those are redundant best-effort choreography (orchestrated/iteration tasks already suppress them because the platform panel owns all narration). To preserve them for first-run tasks, move them to the Lambda tier — `linear-feedback.ts` already has `postIssueComment`; trivial. Not a risk to orchestration; just don't silently drop the first-run comments. | No `linear-server` MCP entry; agent runs from hydrated context; attachments fetched authenticated + screened (Jira #619 pattern); first-run courtesy comments moved to Lambda (or explicitly dropped); orchestration/panel unchanged; tests updated. Requires main merged in (for #619/#176 seams). |
| P5 | **General MCP control plane (registration + Gateway execution)** — NOT Linear. Build `McpRegistration`/`McpCredential`: users/workspaces register arbitrary MCP servers + bind tools to agents/workflows; every registered MCP runs through the Gateway; unsupported auth fails closed; no direct-MCP fallback. | Registration API + Gateway execution; fail-closed verified. |
| P6 | **Trusted task-user identity propagation** (prerequisite for per-user MCP on the general plane, P5): specify + validate a user-scoped inbound identity the Gateway authorizer trusts, replacing the M2M JWT for per-user credential selection. | **Blocks per-user `McpCredential`.** Until done, MCP credentials are workspace-scoped at best. |
| P7 | Jira + Slack `ChannelCredential` (same shape as P1); GitHub `GithubOauth2` behind a flag, retire the shared PAT; OBO `act`-claim delegation feeding #237. | Flag-gated; per-surface. |

**Substrate independence (verified 2026-07-21, both proven live):** the vault path works on any compute. AgentCore Runtime injects the Workload Access Token as the `WorkloadAccessToken` header; ECS/Fargate/Lambda bootstrap it via `GetWorkloadAccessTokenForJWT(workloadName, userToken=<Cognito M2M JWT>)` against a **standalone** (non-service-linked) workload identity, then call `GetResourceOauth2Token`. Runtime-managed (service-linked) workload identities cannot self-vend, so the ECS path needs a manually-created workload identity. The runtime execution role today has `GetWorkloadAccessToken*` but **not** `GetResourceOauth2Token` — P1 adds it (+ `GetSecretValue` on `bedrock-agentcore-identity!*`), mirroring the gateway service role.

## Out of scope (this ADR)

- **The descriptor and resolver implementation code**, and the RFC-249 Phase-0 spike script. This ADR records the decision; the code is follow-up work tracked on #249.
- **Trace and log attribution mechanics.** Owned by #245; this ADR consumes its `user_id` form, it does not define it.
- **Bedrock billing attribution.** Owned by [#215](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/215).

## References

- Issue [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249) — RFC: Identity propagation via AgentCore Identity Token Vault (the RFC this ADR records)
- Issue [#245](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/245) — trace/log attribution (the data half of identity)
- Issue [#215](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/215) — Bedrock billing attribution
- Issue [#237](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/237) — governance planes / `abca.audit.v1` correlation block
- Issue [#288](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/288) / PR [#302](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/302) — Jira integration (second provider through the resolver seam)
- [ADR-014](/sample-autonomous-cloud-coding-agents/architecture/adr-014-workflow-driven-tasks) — workflow-driven tasks; introduced the provider-neutral `VcsProvider` seam this ADR is the credential-plane analog of
- [IDENTITY_AND_AUTH.md](/sample-autonomous-cloud-coding-agents/architecture/identity-and-auth) — the worked use-cases, seams table, decision tree, and Linear before/after
- [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security) — current auth posture, the shared-PAT limitation this ADR resolves
- GitHub issues — per-repo GitHub credentials, layered credential derivation, delegation chain propagation (priority labels `P0`, `P1`, etc.)
- AgentCore Identity, Runtime, and Gateway — the [AWS Bedrock AgentCore developer guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html) and the [CreateOauth2CredentialProvider API reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateOauth2CredentialProvider.html) are the public sources for the flows, the `credentialProviderVendor` enum, and pricing
