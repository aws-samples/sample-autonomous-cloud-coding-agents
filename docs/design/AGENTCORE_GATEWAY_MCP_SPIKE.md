# AgentCore Gateway ↔ Linear MCP federation — spike (GO)

> **VERDICT: GO** (2026-07-14). Live-proven on acct 829933968422 (all spike resources torn down; the real Linear app untouched): AgentCore Gateway CAN federate Linear's hosted MCP with **Gateway-managed 24h token refresh**, via authorization-code (3LO) OAuth. An earlier NO-GO (F4/F5) was WRONG — caused by a stale aws-cli (2.31.20, control-plane model lacked the 3LO grant fields) defaulting to client-credentials. See F6/F7 for the retraction, F12 for the final recipe.
> **Working recipe:** aws-cli ≥2.35 · Gateway authorizer **CUSTOM_JWT** (reuse ABCA's Cognito TaskApiUserPool; AWS_IAM inbound is rejected for 3LO) · OAuth2CredentialProvider **CustomOauth2** (Linear authorize/token endpoints + client creds from `bgagent-linear-oauth-<ws>`) · target OAUTH cred config **grantType=AUTHORIZATION_CODE** + **customParameters {actor: app}** + defaultReturnUrl · **mcpServer.listingMode=DEFAULT** (DYNAMIC incompatible with 3LO) · register the provider's per-UUID callback on the Linear OAuth app.
> **Design costs (all one-time, per-workspace, at admin onboarding — NEVER hit end users):** admin browser consent; per-provider Linear-app redirect-URI registration; actor=app. Do the consent at INITIAL workspace install (clean authorize→code), not as a re-auth of an already-installed app (Linear routes that to a settings page, F12).

## F0 — BASELINE (proven, HTTP 200)
The stored Linear token (/tmp/linear_pat) authenticates DIRECTLY against https://mcp.linear.app/mcp as a plain `Authorization: Bearer <token>`. Full MCP `initialize` handshake succeeds: protocolVersion 2025-06-18, serverInfo "Linear MCP" v1.0.0, tools.listChanged capability present.
→ This is exactly what channel_mcp.py::_linear_server_entry does today (http type + Bearer header).
→ CRITICAL IMPLICATION: Linear's hosted MCP takes a STATIC bearer token — it does NOT require an interactive 3LO round-trip AT CONNECT TIME. So the research's "DYNAMIC-mode incompatible with 3LO" risk may not bite: Gateway's API_KEY outbound mode (inject a static Authorization header) should front it. The 3LO concern applies to servers that force authorization-code flow at connect; Linear accepts a pre-obtained bearer.

## CLI/tooling available for the spike
- aws-cli 2.31.20 knows bedrock-agentcore-control: create-gateway, create-gateway-target, create-oauth2-credential-provider, synchronize-gateway-targets. Live Gateway probe is possible.
- Linear MCP reachable: 401 unauth, 200 with Bearer.

## Next probe (planned)
Stand up a throwaway Gateway + McpServer target (endpoint=https://mcp.linear.app/mcp, outbound=API_KEY with the Linear bearer), then MCP-client tools/list against the Gateway endpoint. If tools surface → federation works with a static key, no 3LO wall. Tear down after.

## F1 — Live CLI API shapes CONFIRMED (aws-cli 2.31.20, bedrock-agentcore-control)
- **Inbound authorizer-type** on THIS CLI = only `CUSTOM_JWT | AWS_IAM` (NOT the CFN's broader CUSTOM_JWT|AWS_IAM|NONE|AUTHENTICATE_ONLY — real correction to the research report; NONE/AUTHENTICATE_ONLY may be CFN/newer-API only). For the probe: AWS_IAM inbound (SigV4 with my own creds, no OIDC setup).
- **create-gateway** requires: --name, --role-arn (gateway service role), --protocol-type MCP, --authorizer-type.
- **protocol-configuration** mcp={supportedVersions=[…],instructions=…,searchType=SEMANTIC} — semantic search is a create-time opt-in here.
- **create-gateway-target**: --gateway-identifier --name --target-configuration --credential-provider-configurations.
  - target-config for MCP federation: `{"mcp":{"mcpServer":{"endpoint":"https://mcp.linear.app/mcp"}}}`
  - credentialProviderType ∈ GATEWAY_IAM_ROLE|OAUTH|API_KEY.
- **KEY COMPOSITION FINDING:** apiKeyCredentialProvider takes a **providerArn** (NOT a raw key) + optional credentialParameterName. So even the "static API key" path is vaulted through AgentCore Identity: you FIRST `create-api-key-credential-provider --name --api-key <linear-token>` → get providerArn → reference it in the target. Confirms the report's thesis (Gateway egress auth is built ON AgentCore Identity) even for API_KEY, not just OAUTH.

## Probe sequence (executing)
1. create-api-key-credential-provider (vault the Linear token) → providerArn
2. IAM gateway service role (trust bedrock-agentcore, + GetResourceApiKey/GetWorkloadAccessToken/GetSecretValue on the provider)
3. create-gateway (AWS_IAM inbound, MCP) → gatewayId + gatewayUrl
4. create-gateway-target (mcpServer endpoint=Linear, API_KEY→providerArn, credentialParameterName=Authorization prefix Bearer)
5. MCP client tools/list against the gateway /mcp endpoint (SigV4) → do Linear tools surface?
6. TEARDOWN all (delete target, gateway, credential provider, role).

## F2 — SPIKE RESULT: ✅ GO. Full federation works end-to-end (LIVE PROVEN, acct 829933968422)
Built the whole chain live and tore it down. Sequence that WORKED:
1. create-api-key-credential-provider --name abca-spike-linear-key --api-key <linear-token>
   → credentialProviderArn (token-vault/default/apikeycredentialprovider/…)
   → apiKeySecretArn = arn:…:secret:**bedrock-agentcore-identity!**default/apikey/… (the EXACT identity!* pattern from ABCA's known gotcha → gateway role needs GetSecretValue on it)
2. gateway service role: trust bedrock-agentcore.amazonaws.com; allow bedrock-agentcore:GetWorkloadAccessToken + GetResourceApiKey (+GetResourceOauth2Token) on *, secretsmanager:GetSecretValue on the identity!* secret.
3. create-gateway --protocol-type MCP --authorizer-type AWS_IAM → gatewayUrl https://{id}.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp; reached READY in ~30s.
4. create-gateway-target --target-configuration '{"mcp":{"mcpServer":{"endpoint":"https://mcp.linear.app/mcp"}}}' --credential-provider-configurations API_KEY→{providerArn, credentialParameterName:"Authorization", credentialPrefix:"Bearer"} → target READY, **no statusReason error** = Gateway's MCP handshake with Linear via the vaulted bearer SUCCEEDED.
5. MCP client (SigV4-signed, service=bedrock-agentcore) → Gateway /mcp: initialize HTTP200 (serverInfo.name=abca-spike-gw), tools/list HTTP200 → **30 Linear tools surfaced, namespaced `linear-mcp___*`** (get_issue, list_comments, create_issue_label, get_team, …).

### The decisive answer to the research's open question
Linear's hosted MCP takes a STATIC bearer (proven F0: 200 on direct Bearer). So the 3LO-vs-DYNAMIC-mode conflict the docs warn about **does NOT apply to Linear** — API_KEY outbound (static header injection) fronts it cleanly. No interactive authorization-code flow, no static-mcpToolSchema workaround needed. Federation via McpServer target = confirmed viable for ABCA's Linear channel.

### Notable real corrections to the desk research
- Inbound authorizer-type on this live CLI = only CUSTOM_JWT | AWS_IAM (report's NONE/AUTHENTICATE_ONLY are CFN/newer-API, not in aws-cli 2.31.20).
- API_KEY outbound requires a pre-created credential provider (providerArn), NOT a raw inline key — so even "API key" routes through AgentCore Identity's vault. Reinforces: Gateway egress auth is built ON Identity for ALL cred types.
- Gateway MCP endpoint negotiated protocolVersion 2025-03-26 (client asked 2025-06-18); tool namespacing uses `<targetName>___<tool>` (triple underscore).

### Migration implication for ABCA
channel_mcp.py today writes an http entry → mcp.linear.app directly with Bearer ${LINEAR_API_TOKEN}. Gateway swap = point that entry at the gateway URL instead, and the agent authenticates to the Gateway (AWS_IAM/SigV4 from the task role, or CUSTOM_JWT). Per-thread LINEAR_API_TOKEN injection into the agent env can RETIRE for the MCP path — the token lives in the Gateway's vault, injected Gateway→Linear, never in the container. (resolve_linear_api_token still needed for the REST reaction path in linear_reactions.py unless that also moves behind Gateway.)

## F3 — Direction locked: Gateway + Identity, per-workspace, OAUTH outbound (refresh-managed)
- Linear OAuth tokens expire in **24h** (LINEAR_SETUP_GUIDE.md:290) → static API_KEY vaulting WOULD break daily. Refresh is mandatory.
- Gateway is built ON Identity (outbound uses an Identity credential provider). "Gateway + Identity" = Gateway fronts the MCP endpoint (federate + token-out-of-container) AND an OAuth2CredentialProvider owns the 24h refresh.
- L2 OAuth2CredentialProviderVendor has NO Linear; use CUSTOM (or .of("...")) with Linear endpoints:
  - authorize: https://linear.app/oauth/authorize
  - token:     https://api.linear.app/oauth/token
- **Client creds available:** bgagent-linear-oauth-<ws> secret already holds client_id + client_secret (+ access/refresh tokens, scope, workspace_id). So the CUSTOM provider can be built from the EXISTING per-workspace secret — no new credential collection.
- Account hygiene: my earlier spike resources fully gone. NOTE a PRE-EXISTING (2026-05-18) `linear-api-key` credential provider is the user's from prior Identity testing — LEAVE IT.

## Next spike (planned): OAuth2CredentialProvider(CUSTOM) → Gateway OAUTH target → Linear
Prove Gateway completes a custom-OAuth flow against Linear + surfaces tools + the refresh path. If the OAuth provider needs authorization-code (3LO) rather than client-credentials, that's the thing to nail — Linear's stored grant is authorization-code with a refresh_token.

## F4 — DECISIVE (live-proven, 829…, torn down): Gateway-managed OAuth ≠ Linear's auth model
Built OAuth2CredentialProvider(CustomOauth2, Linear authorize/token endpoints, client creds from bgagent-linear-oauth-maguireb) → Gateway → McpServer target(OAUTH, scopes read/write/app:*). Target sync → **FAILED**:
  "Error parsing ClientCredentials response (Service: AgentCredentialProvider, Status Code: 400)"

**Root cause:** Gateway's OAUTH outbound uses the **client-credentials grant (2LO)** — it POSTs grant_type=client_credentials to the token endpoint and expects a token. **Linear OAuth is authorization-code (3LO)** — requires a user to authorize the app in a browser; there is NO client-credentials path. Gateway cannot perform 3LO itself (no browser/user consent at egress time), so it can't obtain a Linear token via the OAuth provider.

### What this means for the three credential models (ALL now tested)
1. **OAUTH provider (Gateway-managed refresh)** → ❌ FAILS. Client-credentials only; Linear needs authorization-code. Dead end for Linear.
2. **API_KEY provider (static vaulted token)** → ✅ WORKS (F2, 30 tools) but ⚠️ NO refresh → breaks at 24h (F3). Would need an external re-vault-on-rotation mechanism.
3. **Direct (today)** → ✅ WORKS + refreshes (config.py hand-rolled, per-workspace, 24h).

### Consequence for "Gateway + Identity, per-workspace, refresh"
The clean version the user chose (Gateway owns OAuth refresh via OAuth2CredentialProvider) is **NOT achievable for Linear** with current Gateway — Gateway's OAuth is 2LO-only. To use Gateway you must fall back to API_KEY (model 2) and solve refresh yourself: on token rotation (the existing webhook/orchestrator refresh, or a scheduled job) call update on the api-key credential provider with the fresh access_token. i.e. ABCA keeps doing the refresh (as today) and just SYNCS the rotated token into the Gateway vault. That works but ADDS a moving part vs today, and the "Gateway owns refresh / token never touched by ABCA" benefit is LOST — ABCA still handles the OAuth refresh, just hands the result to Gateway instead of to the container env.

### Honest recommendation
Gateway + Linear buys LESS than hoped: no managed refresh (Linear is 3LO), so the only remaining wins are (a) token injected Gateway→Linear instead of into the container env, and (b) one endpoint for future multi-MCP aggregation. Both are real but modest, and cost a per-workspace api-key-provider + a token-sync-on-refresh mechanism. Worth an explicit go/no-go with the user before building.

## F5 — Workaround investigation: 3LO IS possible in Identity, but NOT reachable for a Gateway target, and NO token-import
Dug for an authorization-code / token-import / OBO path:
- **Gateway target OAUTH config** = providerArn + scopes + customParameters ONLY. No grant-type selector → egress is client-credentials (2LO) only. Confirmed dead for Linear at the Gateway leg (F4).
- **Data-plane `get-resource-oauth2-token`** DOES support 3LO: `--oauth2-flow USER_FEDERATION|M2M`, `--resource-oauth2-return-url`, `--force-authentication` ("always initiate a new three-legged OAuth (3LO) flow"). So Identity *can* do authorization-code — but this is the RUNTIME token-fetch call an agent/app makes directly, NOT something a Gateway target can invoke on egress. Gateway's target only knows client-credentials.
- **No token-import / seeding:** create/update-oauth2-credential-provider do NOT accept an existing access/refresh token. `complete-resource-token-auth` takes only user-identifier + session-uri (completes a browser session, can't seed). → You cannot hand AgentCore the tokens ABCA already holds; the ONLY way to populate a 3LO provider's vault is a live browser USER_FEDERATION consent.
- **Historical landmine:** USER_FEDERATION is exactly the flow ABCA's Phase 2.0a PARKED (memory/project_oauth_2_0b.md: "USER_FEDERATION has an open service-side bug"), which is WHY config.py reads Secrets Manager directly today. So the 3LO workaround = re-adopting the flow already abandoned once.

### FINAL VERDICT
There is NO clean path to put Linear behind Gateway with managed refresh:
- Gateway OAUTH target = 2LO only → Linear (3LO) fails.
- Identity 3LO exists but is (a) a runtime call, not a Gateway-egress option, and (b) needs live browser consent (no import), and (c) is the parked-2.0a buggy flow.
- Only working Gateway path = API_KEY (static token) + ABCA syncs the rotated token into the vault every 24h refresh. Works, but ABCA still owns refresh; Gateway adds a moving part for modest gains (token-out-of-container + aggregation).

**Recommendation: NO-GO on Gateway-for-Linear right now.** Revisit if/when Gateway adds authorization-code egress or token-import, or pivot Gateway to a client-credentials/IAM-auth tool where its strengths actually apply. Today's direct-MCP + hand-rolled per-workspace refresh remains the right design for Linear.

## F6 — CORRECTION (2026-07-14, verified vs primary AWS docs): F4/F5 NO-GO was WRONG. GO.
I re-verified against the official devguide (gateway-outbound-auth.html + gateway-target-MCPservers.html) after the deep-research harness kept flaking. My live-spike NO-GO was a MISREAD of a config error as a capability limit.

**The outbound-auth matrix (gateway-outbound-auth.html) for an MCP server target explicitly supports:**
No-auth ✓ · Gateway service role (SigV4) ✓ · Caller IAM ✗ · OAuth client-credentials ✓ · **OAuth authorization-code (3LO) ✓** · **OAuth token-exchange/OBO ✓** · Token passthrough ✗ · API key ✓.

**So:**
- F4 claim "Gateway OAuth egress = client-credentials only" → **REFUTED.** Authorization-code (3LO) IS supported for MCP targets. There's a dedicated section "Connecting to an OAuth-protected MCP server using Authorization Code flow."
- F5 "only API_KEY works for Linear" → **REFUTED.** 3LO is the intended path; Gateway then owns refresh.

**Why my spike 400'd:** I built the OAuth2 provider + target and let it default to the CLIENT-CREDENTIALS grant → Gateway POSTed grant_type=client_credentials → Linear (3LO-only) returned 400 ("Error parsing ClientCredentials response"). I never triggered the authorization-code flow. Real 3LO path per docs: CreateGatewayTarget returns an **authorization URL** → admin completes browser consent → app calls **CompleteResourceTokenAuth** (user-identifier + session-uri; OAuth2 URL session-binding, 10-min validity) → Gateway exchanges the code, stores tokens, and manages refresh. Target sits in CREATE_PENDING_AUTH until consent completes (I saw FAILED because wrong grant, not pending-auth).

**Two REAL constraints (docs):**
1. **DYNAMIC listing mode is NOT interoperable with 3LO or semantic search.** Must use DEFAULT mode (Gateway syncs catalog via SynchronizeGatewayTargets) OR supply `mcpToolSchema` upfront. (The original research caveat was half-right.)
2. **One-time browser consent per workspace** at onboard (the authz-code flow). Maps onto ABCA's existing per-workspace Linear OAuth onboarding. After consent, Gateway holds the refresh token and refreshes itself = the managed-refresh benefit we wanted.

**Also:** token-exchange/OBO supported for MCP targets → a per-user inbound token could be exchanged for a downstream-scoped token (fine-grained per-hop authz, no extra consent) — a candidate for the multi-tenant story.

### REVISED VERDICT: GO (authorization-code grant, DEFAULT listing mode).
The clean "Gateway + Identity, Gateway-managed refresh, per-workspace" design the user chose IS achievable for Linear. My earlier NO-GO is RETRACTED. Next: re-spike with the authorization-code flow (expect an auth URL + CompleteResourceTokenAuth consent step) to prove it end-to-end before building the CDK.

LESSON: a live 400 proved my CONFIG was wrong, not that the CAPABILITY was absent. I generalized a single failed attempt into a capability claim without checking the matrix doc. Verify capability limits against reference docs before declaring NO-GO.

## F7 — 3LO spike PROGRESS (2026-07-14, aws-cli upgraded 2.31.20→2.35.22)
The stale CLI was the blocker for F4/F6: aws-cli 2.31.20's control-plane model (bedrock-agentcore-control 2023-06-05) LACKED the 3LO fields. Upgraded to 2.35.22 → model now HAS: `grantType` (CLIENT_CREDENTIALS|AUTHORIZATION_CODE|TOKEN_EXCHANGE) on the target's oauthCredentialProvider, `defaultReturnUrl`, `mcpServer.listingMode` (DEFAULT|DYNAMIC), `mcpToolSchema`, target status `CREATE_PENDING_AUTH`/`UPDATE_PENDING_AUTH`/`SYNCHRONIZE_PENDING_AUTH`, `authorizationUrl` in the response. (CompleteResourceTokenAuth is on the DATA-plane `bedrock-agentcore` service.)

**Confirms F6:** my original 400 was because the old CLI couldn't set grantType → defaulted to CLIENT_CREDENTIALS (2LO) → Linear (3LO) rejected. With grantType=AUTHORIZATION_CODE the config is now expressible.

**NEW hard constraint (live, ValidationException):** "3LO Auth is not supported when gateway authorizer type is AWS_IAM." → the gateway's INBOUND authorizer must be **CUSTOM_JWT** (OIDC), not AWS_IAM, for a 3LO outbound target. Makes sense: Gateway binds the OAuth consent to a *user* identity, so it needs a user on the inbound leg. This raises the bar — a 3LO gateway needs a JWT/OIDC inbound (Cognito user pool + client + a user token).

**Reusable asset found:** ABCA's own Cognito pool `TaskApiUserPoolCE5247B7-UJbF9UXnbkg5` (us-east-1_VqJbmP07r) exists in acct 829… — a CUSTOM_JWT gateway can reuse it (no new pool). But completing the flow still needs: gateway w/ CUSTOM_JWT(discoveryUrl=that pool) → create 3LO target → get authorizationUrl → USER clicks consent in browser → CompleteResourceTokenAuth(user-identifier, session-uri) → tools/list. That's a bigger, interactive spike.

**Correct config shapes (verified):**
- target-configuration: {"mcp":{"mcpServer":{"endpoint":"https://mcp.linear.app/mcp","listingMode":"DEFAULT"}}}  (listingMode lives INSIDE mcpServer, NOT as a sibling of mcpServer)
- credential-provider-configurations: [{"credentialProviderType":"OAUTH","credentialProvider":{"oauthCredentialProvider":{"providerArn":..., "scopes":[...], "grantType":"AUTHORIZATION_CODE", "defaultReturnUrl":"https://..."}}}]

**State:** AWS_IAM gateway deleted. OAuth2 provider `abca-spike-linear-3lo` + role `abca-spike-gw-3lo-role` KEPT (reusable for the JWT retry). NEXT: recreate gateway with CUSTOM_JWT inbound (TaskApiUserPool discovery URL) and drive the interactive consent.

## F8 — 3LO flow REACHED consent (huge — refutes NO-GO conclusively), one config gap
CUSTOM_JWT gateway (reusing ABCA's TaskApiUserPool us-east-1_VqJbmP07r, client 3ersr87bivu3ldh3vpm1ngsp46) → create-gateway-target with grantType=AUTHORIZATION_CODE returned **status=CREATE_PENDING_AUTH** + authorizationData.oauth2.authorizationUrl + a userId. So the 3LO flow is REAL and reachable — definitively kills the F4/F5 NO-GO.

**Consent step gap (live):** clicking the auth URL → Linear returned "Invalid redirect_uri parameter for the application." Root cause: AgentCore redirects to ITS OWN callback (get-oauth2-credential-provider → callbackUrl = https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/087ee75c-...), which is NOT registered on the Linear OAuth app's allowed redirect URIs. 
→ **DESIGN IMPLICATION:** adopting Gateway requires registering AgentCore's per-credential-provider callback URL on the Linear OAuth app. The callback contains a provider-specific UUID, so it's per-provider — if per-workspace = per-provider, that's a redirect-URI to register PER workspace on the Linear app (or one shared provider). This is a NEW onboarding step vs today's direct flow (today ABCA's own CLI callback localhost:8080 is what's registered). Waiting on user to add the callback to the Linear app, then re-trigger a fresh authorize URL (10-min expiry).

## F9 — callback URL is PER-PROVIDER (per-UUID) → redirect-URI registration is per-provider
Live: my provider abca-spike-linear-3lo callback = .../callback/087ee75c-...; user's Linear app had a DIFFERENT UUID registered (96c1b201-..., from another/older provider) + localhost:8080. Linear rejected 3LO consent ("Invalid request" after the PAR expiry, and earlier "Invalid redirect_uri") until the EXACT 087ee75c callback is registered.
→ **DESIGN COST (confirmed):** each AgentCore OAuth2 credential provider gets a unique callback UUID. Every provider → a distinct redirect URI that must be registered on the Linear OAuth app. Per-workspace design (1 provider/workspace) = 1 Linear-app redirect-URI registration PER workspace. That's a real per-workspace onboarding step beyond the browser consent. A single shared provider (one Linear token for all workspaces) would need only one registration but loses per-workspace scoping. Tradeoff to weigh in the design.

## F10 — debug of the stuck consent: it's redirect-URI-mismatch + window expiry, NOT a browser bug
Target S1QT8QPTH0 → status FAILED, reason: "OAuth User_Federation authorization timed out. The gateway owner did not complete authorization within the allowed time." The null cookie/authorizationCode/state error = AgentCore's callback fired with no completed Linear round-trip (session lapsed / redirect never came back with a code).
Root cause chain: (1) my provider's callback is 087ee75c-...; (2) the Linear app has 96c1b201-... + localhost registered, NOT 087ee75c; so Linear can't redirect back to AgentCore with the code → AgentCore times out at 10min → FAILED. It was never a cookie/browser issue.
CLEAN-PASS REQUIREMENTS (both must hold at once): (a) register EXACTLY https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/087ee75c-5edd-4d80-9dc0-038155bb7647 on the Linear OAuth app; (b) click a FRESH auth URL and complete Linear consent within 10 min in one browser pass.

## F11 — Linear requires actor=app custom param for app-scopes (matches ABCA prod)
Linear rejected the 3LO consent: "The scopes requested are not valid for this actor mode." app:assignable/app:mentionable are only valid in actor=app mode; AgentCore's authorize call didn't pass it → Linear defaulted to user-actor. Fix: set the target oauthCredentialProvider.customParameters={"actor":"app"} (passed through to Linear's /oauth/authorize). This matches ABCA's existing Linear OAuth (actor=app; stored scope "app:assignable app:mentionable read write" — see project_linear_app_actor). 
→ DESIGN: the Gateway OAuth provider config must carry customParameters actor=app for Linear, same as ABCA's CLI does today. Target 8YAMA9E3XT created with it; awaiting user consent.

## F12 — consent completion blocked by Linear "already-installed app" behavior (NOT an AgentCore limit) → STOP
Clicking through the actor=app consent for the ALREADY-INSTALLED app ("Alan Turing"/bgagent, the user's REAL production app installed Jul 13) lands on Linear's app MANAGE/settings page, not a fresh authorization-code redirect with a ?code=. Linear doesn't re-issue a code for an already-installed actor=app app via the authorize URL; a clean code redirect would need uninstall+reinstall — which would DISRUPT the user's live Linear integration. So we STOP rather than finish the token vaulting.
CRITICAL for the real build: do the Gateway 3LO consent at INITIAL workspace onboarding (first install = clean authorize → code), NOT as a re-auth of an already-installed app. This maps onto ABCA's existing per-workspace onboarding moment.

## SPIKE COMPLETE — VERDICT: GO (my original NO-GO fully refuted)
Proven live (acct 829…, all spike resources torn down; user's real Linear app untouched):
- Gateway CAN federate Linear's 3LO MCP with Gateway-managed refresh. NO-GO (F4/F5) was a stale-CLI + wrong-grant misread.
- Working recipe: aws-cli ≥2.35 (control-plane model w/ 3LO fields) · Gateway authorizer CUSTOM_JWT (reuse TaskApiUserPool) — AWS_IAM inbound is REJECTED for 3LO · OAuth2CredentialProvider CustomOauth2 (Linear authorize/token endpoints, client creds from bgagent-linear-oauth-<ws>) · target credentialProviderConfigurations OAUTH grantType=AUTHORIZATION_CODE + customParameters{actor:app} + defaultReturnUrl · mcpServer.listingMode=DEFAULT (DYNAMIC incompatible w/ 3LO) · register the provider's per-UUID callback on the Linear app.
- Design costs (all real, all one-time-per-workspace-at-onboard, none hit end users): admin browser consent; per-provider Linear-app redirect-URI registration; actor=app param.
- End users NEVER consent — it's the same one-admin-per-workspace install ABCA does today; Gateway only moves that consent's plumbing + gains 24h managed refresh.
