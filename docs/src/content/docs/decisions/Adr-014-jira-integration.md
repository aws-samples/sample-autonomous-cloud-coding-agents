---
title: Adr 014 jira integration
---

# ADR-014: Jira Cloud integration via label trigger, OAuth 3LO, and MCP outbound

**Status:** proposed
**Date:** 2026-06-08

## Context

ABCA ingests coding tasks from CLI, GitHub webhooks, Slack, and Linear, then opens PRs autonomously. Linear was the only issue-tracker channel, but many teams use Jira instead. We want parity: a Jira issue gets a `bgagent` label → ABCA picks it up → an agent run produces a PR → status flows back into the Jira issue.

The Linear integration (`cdk/src/constructs/linear-integration.ts` + sibling handlers + `agent/src/channel_mcp.py`) is the established pattern for an issue-tracker channel, and the forces here are the same: per-tenant credential isolation, webhook authenticity, a low-friction trigger, and an outbound path for the agent to report progress. Jira differs from Linear in a few concrete ways that shape the decision — most notably how label changes and issue descriptions are represented, and how webhook signing secrets are provisioned.

## Decision

Build a **parity-level Jira Cloud integration** that mirrors Linear file-for-file where the shape is the same, and diverges only where Jira's API forces it. Specifically:

- **Jira Cloud only.** Jira Server / Data Center, and Forge/Connect app distribution, are out of scope. The integration targets REST v3 and Atlassian Cloud webhooks.
- **Per-tenant OAuth 3LO**, stored in Secrets Manager as `bgagent-jira-oauth-<cloudId>`, mirroring `bgagent-linear-oauth-<slug>`. `cloudId` (the Atlassian tenant UUID) is the tenant key across all tables and secrets — not the site domain or name.
- **Label trigger** (default `bgagent`), parity with Linear. No status-transition or comment-command triggers in v1.
- **Outbound via the Atlassian Remote MCP server** only (`https://mcp.atlassian.com/v1/sse`), registered into `.mcp.json` when `channel_source == "jira"`. No `jira_reactions.py` REST module unless MCP coverage proves insufficient.
- **Inbound-only adapter.** No DynamoDB Streams consumer and no outbound-notify Lambda, matching Linear's stance.

The channel selection in `agent/src/channel_mcp.py` becomes a small dispatch registry (`{"linear": ..., "jira": ...}`) rather than a hardcoded Linear gate, so adding a channel is an entry, not a rewrite.

### Where Jira forced divergence from the Linear copy

These are the points where blindly copying Linear would have been wrong:

1. **Label-add detection on updates.** Jira's `jira:issue_updated` payload reports label changes in `changelog.items[]` (`field: "labels"`, `fromString` / `toString`) — it does *not* re-send the full label list. The processor diffs the changelog, not `issue.fields.labels`, so re-saving an issue that already carries the label does not re-trigger.
2. **Webhook signing secret is operator-chosen.** Atlassian does not auto-generate a per-subscription signing secret the way Linear does. The operator picks one at webhook-create time and pastes it during `bgagent jira setup`; ABCA stores it on the per-tenant OAuth bundle with a stack-wide fallback for older installs.
3. **Signature scheme.** Atlassian signs with HMAC-SHA256 over the *raw* request body, delivered as `X-Hub-Signature: sha256=<hex>`. Verification uses a constant-time compare over the unparsed bytes.
4. **ADF descriptions.** Jira issue descriptions are Atlassian Document Format, not markdown. The processor extracts text/headings/lists into markdown for the task description rather than rolling a full ADF converter.
5. **Dedup key.** `{issueKey}#{webhookEventTimestamp}` with an 8-hour TTL, rather than keying on event type — so two distinct label-adds in quick succession aren't collapsed. Jira retries far less aggressively than Linear, so 8 hours is safe parity.

## Consequences

- (+) Teams on Jira Cloud get the same label → PR → progress-comment loop as Linear, with no new operational concepts.
- (+) The MCP-only outbound path means no bespoke Jira REST client to maintain; the agent uses Atlassian's own tools.
- (+) Per-tenant credential isolation and the changelog-diff trigger keep the trust and re-trigger semantics correct for multi-tenant installs.
- (-) Dependence on the Atlassian Remote MCP server. If it is gated/preview or changes its contract, outbound progress comments break until a `jira_reactions.py` REST fallback (Plan B) is written.
- (-) ADF→markdown is lossy by design (text/headings/lists only); rich content in descriptions is flattened.
- (!) `cloudId` must be used consistently as the tenant key. Indexing on domain or site name anywhere would break tenant resolution.
- (!) The webhook signing secret lives on the per-tenant OAuth bundle; rotating it in Jira without re-running `bgagent jira setup` causes silent 401s on every delivery.

## References

- Issue: [#288 — Jira Cloud integration (parity with Linear)](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/288)
- [JIRA_SETUP_GUIDE.md](/using/jira-setup-guide) — operational walkthrough
- [LINEAR_SETUP_GUIDE.md](/using/linear-setup-guide) — the analog integration this mirrors
- Reference implementation: `cdk/src/constructs/jira-integration.ts`, `cdk/src/handlers/jira-*.ts`, `agent/src/channel_mcp.py`
