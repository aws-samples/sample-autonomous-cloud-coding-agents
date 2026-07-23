---
title: Adr 015 jira integration
---

# ADR-015: Jira Cloud integration via label trigger, OAuth 3LO, and REST outbound

**Status:** accepted
**Date:** 2026-06-08

## Context

ABCA ingests coding tasks from CLI, GitHub webhooks, Slack, and Linear, then opens PRs autonomously. Linear was the only issue-tracker channel, but many teams use Jira instead. We want parity: a Jira issue gets a `bgagent` label → ABCA picks it up → an agent run produces a PR → status flows back into the Jira issue.

The Linear integration (`cdk/src/constructs/linear-integration.ts` + sibling handlers + `agent/src/channel_mcp.py`) is the established pattern for an issue-tracker channel, and the forces here are the same: per-tenant credential isolation, webhook authenticity, a low-friction trigger, and an outbound path for the agent to report progress. Jira differs from Linear in a few concrete ways that shape the decision — most notably how label changes and issue descriptions are represented, how webhook signing secrets are provisioned, and (as it turned out) how the outbound progress path is implemented.

> This ADR was originally numbered ADR-014. Issue [#296](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/296) merged a different ADR-014 (workflow-driven tasks) first, so this one is renumbered to **ADR-015**.

## Decision

Build a **parity-level Jira Cloud integration** that mirrors Linear file-for-file where the shape is the same, and diverges only where Jira's API forces it. Specifically:

- **Jira Cloud only.** Jira Server / Data Center and general Marketplace distribution are out of scope. The integration targets REST v3, Atlassian Cloud webhooks, and an operator-deployed Forge app for outbound identity.
- **Per-tenant OAuth 3LO for inbound reads and human lookup**, stored in Secrets Manager as `bgagent-jira-oauth-<cloudId>`, mirroring `bgagent-linear-oauth-<slug>`. `cloudId` (the Atlassian tenant UUID) is the tenant key across all tables and secrets — not the site domain or name.
- **Label trigger** (default `bgagent`), parity with Linear. No status-transition or comment-command triggers in v1.
- **Outbound via a signed Forge app proxy.** The proxy exposes only identity, comment, read-transition, and perform-transition operations, then calls Jira REST v3 with `api.asApp().requestJira(...)`. Agent start comments/transitions and Lambda acknowledgements/final comments use the same selection rule.
- **Migration fallback.** A tenant with no Forge configuration keeps the original 3LO REST writer. Once any app configuration exists, proxy/auth/permission failures never fall back to 3LO, because doing so would silently attribute a write to the setup user.
- **Deterministic terminal feedback.** The shared DynamoDB Streams fan-out consumer owns the single terminal Jira comment, including crash and timeout outcomes.

The channel selection in `agent/src/channel_mcp.py` becomes a small dispatch registry (`CHANNEL_MCP_BUILDERS`) rather than a hardcoded Linear gate, so adding a channel is an entry, not a rewrite.

### Outbound is REST through Forge, not MCP

This ADR originally specified the **Atlassian Remote MCP server** (`https://mcp.atlassian.com/v1/sse`) for outbound, registered into `.mcp.json` when `channel_source == "jira"`, with a REST shim noted only as a fallback ("Plan B") if MCP coverage proved insufficient.

In practice the hosted Atlassian MCP requires an **interactive, browser-based OAuth 2.1 authorization flow with dynamic client registration** and will **not** accept the stored REST OAuth token as a `Bearer` header. A headless background agent cannot complete that handshake, so the MCP server fails to connect (`claude mcp list` → "Failed to connect").

The original implementation therefore used Jira REST v3 directly with the stored 3LO token. That fixed headless access but not attribution: Atlassian 3LO acts on behalf of the consenting user, so comments and transitions appeared as the administrator who ran setup.

Issue #642 adds the dedicated actor without replacing REST. A minimal Forge web trigger receives HMAC-authenticated, operation-allowlisted requests and calls the same Jira REST resources through `api.asApp().requestJira(...)`. Forge supplies the installation's app account as the actor. The proxy URL and shared secret live on the existing per-tenant OAuth bundle; non-secret app identity metadata lives in the workspace registry.

Web-trigger URLs have no Forge-managed caller authentication. ABCA signs `timestamp + "." + rawBody` with HMAC-SHA256, the proxy enforces a five-minute clock window, and both sides restrict the URL to Forge v2 installation hosts. `bgagent jira app-setup` probes `/rest/api/3/myself` and `/rest/api/3/serverInfo` through `asApp`; it refuses to store an identity unless Jira returns `accountType=app` and the installation URL matches the selected tenant.

### Where Jira forced divergence from the Linear copy

These are the points where blindly copying Linear would have been wrong:

1. **Label-add detection on updates.** Jira's `jira:issue_updated` payload reports label changes in `changelog.items[]` (`field: "labels"`, `fromString` / `toString`) — it does *not* re-send the full label list. The processor diffs the changelog, not `issue.fields.labels`, so re-saving an issue that already carries the label does not re-trigger.
2. **Webhook signing secret is operator-chosen.** Atlassian does not auto-generate a per-subscription signing secret the way Linear does. The operator picks one at webhook-create time and pastes it during `bgagent jira setup`; ABCA stores it on the per-tenant OAuth bundle. The stack-wide secret is seeded only once (from the first tenant) for single-tenant back-compat — it is **not** copied into later tenants' bundles (see *Multi-tenant signature binding* below).
3. **Signature scheme.** Atlassian signs with HMAC-SHA256 over the *raw* request body, delivered as `X-Hub-Signature: sha256=<hex>`. Verification uses a constant-time compare over the unparsed bytes.
4. **ADF descriptions.** Jira issue descriptions are Atlassian Document Format, not markdown. The processor extracts text/headings/lists (and external `media` image URLs) into markdown for the task description rather than rolling a full ADF converter.
5. **Dedup key.** `{issueKey}#{webhookEvent}#{timestamp}` with an 8-hour TTL, rather than keying on event type alone — so two distinct label-adds in quick succession aren't collapsed, while retries of one delivery (same timestamp) are. Jira retries far less aggressively than Linear, so 8 hours is safe parity. A timestamp-less delivery collapses to `…#unknown` and skips the (advisory, unsigned) replay-window check, which is logged rather than treated as fatal.

### Multi-tenant signature binding

The per-tenant signing secret proves which tenant signed a delivery, so a per-tenant-verified webhook's body `cloudId` is trusted for routing. The **stack-wide fallback secret is not bound to any `cloudId`**, so a delivery verified that way cannot trust a body-supplied `cloudId`. The receiver flags stack-wide verifications (`verified_via_stack_wide`) to the processor, which then ignores the body `cloudId` and binds the event to the **sole active tenant**, dropping when zero or multiple tenants are active. This preserves the fail-closed multi-tenant guarantee: a holder of the stack-wide secret cannot steer a webhook at an arbitrary tenant's mappings.

### Token refresh ownership

Atlassian **rotates the `refresh_token` on every use**. Only trusted Lambda code (`jira-oauth-resolver.ts`, with `secretsmanager:PutSecretValue`) refreshes tokens and writes the rotated bundle back. The **agent never refreshes** — it has `GetSecretValue` only, so a refresh would consume the stored `refresh_token`, keep the rotated replacement in memory for one task, and leave Secrets Manager holding a dead token (bricking the tenant). The agent uses whatever access token the Lambdas most-recently wrote and fails closed (skips the advisory comment) if that token is already expiring.

## Consequences

- (+) Teams on Jira Cloud get the same label → PR → progress-comment loop as Linear, with no new operational concepts.
- (+) Jira comments and workflow history identify the dedicated `bgagent` app instead of the OAuth setup user.
- (+) Inbound human attribution remains independent: `JiraUserMappingTable` still controls task ownership, concurrency, cost, and audit.
- (+) One identity-selection rule covers Lambda and agent writes, and a configured app failure cannot silently change actor.
- (+) Per-tenant credential isolation, signature binding, and the changelog-diff trigger keep the trust and re-trigger semantics correct for multi-tenant installs.
- (-) Operators deploy and install a small Forge app per Atlassian environment and manage one additional HMAC secret.
- (-) Forge web-trigger and invocation limits become part of the outbound path.
- (-) ADF→markdown is lossy by design (text/headings/lists + external image URLs only); rich content in descriptions is flattened, and `file`-type attachment media (needing a Jira API round-trip) are skipped.
- (!) `cloudId` must be used consistently as the tenant key. Indexing on domain or site name anywhere would break tenant resolution.
- (!) The webhook signing secret lives on the per-tenant OAuth bundle; rotating it in Jira without re-running `bgagent jira setup` causes silent 401s on every delivery.

## References

- Issue: [#288 — Jira Cloud integration (parity with Linear)](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/288)
- Issue: [#642 — give Jira outbound actions a bgagent app identity](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/642)
- [JIRA_SETUP_GUIDE.md](/sample-autonomous-cloud-coding-agents/using/jira-setup-guide) — operational walkthrough
- [LINEAR_SETUP_GUIDE.md](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide) — the analog integration this mirrors
- Reference implementation: `cdk/src/constructs/jira-integration.ts`, `cdk/src/handlers/jira-*.ts`, `cdk/src/handlers/shared/jira-{verify,oauth-resolver,feedback}.ts`, `agent/src/jira_reactions.py`, `agent/src/channel_mcp.py`
