---
title: "ADR-015: Jira Cloud integration via label trigger, OAuth 3LO, and REST outbound"
---

**Status:** accepted
**Date:** 2026-06-08
**Last-updated:** 2026-11-26
**Revised:** 2026-08-05 by [#709](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/709)

## Context

ABCA ingests coding tasks from CLI, GitHub webhooks, Slack, and Linear, then opens PRs autonomously. Linear was the only issue-tracker channel, but many teams use Jira instead. We want parity. A Jira issue gets a `bgagent` label, ABCA picks the issue up, an agent run produces a PR, and status flows back into the Jira issue.

The Linear integration (`cdk/src/constructs/linear-integration.ts`, its sibling handlers, and `agent/src/channel_mcp.py`) is the established pattern for an issue-tracker channel. The forces here are the same: per-tenant credential isolation, webhook authenticity, a low-friction trigger, and an outbound path for the agent to report progress. Jira differs from Linear in a few concrete ways that shape the decision. The main differences are how label changes and issue descriptions are represented, how webhook signing secrets are provisioned, and, as it turned out, how the outbound progress path is implemented.

> This ADR was originally numbered ADR-014. Issue [#296](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/296) merged a different ADR-014 (workflow-driven tasks) first, so this one is renumbered to **ADR-015**.

## Decision

Build a parity-level Jira Cloud integration that mirrors Linear file-for-file where the shape is the same, and diverges only where Jira's API forces it. The integration has these properties:

- **Jira Cloud only.** Jira Server, Data Center, and general Marketplace distribution are out of scope. The integration targets REST v3, Atlassian Cloud webhooks, and an operator-deployed Forge app for outbound identity.
- **Per-tenant OAuth 3LO for inbound reads and human lookup.** The credentials are stored in Secrets Manager as `bgagent-jira-oauth-<cloudId>`, mirroring `bgagent-linear-oauth-<slug>`. `cloudId` (the Atlassian tenant UUID) is the tenant key across all tables and secrets, not the site domain or name.
- **Label trigger.** The default label is `bgagent`, for parity with Linear. v1 has no status-transition or comment-command triggers.
- **Outbound via a signed Forge app proxy.** The proxy exposes only identity, comment, read-transition, and perform-transition operations, then calls Jira REST v3 with `api.asApp().requestJira(...)`. Agent start comments and transitions, and Lambda acknowledgements and final comments, use the same selection rule.
- **Migration fallback.** A tenant with no Forge configuration keeps the original 3LO REST writer. Once any app configuration exists, proxy, auth, and permission failures never fall back to 3LO, because a fallback would silently attribute a write to the setup user.
- **Deterministic terminal feedback.** The shared DynamoDB Streams fan-out consumer owns the single terminal Jira comment, including crash and timeout outcomes.

The channel selection in `agent/src/channel_mcp.py` becomes a small dispatch registry (`CHANNEL_MCP_BUILDERS`) instead of a hardcoded Linear gate, so adding a channel is a new entry, not a rewrite.

### Outbound is REST through Forge, not MCP

This ADR originally specified the Atlassian Remote MCP server (`https://mcp.atlassian.com/v1/sse`) for outbound, registered into `.mcp.json` when `channel_source == "jira"`. It noted a REST shim only as a fallback ("Plan B") if MCP coverage proved insufficient.

In practice the hosted Atlassian MCP requires an interactive, browser-based OAuth 2.1 authorization flow with dynamic client registration. It does not accept the stored REST OAuth token as a `Bearer` header. A headless background agent cannot complete that handshake, so the MCP server fails to connect (`claude mcp list` reports "Failed to connect").

The original implementation therefore used Jira REST v3 directly with the stored 3LO token. That fixed headless access but not attribution. Atlassian 3LO acts on behalf of the consenting user, so comments and transitions appeared as the administrator who ran setup.

Issue #642 adds the dedicated actor without replacing REST. A minimal Forge web trigger receives HMAC-authenticated, operation-allowlisted requests and calls the same Jira REST resources through `api.asApp().requestJira(...)`. Forge supplies the installation's app account as the actor. The proxy URL and shared secret are stored on the existing per-tenant OAuth bundle. Non-secret app identity metadata is stored in the workspace registry.

Web-trigger URLs have no Forge-managed caller authentication. ABCA signs `timestamp + "." + rawBody` with HMAC-SHA256, the proxy enforces a five-minute clock window, and both sides restrict the URL to Forge v2 installation hosts. `bgagent jira app-setup` probes `/rest/api/3/myself` and `/rest/api/3/serverInfo` through `asApp`. It refuses to store an identity unless Jira returns `accountType=app` and the installation URL matches the selected tenant.

### Where Jira forced divergence from the Linear copy

These are the points where copying Linear unchanged would have been wrong:

1. **Label-add detection on updates.** Jira's `jira:issue_updated` payload reports label changes in `changelog.items[]` (`field: "labels"`, `fromString` / `toString`). It does not re-send the full label list. The processor diffs the changelog, not `issue.fields.labels`, so re-saving an issue that already carries the label does not re-trigger.
2. **Webhook signing secret is operator-chosen and synchronized.** Atlassian does not auto-generate a per-subscription signing secret the way Linear does. The operator picks one at webhook-create time and pastes it during `bgagent jira setup`. ABCA stores the same value on the sole active tenant's OAuth bundle and in the stack-wide verifier. Jira admin-console webhook payloads omit `cloudId`, so the channel supports exactly one active Jira tenant.
3. **Signature scheme.** Atlassian signs with HMAC-SHA256 over the *raw* request body, delivered as `X-Hub-Signature: sha256=<hex>`. Verification uses a constant-time compare over the unparsed bytes.
4. **ADF descriptions.** Jira issue descriptions are Atlassian Document Format, not markdown. The processor extracts text, headings, lists, and external `media` image URLs into markdown for the task description. It does not implement a full ADF converter.
5. **Dedup key.** The key is `{issueKey}#{webhookEvent}#{timestamp}` with an 8-hour TTL, not the event type alone. Two distinct label-adds in quick succession are therefore not collapsed, while retries of one delivery, which carry the same timestamp, are. Jira retries far less aggressively than Linear, so 8 hours is safe parity. A delivery without a timestamp collapses to `…#unknown` and skips the replay-window check, which is advisory and unsigned. The skip is logged and is not treated as fatal.

### Admin-console webhook tenant binding

Jira admin-console webhook payloads omit `cloudId`, so one webhook URL cannot select among multiple tenant secrets. `bgagent jira setup` therefore refuses to onboard a second active Jira tenant and synchronizes the sole active tenant's signing secret to both its OAuth bundle and the stack-wide verifier.

Payloads that do carry `cloudId` can still use the per-tenant copy. For stack-wide verifications, the receiver flags the delivery (`verified_via_stack_wide`), and the processor ignores any body-supplied `cloudId` and binds the event to the sole active tenant. The processor drops the event when zero or multiple tenants are active, so a holder of the stack-wide secret cannot steer a webhook at arbitrary tenant mappings.

### Token refresh ownership

Atlassian rotates the `refresh_token` on every use. Only trusted Lambda code (`jira-oauth-resolver.ts`, with `secretsmanager:PutSecretValue`) refreshes tokens and writes the rotated bundle back. The **agent never refreshes**. It has `GetSecretValue` only, so a refresh would consume the stored `refresh_token`, keep the rotated replacement in memory for one task, and leave Secrets Manager with a dead token, which breaks the tenant. The agent uses the access token that the Lambdas most recently wrote. If that token is already expiring, the agent fails closed and skips the advisory comment.

## Consequences

- (+) Teams on Jira Cloud get the same loop of label, PR, and progress comment as Linear, with no new operational concepts.
- (+) Jira comments and workflow history identify the dedicated `bgagent` app instead of the OAuth setup user.
- (+) Inbound human attribution remains independent: `JiraUserMappingTable` still controls task ownership, concurrency, cost, and audit.
- (+) One identity-selection rule covers Lambda and agent writes, and a configured app failure cannot silently change actor.
- (+) Synchronizing the tenant and stack-wide signing-secret copies keeps admin-console webhook verification deterministic.
- (-) Operators deploy and install a small Forge app per Atlassian environment and manage one additional HMAC secret.
- (-) The Jira channel supports exactly one active tenant because admin-console webhook payloads provide no tenant-routing key.
- (-) Forge web-trigger and invocation limits become part of the outbound path.
- (-) The conversion from ADF to markdown is lossy by design. It keeps only text, headings, lists, and external image URLs. Rich content in descriptions is flattened, and `file`-type attachment media, which need a Jira API round-trip, are skipped.
- (!) `cloudId` must be used consistently as the tenant key. Indexing on domain or site name anywhere would break tenant resolution.
- (!) The webhook signing secret is stored in both the per-tenant OAuth bundle and the stack-wide verifier. After you rotate it in Jira, run `bgagent jira update-webhook-secret <cloudId>` to synchronize both copies and avoid silent 401s.

## References

- Issue: [#288, Jira Cloud integration (parity with Linear)](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/288)
- Issue: [#642, give Jira outbound actions a bgagent app identity](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/642)
- Issue: [#709, repair Jira webhook admission and secret rotation](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/709)
- [JIRA_SETUP_GUIDE.md](/sample-autonomous-cloud-coding-agents/using/jira-setup-guide). Operational walkthrough.
- [LINEAR_SETUP_GUIDE.md](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide). The analog integration that this one mirrors.
- Reference implementation: `cdk/src/constructs/jira-integration.ts`, `cdk/src/handlers/jira-*.ts`, `cdk/src/handlers/shared/jira-{verify,oauth-resolver,feedback}.ts`, `agent/src/jira_reactions.py`, `agent/src/channel_mcp.py`

## Changelog

- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
