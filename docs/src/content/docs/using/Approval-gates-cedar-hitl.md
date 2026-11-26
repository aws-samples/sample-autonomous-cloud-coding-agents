---
title: "Approval gates (Cedar HITL)"
---

The platform evaluates every tool call the agent is about to make (Bash, Write, Edit, WebFetch, and others) against a Cedar policy set. Most calls resolve to a plain **Allow** or **Deny** with no human involvement. For a small, explicitly marked set of rules, the decision is **require-approval**. The agent pauses, the task transitions to `AWAITING_APPROVAL`, and the platform asks you to decide.

The mechanism is called Cedar HITL gates. HITL stands for "Human-In-The-Loop". The gates use the same policy language that you can already author at the blueprint level, with one added annotation, `@tier("soft")`, that changes a rule from hard-deny to require-approval.

For the full design and its guarantees (atomicity, fail-closed posture, timeout semantics, and late-approval handling), see the [Cedar HITL gates design doc](/sample-autonomous-cloud-coding-agents/architecture/cedar-hitl-gates). To write policies, see the [Cedar policy guide](/sample-autonomous-cloud-coding-agents/customizing/cedar-policies).

### When a gate fires

When a rule marked `@tier("soft")` matches a tool call:

1. The agent stops before invoking the tool.
2. A row is written atomically to the approvals table, and the task status changes to `AWAITING_APPROVAL`.
3. A progress event (`approval_requested`) is emitted, so that `bgagent watch` shows the gate in real time.
4. The task waits for your decision up to the rule's timeout (default 300 s, configurable per rule and per task).
5. On approval, the agent proceeds. On denial, the deny reason is injected back into the agent's context on a best-effort basis, so that the agent can adapt. On timeout, the gate is treated as a denial with `timed_out` as the reason.

A decision is recorded at most once per request. A repeated approve or deny on the same `(task_id, request_id)` is idempotent.

### Listing pending approvals

```bash
node lib/bin/bgagent.js pending
```

The command lists every approval across your tasks that currently awaits your decision. The default text output gives you the `request_id`, the tool, the severity, the reason the rule matched, the tool-input preview, the expiry time, and ready-to-run `approve` and `deny` command lines. Use `--output json` for scripting.

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

The `--scope` flag controls how far the approval extends within the running task:

| Scope | Effect |
|---|---|
| `this_call` | Default. Approves only the exact tool call that is waiting. The next matching gate will ask again. |
| `tool_type_session` | Approves every call to the same tool type (for example `Bash`) for the rest of this task. |
| `tool_type:<name>` | Same as `tool_type_session`, but pinned to a specific tool (`tool_type:Bash`). |
| `tool_group_session` / `tool_group:<name>` | Same pattern by tool group (`tool_group:file_write` covers `Edit` and `Write`). For a tool that is in no group, `tool_group_session` covers that call only. |
| `bash_pattern:<glob>` | Approves Bash commands matching a glob (for example `bash_pattern:pytest*`). |
| `write_path:<glob>` | Approves Write and Edit calls whose target path matches the glob (for example `write_path:tests/**`). |
| `rule:<rule_id>` | Approves every future gate fired by a specific rule. |
| `all_session` | The broadest scope. Approves every subsequent gate in the task. Requires `--yes`. |

Approvals affect only the current task. They do not persist across tasks.

### Denying a gate

```bash
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID>
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID> --reason "run the migration dry-run first"
node lib/bin/bgagent.js deny <TASK_ID> <REQUEST_ID> --reason-file deny.txt
```

The optional `--reason` text is sanitized and truncated server-side, then injected into the agent's Stop-hook context on a best-effort basis. With the reason, the agent can adapt (try a different approach, ask you a question, or stop cleanly) instead of retrying without guidance. Use `--reason-file` when the reason has several lines and would otherwise need careful shell quoting.

A deny tells the agent to stop trying that kind of action, not only that one call. With the refused call the agent gets your reason, the name of the rule that gated the call, and an instruction not to retry the action with variations. It has to find another way to do the task, or report why it is blocked.

Put what matters most first. With the refused call the agent sees only about the first 200 characters of a long reason (that message is limited to 500 characters). The full text is in the Stop-hook injection described above.

For the next 60 seconds, any other call of the same tool that the same rule gates is refused at once, without a new approval request. `bgagent watch` shows each such refusal as a `policy_decision` milestone. After that window a new attempt opens a new request. A gate that times out does less. The agent then gets no such instruction, and only the identical call is refused for 60 seconds.

If you want the action to go through this time and be asked again the next time, approve it with the default scope `this_call` instead of denying. To stop being asked about a rule for the rest of the task, approve with `--scope rule:<rule_id>`.

### Discovering repo policies

Before submitting a task you can list the rules that apply to the target repository:

```bash
node lib/bin/bgagent.js policies list --repo owner/repo
node lib/bin/bgagent.js policies list --repo owner/repo --tier soft
node lib/bin/bgagent.js policies show --repo owner/repo --rule force_push_any
```

`policies list` prints both tiers. **Hard-deny** rules are absolute, and even `--pre-approve` cannot bypass them. **Soft-deny** rules are the rules you can approve. `policies show` prints the full detail of a specific rule (severity, timeout, category, and summary).

### Pre-approving scopes at submit time

If you trust a task to make a certain class of changes without interactive confirmation, pre-approve that class when you submit:

```bash
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 \
  --pre-approve tool_type:Bash \
  --pre-approve 'write_path:tests/**'

# Per-task timeout override (platform default is 300s)
node lib/bin/bgagent.js submit --repo owner/repo --issue 42 --approval-timeout 600
```

`--pre-approve` can be repeated up to 20 times. Valid scope forms are `all_session` and those of the `approve --scope` table above that name their target: `tool_type:<name>`, `tool_group:<name>`, `bash_pattern:<glob>`, `write_path:<glob>` and `rule:<rule_id>`. `this_call`, `tool_type_session` and `tool_group_session` stand for a call that is waiting for approval and are rejected. Hard-deny rules are still enforced. `--pre-approve` bypasses only soft-deny rules.

`--approval-timeout` sets the task-wide default. A rule with its own `@approval_timeout_s` annotation still takes the minimum of the two.

For Lambda MicroVM tasks, a waiting approval can put the worker to sleep so it
stops billing compute. With the defaults (a 300-second approval window and a
60-second sleep delay) the worker sleeps after one minute and wakes when you
answer, or 60 seconds before the deadline so a timeout is still recorded
normally. `--microvm-sleep-after 120` selects two minutes and
`--microvm-sleep-after off` keeps the worker awake. The delay starts when each
approval request is created. Sleep never extends the approval deadline. The API
equivalent is `microvm_sleep_after_s` (zero means off), and task details return
the saved setting. Automatic sleep is disabled by default for new deployments.
An operator enables it after [verifying the deployed image and
coordinator](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/verification/README.md#live-acceptance-for-an-installation).