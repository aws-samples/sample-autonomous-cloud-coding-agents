---
title: Approval gates (Cedar HITL)
---

The platform evaluates every tool call the agent is about to make (Bash, Write, Edit, WebFetch, ...) against a Cedar policy set. Most calls resolve to a plain **Allow** or **Deny** with no human involvement. For a small, explicitly-marked set of rules, the decision is **require-approval**: the agent pauses, the task transitions to `AWAITING_APPROVAL`, and you are asked to make the call.

The mechanism is Cedar HITL gates — "Human-In-The-Loop." It is the same policy language you can already author at the blueprint level, with one added annotation (`@tier("soft")`) that flips a rule from hard-deny to require-approval.

For the full design and guarantees (atomicity, fail-closed posture, timeout semantics, late-approval handling), see [Cedar HITL gates design doc](/sample-autonomous-cloud-coding-agents/architecture/cedar-hitl-gates). For writing policies, see the [Cedar policy guide](/sample-autonomous-cloud-coding-agents/customizing/cedar-policies).

### When a gate fires

When a rule marked `@tier("soft")` matches a tool call:

1. The agent stops before invoking the tool.
2. A row is atomically written to the approvals table and the task status flips to `AWAITING_APPROVAL`.
3. A progress event (`approval_requested`) is emitted so `bgagent watch` shows the gate in real time.
4. The task waits for your decision without an automatic deadline by default. An explicit per-task or policy-rule timeout can limit that window.
5. On approval, the agent proceeds; on denial, the deny reason is best-effort injected back into the agent's context so it can adapt; on timeout, the gate is treated as a denial with `timed_out` as the reason.

A decision is recorded at most once per request. A repeated decision cannot change an already closed request.

### Responding in Linear

For a Linear task, the bot posts an **Approval needed** comment with the action
and reason. Reply **approve** or **deny** in that comment's thread. You do not
need a task ID, request ID, or bot mention. Your Linear account must be linked to
the ABCA account that submitted the task.

`approve` allows the displayed action once. The bot acknowledges the saved
decision. An old thread cannot approve a newer request; replies to closed requests
explain that no new decision was recorded. Use the CLI for broader approval scopes
or a denial reason. Editing an existing comment does not submit a decision.

This works on every compute backend. A sleeping MicroVM wakes to receive the
decision; AgentCore and ECS receive it through their existing approval wait.
Sleep does not set the approval deadline. Requests have no automatic deadline by
default, and an explicitly configured deadline still applies.

### Listing pending approvals

```bash
node lib/bin/bgagent.js pending
```

Lists every approval across your tasks that is currently awaiting your decision. The default text output gives you the `request_id`, tool, severity, the reason the rule matched, the tool-input preview, the deadline or “no automatic expiry,” and ready-to-run `approve` / `deny` command lines. The JSON `expires_at` is `null` when there is no deadline. Cancelled or completed tasks no longer have answerable requests.

```text
1 pending approval(s):

  task_id:    01KN37PZ77P1W19D71DTZ15X6X
  request_id: 01R...
  tool:       Bash    severity: high
  reason:     Bash command matches force-push pattern
  rules:      force_push_any
  preview:    git push --force origin feature/xyz
  created:    2026-05-13T12:04:12Z
  expires:    no automatic expiry
  approve:    bgagent approve 01KN37PZ77P1W19D71DTZ15X6X 01R...
  deny:       bgagent deny 01KN37PZ77P1W19D71DTZ15X6X 01R... --reason "..."
```

### Approving a gate

```bash
node lib/bin/bgagent.js approve <TASK_ID> <REQUEST_ID>
node lib/bin/bgagent.js approve <TASK_ID> <REQUEST_ID> --scope tool_type:Bash
node lib/bin/bgagent.js approve <TASK_ID> <REQUEST_ID> --scope rule:force_push_any
node lib/bin/bgagent.js approve <TASK_ID> <REQUEST_ID> --scope all_session --yes
```

The `--scope` flag controls how long the approval carries forward within the running task:

| Scope | Effect |
|---|---|
| `this_call` | Default. Approves only the exact tool call that is waiting. The next matching gate will ask again. |
| `tool_type_session` | Approves every call to the same tool type (e.g. `Bash`) for the rest of this task. |
| `tool_type:<name>` | Same as `tool_type_session`, but pinned to a specific tool (`tool_type:Bash`). |
| `tool_group_session` / `tool_group:<name>` | Same pattern by tool group (`Edit` + `Write` are grouped as file-write, etc.). |
| `bash_pattern:<glob>` | Approves Bash commands matching a glob (e.g. `bash_pattern:pytest*`). |
| `write_path:<glob>` | Approves Write/Edit calls whose target path matches the glob (e.g. `write_path:tests/**`). |
| `rule:<rule_id>` | Approves every future gate fired by a specific rule. |
| `all_session` | Nuclear option — approves every subsequent gate in the task. Requires `--yes`. |

Approvals only affect the current task; they do not persist across tasks.

### Denying a gate

```bash
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID>
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID> --reason "run the migration dry-run first"
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID> --reason-file deny.txt
```

The optional `--reason` text is sanitized and truncated server-side, then best-effort injected into the agent's Stop-hook context so it can adapt (try a different approach, ask you a question, or stop gracefully) instead of retrying blindly. Use `--reason-file` when the reason is multi-line and would otherwise require careful shell quoting.

### Discovering repo policies

Before submitting a task you can list the rules that apply to the target repository:

```bash
node lib/bin/bgagent.js policies list --repo owner/repo
node lib/bin/bgagent.js policies list --repo owner/repo --tier soft
node lib/bin/bgagent.js policies show --repo owner/repo --rule force_push_any
```

`policies list` prints both tiers: **hard-deny** rules are absolute (even `--pre-approve` cannot bypass them), **soft-deny** rules are the approvable ones. `policies show` prints the full detail for a specific rule (severity, timeout, category, summary).

### Pre-approving scopes at submit time

If you trust a task to make a certain class of changes without interactive confirmation, pre-approve them up front:

```bash
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 \
  --pre-approve tool_type:Bash \
  --pre-approve write_path:tests/**

# Optional ten-minute decision deadline (the default has no deadline)
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 --approval-timeout 600
```

`--pre-approve` can be repeated up to the platform limit (see `bgagent submit --help` for the current cap). Valid scope forms are the same as the `approve --scope` table above. Hard-deny rules are still enforced — `--pre-approve` only short-circuits soft-deny rules.

`--approval-timeout 0` keeps unanswered requests available. A positive setting
limits the decision window; the shortest positive deadline from the task and
matching policy rules wins. Zero does not disable a policy rule's explicit
deadline. Cancelling the task closes its requests.

For Lambda MicroVM tasks, `--microvm-sleep-after 600` selects the default
10-minute delay; `--microvm-sleep-after 120` selects two minutes and
`--microvm-sleep-after off` keeps the worker awake. The delay starts when each
approval request is created. Waking for approval, denial, or an approaching
deadline remains automatic. Sleep never starts a new approval timer.

An unanswered request can outlive its MicroVM. After a longer wait, ABCA saves
the workspace and conversation, stops the worker, and releases its capacity.
Your answer can then start a replacement when capacity is available. A request
remaining open does not mean its old computer must stay alive. Sleeping saves
compute charges but adds snapshot save/restore charges and wake-up time; short
pauses can cost more than staying awake. The API equivalent is
`microvm_sleep_after_s` (zero means off); task
details return the saved setting. Automatic suspension is disabled by default for
new deployments. An operator enables it after [verifying the deployed image and
coordinator](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/verification/README.md#live-acceptance-for-an-installation).