---
title: Approval gates (Cedar HITL)
---

The platform evaluates every tool call the agent is about to make (Bash, Write, Edit, WebFetch, ...) against a Cedar policy set. Most calls resolve to a plain **Allow** or **Deny** with no human involvement. For a small, explicitly-marked set of rules, the decision is **require-approval**: the agent pauses, the task transitions to `AWAITING_APPROVAL`, and you are asked to make the call.

The mechanism is Cedar HITL gates — "Human-In-The-Loop." It is the same policy language you can already author at the blueprint level, with one added annotation (`@tier("soft")`) that flips a rule from hard-deny to require-approval.

For the full design and guarantees (atomicity, fail-closed posture, timeout semantics, late-approval handling), see [Cedar HITL gates design doc](/architecture/cedar-hitl-gates). For writing policies, see the [Cedar policy guide](/customizing/cedar-policies).

### When a gate fires

When a rule marked `@tier("soft")` matches a tool call:

1. The agent stops before invoking the tool.
2. A row is atomically written to the approvals table and the task status flips to `AWAITING_APPROVAL`.
3. A progress event (`approval_requested`) is emitted so `bgagent watch` shows the gate in real time.
4. The task waits for your decision up to the rule's timeout (default 300 s, configurable per-rule and per-task).
5. On approval, the agent proceeds; on denial, the deny reason is best-effort injected back into the agent's context so it can adapt; on timeout, the gate is treated as a denial with `timed_out` as the reason.

A decision is recorded at most once per request. Replaying approve/deny on the same `(task_id, request_id)` is idempotent.

### Listing pending approvals

```bash
node lib/bin/bgagent.js pending
```

Lists every approval across your tasks that is currently awaiting your decision. The default text output gives you the `request_id`, tool, severity, the reason the rule matched, the tool-input preview, the expiry time, and ready-to-run `approve` / `deny` command lines. Pipe through `--output json` for scripting.

```text
1 pending approval(s):

  task_id:    01KN37PZ77P1W19D71DTZ15X6X
  request_id: 01R...
  tool:       Bash    severity: high
  reason:     Bash command matches force-push pattern
  rules:      force_push_any
  preview:    git push --force origin feature/xyz
  created:    2026-05-13T12:04:12Z
  expires:    2026-05-13T12:09:12Z (timeout_s=300)
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

# Per-task timeout override (platform default is 300s)
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 --approval-timeout 600
```

`--pre-approve` can be repeated up to the platform limit (see `bgagent submit --help` for the current cap). Valid scope forms are the same as the `approve --scope` table above. Hard-deny rules are still enforced — `--pre-approve` only short-circuits soft-deny rules.

`--approval-timeout` sets the task-wide default; a rule with its own `@approval_timeout_s` annotation still takes the minimum of the two.