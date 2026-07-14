# AgentCore Gateway ↔ MCP federation — spike (GO)

> **Status:** SPIKE COMPLETE 2026-07-14 — **GO**. Live-proven that AgentCore Gateway can federate the hosted Linear MCP behind a managed MCP endpoint via a `McpServer` target + API_KEY outbound (vaulted token). The research-flagged 3LO/DYNAMIC-mode risk does NOT apply to Linear (it accepts a static bearer). Next: build the CDK L1 Gateway + target construct and repoint `channel_mcp.py`.

# AgentCore Gateway ↔ Linear MCP spike — live findings

Environment: laptop AWS acct 829933968422 (sphia-dev). NOTE: deployed ABCA dev stack is 565895652731 (cloud box) — this spike is in a scratch account, throwaway resources only.

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
