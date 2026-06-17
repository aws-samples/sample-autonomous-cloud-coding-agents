---
title: Adr 017 linear agent session interaction
---

# ADR-017: Linear agent-session as a future interaction channel

**Status:** proposed
**Date:** 2026-06-17

## Context

ABCA's Linear integration today triggers and reports work through a
**hand-rolled comment protocol** layered on Linear's generic Issue/Comment
webhooks:

- **Trigger** — a string match on `@bgagent` in a `Comment` webhook body
  (`parseCommentTrigger`), plus a label-add on an issue to seed a #247
  orchestration.
- **Acknowledgement** — emoji reactions managed by hand (👀 on receipt →
  ✅/❌ on settle via `swapCommentReaction`/`swapIssueReaction`), threaded
  replies (`replyToComment`), and a single maturing "epic panel" comment
  edited in place (`upsertEpicPanel`).

This protocol works and is now well-tested (see the #247 UX.1–23 series),
but the comment seam has been the single richest source of edge-case bugs:
reply `issueId` vs `parentId` rules, "parent comment must be top-level"
threading, webhook-redelivery reply spam, self-trigger loops from our own
`@bgagent` example text, and reaction/state flapping. Each was a
consequence of bolting an agent protocol onto a human-comment surface.

Linear now ships a first-class **Agents API** (agent-session model):
delegate or @mention an installed agent app → a typed `AgentSessionEvent`
webhook (`created`/`prompted`) → the agent emits typed **activities**
(`thought` / `action` / `response` / `elicitation` / `error`) and Linear
derives a native session **state** (`pending`/`active`/`awaitingInput`/
`error`/`complete`/`stale`) with a built-in "thinking"/activity UI.

Two facts establish the starting point:

1. **The auth migration is already done.** ABCA's OAuth flow
   (`cli/src/linear-oauth.ts`) requests
   `read write app:assignable app:mentionable` with `actor=app`. Verified
   live on `backgroundagent-dev` (2026-06-17): both deployed workspace
   tokens (`bgagent-linear-oauth-maguireb`, `…-demo-abca`) carry exactly
   that scope. **bgagent is already installed as an app actor** — it is
   assignable, mentionable, and delegatable today. No auth work is needed
   to adopt agent sessions.
2. **Linear is an interaction layer, not compute.** Adopting agent sessions
   changes *how we are triggered* and *how status is shown*. All compute
   (clone, run the coding agent, build/test, open the PR) still runs on
   ABCA's own AgentCore Runtime + ECS. The switch offloads nothing to
   Linear and does not change the AWS architecture or cost model.

## Decision

**Adopt the Linear agent-session model as an ADDITIONAL, flag-gated
trigger/ack channel once Linear marks the Agents API GA — not now, and not
as a replacement for the comment path.**

The orchestration **engine** is channel-agnostic by design (the #247
trigger-agnostic seams): graph discovery, the reconciler, the epic
panel/rollup, base-branch stacking, and the cascade do not care how a task
was triggered. Agent sessions slot in as a new front end to that engine,
mapping cleanly onto what we already built:

| ABCA today (hand-rolled)            | Linear agent-session (native)     |
|-------------------------------------|-----------------------------------|
| `@bgagent` string match in comment  | `created` AgentSessionEvent (mention/delegate) |
| 👀 reaction "on it"                  | `thought` activity                |
| 🤖 Starting / 🔗 PR opened           | `action` activity (+ result)      |
| ✅ Updated / completion              | `response` activity               |
| ❌ failure reply                     | `error` activity                  |
| "reply with guidance" retry (UX.9)   | `elicitation` + `prompted` webhook + conversation history |
| panel header state (🔄/✅/⚠️)        | session state (active/complete/error) |

### Preview-API spike (2026-06-17, UX.24)

A time-boxed, no-infra spike validated the API surface against the deployed
**app-actor** token (`bgagent`, workspace `maguireb`) — read-only schema
probes + mutation input validation, no migration code:

- **API reachable by our token.** Introspection confirms `agentActivityCreate`,
  `agentSessionCreateOnIssue`/`OnComment`/`Create`, `AgentSession` (fields incl.
  `status`, `issue`, `comment`, `appUser`), and `AgentActivityType` =
  `thought, action, response, elicitation, error, prompt` — exactly the docs.
- **Activity input shape verified callable.** `agentActivityCreate(input:
  {agentSessionId, content: JSONObject, signal, ephemeral})` accepts our
  `{type:'thought', body}` content — a call failed only on session-id lookup,
  not schema/enablement, so the ack-emission half of the loop is proven.
- **BLOCKER (config, not code):** `agentSessionCreateOnIssue` returns
  `"Agent sessions are not enabled for this application."` The bgagent OAuth
  app has the scopes + `actor=app` but has **not been enabled as an agent** in
  its Linear Application settings. Per docs, enabling = edit the app at
  *Settings → API → Applications*, enable webhooks, and select the **"Agent
  session events"** category. App-owner action; no waitlist mentioned.
- **The 10s-ack-vs-long-compute risk is therefore NOT yet proven end-to-end** —
  it needs a real `agentSessionId`, which is gated on the enablement toggle
  above. The pieces it depends on (immediate `thought` ack, then later
  `action`/`response` activities) are individually confirmed callable; the
  remaining unknown is purely whether Linear marks the session unresponsive if
  our spawn exceeds 10s after the initial `thought` (docs say the `thought`
  ack within 10s is sufficient, which our processor can emit synchronously
  before the async spawn — same shape as today's 👀).

Net: the spike de-risked reachability + the activity model and pinpointed the
single enablement step, without committing to migration. Re-run the
session-create + timed-activity sequence once the app is enabled.

### Why a channel, not a rewrite

- The win is **real but partial**: agent sessions retire the brittle
  *trigger + per-comment ack* seam (the bug class above), but Linear agent
  sessions are **per-issue delegations with no native cross-issue epic
  rollup**. The #247 parent-epic panel, fan-out integration node, dependency
  cascade, and base-branch stacking stay ABCA's responsibility either way —
  so roughly half of the recent bug classes (panel settle, cross-issue
  concurrency) are unaffected by the migration.
- The Agents API is a **Developer Preview** (confirmed against
  `developers.linear.app`, 2026-06-17): "in active development… may change
  before GA." Ripping out a working, now-hardened comment path to depend on
  an unstable API is the wrong trade today.
- Treating it as an additive channel behind a flag (per ADR-006) lets us
  reuse the channel-agnostic engine, run both paths side by side during
  evaluation, and revert via the flag if the Preview API shifts.

## Consequences

- **Positive:** removes the highest-friction seam (string-match trigger +
  hand-rolled threading/reactions); native progress UI; conversation-history
  retry replaces our bespoke loop; no auth work (already app-actor).
- **Negative / risk:** Preview API churn; hard runtime constraints (webhook
  receiver must return within ~5s; an activity or external URL must be
  emitted within ~10s of `created` or the session is marked unresponsive) —
  ABCA's task spawn is async and slower than 10s, so the `created` handler
  must emit an immediate `thought` ack and hand off, exactly as the current
  processor 👀s then spawns.
- **No-op surfaces:** the orchestration engine, panel/rollup renderer,
  reconciler, cascade, and base-branch logic are untouched by this decision.

## Phasing

1. **Now (this ADR):** record the decision; auth verified; do not build.
   Keep the hardened comment path as the sole Linear interaction channel.
2. **When Linear GAs the Agents API:** spike a flag-gated `agent-session`
   trigger/ack adapter behind the existing channel-agnostic engine —
   `created`→seed/iterate, activities↔our ack states — running in parallel
   with the comment path on `backgroundagent-dev`.
3. **After evaluation:** if the native path is strictly better, default the
   flag on and deprecate the `@bgagent` string-match trigger; keep the
   panel/rollup engine.

## Out of scope (this ADR)

- Any implementation. This is a direction + go/no-go record only.
- Changes to the orchestration engine, OAuth/token storage (done, ADR-016
  governs pluggable identity), or the Slack/Jira channels.
- The Mode B planner (#299) — orthogonal.

## References

- `cli/src/linear-oauth.ts` — `actor=app`, `app:assignable`/`app:mentionable`
- `cdk/src/handlers/linear-webhook-processor.ts` — current comment trigger + acks
- ADR-006 (feature flags), ADR-015 (Jira integration), ADR-016 (pluggable identity and auth)
- Linear Agents API — `https://linear.app/developers/agents`,
  `https://linear.app/developers/agent-interaction` (Developer Preview, fetched 2026-06-17)
- #247 UX.16–23 — the comment-path bug classes this would retire
