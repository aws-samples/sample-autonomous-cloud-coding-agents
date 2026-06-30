# ADR-016: Pluggable identity and authentication

> Number: candidate ADR-016 (next free on main; ADR-015 is claimed by open PR [#302](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/302), the Jira integration). Numbers are never reused. If a lower number frees before merge, renumber and coordinate with PR #302 and the [#277](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/277) ADR-014 governance discussion.

**Status:** proposed
**Date:** 2026-06-11

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

Two sub-decisions:

1. **Inbound: an OIDC-descriptor seam.** Abstract "who is the inbound principal and how is it verified" into a descriptor so Cognito can be swapped for Okta, Microsoft Entra, Keycloak, or any OIDC provider without handler changes. The descriptor maps to a CUSTOM_JWT-style authorizer shape: a `discoveryUrl` (must end `/.well-known/openid-configuration`) plus `allowedAudience` / `allowedClients` / `customClaims` gates that all must pass. AgentCore Runtime's `customJWTAuthorizer` is **one** implementation behind the seam; ABCA's own Cognito authorizer plus the SigV4 user-header path (`X-Amzn-Bedrock-AgentCore-Runtime-User-Id`) is another. Adapters: Cognito (shipped), Okta, Entra, Keycloak.

   | Adapter | Discovery | Notes |
   |---|---|---|
   | Cognito | User Pool `/.well-known/openid-configuration` | Shipped today; the SigV4 path carries the user id as a header. |
   | Okta | Org or custom-auth-server discovery URL | Standard OIDC; `allowedClients` gates the app. |
   | Entra | v2 tenant discovery URL | Issue **plain** JWTs — Entra emits *encrypted* access tokens when an app registration has confidential optional claims, and the JWT authorizer cannot decrypt them (fails silently). Use v2 + a custom exposed-API scope, or v1 + `<application-id>/.default`. |
   | Keycloak | Realm discovery URL | Private-IdP reachable via a private endpoint where the realm is not internet-facing. |

2. **Outbound: an OAuth2-resolver seam.** Unify the `resolve_<integration>_token()` resolvers behind one contract that selects `USER_FEDERATION` / `M2M` / `ON_BEHALF_OF_TOKEN_EXCHANGE` per the deep-dive decision tree, and binds each token to `(workload_identity, user_id)` using #245's IdP-namespaced `user_id` (`cognito+<sub>`). The vault does **not** auto-namespace by IdP, so the namespaced form is what keeps two IdPs that issue the same `sub` from colliding. One identity feeds both the log plane (#245) and the credential plane (#249). AgentCore's token vault (`GetResourceOauth2Token`) is **one** implementation; the current Secrets-Manager resolvers are another. The deep-dive's raw-boto3 path (its §15) proves the `@requires_access_token` helper is convenient, not required, which is what makes the seam backend-swappable. Adapters: `GithubOauth2`, `AtlassianOauth2` (Jira), `SlackOauth2`, and `CustomOauth2` for Linear.

   **Linear is `CustomOauth2`, verified.** There is no `LinearOauth2` built-in vendor in the `credentialProviderVendor` enum — confirmed against the bedrock-agentcore-control service model (API version 2023-06-05), with zero drift across all 25 enum values. Linear is wired through `oauth2ProviderConfigInput.customOauth2ProviderConfig`: set `oauthDiscovery` (or explicit `authorizationEndpoint=https://linear.app/oauth/authorize` + `tokenEndpoint=https://api.linear.app/oauth/token`), `clientId`, `clientSecret`, and `clientAuthenticationMethod` (`CLIENT_SECRET_BASIC` or `CLIENT_SECRET_POST`). Linear's authorize URL takes `actor=app` (and `prompt=consent`) for workspace-actor tokens, passed as an extra authorization-request parameter — the same `actor=app` flow `linear-oauth-resolver.ts` already runs. Use `auth_flow=USER_FEDERATION` for per-workspace consent and copy `provider['callbackUrl']` into Linear's OAuth app redirect URIs. This is the same `CustomOauth2` shape the deep-dive uses for its M2M data-api example.

### Why a seam, not a rewrite

The abstraction is intentionally a contract, not a forklift of credential handling onto AgentCore:

- **Backend-agnostic.** One `resolve_<integration>_token()` contract serves both the AgentCore Runtime backend (token arrives via the `WorkloadAccessToken` header) and the parked ECS backend (in-process boto3). The backend decides how the token arrives; the seam does not care.
- **Incremental.** The rollout is phased and flag-gated, and the shared PAT fallback stays until the vault path is green. No big-bang cutover.
- **Consistent with ADR-014.** This is the credential-plane analog of [ADR-014](./ADR-014-workflow-driven-tasks.md)'s provider-neutral `VcsProvider` seam: that one named GitHub-specific control-plane operations as instances of generic concepts; this one names the per-integration credential resolvers as instances of one outbound contract.

## Consequences

- (+) **One credential abstraction, not N resolvers.** New integrations register an adapter against one contract instead of re-implementing fetch + refresh + race handling per provider.
- (+) **Per-user, per-repo scoping replaces the shared PAT.** Tokens bind to `(workload_identity, user_id)`, so the single GitHub PAT covering every repo and user gives way to scoped, short-lived credentials.
- (+) **Cryptographic attribution, not asserted attribution.** OBO delegation carries an `act` claim (RFC 8693 delegation mode, `user ← agent`), which is joinable to #245's `trace_id` and #237's `correlation` block. The *who acted* is verifiable, not inferred from a webhook payload.
- (+) **Operators can bring their own IdP.** The inbound descriptor lets a deployment run on Okta, Entra, or Keycloak without forking handler code.
- (+) **Backend-agnostic.** The same seam serves the AgentCore Runtime and ECS backends, matching the design posture already documented for the SessionRole in [SECURITY.md](../design/SECURITY.md).
- (−) **A new abstraction plus an adapter registry to maintain.** Two seams and their adapter sets are added platform surface; mitigated by keeping the inbound descriptor a parameterization of a single verification path (see the risk below) and the outbound contract a thin selector over the existing flows.
- (−) **AgentCore Identity adds a managed dependency and token-vault cost.** Vault fetches (`GetResourceOauth2Token` / `GetResourceApiKey`) bill at `$0.010/1,000`. The ECS in-process resolver path remains available where that dependency is unwanted.
- (!) **The inbound seam must not become a second auth code path.** A descriptor that grew its own verification logic would drift from the shipped Cognito/HMAC path and create two implementations to keep in sync. That is the exact cedar-parity drift hazard ADR-014 calls out. Mitigation: exactly **one** inbound verification implementation; the descriptor only parameterizes it (discovery URL, audience, client list, claim gates), never reimplements it.

## Phasing

| Phase | Action | Gate |
|---|---|---|
| P0 ✅ | Re-validate `USER_FEDERATION` / OBO post-GA against the live service. | **Done 2026-06-14 (`us-east-1`): GO-LIKELY** — parked PAR bug does not reproduce (see [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)). Full GO pending one human consent click. |
| P1 | Route GitHub through the vault `GithubOauth2` provider behind a flag; retire the shared PAT. | Flag-gated; PAT fallback retained until green. |
| P2 | Move Linear onto the vault (`CustomOauth2`); delete the manual-refresh logic in `linear-oauth-resolver.ts`. | Per-workspace token isolation preserved. |
| P3 | OBO `act`-claim delegation feeding #237's `correlation` block. | Delegation chain visible in audit. |

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
- [ADR-014](./ADR-014-workflow-driven-tasks.md) — workflow-driven tasks; introduced the provider-neutral `VcsProvider` seam this ADR is the credential-plane analog of
- [IDENTITY_AND_AUTH.md](../design/IDENTITY_AND_AUTH.md) — the worked use-cases, seams table, decision tree, and Linear before/after
- [SECURITY.md](../design/SECURITY.md) — current auth posture, the shared-PAT limitation this ADR resolves
- GitHub issues — per-repo GitHub credentials, layered credential derivation, delegation chain propagation (priority labels `P0`, `P1`, etc.)
- AgentCore Identity, Runtime, and Gateway — the [AWS Bedrock AgentCore developer guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html) and the [CreateOauth2CredentialProvider API reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateOauth2CredentialProvider.html) are the public sources for the flows, the `credentialProviderVendor` enum, and pricing
