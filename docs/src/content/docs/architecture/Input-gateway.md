---
title: "Input Gateway"
---

## What is the Input Gateway?

The **input gateway** is the single entry point through which all user interactions reach the background agents platform. It sits between the external **channels** and the rest of the system (task creation, orchestration, agent execution). The channels are the CLI and Slack, and in future others such as a web UI or GitHub Actions.

Users interact in different ways: from a terminal with a CLI, from Slack with a message or button, or later from a web dashboard or a webhook. Each channel has its own authentication, message shape, and constraints:

- **Authentication.** For example, a Cognito JWT for the CLI and a Slack signing secret for Slack.
- **Message shape.** Slack Block Kit, CLI flags, or web form JSON.
- **Constraints.** Slack expects a response within 3 seconds. The CLI uses synchronous HTTP.

The input gateway **adapts** these differences so that the rest of the platform stays channel-agnostic. For each request, the gateway does the following:

1. **Accepts** requests from any enabled channel.
2. **Verifies** the request (auth, signatures, tokens).
3. **Normalizes** the channel-specific payload into a single **internal message format**.
4. **Validates** the normalized message (required fields, allowed values, no malformed or unsafe input).
5. **Dispatches** the validated message into the task pipeline (for example create task, cancel task, approve, or other actions).

When the system sends information back to the user (for example task status, completion, or errors), the same gateway concept applies in the **outbound** direction. The core produces a single **internal notification format**, and channel-specific adapters **render** and **send** that content in the right form for each channel, such as Slack blocks, CLI output, or email. The term "input gateway" therefore often means both inbound normalization and outbound rendering, even though the outbound side may be implemented separately.

In short, **every input channel connects through this central point, and the gateway turns many channel formats into one internal contract.**

---

## Requirements

### Inbound (requests from users)

- **Single entry point**
  All channels must go through the gateway. No channel should talk directly to task storage or orchestration.

- **Channel-specific authentication and verification**
  Each channel has its own way to prove that a request is legitimate, such as a Cognito JWT, a Slack signing secret, or a webhook secret. The gateway (or per-channel adapters) must verify every request before processing it.

- **Normalization to an internal message schema**
  The gateway must transform every channel-specific payload into the same internal message structure. The rest of the system sees only this normalized form.

- **Validation**
  The gateway must validate normalized messages (required fields, types, allowed actions, target repo and issue refs, size limits) and reject malformed or invalid requests with clear errors. Amazon Bedrock Guardrails also screens task descriptions for prompt injection at submission time, and the screen fails closed. See [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security).

- **Access control**
  The gateway enforces who can do what. For example, only the task owner can cancel a task, and only authenticated users can create tasks. These rules may be defined per channel or globally.

- **Support for multiple action types**
  The minimum set is create task, get one or more tasks, and cancel task. If the product supports human-in-the-loop, add approve and reject, and possibly a free-form message. The internal schema must represent each action type distinctly.

- **Multi-modal input**
  Users can send text and, where the channel allows it, images or other attachments. The internal message format must carry these in a channel-agnostic way (for example as a type plus a URL or inline data).

- **Channel metadata preservation**
  Enough channel-specific metadata (for example the Slack channel and thread, or the CLI request id) must be stored with the task so that outbound notifications can be delivered to the right place.

### Outbound (notifications to users)

- **Single internal notification format**
  The core emits one canonical structure for all outbound events (for example status change, task completed, error, approval requested). Channel adapters consume only this structure.

- **Channel-specific rendering and delivery**
  Each channel has a renderer that turns the internal notification into the format of that channel, such as Slack blocks, CLI text, or email HTML, and sends it through the channel's API or protocol.

- **Routing and preferences**
  The system must know where to send notifications (for example only to the channel the task was created from, or to several channels according to user preferences). Routing rules are part of the gateway and notification design, not of the core task logic.

### User channel preferences (future)

A user who submits a task from one channel, for example Slack, may want notifications (task completed, errors, approval requests) delivered to other channels too, for example the CLI, email, or a different Slack channel. The plans describe a **per-user notification preference** model with three parts:

- **Which channels** receive notifications, for example only the originating channel, or a list such as Slack and the CLI.
- **Per-channel configuration.** For example, a Slack channel ID or DM flag, or an email address, so that outbound adapters know where to send.
- **Per-channel filters.** For example, send only approval_request and task_completed to Slack, but all events to the CLI.

The MVP can use **implicit routing**. Implicit routing sends notifications only to the channel the task was submitted from, which is stored as `channel_source` on the task, and to any always-on channel (for example the real-time API for the CLI). A **UserPreferences** store (for example a DynamoDB table keyed by `user_id`) can hold `notification_channels`, `channel_configs`, and `notification_filters`, so that outbound adapters can route each notification to the right set of channels for each user.

### Cross-cutting

- **Extensibility**
  Adding a new channel should require only one or more new adapters and configuration (routes, secrets). The core task pipeline, storage, and orchestration should not change.

- **Browser extension channel**
  A lightweight Chrome or Firefox extension can let users trigger tasks directly from the browser. For example, a user who is viewing a GitHub issue page clicks a button to submit the issue as a task. The extension can call the existing webhook API with the issue URL of the current page, so it requires minimal new infrastructure. The extension authenticates with the user's existing webhook credentials, or through OAuth to obtain a JWT. To the gateway, the extension is another channel adapter that produces the same internal message format. No core pipeline changes are needed.

- **Consistency with product scope**
  If a deployment supports a single channel (for example CLI only), the gateway should remain the place where additional channels plug in. Adding Slack, browser extensions, or other channels is then an extension, not a rewrite.

---

## Internal Message Schema (Inbound)  - Concept

The gateway defines a single **internal message** format that all channels produce. The rest of the system (task creation, orchestration) depends only on this format. The following is a conceptual schema, not an implementation spec.

- **Message identity**
  A unique id (for example a ULID) for deduplication and tracing.

- **Channel source**
  The channel the message came from (for example `api`, `webhook`, `slack`, `web`, `github_actions`).

- **Channel metadata**
  Opaque or structured data needed to route replies (for example the Slack channel id and thread ts, or the CLI session or request id). It is stored with the task for outbound notifications.

- **User identity**
  A stable platform user id (for example the Cognito sub or a mapped id). All channels must map to this id so that authorization and "my tasks" work consistently.

- **Action type**
  One of create task, get tasks, get one task, cancel task, approve or reject (if HITL), or other defined actions.

- **Payload**
  Action-specific data, for example:
  - **Create task:** user message text, repo URL or org/repo, issue or PR ref (for example an issue number), optional attachments (images, files) with type and URL or inline data.
  - **Cancel or approve:** task id, and for approve also the approval decision and optional response text.

Validation rules (for example required fields per action, max message length, allowed URL schemes) apply to this normalized payload.

---

## Internal Notification Schema (Outbound)  - Concept

When the core needs to notify the user, it produces a single **internal notification** format. Channel adapters turn it into channel output such as Slack messages, CLI output, or emails.

- **Notification identity**
  A unique id for the notification.

- **Task and user**
  The task id and user id, so that adapters can route and filter.

- **Notification type**
  For example status change, task completed, error, approval requested, or a log or progress update.

- **Payload**
  Type-specific content, such as a status value, short message, approval question, PR URL, error message, or log snippet.

Adapters render the notification into channel-specific formats (for example Slack Block Kit, or plain text for the CLI) and deliver it through the channel's API or protocol.

---

## Examples

### Example 1: User submits a task from the CLI

- The user runs `bgagent submit --repo org/myapp --issue 42`, and optionally adds a message or attachment.
- The CLI sends an HTTP request to the gateway with a Cognito JWT.
- **Gateway (inbound):**
  - Verifies the JWT.
  - Normalizes the request into the internal message: action = create task, repo = org/myapp, issue_ref = 42, user message from args, channel_source = cli, user_id from the JWT.
  - Validates required fields and allowed values.
  - Dispatches to the task pipeline (create task).
- The task pipeline creates the task and starts orchestration. Later, when the status changes or the task completes, the core emits internal notifications.
- **Gateway (outbound):**
  In an MVP with only the CLI, "outbound" may be implicit. For example, the user polls `GET /tasks/{id}` and sees the status in the response. When push is added, an adapter could stream or push these notifications to the CLI, for example over WebSocket or SSE.

### Example 2: User checks status from the CLI

- The user runs `bgagent status abc-123`.
- The CLI sends `GET /tasks/abc-123` with a Cognito JWT.
- **Gateway:**
  The gateway verifies the JWT, normalizes the request to the internal "get one task" action with task_id = abc-123 and user_id from the JWT, validates it, and dispatches it. The handler loads the task, enforces that the user owns it, and returns the status, and optionally fields such as the PR URL or an error message, in a consistent response format. The CLI renders the response as text.

### Example 3: User cancels a task

- The user runs `bgagent cancel abc-123`.
- **Gateway:**
  The gateway verifies the JWT, normalizes the request to "cancel task" with task_id and user_id, validates ownership (or delegates that check to a downstream service), and dispatches the message. The task pipeline marks the task cancelled and stops the agent run. Outbound notifications, if any, can tell the user that the task was cancelled.

### Example 4: Future  - User submits a task from Slack

- The user sends "Implement the feature from issue #42 in org/myapp" in a Slack channel, or through a slash command.
- Slack sends an HTTP POST to the gateway (for example to `/channels/slack/events`) with its own signing and payload.
- **Gateway (inbound):**
  The gateway verifies the Slack signing secret and normalizes the request to the same internal message: action = create task, repo = org/myapp, issue_ref = 42, user message from the Slack text, channel_source = slack, channel_metadata = { channel_id, thread_ts }, user_id = mapped from the Slack user (for example through a Slack-to-Cognito or Slack-to-platform-user mapping). The gateway then validates the message and dispatches it.
- **Gateway (outbound):**
  When the task completes or needs approval, the core emits an internal notification. The Slack adapter renders it (for example as Block Kit with "Task completed" and a PR link, or with approval buttons) and sends it to the right channel and thread, using the stored channel_metadata.

### Example 5: Same user, different channels

- The user creates a task from Slack and later runs `bgagent status abc-123` from the CLI.
- The gateway ensures the same internal user identity for both channels, through the Slack-to-platform-user mapping and Cognito. "My tasks" and "cancel my task" therefore work on either channel. Notifications can go to the originating channel (Slack), to the CLI if the user is subscribed, or to both, depending on product and routing rules.

---

## Summary

- **Role.** The gateway is the single entry point for all user-facing channels. It adapts many formats to one internal contract.
- **Inbound.** The gateway verifies, normalizes, validates, and dispatches. All channels produce the same internal message schema.
- **Outbound.** The core emits one internal notification schema. Channel adapters render and send it per channel.
- **Requirements.** Per-channel auth, normalization, validation, access control, multi-modal payloads, and channel metadata for routing.
- **Extensibility.** A new channel needs one or more new adapters and config. The core task pipeline and storage stay unchanged.

This document describes **only the purpose, requirements, and examples of the input gateway**. It does not specify the implementation (for example API Gateway, Lambda, SQS, or other specific technologies). The implementation belongs in the architecture and implementation docs.
