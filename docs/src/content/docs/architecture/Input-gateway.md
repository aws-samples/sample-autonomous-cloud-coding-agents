---
title: Input gateway
---

# Input Gateway

## What is the Input Gateway?

The **input gateway** is the single entry point through which all user interactions reach the background agents platform. It sits between external **channels** (CLI, Slack, future: web UI, GitHub Actions, etc.) and the rest of the system (task creation, orchestration, agent execution).

Users interact in different ways: from a terminal with a CLI, from Slack with a message or button, or later from a web dashboard or a webhook. Each channel has its own:

- **Authentication** (e.g. Cognito JWT for CLI, Slack signing secret for Slack)
- **Message shape** (Slack block kit, CLI flags, web form JSON)
- **Constraints** (Slack expects a response within 3 seconds; CLI is synchronous HTTP)

The input gateway’s job is to **adapt** these differences so the rest of the platform stays channel-agnostic. It:

1. **Accepts** requests from any enabled channel.
2. **Verifies** the request (auth, signatures, tokens).
3. **Normalizes** the channel-specific payload into a single **internal message format**.
4. **Validates** the normalized message (required fields, allowed values, no malformed or unsafe input).
5. **Dispatches** the validated message into the task pipeline (e.g. create task, cancel task, approve, or other actions).

When the system sends information back to the user (e.g. task status, completion, errors), the same gateway concept applies in the **outbound** direction: the core produces a single **internal notification format**, and channel-specific adapters **render** and **send** that content in the right form for each channel (Slack blocks, CLI output, email, etc.). So “input gateway” is often used to mean both inbound normalization and outbound rendering, even though outbound may be implemented separately.

In short: **every input channel connects through this central point; the gateway turns many channel formats into one internal contract.**

---

## Requirements

### Inbound (requests from users)

- **Single entry point**
  All channels must go through the gateway. No channel should talk directly to task storage or orchestration.

- **Channel-specific authentication and verification**
  Each channel has its own way to prove legitimacy (Cognito JWT, Slack signing secret, webhook secrets, etc.). The gateway (or per-channel adapters) must verify every request before processing.

- **Normalization to an internal message schema**
  Every channel-specific payload must be transformed into the same internal message structure. The rest of the system only ever sees this normalized form.

- **Validation**
  The gateway must validate normalized messages (required fields, types, allowed actions, target repo/issue refs, size limits) and reject malformed or invalid requests with clear errors. Task descriptions are additionally screened by Amazon Bedrock Guardrails for prompt injection at submission time (fail-closed). See [SECURITY.md](/architecture/security).

- **Access control**
  The gateway enforces who can do what (e.g. only the task owner can cancel; only authenticated users can create tasks). This may be defined per channel or globally.

- **Support for multiple action types**
  At minimum: create task, get task(s), cancel task. If the product supports human-in-the-loop, add approve/reject and possibly free-form message. The internal schema must represent these distinctly.

- **Multi-modal input**
  Users can send text and, where the channel allows it, images or other attachments. The internal message format must carry these in a channel-agnostic way (e.g. type + URL or inline data).

- **Channel metadata preservation**
  Enough channel-specific metadata (e.g. Slack channel + thread, CLI request id) must be stored with the task so that outbound notifications can be delivered to the right place.

### Outbound (notifications to users)

- **Single internal notification format**
  The core emits one canonical structure for all outbound events (e.g. status change, task completed, error, approval requested). Channel adapters consume only this.

- **Channel-specific rendering and delivery**
  Each channel gets a renderer that turns the internal notification into the right format (Slack blocks, CLI text, email HTML, etc.) and sends it using the channel’s API or protocol.

- **Routing and preferences**
  The system must know where to send notifications (e.g. only to the channel the task was created from, or to multiple channels per user preferences). Routing rules are part of the gateway/notification design, not of the core task logic.

### User channel preferences (future)

When a user submits a task from one channel (e.g. Slack), they may want notifications (task completed, errors, approval requests) delivered to other channels too (e.g. CLI, email, or a different Slack channel). The plans describe a **per-user notification preference** model:

- **Which channels** receive notifications (e.g. only the originating channel, or a list such as Slack + CLI).
- **Per-channel configuration**  - e.g. Slack channel ID or DM flag, email address, so that outbound adapters know where to send.
- **Per-channel filters**  - e.g. send only approval_request and task_completed to Slack, but all events to CLI.

MVP can use **implicit routing**: send notifications only to the channel the task was submitted from (stored as `channel_source` on the task), plus any always-on channel (e.g. real-time API for CLI). A **UserPreferences** store (e.g. DynamoDB table keyed by `user_id`) can hold `notification_channels`, `channel_configs`, and `notification_filters` so that outbound adapters can route each notification to the right set of channels per user.

### Cross-cutting

- **Extensibility**
  Adding a new channel should require only new adapter(s) and configuration (routes, secrets). Core task pipeline, storage, and orchestration should not change.

- **Browser extension channel**
  A lightweight Chrome/Firefox extension can let users trigger tasks directly from the browser (e.g. while viewing a GitHub issue page, click a button to submit it as a task). The extension can call the existing webhook API with the current page's issue URL, requiring minimal new infrastructure. The extension authenticates via the user's existing webhook credentials or via OAuth to obtain a JWT. From the gateway's perspective, this is another channel adapter that produces the same internal message format. No core pipeline changes are needed.

- **Consistency with product scope**
  If deployment supports a single channel (e.g. CLI only), the gateway should still remain the place where additional channels plug in, so that adding Slack, browser extensions, or others is an extension, not a rewrite.

---

## Internal Message Schema (Inbound)  - Concept

The gateway defines a single **internal message** format that all channels produce. The rest of the system (task creation, orchestration) depends only on this. The following is a conceptual schema, not an implementation spec.

- **Message identity**
  A unique id (e.g. ULID) for deduplication and tracing.

- **Channel source**
  Which channel the message came from (e.g. `api`, `webhook`, `slack`, `web`, `github_actions`).

- **Channel metadata**
  Opaque or structured data needed to route replies (e.g. Slack channel id, thread ts; CLI session or request id). Stored with the task for outbound.

- **User identity**
  A stable platform user id (e.g. Cognito sub or mapped id). All channels must map to this so authorization and “my tasks” work consistently.

- **Action type**
  One of: create task, get task(s), get one task, cancel task, approve/reject (if HITL), or other defined actions.

- **Payload**
  Action-specific data, for example:
  - **Create task:** user message text, repo URL or org/repo, issue/PR ref (e.g. issue number), optional attachments (images, files) with type and URL or inline data.
  - **Cancel / approve:** task id, and for approve: approval decision and optional response text.

Validation rules (e.g. required fields per action, max message length, allowed URL schemes) apply to this normalized payload.

---

## Internal Notification Schema (Outbound)  - Concept

When the core needs to notify the user, it produces a single **internal notification** format. Channel adapters turn this into Slack messages, CLI output, emails, etc.

- **Notification identity**
  Unique id for the notification.

- **Task and user**
  Task id and user id so adapters can route and filter.

- **Notification type**
  E.g. status change, task completed, error, approval requested, log or progress update.

- **Payload**
  Type-specific content: status value, short message, approval question, PR URL, error message, log snippet, etc.

Adapters are responsible for rendering this into channel-specific formats (e.g. Slack Block Kit, plain text for CLI) and delivering via the channel’s API or protocol.

---

## Examples

### Example 1: User submits a task from the CLI

- User runs: `bgagent submit --repo org/myapp --issue 42` (and optionally adds a message or attachment).
- The CLI sends an HTTP request to the gateway with Cognito JWT.
- **Gateway (inbound):**
  - Verifies the JWT.
  - Normalizes the request into the internal message: action = create task, repo = org/myapp, issue_ref = 42, user message from args, channel_source = cli, user_id from JWT.
  - Validates required fields and allowed values.
  - Dispatches to the task pipeline (create task).
- The task pipeline creates the task and starts orchestration. Later, when status changes or the task completes, the core emits internal notifications.
- **Gateway (outbound):**
  In MVP with CLI-only, “outbound” may be implicit (e.g. user polls `GET /tasks/{id}` and sees status in the response). When push is added, an adapter could stream or push these notifications to the CLI (e.g. over WebSocket or SSE).

### Example 2: User checks status from the CLI

- User runs: `bgagent status abc-123`.
- CLI sends `GET /tasks/abc-123` with Cognito JWT.
- **Gateway:**
  Verifies JWT, normalizes to internal “get one task” action with task_id = abc-123 and user_id from JWT, validates, dispatches. The handler loads the task, enforces that the user owns it, and returns status (and optionally PR URL, error message, etc.) in a consistent response format. The CLI renders that as text.

### Example 3: User cancels a task

- User runs: `bgagent cancel abc-123`.
- **Gateway:**
  Verifies JWT, normalizes to “cancel task” with task_id and user_id, validates ownership (or delegates to a downstream service), dispatches. The task pipeline marks the task cancelled and stops the agent run. Outbound notifications (if any) can inform the user that the task was cancelled.

### Example 4: Future  - User submits a task from Slack

- User sends: “Implement the feature from issue #42 in org/myapp” in a Slack channel (or via a slash command).
- Slack sends an HTTP POST to the gateway (e.g. `/channels/slack/events`) with its own signing and payload.
- **Gateway (inbound):**
  Verifies Slack signing secret, normalizes to the same internal message: action = create task, repo = org/myapp, issue_ref = 42, user message from Slack text, channel_source = slack, channel_metadata = { channel_id, thread_ts }, user_id = mapped from Slack user (e.g. via a Slack→Cognito or Slack→platform-user mapping). Validates and dispatches.
- **Gateway (outbound):**
  When the task completes or needs approval, the core emits an internal notification. The Slack adapter renders it (e.g. Block Kit with “Task completed” and PR link, or approval buttons), and sends it to the right channel/thread using the stored channel_metadata.

### Example 5: Same user, different channels

- User creates a task from Slack, then later runs `bgagent status abc-123` from the CLI.
- The gateway ensures the same internal user identity for both channels (via Slack→platform user mapping and Cognito). So “my tasks” and “cancel my task” work regardless of which channel is used. Notifications can be sent to the originating channel (Slack) and/or to the CLI if the user is subscribed, depending on product and routing rules.

---

## Summary

- **Role**  - Single entry point for all user-facing channels; adapts many formats to one internal contract.
- **Inbound**  - Verify → normalize → validate → dispatch. All channels produce the same internal message schema.
- **Outbound**  - Core emits one internal notification schema; channel adapters render and send per channel.
- **Requirements**  - Per-channel auth, normalization, validation, access control, multi-modal payloads, channel metadata for routing.
- **Extensibility**  - New channel = new adapter(s) and config; core task pipeline and storage stay unchanged.

This document describes the **input gateway’s purpose, requirements, and examples only**. It does not specify implementation (e.g. API Gateway, Lambda, SQS, or specific technologies); those belong in the architecture and implementation docs.
