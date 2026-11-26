# ADR-018: Linear agent-session as a future interaction channel

**Status:** accepted — Phase 2 implemented behind a flag (#990, 2026-11-04)
**Date:** 2026-06-17 · amended 2026-11-04
**Last-updated:** 2026-11-26

## Context

ABCA's Linear integration today triggers and reports work through a **hand-rolled comment protocol** layered on Linear's generic Issue and Comment webhooks:

- **Trigger.** A string match on `@bgagent` in a `Comment` webhook body (`parseCommentTrigger`), plus a label-add on an issue to seed a sub-issue orchestration.
- **Acknowledgement.** Emoji reactions managed by hand (👀 on receipt, then ✅ or ❌ on settle, through `swapCommentReaction` and `swapIssueReaction`), threaded replies (`replyToComment`), and a single maturing "epic panel" comment edited in place (`upsertEpicPanel`).

This protocol works and is now well-tested, but the comment seam has been the largest single source of edge-case bugs: reply `issueId` versus `parentId` rules, "parent comment must be top-level" threading, webhook-redelivery reply spam, self-trigger loops from our own `@bgagent` example text, and reaction and state flapping. Each bug was a consequence of layering an agent protocol on comments meant for people.

Linear now ships a first-class **Agents API** (the agent-session model). A user delegates to, or @mentions, an installed agent app. Linear sends a typed `AgentSessionEvent` webhook (`created` or `prompted`). The agent emits typed **activities** (`thought`, `action`, `response`, `elicitation`, or `error`), and Linear derives a native session **state** (`pending`, `active`, `awaitingInput`, `error`, `complete`, or `stale`) with a built-in "thinking" and activity UI.

Two facts establish the starting point:

1. **The auth migration is already done.** ABCA's OAuth flow (`cli/src/linear-oauth.ts`) requests `read write app:assignable app:mentionable` with `actor=app`. A check against a deployed dev stack verified that every deployed workspace token carries exactly that scope. **bgagent is already installed as an app actor.** It is assignable, mentionable, and delegatable today. No auth work is needed to adopt agent sessions.
2. **Linear is an interaction layer, not compute.** Adopting agent sessions changes *how we are triggered* and *how status is shown*. All compute (clone, run the coding agent, build and test, open the PR) still runs on ABCA's own AgentCore Runtime and ECS. The switch offloads nothing to Linear and does not change the AWS architecture or cost model.

## Decision

**Adopt the Linear agent-session model as an ADDITIONAL, flag-gated trigger and ack channel once Linear marks the Agents API GA. Do not adopt it now, and do not adopt it as a replacement for the comment path.**

The orchestration **engine** is channel-agnostic by design, through its trigger-agnostic seams. Graph discovery, the reconciler, the epic panel and rollup, base-branch stacking, and the cascade work the same however a task was triggered. Agent sessions become a new front end to that engine and map onto what we already built:

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

A time-boxed, no-infra spike validated the API against the deployed **app-actor** token (the `bgagent` app in a real workspace). The spike used read-only schema probes and mutation input validation, with no migration code:

- **API reachable by our token.** Introspection confirms `agentActivityCreate`, `agentSessionCreateOnIssue`/`OnComment`/`Create`, `AgentSession` (fields including `status`, `issue`, `comment`, `appUser`), and `AgentActivityType` = `thought, action, response, elicitation, error, prompt`, exactly as the docs describe.
- **Activity input shape verified callable.** `agentActivityCreate(input:
  {agentSessionId, content: JSONObject, signal, ephemeral})` accepts our
  `{type:'thought', body}` content. A call failed only on session-id lookup, not on schema or enablement, so the ack-emission half of the loop is proven.
- **BLOCKER (config, not code).** `agentSessionCreateOnIssue` returns `"Agent sessions are not enabled for this application."` The bgagent OAuth app has the scopes and `actor=app` but has **not been enabled as an agent** in its Linear Application settings. Per the docs, to enable it you edit the app at *Settings → API → Applications*, enable webhooks, and select the **"Agent session events"** category. This is an app-owner action. The docs mention no waitlist.
- **The 10s-ack-vs-long-compute risk is therefore NOT yet proven end-to-end.** The proof needs a real `agentSessionId`, which is gated on the enablement toggle above. The pieces that the proof depends on (an immediate `thought` ack, then later `action` and `response` activities) are individually confirmed callable. The one remaining unknown is whether Linear marks the session unresponsive if our spawn exceeds 10s after the initial `thought`. The docs say that the `thought` ack within 10s is sufficient. Our processor can emit that ack synchronously before the async spawn, the same shape as today's 👀.

In the first pass, the spike reduced the risk in reachability and the activity model and identified the single enablement step, without committing to migration.

**Spike re-run, after the app owner enabled "Agent session events". The core risk is RESOLVED end-to-end:**

- `agentSessionCreateOnIssue` now succeeds, and the session has `status: active`.
- **The 10s-vs-long-compute question is answered.** The spike emitted a `thought` at t+0 (status `active`), then **waited 14s with no further activity**. The session **stayed `active`** (not stale or unresponsive). The 10s rule governs only the *initial* ack. Once a `thought` lands, an arbitrarily long gap before the next activity is fine. ABCA's webhook can emit the `thought` synchronously (exactly like today's 👀) and let the async spawn, which takes more than 10s, proceed. There is **no architectural conflict.**
- **Full lifecycle derives correctly**, matching the mapping table below: `thought`→active, `action`→active, `action`+result→active, `response`→**complete**. On a second session, `elicitation`→**awaitingInput** and `error`→**error**. All five emittable types were accepted. States auto-derive from the last activity. `AgentActivityContent` is a union (`AgentActivityActionContent`, `…ElicitationContent`, `…ErrorContent`, and others), so each type persists as a distinct typed record.

The conclusion is that the **trigger and ack half is fully validated** against the live Preview API. The remaining gate for an actual additive channel is unchanged. The gate is the gap between per-issue sessions and the cross-issue epic rollup (the engine stays ours), plus the stability wait from Preview to GA. It is NOT any technical blocker that we found. The spike issues were created and deleted. No migration code was written.

> **⚠️ The enablement toggle is NOT a side-effect-free no-op.**
> Leaving "Agent session events" ON after the spike means that **every `@bgagent` mention now also spawns a native agent session**, which Linear expects to be answered through `agentActivityCreate` within 10s. Our deployed code answers on the **comment** path (👀 and a reply) and emits no session activity. The session therefore gets zero activities and goes `stale`, and Linear shows a misleading **"bgagent did not respond"** banner, even though the comment reply posted correctly. Live use showed a reply at t+2s, session `stale`, and activities `[]`. **Consequence for phasing.** Adoption is *not* "additive alongside the comment path for free". Once the toggle is on, mentions route to sessions, and the adapter MUST emit activities or every mention looks dead. The toggle therefore stays **OFF** until the flag-gated adapter (Phase 2 below) ships in the same change that flips it. Interim action after the spike: **turn the toggle off** (app owner, Settings → API → Applications).

### Why a channel, not a rewrite

- The benefit is **real but partial**. Agent sessions retire the brittle *trigger + per-comment ack* seam (the bug class above), but Linear agent sessions are **per-issue delegations with no native cross-issue epic rollup**. The parent-epic panel, fan-out integration node, dependency cascade, and base-branch stacking stay ABCA's responsibility either way. Roughly half of the recent bug classes (panel settle, cross-issue concurrency) are therefore unaffected by the migration.
- The Agents API is a **Developer Preview** (confirmed against `developers.linear.app`): "in active development… may change before GA." Removing a working, now-hardened comment path to depend on an unstable API is the wrong trade today.
- Treating it as an additive channel behind a flag (per ADR-006) lets us reuse the channel-agnostic engine, run both paths side by side during evaluation, and revert through the flag if the Preview API changes.

## Consequences

- **Positive.** The decision removes the highest-friction seam (the string-match trigger plus hand-rolled threading and reactions). It adds a native progress UI. Conversation-history retry replaces our bespoke loop. No auth work is needed, because bgagent is already an app actor.
- **Negative or risk.** The Preview API may churn. There are hard runtime constraints. The webhook receiver must return within about 5s. An activity or external URL must be emitted within about 10s of `created`, or the session is marked unresponsive. ABCA's task spawn is async and slower than 10s, so the `created` handler must emit an immediate `thought` ack and hand off, exactly as the current processor posts 👀 and then spawns.
- **Unchanged parts.** This decision does not touch the orchestration engine, the panel and rollup renderer, the reconciler, the cascade, or the base-branch logic.

## Phasing

1. **Now (this ADR).** Record the decision. Auth is verified. Do not build. Keep the hardened comment path as the sole Linear interaction channel.
2. **When Linear makes the Agents API GA.** Spike a flag-gated `agent-session` trigger and ack adapter behind the existing channel-agnostic engine. The adapter maps `created` to seed or iterate, and maps activities to and from our ack states. It runs in parallel with the comment path on a dev stack.
3. **After evaluation.** If the native path is strictly better, default the flag on and deprecate the `@bgagent` string-match trigger. Keep the panel and rollup engine.

## Amendment (2026-11-04, #990): Phase 2 ships during the Preview

Phase 2 was planned for after Linear's Agents API reached GA. It ships earlier, during the Developer Preview, for three reasons:

- The approved issue (#990) asks for it.
- The spike above already proved the full lifecycle end to end against the live API.
- The flag keeps the Preview risk contained. The flag is off by default. With the flag off, a stack synthesizes and behaves exactly as before. To roll back, untick *Agent session events* and redeploy without the flag.

The GA wait still applies to **Phase 3**, which defaults the flag on and deprecates the `@bgagent` string match.

**Flag (ADR-006).**

- **Name.** `--context enableLinearAgentSessions=true`. The flag sets `LINEAR_AGENT_SESSIONS_ENABLED=true` on the Linear webhook receiver, the processor and the fan-out consumer.
- **Owner.** #990.
- **Removal.** The Phase 3 change, which removes the flag together with the string-match trigger. Re-evaluate at Linear's Agents API GA.
- **Coupling.** The flag must be flipped together with the Linear app's *Agent session events* toggle, for the reason in the ⚠️ note above.

**How the channel maps onto the engine.**

| Linear | ABCA |
|---|---|
| `created` (mention / delegation) | An immediate `thought`, then `createTaskCore`: `coding/new-task-v1` from the mention's instruction and `promptContext`. `promptContext` already carries the issue, so the fetched description is only the fallback when `promptContext` is absent. `promptContext` includes other people's comments, so the guardrail screens it on its own first, and it is dropped if it is blocked or cannot be screened, as the label path does with comments. The task then proceeds from the instruction and the fetched issue, which `createTaskCore` screens fail-closed. The workflow is `coding/pr-iteration-v1` instead when the issue already has an ABCA PR and the mention carries an instruction. The task's `channel_metadata.linear_agent_session_id` ties it to the session. |
| `prompted` while the task runs | Forwarded to the running agent as a nudge. The nudge goes through the same `submitNudge` core as `POST /tasks/{id}/nudge`, so guardrail screening fails closed and the same per-minute limit applies. As with that API, only the task's owner can nudge. A request that arrives in a session other than the task's own gets a final `response`, so it never hangs. |
| `prompted` after the task finished | A follow-up task, with the same rules as `created`. An answer to a clarify hold resumes the original request (`buildClarifyResumeDescription`). |
| `prompted` with `signal: stop` | `cancelTask` (the CANCELLED transition and the `task_cancelled` event in one transaction, retried on a `TransactionConflict` with a concurrent write to the task row), then `stopTaskCompute`, then a final `response`. This path is the same core as `DELETE /tasks/{id}`, and as with that API only the task's owner can stop. Stopping the compute matters. With the record change alone, the agent finishes its turn and can push after "Stopped". The stop's own `task_cancelled` stamps the session's post-once marker, so a later terminal event for the task does not post a second close. Orchestration children are refused, because the epic owns their lifecycle. |
| `pr_created` milestone | `agentSessionUpdate.addedExternalUrls` (the PR), plus an `action` activity. Each has its own post-once marker, so a retry neither duplicates the link nor skips a failed one. |
| `agent_turn` | One ephemeral `thought` per 10 minutes, claimed by a conditional write on the task record, so a long run never goes `stale` (30 min idle). The dispatcher remembers per container which tasks are session tasks and when their window was claimed, so per-turn events for other tasks, and turns inside the window, cost no task read. |
| task queued on the concurrency cap | A `thought` in the session instead of the issue comment the comment channel posts. |
| a refusal (unlinked user, non-owner steer or stop) | A `response`, which also closes the session as a refused stop requires. The one exception is the session that a running task reports into. Session state follows the last activity, so a closing or `error` activity there would mark the owner's healthy run as finished or failed. There the refusal is a `thought`, and the task's own final activity still closes the session. |
| terminal task event | One `response`, `elicitation`, or `error` with the comment channel's final-status body. It is posted once, through the existing fan-out markers. |

**Boundaries kept from the original decision.**

- **Epics and started orchestration children stay on the comment path.** The session handler applies the same membership test the comment trigger routes on, and defers with a `response`.
- **Standalone `@bgagent` comments yield to the session only in workspaces that deliver sessions.** The session answers the same mention, and acting on both would start two tasks. But the flag is stack-wide while Linear's *Agent session events* toggle is per app installation, so yielding on the flag alone left a mention unanswered wherever the toggle was off. The processor therefore stamps `agent_sessions_seen_at` on a workspace's registry row when it delivers an `AgentSessionEvent` (refreshed at most once a day), and the comment trigger yields only while that timestamp is less than 14 days old. Otherwise it answers exactly as with the flag off.
  - *The evidence expires because Linear sends nothing when the toggle is turned off.* A marker that lasted forever would keep yielding to sessions that no longer open. With expiry, a workspace that turns the toggle off gets its comment trigger back within 14 days. To restore the comment trigger at once, remove `agent_sessions_seen_at` from the workspace's registry row.
  - *The cost of expiry* falls on a workspace that sends no session event for 14 days. Its next mention may be answered by the comment trigger as well as the session. That double answer is visible and corrects itself on that mention. A lost mention is neither visible nor self-correcting.
  - *The yield depends on mention sessions reaching the processor.* A yielded mention is answered only by its session, so this change must not deploy ahead of the WAF fix in #1065 (see known gaps).
  - The very first mention in a newly toggled workspace can race (the comment may be processed before the session event stamps the row), so the setup guide has operators delegate one issue first. A `@bgagent` typed as plain text, which is not a mention and opens no session, is still left alone in a marked workspace.
- **Decisions use the base-table row.** "Running or finished?", the owner and the clarify state are read from the task row with a strongly consistent read, never from the eventually consistent `LinearIssueIndex`. The index still chooses *which* row, and it can lag a task created a moment ago. The handler therefore also writes a short-lived pointer from session to task (webhook dedup table, read consistently) once `createTaskCore` has created the task, and takes the newer of the two candidates. The pointer is written only for a task that exists: after a 201, or with the original task's id when a redelivery is an idempotent replay. A pointer to an id that was never created would hide the real task from the lookups it serves. Without the pointer, a prompt or Stop within about a second of `created` started a second task or answered "nothing was running". A task with no recorded workspace (an older row) counts as the issue's task. Only a different workspace is rejected.
- **One project-mapping check for both channels.** The label trigger and the session handler share `lookupLinearProjectMapping`, so they admit the same issues, including mappings written before the owning workspace was recorded.
- **No new AWS resources. The processor's role grows, only with the flag on.** The role gains `PutItem` and `UpdateItem` on the nudges table, `PutItem` on the webhook dedup table (the pointer above), and the stop actions that the cancel API holds, scoped the same way: `bedrock-agentcore:StopRuntimeSession` on the runtime, `ecs:StopTask` conditioned on the cluster, and `lambda:TerminateMicrovm` on the platform image, each only when that backend is deployed. This role parses attacker-supplied attachments, and for that reason its grants are argued down elsewhere. These are stop actions only. The worst that a compromised processor gains is cancelling running tasks, and a Stop that leaves the agent running was judged the worse failure.

**Deliberate differences from the comment path.**

- **Attribution.** A session task is attributed to the linked user who made the request, not to the original task's requester. This matches the identity split in #786: the human actor is the task owner.
- **Attachments.** Session-triggered tasks do not hydrate issue attachments yet.
- **First-activity latency.** The ack is emitted after the processor's cold start and token resolution. Review measured 4–7 s for the first ack after a deploy and 0.7–1.5 s warm, inside the 10 s budget but not comfortably. Opt-in provisioned concurrency on the receiver and processor is the mitigation, and is not part of this change.
- **Issue reactions.** The agent posts no 👀, ✅, or ❌ reactions on a session task, because the session shows that state. It still moves the issue's workflow state.

**Known gaps (follow-ups).**

- **WAF blocks @-mention sessions. This is fixed separately in #1065, which must merge first.** The block was reported from live runs during review of #991 and was not reproduced for this change. A mention-created session carries XML-like `promptContext` (`<issue identifier=…>`), which trips `CrossSiteScripting_BODY` on `/v1/linear/webhook`, so the request is rejected before the receiver runs. Delegation is unaffected. On its own, the block loses only mention sessions. Combined with the per-workspace yield above, it loses the mention entirely. Once a workspace has delivered one session (a delegation is enough), the comment trigger leaves standalone mentions to a session that the WAF never lets through. #1065 counts `CrossSiteScripting_BODY` and `SizeRestrictions_BODY` on the signed webhook routes instead of blocking, and alarms on the counted label.
- **A queued session can go stale.** The queued `thought` is posted once. A task that waits more than 30 minutes for a slot gets no further activity until it starts, because the `agent_turn` keep-alive fires only once the agent runs.
- **A follow-up after the PR leaves the issue in "In Review".** The agent's start transition does not move an issue backwards within the same state type.

## Out of scope (this ADR)

- Any implementation. This ADR is a direction and go/no-go record only.
- Changes to the orchestration engine, to OAuth and token storage (done, and ADR-016 governs pluggable identity), or to the Slack and Jira channels.

## References

- `cli/src/linear-oauth.ts`. `actor=app`, `app:assignable`, and `app:mentionable`.
- `cdk/src/handlers/linear-webhook-processor.ts`. Current comment trigger and acks.
- ADR-006 (feature flags), ADR-015 (Jira integration), ADR-016 (pluggable identity and auth)
- Linear Agents API. `https://linear.app/developers/agents`, `https://linear.app/developers/agent-interaction` (Developer Preview).

## Changelog

- 2026-11-26 — Reworded for plain technical style: shorter sentences, no dashes as punctuation, one name for each thing. The decision and its facts are unchanged.
