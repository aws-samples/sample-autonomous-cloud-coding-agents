---
title: "ADR-018: Linear agent-session as a future interaction channel"
---

**Status:** accepted — Phase 2 implemented behind a flag (#990, 2026-11-04)
**Date:** 2026-06-17 · amended 2026-11-04

## Context

ABCA's Linear integration today triggers and reports work through a
**hand-rolled comment protocol** layered on Linear's generic Issue/Comment
webhooks:

- **Trigger** — a string match on `@bgagent` in a `Comment` webhook body
  (`parseCommentTrigger`), plus a label-add on an issue to seed a
  sub-issue orchestration.
- **Acknowledgement** — emoji reactions managed by hand (👀 on receipt →
  ✅/❌ on settle via `swapCommentReaction`/`swapIssueReaction`), threaded
  replies (`replyToComment`), and a single maturing "epic panel" comment
  edited in place (`upsertEpicPanel`).

This protocol works and is now well-tested, but the comment seam has been
the single richest source of edge-case bugs:
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
   against a deployed dev stack: every deployed workspace
   token carries exactly
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

The orchestration **engine** is channel-agnostic by design (its
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
| "reply with guidance" retry          | `elicitation` + `prompted` webhook + conversation history |
| panel header state (🔄/✅/⚠️)        | session state (active/complete/error) |

### Preview-API spike

A time-boxed, no-infra spike validated the API surface against the deployed
**app-actor** token (the `bgagent` app in a real workspace) — read-only schema
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

Net (first pass): the spike de-risked reachability + the activity model and
pinpointed the single enablement step, without committing to migration.

**Spike re-run, after the app owner enabled "Agent session events"
— the core risk is RESOLVED end-to-end:**

- `agentSessionCreateOnIssue` now succeeds → session `status: active`.
- **The 10s-vs-long-compute question is answered:** emit a `thought` at t+0
  (status `active`), then **wait 14s with no further activity** → session
  **stays `active`** (not stale/unresponsive). The 10s rule governs only the
  *initial* ack; once a `thought` lands, an arbitrarily long gap before the
  next activity is fine. ABCA's webhook can emit the `thought` synchronously
  (exactly like today's 👀) and let the >10s async spawn proceed — **no
  architectural conflict.**
- **Full lifecycle derives correctly**, matching the mapping table below:
  `thought`→active, `action`→active, `action`+result→active,
  `response`→**complete**; on a second session `elicitation`→**awaitingInput**,
  `error`→**error**. All five emittable types accepted; states auto-derive
  from the last activity. (`AgentActivityContent` is a union —
  `AgentActivityActionContent`/`…ElicitationContent`/`…ErrorContent`/etc. — so
  each type persists as a distinct typed record.)

Conclusion: the **trigger/ack half is fully validated** against the live
Preview API. The remaining gate for an actual additive channel is unchanged —
it's the per-issue-session vs. cross-issue-epic-rollup gap (engine stays ours)
plus the Preview→GA stability wait, NOT any technical blocker we found. The
spike issues were created + deleted; no migration code written.

> **⚠️ The enablement toggle is NOT a side-effect-free no-op.**
> Leaving "Agent session events" ON after the spike means **every `@bgagent`
> mention now also spawns a native agent session** that Linear expects answered
> via `agentActivityCreate` within 10s. Our deployed code answers on the
> **comment** path (👀 + reply) and emits no session activity, so the session
> gets zero activities, goes `stale`, and Linear surfaces a misleading
> **"bgagent did not respond"** banner — even though the comment reply posted
> fine (observed in live use: reply at t+2s, session `stale`, activities
> `[]`). **Consequence for phasing:** adoption is *not* "additive alongside the
> comment path for free" — once the toggle is on, mentions route to sessions
> and the adapter MUST emit activities or every mention looks dead. So the
> toggle stays **OFF** until the flag-gated adapter (Phase 2 below) ships in the
> same change that flips it. Interim action after the spike: **turn the toggle
> off** (app owner, Settings → API → Applications).

### Why a channel, not a rewrite

- The win is **real but partial**: agent sessions retire the brittle
  *trigger + per-comment ack* seam (the bug class above), but Linear agent
  sessions are **per-issue delegations with no native cross-issue epic
  rollup**. The parent-epic panel, fan-out integration node, dependency
  cascade, and base-branch stacking stay ABCA's responsibility either way —
  so roughly half of the recent bug classes (panel settle, cross-issue
  concurrency) are unaffected by the migration.
- The Agents API is a **Developer Preview** (confirmed against
  `developers.linear.app`): "in active development… may change
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
   with the comment path on a dev stack.
3. **After evaluation:** if the native path is strictly better, default the
   flag on and deprecate the `@bgagent` string-match trigger; keep the
   panel/rollup engine.

## Amendment (2026-11-04, #990): Phase 2 ships during the Preview

Phase 2 was planned for after Linear's Agents API reached GA. It ships earlier, during the Developer Preview, because:

- The approved issue (#990) asks for it.
- The spike above already proved the full lifecycle end to end against the live API.
- The flag keeps the Preview risk contained. The flag is off by default; with it off, a stack synthesizes and behaves exactly as before. Rollback is untick *Agent session events* and redeploy without the flag.

The GA wait still applies to **Phase 3**: defaulting the flag on and deprecating the `@bgagent` string match.

**Flag (ADR-006).**

- **Name:** `--context enableLinearAgentSessions=true`. This sets `LINEAR_AGENT_SESSIONS_ENABLED=true` on the Linear webhook receiver, the processor and the fan-out consumer.
- **Owner:** #990.
- **Removal:** the Phase 3 change, which removes the flag together with the string-match trigger. Re-evaluate at Linear's Agents API GA.
- **Coupling:** the flag must be flipped together with the Linear app's *Agent session events* toggle, for the reason in the ⚠️ note above.

**How the channel maps onto the engine.**

| Linear | ABCA |
|---|---|
| `created` (mention / delegation) | An immediate `thought`, then `createTaskCore`: `coding/new-task-v1` from the mention's instruction and `promptContext` (which already carries the issue, so the fetched description is only the fallback when it is absent). `promptContext` includes other people's comments, so it is screened by the guardrail on its own first and dropped if it is blocked or cannot be screened, as the label path does with comments; the task then proceeds from the instruction and the fetched issue, which `createTaskCore` screens fail-closed. Or or `coding/pr-iteration-v1` when the issue already has an ABCA PR and the mention carries an instruction. The task's `channel_metadata.linear_agent_session_id` ties it to the session. |
| `prompted` while the task runs | Forwarded to the running agent as a nudge. This goes through the same `submitNudge` core as `POST /tasks/{id}/nudge`: guardrail screening fails closed, with the same per-minute limit. As with that API, only the task's owner can nudge. A request arriving in a session other than the task's own gets a final `response`, so it never hangs. |
| `prompted` after the task finished | A follow-up task, with the same rules as `created`. An answer to a clarify hold resumes the original request (`buildClarifyResumeDescription`). |
| `prompted` with `signal: stop` | `cancelTask` (the CANCELLED transition and the `task_cancelled` event in one transaction, retried on a `TransactionConflict` with a concurrent write to the task row), then `stopTaskCompute`, then a final `response`. This is the same core as `DELETE /tasks/{id}`, and like it only the task's owner can stop. Stopping the compute matters: on the record change alone the agent finishes its turn and can push after "Stopped". The stop's own `task_cancelled` stamps the session's post-once marker, so a later terminal event for the task does not post a second close. Orchestration children are refused, because the epic owns their lifecycle. |
| `pr_created` milestone | `agentSessionUpdate.addedExternalUrls` (the PR), plus an `action` activity. Each has its own post-once marker, so a retry neither duplicates the link nor skips a failed one. |
| `agent_turn` | One ephemeral `thought` per 10 minutes, claimed by a conditional write on the task record, so a long run never goes `stale` (30 min idle). The dispatcher remembers per container which tasks are session tasks and when their window was claimed, so per-turn events for other tasks, and turns inside the window, cost no task read. |
| task queued on the concurrency cap | A `thought` in the session instead of the issue comment the comment channel posts. |
| a refusal (unlinked user, non-owner steer or stop) | A `response`, which also closes the session as a refused stop requires. The one exception is the session a running task reports into: session state follows the last activity, so a closing or `error` activity there would mark the owner's healthy run as finished or failed. There the refusal is a `thought`, and the task's own final activity still closes the session. |
| terminal task event | One `response` / `elicitation` / `error` with the comment channel's final-status body. It is post-once via the existing fan-out markers. |

**Boundaries kept from the original decision.**

- **Epics and started orchestration children stay on the comment path.** The session handler applies the same membership test the comment trigger routes on, and defers with a `response`.
- **Standalone `@bgagent` comments yield to the session only in workspaces that deliver sessions.** The session answers the same mention, and acting on both would start two tasks. But the flag is stack-wide while Linear's *Agent session events* toggle is per app installation, so yielding on the flag alone left a mention unanswered wherever the toggle was off. The processor therefore stamps `agent_sessions_seen_at` on a workspace's registry row when it delivers an `AgentSessionEvent` (refreshed at most once a day), and the comment trigger yields only while that timestamp is less than 14 days old. Otherwise it answers exactly as with the flag off.
  - *The evidence expires because Linear sends nothing when the toggle is turned off.* A marker that lasted forever would keep yielding to sessions that no longer open. With expiry, a workspace that turns the toggle off gets its comment trigger back within 14 days; to restore it at once, remove `agent_sessions_seen_at` from the workspace's registry row.
  - *The cost of expiry* falls on a workspace that sends no session event for 14 days: its next mention may be answered by the comment trigger as well as the session. That is visible and corrects itself on that mention; a lost mention is neither.
  - *The yield depends on mention sessions reaching the processor.* A yielded mention is answered only by its session, so this change must not deploy ahead of the WAF fix in #1065 (see known gaps).
  - The very first mention in a newly toggled workspace can race (the comment may be processed before the session event stamps the row), so the setup guide has operators delegate one issue first. A `@bgagent` typed as plain text, which is not a mention and opens no session, is still left alone in a marked workspace.
- **Decisions use the base-table row.** "Running or finished?", the owner and the clarify state are read from the task row with a strongly consistent read, never from the eventually consistent `LinearIssueIndex`. The index still chooses *which* row, and it can lag a task created a moment ago. So the handler also writes a short-lived session → task pointer (webhook dedup table, read consistently) once `createTaskCore` has created the task, and takes the newer of the two candidates. It is written only for a task that exists: after a 201, or with the original task's id when a redelivery is an idempotent replay. A pointer to an id that was never created would hide the real task from the lookups it serves. Without it, a prompt or Stop within about a second of `created` started a second task or answered "nothing was running". A task with no recorded workspace (an older row) counts as the issue's task; only a different workspace is rejected.
- **One project-mapping check for both channels.** The label trigger and the session handler share `lookupLinearProjectMapping`, so they admit the same issues, including mappings written before the owning workspace was recorded.
- **No new AWS resources; the processor's role grows, only with the flag on.** It gains `PutItem`/`UpdateItem` on the nudges table, `PutItem` on the webhook dedup table (the pointer above), and the stop actions the cancel API holds, scoped the same way: `bedrock-agentcore:StopRuntimeSession` on the runtime, `ecs:StopTask` conditioned on the cluster, `lambda:TerminateMicrovm` on the platform image, each only when that backend is deployed. This role parses attacker-supplied attachments, which is why its grants are argued down elsewhere. These are stop actions only: the worst a compromised processor gains is cancelling running tasks, and a Stop that leaves the agent running was judged the worse failure.

**Deliberate differences from the comment path.**

- **Attribution.** A session task is attributed to the linked user who made the request, not to the original task's requester. This matches the identity split in #786: the human actor is the task owner.
- **Attachments.** Session-triggered tasks do not hydrate issue attachments yet.
- **First-activity latency.** The ack is emitted after the processor's cold start and token resolution. Review measured 4–7 s for the first ack after a deploy and 0.7–1.5 s warm, inside the 10 s budget but not comfortably. Opt-in provisioned concurrency on the receiver and processor is the mitigation, and is not part of this change.
- **Issue reactions.** The agent posts no 👀/✅/❌ reactions on a session task, since the session shows that state. It still moves the issue's workflow state.

**Known gaps (follow-ups).**

- **WAF blocks @-mention sessions — fixed separately in #1065, which must merge first.** Reported from live runs during review of #991, not reproduced for this change: a mention-created session carries XML-like `promptContext` (`<issue identifier=…>`), which trips `CrossSiteScripting_BODY` on `/v1/linear/webhook`, so the request is rejected before the receiver runs. Delegation is unaffected. On its own that only loses mention sessions. Combined with the per-workspace yield above it loses the mention entirely: once a workspace has delivered one session (a delegation is enough), the comment trigger leaves standalone mentions to a session the WAF never lets through. #1065 counts `CrossSiteScripting_BODY` and `SizeRestrictions_BODY` on the signed webhook routes instead of blocking, and alarms on the counted label.
- **A queued session can go stale.** The queued `thought` is posted once. A task that waits more than 30 minutes for a slot gets no further activity until it starts, because the `agent_turn` keep-alive only fires once the agent runs.
- **A follow-up after the PR leaves the issue in "In Review".** The agent's start transition does not move an issue backwards within the same state type.

## Out of scope (this ADR)

- Any implementation. This is a direction + go/no-go record only.
- Changes to the orchestration engine, OAuth/token storage (done, ADR-016
  governs pluggable identity), or the Slack/Jira channels.

## References

- `cli/src/linear-oauth.ts` — `actor=app`, `app:assignable`/`app:mentionable`
- `cdk/src/handlers/linear-webhook-processor.ts` — current comment trigger + acks
- ADR-006 (feature flags), ADR-015 (Jira integration), ADR-016 (pluggable identity and auth)
- Linear Agents API — `https://linear.app/developers/agents`,
  `https://linear.app/developers/agent-interaction` (Developer Preview)
