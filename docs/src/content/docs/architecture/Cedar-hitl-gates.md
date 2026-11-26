---
title: "Cedar HITL Approval Gates"
---

> **Status:** Core implemented. This document remains the authoritative design reference.
> **Companion:** [`INTERACTIVE_AGENTS.md`](/sample-autonomous-cloud-coding-agents/architecture/interactive-agents) §9.3 (pointing here), §7 (state machine).
> **Design locked:** 2026-04-23 (Sam ↔ assistant discussion).
> **Rev:** 5 (2026-05-06). Folds in the parallel adversarial and advocate review of the timeout design: the late-approval re-read on TIMED_OUT ConditionCheckFailed, user-visible timeout-cap milestones, the ceiling-shrink milestone, the Runtime JWT bound verified as auto-refreshed IAM, three new tuning metrics, an explicit off-hours trade-off section, and the notification-delivery-failure boundary. IMPL-24 through IMPL-28 added.
> **Implementation:** Core shipped. The 3-outcome engine (`agent/src/policy.py`), default policy sets (`agent/policies/hard_deny.cedar`, `agent/policies/soft_deny.cedar`), approval Lambdas (`cdk/src/handlers/{approve-task,deny-task,get-pending,get-policies}.ts`) wired into `cdk/src/constructs/task-api.ts` (routes `/tasks/{id}/approve`, `/deny`, `/pending`, `/repos/{repo_id}/policies`), the cross-engine parity fixtures (`contracts/cedar-parity/`), and the exact engine pins are all on `main`. §15's task list is preserved as a historical implementation record. See the note at the top of §15 for what (if anything) remains unbuilt.

---

## 0. Contents

1. [What we are building, in one paragraph](#1-what-we-are-building-in-one-paragraph)
2. [The three-outcome model and why Cedar alone can't give it](#2-the-three-outcome-model)
3. [Design decisions (locked)](#3-design-decisions-locked)
4. [End-to-end request flow](#4-end-to-end-request-flow)
5. [Cedar policy authoring guide](#5-cedar-policy-authoring-guide)
6. [Engine implementation](#6-engine-implementation)
7. [REST API contract](#7-rest-api-contract)
8. [CLI UX](#8-cli-ux)
9. [State machine + concurrency](#9-state-machine--concurrency)
10. [Data model](#10-data-model)
11. [Observability and notification plane](#11-observability-and-notification-plane)
12. [Security model](#12-security-model)
13. [Failure modes + fail-closed posture](#13-failure-modes--fail-closed-posture). Includes §13.12 VM-throttle + late-approval race, §13.13 Runtime JWT expiry, §13.14 Notification delivery failure, §13.15 Fail-closed summary
14. [Sample scenarios](#14-sample-scenarios). Includes §14.6 VM-throttle race trace, §14.7 timeout-capped visibility, §14.8 Off-hours and unattended tasks (known trade-off)
15. [Implementation plan](#15-implementation-plan)
16. [Implementation notes (carry-forward tasks)](#16-implementation-notes-carry-forward-tasks)
17. [Future work (not in v1 scope)](#17-future-work-not-in-v1-scope). Includes §17.18 Off-hours escalation mode, §17.19 `bgagent pending --output json` schema stability

---

## 1. What we are building, in one paragraph

When the agent is about to call a tool (Bash, Write, Edit, WebFetch, and others), our existing Cedar policy engine decides **Allow** or **Deny**. This feature adds a third outcome, **Require-approval**. It pauses the tool call, writes an approval request to a new DynamoDB table atomically with the task state transition, notifies the user with a live stream marker, and waits for a human response through a new REST endpoint and CLI command. The agent polls DynamoDB for the user's decision with strongly-consistent reads. On approval the agent proceeds. On denial or timeout, the decision text is injected best-effort into the agent's context through the validated Phase-2 Stop-hook mechanism, so that the agent adapts instead of looping. At task-submit time the user can also *pre-approve* scopes (specific tools, bash patterns, rule IDs, path patterns, or `all_session`) so that low-risk agents run without interactive gates. The same Cedar policy language is reused. A new `@tier("soft")` annotation marks the rules that trigger approval instead of absolute denial, so there is no new language, only broader semantics.

---

## 2. The three-outcome model

### Cedar's native model is binary

The [Cedar authorization engine](https://www.cedarpolicy.com/) answers exactly one question on every call: given a `(principal, action, resource, context)` tuple, is the action **Allowed**, **Denied**, or is there **NoDecision** (no policy matched)? Our existing engine in `agent/src/policy.py` treats `NoDecision` as deny (fail-closed) and returns a boolean `allowed` to callers. That is the baseline that this feature extends.

### What we add

We add a **three-outcome abstraction** on top of Cedar. The engine runs up to **two Cedar evaluations per tool call** against two separate policy sets, interleaved with an in-process allowlist and a recent-decision cache:

```mermaid
flowchart TB
    start(["PolicyEngine.evaluate_tool_use(tool_name, tool_input)"])
    s1["<b>1 · Hard-deny Cedar eval</b><br/>HARD_DENY_POLICIES<br/><i>Absolute. No allowlist can override.</i>"]
    s2["<b>2 · Allowlist fast-path</b><br/>--pre-approve or scope != this_call<br/><i>Skip human for trusted patterns.</i>"]
    s25["<b>2.5 · Recent-decision cache</b><br/>(tool_name, input_sha) within 60s<br/><i>Prevents re-gate storms on retry.</i>"]
    s3["<b>3 · Soft-deny Cedar eval</b><br/>SOFT_DENY_POLICIES<br/><i>Human must approve before tool runs.</i>"]
    s4["<b>4 · Default ALLOW</b>"]
    outDeny(["<b>DENY</b><br/>PolicyDecision(outcome=DENY, reason)"])
    outAllow(["<b>ALLOW</b><br/>PolicyDecision(outcome=ALLOW, reason)"])
    outReq(["<b>REQUIRE_APPROVAL</b><br/>PolicyDecision(outcome, reason,<br/>timeout_s, severity, matching_rule_ids)"])

    start --> s1
    s1 -- match --> outDeny
    s1 -- no match --> s2
    s2 -- match --> outAllow
    s2 -- no match --> s25
    s25 -- cached DENIED / TIMED_OUT --> outDeny
    s25 -- no cache hit --> s3
    s3 -- match --> outReq
    s3 -- no match --> s4
    s4 --> outAllow

    classDef stage fill:#E8F1FF,stroke:#4A90E2,stroke-width:1px,color:#0B3D91
    classDef denyOut fill:#FCEAEA,stroke:#D64545,stroke-width:1.5px,color:#8B1F1F
    classDef allowOut fill:#EAF7EA,stroke:#3AA655,stroke-width:1.5px,color:#1F6B32
    classDef reqOut fill:#FFF4E0,stroke:#E0A03A,stroke-width:1.5px,color:#7A4A10
    classDef startEnd fill:#F5F5F5,stroke:#888,stroke-width:1px,color:#333

    class s1,s2,s25,s3,s4 stage
    class outDeny denyOut
    class outAllow allowOut
    class outReq reqOut
    class start startEnd
```

Each Cedar evaluation takes less than a millisecond, with no network hop and no AWS API call. The "approval wait" (the handling downstream of step 3, which polls DDB for the user's decision) runs entirely inside our `PreToolUse` hook coroutine.

### SDK mapping

The Claude Agent SDK never sees `REQUIRE_APPROVAL`. After the approval wait resolves, the hook maps the three-outcome model back to the SDK's binary decision:

| Engine outcome | SDK-visible return |
|---|---|
| `ALLOW` (stages 2, 4) | `{"permissionDecision": "allow"}` |
| `DENY` (stage 1 hard-deny, stage 2.5 cache hit) | `{"permissionDecision": "deny"}` |
| `REQUIRE_APPROVAL` → user approves | `{"permissionDecision": "allow"}` |
| `REQUIRE_APPROVAL` → user denies or the gate times out | `{"permissionDecision": "deny"}` |

The three-outcome model is an internal engine abstraction. The SDK interface stays binary and unchanged.

### Why not a single policy set with a custom "require approval" outcome

Cedar has no `require_approval` effect. We considered three options:

- **Cedar annotations without a policy-set split.** Mark some `forbid` rules with `@require_approval("true")` and let the engine inspect the matched policy. This works, but every `forbid` becomes a potential approval. That is a maintenance hazard: rule authors forget to mark approval rules, or accidentally convert hard-denies into soft-denies. Rejected.
- **Context-encoded re-evaluation.** Pass `context.allow_approval: bool` and check twice. This is clever but opaque, and policy authors must write dual conditions. Rejected.
- **Two policy sets.** This is the chosen design. The split is physical, so a policy author knows a rule's tier from the file that holds it. The `@tier("hard"|"soft")` annotation is a second check.

The deciding property is that a policy author doing a security review can read the hard-deny file alone, without the approval-eligible rules. Most review effort goes to the hard-deny set, because soft-deny rules are backed by a human decision.

---

## 3. Design decisions (locked)

These decisions were settled during the 2026-04-23 design discussion and extended after the 2026-04-24 and 2026-05-06 reviews. The detailed rationale for each is in those conversations. This table is a summary for implementers. There are **23 decisions**, all locked unless an adversarial review finding explicitly reopened a concern.

| # | Decision | Summary |
|---|---|---|
| 1 | **Cedar encoding: two policy sets** | Physical hard-deny versus soft-deny split, validated via `@tier(...)` annotation. |
| 2 | **Hook point: extend `PreToolUse`, not `can_use_tool`** | PreToolUse is already async-compatible, already wired to Cedar, and already owns the tool-governance boundary. |
| 3 | **Wait mechanism: DDB strongly-consistent polling, 2s → 5s backoff** | Initial 2s cadence for the first 30s, then 5s. `ConsistentRead=True` so the agent never misses an approval that already landed. |
| 4 | **Scope allowlist: in-process, seeded from persisted `initial_approvals`** | Runtime escalation lives in the `PolicyEngine` instance. Submit-time `--pre-approve` flags persist on TaskTable and seed the allowlist at container startup. Lost on restart, which is rare. The reconciler fails stranded tasks. |
| 5 | **CLI UX: standalone `bgagent approve/deny` + `--pre-approve <scope>` + `bgagent policies list` + `bgagent pending`** | No inline interactive prompt in the streaming CLI for v1. The discovery and listing commands solve the request_id/rule_id copy problem. |
| 6 | **Timeouts: per-task default + per-rule Cedar annotation override, min wins, bounded floor + ceiling, fail-closed** | Per-task default: **300s** (5 min), overridable via `--approval-timeout` on submit and bounded by `[30, min(3600, maxLifetime - 300)]`. Floor: 30s (engine-enforced on both task default and rule annotations). Ceiling: `min(1h, maxLifetime_remaining - cleanup_margin)`, sized so the TTL on the approval row always covers the decision window. A timeout denies and never auto-approves. See §14.8 for the off-hours trade-off that this posture accepts. |
| 7 | **Concurrency slots: AWAITING_APPROVAL holds the slot** | Matches PAUSED semantics. The container is alive and consumes memory. |
| 8 | **Hard-deny is absolute** | No `--pre-approve` scope, and no blueprint `disable:` directive, can bypass it. CreateTaskFn validates and rejects `rule:<hard_deny_rule_id>`. The blueprint loader rejects `disable:` entries that name built-in hard-deny rules. |
| 9 | **Submit-time scope cap: 20 entries, ≤128 chars each** | Keeps the audit trail legible, bounds the allowlist check cost, and limits the damage of abuse. |
| 10 | **Cedar annotations (verified working)** | `@rule_id(...)`, `@tier(...)`, `@approval_timeout_s(...)`, `@severity(...)`, `@category(...)`. Recoverable as JSON via `cedarpy.policies_to_json_str()`. Multi-match merging: min timeout wins (clamped by floor), max severity wins. |
| 11 | **Atomic state transitions via DDB TransactWriteItems** | The approval-request row write and the TaskTable status transition are a single atomic transaction. No partial-failure states. |
| 12 | **Ownership encoded in ConditionExpression, not fetch-then-check** | `ApproveTaskFn` / `DenyTaskFn` use `TransactWriteItems` with ConditionExpressions on both tables (ownership on TaskApprovalsTable, state on TaskTable). Authorization and state transition are atomic. |
| 13 | **Per-task approval-gate cap: default 50, per-blueprint configurable, fail-task on exceed** | Terminal circuit breaker against denial-loop storms and prompt-injection abuse. Default 50 is an order-of-magnitude estimate, not empirically derived. Blueprints override it via `security.approvalGateCap` (bounded 1 ≤ N ≤ 500). The cache-memory bound is separate: the recent-decision cache is capped at 50 entries regardless of `approvalGateCap` (§12.8, §12.9). The re-evaluation criteria for the default are recorded as an IMPL item. |
| 14 | **Per-minute approval-creation rate limit: 20/task, per-container best-effort** | Agent-side throttle independent of per-task lifetime cap. The counter is in-process. On container restart the counter resets, but the per-task approval-gate cap (decision #13) and the reconciler still bound total damage (§6.5, §13.6). |
| 15 | **Recent-decision cache: deny an identical (tool, input) for 60s after DENIED/TIMED_OUT, and any input of a denied (tool, rule) for 60s after DENIED** | Prevents naïve retry-loop amplification on the same destructive action. A DENIED outcome is also recorded per matching rule, so a variation of the denied call that the same rule gates is denied without a new request. TIMED_OUT stays input-scoped, because a timeout is not a refusal. The cache is session-scoped (in-process), and a container restart clears it. Accepted as a threat-model caveat. Cache memory is bounded at 50 entries regardless of `approvalGateCap`, so cache sizing is separate from the UX cap (§12.8, §12.9). |
| 16 | **Denial reason sanitized in the Lambda, before persisting** | `DenyTaskFn` runs `output_scanner` on the reason before writing to DDB. The agent never sees unscanned text. |
| 17 | **`tool_input_preview` stripped of ANSI/control characters at agent-side write + CLI render** | Defense in depth against approver-confusion attacks where a prompt-injected tool input overwrites the CLI prompt with a different command. |
| 18 | **Deny-as-steering injected via Stop hook `between_turns_hooks`, NOT via `permissionDecisionReason` (best-effort)** | Reuses the validated Phase-2 nudge mechanism. The `<user_denial>` XML block is wrapped by the same `_xml_escape` utility. Because the denial hook runs AFTER the cancel-wins hook, denial injection is best-effort on cancelled tasks. `permissionDecisionReason` on the SDK return is the guaranteed surface (§4 step 25b, §6.5). |
| 19 | **`rule:` discovery via new endpoint** | `GET /v1/repos/{repo_id}/policies` and `bgagent policies list` return the rule IDs, the annotations, and whether each rule is hard or soft. Without them a user cannot discover the IDs for the `rule:X` pre-approval scope. Packaged via a Lambda layer (§15.6) so cedar-wasm isn't bundled per function. |
| 20 | **`write_path:<glob>` scope** | Added so users can pre-approve file writes under specific path patterns (for example `write_path:docs/**`) without granting all Writes. Validation uses Python `fnmatch` at runtime. Glob semantics are a Cedar-`like` superset (§6.4, §5.5). |
| 21 | **`tool_group:file_write` convenience scope** | Resolves to `{Write, Edit}`. Prevents the surprise of pre-approving `Write` and still getting gated on `Edit`. |
| 22 | **Pre-implementation spike: cedarpy annotation round-trip** | Day 1 of implementation validates that `policies_to_json_str()` returns annotations in the expected shape. If the API has changed, fall back to policy-ID prefix conventions. |
| 23 | **Cedar engine parity contract (Python `cedarpy` ↔ JS `cedar-wasm`)** | Both engines are pinned in `mise.toml`. A golden-file parity test runs in CI. For each `(policy, input)` fixture the test asserts Python and WASM return the same `decision` and the same set of matching rule IDs. Policy authors who upgrade either engine must refresh the golden file. Drift fails the build. See §15.6 and Appendix B. |

---

## 4. End-to-end request flow

This section walks through the happy path. The round-trip Mermaid diagram below shows the sequence.

### Setup (task start)

1. The user runs `bgagent run --repo my-org/my-app --task "rebase feature-x onto main and push" --approval-timeout 600 --pre-approve tool_type:Read --pre-approve bash_pattern:"git status*"`.
2. The CLI validates each scope string client-side (format, ≤128 chars, cap 20). It rejects invalid syntax without a round-trip.
3. The CLI POSTs `/v1/tasks` with `{repo, task, initial_approvals: [...], approval_timeout_s: 600}`.
4. `CreateTaskFn` validates `initial_approvals`:
   - max 20 entries, ≤128 chars each
   - rejects `rule:<id>` where `<id>` names a hard-deny rule (resolved via the shared policy-parsing library against the repo's blueprint, see §5.4)
   - rejects degenerate `bash_pattern`/`write_path` scopes that match too broadly (see §7.3)
   - honors `Blueprint.security.maxPreApprovalScope` (see §7.3)
   - normalizes scope strings (trims whitespace, case-sensitive as documented)
   - rejects a blueprint whose combined `cedar_policies` text exceeds the 64 KB cap (§12.4) regardless of origin
   - resolves `approval_gate_cap` = `Blueprint.security.approvalGateCap ?? 50`, and rejects a value outside `[1, 500]` (decision #13)
5. The task persists. `approval_timeout_s`, `approval_gate_cap`, and `initial_approvals` become DDB attributes on the task row. The cap is captured at submit time so that mid-task blueprint edits do not change the cap of a running task.
6. The container spawns on Runtime-JWT. `PolicyEngine.__init__` loads:
   - `HARD_DENY_POLICIES` (built-in plus the repo blueprint's `security.cedarPolicies.hard`, where blueprint `disable:` may suppress non-built-in rules only, §5.1, §15.4)
   - `SOFT_DENY_POLICIES` (built-in plus the repo blueprint's `security.cedarPolicies.soft`, where blueprint `disable:` may suppress soft-deny rules freely)
   - Annotation lookup table: `{policy_id: {annotation: value}}` built from `cedarpy.policies_to_json_str()` once, cached for the task lifetime
   - Rule-ID map: `{rule_id_annotation: policy_id}` to resolve `--pre-approve rule:<rule_id>` to the internal Cedar policy ID
   - Allowlist seeded from `initial_approvals`
   - `initial_approvals` re-validation: every scope in `initial_approvals` is re-resolved against the freshly-loaded policy set. If a `rule:<id>` no longer resolves to a soft-deny rule (because the blueprint changed between submit and start), the task fails at HYDRATING with reason `"initial_approvals drift: rule <id> missing"`. See §5.4 and §13.10.
   - Annotation validation: `@rule_id` uniqueness is enforced (on a duplicate the task fails to start). `@approval_timeout_s` must be an integer ≥ 30 (on a malformed value or one below the floor the task fails to start).
7. The container emits `agent_milestone("pre_approvals_loaded", {count: 2, scopes: ["tool_type:Read", "bash_pattern:git status*"]})` so Terminal A's stream shows the starting posture.
8. The agent begins normal work.

### First approval gate (soft-deny hit)

9. The agent decides to run `Bash(command="git push --force origin feature-x")`.
10. The SDK fires the `PreToolUse` hook with `tool_name="Bash"`, `tool_input={command: "..."}`.
11. The hook calls `PolicyEngine.evaluate_tool_use`:
    - Hard-deny eval: matches nothing, so `allowed=True`
    - Allowlist fast-path: there is no `tool_type:Bash` entry, and the `bash_pattern` entry `git status*` doesn't match `git push --force ...`, so this stage is skipped
    - Recent-decision cache: no matching `(Bash, sha256(input))` in the cache, so this stage is skipped
    - Soft-deny eval: policy `force_push_any` matches. `diagnostics.reasons == ["policy1"]`. Lookup: `policy1` has annotations `{rule_id: "force_push_any", approval_timeout_s: "300", severity: "medium"}`.
    - The engine returns `PolicyDecision(outcome=REQUIRE_APPROVAL, reason="Cedar soft-deny: force_push_any", timeout_s=300, severity="medium", matching_rule_ids=["force_push_any"])`.

    Effective timeout computation:
    ```
    effective = max(
        FLOOR_30S,
        min(
            rule_annotation_timeout_s or task_default,     # 300
            task_default,                                   # 600 from submit
            maxLifetime_remaining_s - CLEANUP_MARGIN_120S   # ~7h remaining
        )
    )
    → effective = 300s
    ```
    If `maxLifetime_remaining_s - CLEANUP_MARGIN_120S < FLOOR_30S`, the hook returns DENY immediately with reason `"insufficient lifetime for approval"` (§13.7).

12. The hook checks the per-task approval-gate cap (default 50, configurable per blueprint via `security.approvalGateCap`, §5.1) and the per-minute rate limit (20/task, per-container). If either is exceeded, the hook returns DENY with reason `"approval-gate cap exceeded"` (fail-closed).
13. The hook mints `request_id = _ulid()` (26-char ULID).
14. The hook builds the approval row payload:
    ```python
    row = {
      "task_id": "01KPW...",
      "request_id": "01KPR...",
      "tool_name": "Bash",
      "tool_input_preview": strip_ansi("git push --force origin feature-x")[:256],
      "tool_input_sha256": "abc123...",
      "reason": "Cedar soft-deny: force_push_any",
      "severity": "medium",
      "matching_rule_ids": ["force_push_any"],        # list, not set — supports empty
      "status": "PENDING",
      "created_at": "2026-04-23T14:00:00Z",
      "timeout_s": 300,
      "ttl": 1734567890,  # created_at + timeout_s + CLEANUP_MARGIN_120S; always covers the decision window
      "user_id": "...",
      "repo": "my-org/my-app"
    }
    ```
15. **Atomic transition.** The hook issues `TransactWriteItems` with two operations:
    - Put on `TaskApprovalsTable` (new row with status=PENDING)
    - ConditionalUpdate on `TaskTable`: `status = :awaiting, awaiting_approval_request_id = :rid WHERE status = :running`
    Both succeed or both fail. On `TransactionCanceledException` (most likely the TaskTable condition fails because another process moved the status), the hook emits `approval_write_failed` and returns DENY.
16. The hook emits `agent_milestone("approval_requested", {...})` to both `ProgressWriter` (DDB audit) and `sse_adapter` (live stream). Emission is best-effort. The transactional write has already committed, so a milestone failure degrades observability, not state.
17. The Terminal A stream renders:
    ```
    [14:00:00]  ★ approval_requested: Bash "git push --force origin feature-x" (medium)
                reason: Cedar soft-deny: force_push_any
                bgagent approve <task_id> 01KPR... [--scope ...]
                bgagent deny <task_id> 01KPR... [--reason "..."]
                timeout 300s
    ```
    Severity colors the line (respecting the `NO_COLOR` env var).
18. The hook enters the poll loop with strongly-consistent reads:
    ```python
    async def _poll_for_decision(task_id, request_id, timeout_s):
        start = time.monotonic()
        interval = 2
        consecutive_failures = 0
        while True:
            elapsed = time.monotonic() - start
            if elapsed >= timeout_s:
                return TimedOut()
            if elapsed > 30:
                interval = 5  # backoff
            try:
                row = await _ddb_get_approval(task_id, request_id, ConsistentRead=True)
                consecutive_failures = 0
                if row is None:
                    # Row disappeared between write and poll — treat as stranded
                    return TimedOut(reason="approval row missing; fail-closed")
                if row["status"] != "PENDING":
                    return Decided(row)
            except Exception as exc:
                consecutive_failures += 1
                if consecutive_failures == 3:
                    log("WARN", f"approval poll degraded for {request_id}: {exc}")
                    emit_milestone("approval_poll_degraded", {...})
                if consecutive_failures >= 10:
                    return TimedOut(reason="approval poll consecutive failures")
            await asyncio.sleep(interval)
    ```
19. The approval CAP and local-timeout paths ALWAYS attempt to write the row to TIMED_OUT (best-effort conditional update `status = :pending`) before returning. This prevents orphan PENDING rows when the agent aborts internally.

### User responds

20. The user in Terminal B runs `bgagent approve <task_id> <req_id> --scope tool_type_session`.
21. The CLI validates scope syntax client-side.
22. The CLI POSTs `/v1/tasks/{task_id}/approve` with `{request_id, decision: "approve", scope: "tool_type_session"}`.
23. `ApproveTaskFn` (atomic cross-table transaction, see §7.1):
    - Validates the Cognito JWT and extracts `sub` as `caller_user_id` (verbatim, with no transformation, see §7.1 and decision #12).
    - Issues a single `TransactWriteItems` with:
      - ConditionalUpdate on `TaskApprovalsTable`: `#status = :pending AND user_id = :caller AND task_id = :task_id`, which flips the row to APPROVED
      - ConditionalUpdate on `TaskTable`: `#status = :awaiting AND awaiting_approval_request_id = :rid`. This is a no-op update that only guards state. The status stays AWAITING_APPROVAL until the agent's resume transaction sets it to RUNNING.
      Both conditions must hold or the entire transaction is cancelled. There is no TOCTOU window, and no 202 for an approve on a cancelled task.
    - On `TransactionCanceledException`, uses the per-item `CancellationReasons` to distinguish between (a) approvals row missing (404 `REQUEST_NOT_FOUND`), (b) approvals row wrong user (404 `REQUEST_NOT_FOUND`, so that existence does not leak), (c) approvals row wrong status (409 `REQUEST_ALREADY_DECIDED`), (d) task no longer AWAITING_APPROVAL (409 `TASK_NOT_AWAITING_APPROVAL`).
    - Records an audit event to TaskEventsTable directly (`approval_decision_recorded`), so that the Lambda owns the 90-day audit trail and the trail does not depend on agent milestones.
    - Returns 202 `{task_id, request_id, status: "APPROVED", scope, decided_at}` or error.
24. The agent's poll reads the `APPROVED` row on the next tick (within 2-5s).
25. The hook executes the decision in this order:
    - a. **Atomic resume transition.** `TransactWriteItems` on TaskTable: `status = :running, REMOVE awaiting_approval_request_id WHERE status = :awaiting AND awaiting_approval_request_id = :rid`. If this fails (likely because the user cancelled during the poll gap), the hook skips the allowlist mutation and returns DENY with reason `"task no longer awaiting approval"`.
    - b. **Allowlist mutation** (only if `scope != "this_call"`): `PolicyEngine._allowlist.add(...)`. `tool_type_session` and `tool_group_session` name no tool, so the hook translates them first: `tool_type_session` adds `tool_type:<tool of the approved call>` (here `tool_type:Bash`), and `tool_group_session` adds `tool_group:<group>` for each group that tool is in (`file_write` for `Write` and `Edit`). For a tool that is in no group, `tool_group_session` adds nothing and the approval covers that call only. Every other scope (`all_session`, `bash_pattern:...`, `rule:...`) is added as it is. The mutation is logged synchronously.
    - c. **Milestone emission** (best-effort): `approval_granted` to both writers.
    - d. **Return to SDK**: `{"permissionDecision": "allow"}`.
26. The SDK runs the tool. The stream shows:
    ```
    [14:00:12]  ★ approval_granted: request_id=01KPR... scope=tool_type_session
    [14:00:12]  ▶ Bash: git push --force origin feature-x
    [14:00:14]  ◀ Bash: remote: Force pushed. New SHA abc123.
    ```

### Round-trip sequence (Mermaid)

```mermaid
sequenceDiagram
    participant Agent
    participant Hook as PreToolUse hook
    participant Engine as PolicyEngine
    participant Events as TaskEventsTable
    participant Approvals as TaskApprovalsTable
    participant CLI
    participant User
    participant Lambda as ApproveTaskFn
    participant Stop as Stop hook (between_turns)

    Agent->>Hook: tool call (Bash git push --force)
    Hook->>Engine: evaluate_tool_use
    Engine-->>Hook: REQUIRE_APPROVAL (soft-deny force_push_any)
    Hook->>Approvals: TransactWriteItems
    Note right of Hook: Put approval row PENDING<br/>plus TaskTable status<br/>to AWAITING_APPROVAL
    Hook->>Events: approval_requested milestone
    Events-->>CLI: live stream with approval_requested
    CLI-->>User: bgagent approve TASK REQ
    User->>CLI: bgagent approve TASK REQ
    CLI->>Lambda: POST /tasks/:id/approve
    Lambda->>Approvals: TransactWriteItems
    Note right of Lambda: Approvals row PENDING to APPROVED<br/>plus TaskTable AWAITING_APPROVAL guard
    Lambda->>Events: approval_decision_recorded (audit)
    Lambda-->>CLI: 202 APPROVED
    Hook->>Approvals: poll with ConsistentRead
    Approvals-->>Hook: status APPROVED
    Hook->>Approvals: TransactWriteItems, TaskTable to RUNNING
    Hook->>Engine: allowlist.add for the scope (step 25b) if it is not this_call
    Hook-->>Agent: permissionDecision allow
    Note over Stop: (not used on approval path)
```

### Continuation

27. The agent continues with its turn and makes another `Bash` call (say `git log --oneline -5`).
28. The PreToolUse hook calls PolicyEngine.evaluate_tool_use:
    - Hard-deny: no match
    - Allowlist: `tool_type:Bash` matches. The engine returns ALLOW on the fast-path.
29. There is no new approval request. The tool runs immediately.
30. The agent reaches task completion, opens a PR, and writes memory. The task moves to `COMPLETED`.

### Denial with steering text

If instead the user runs `bgagent deny <task_id> <req_id> --reason "use --force-with-lease instead"`:
- `DenyTaskFn` runs `output_scanner.scan(reason)` to redact any accidental secrets or PII from the reason **before** writing it to DDB.
- `DenyTaskFn` flips the row to DENIED with the sanitized reason, through the same atomic cross-table `TransactWriteItems` pattern as approve (§7.1).
- The agent's poll reads the DENIED row.
- Hook execution order:
  - a. Atomic resume transition to RUNNING (same as approve path).
  - b. **Best-effort denial injection** into the agent context via the Phase-2 `between_turns_hooks` registry. The hook queues a synthetic `<user_denial nudge_id="..." timestamp="..." request_id="...">sanitized reason</user_denial>` block for the next Stop-seam injection. The `_denial_between_turns_hook` is registered AFTER `_nudge_between_turns_hook` (which itself runs after `_cancel_between_turns_hook`). On a task that is simultaneously denied and cancelled, the cancel therefore short-circuits both the nudge and denial readers, and the steering text does NOT reach the model. This is acceptable because:
    - The SDK's `permissionDecisionReason` on the hook return (step d) is the guaranteed steering surface. The model always sees the user's reason and the stop-language of step d, even when the between-turns injection is pre-empted by cancel.
    - On a cancelled task, the agent turn terminates anyway, so there is no "next turn" for the between-turns injection to act on.
    - Queued denial rows remain in DDB with status=DENIED for the 90-day audit window, so operators can retrospectively see what the user said even when the model didn't receive it.
  - c. Milestone emission: `approval_denied`. Emission is best-effort. The audit record in TaskEventsTable owned by `DenyTaskFn` is authoritative.
  - d. Return to SDK: `{"permissionDecision": "deny", "permissionDecisionReason": "AUTHORITATIVE DENY from human reviewer: <sanitized reason> (matching rule: <rule_id>). Do NOT retry this class of action with trivial variations; …"}`, with `permissionDecisionReason` held to 500 chars. This is the guaranteed surface. It is included directly as the SDK's rejection hint, so the model sees the user's intent even when the Stop-seam injection is pre-empted. The stop-language, from "Do NOT retry" on, answers issue #113. Given a bare reason, the agent retried the denied rule with variations until it ran out of turns. When the text would exceed 500 chars, the user's reason is shortened and the stop-language is kept. A TIMED_OUT gate returns its plain reason, without stop-language.

There are two paths for the denial reason. The Claude Agent SDK's `permissionDecisionReason` reaches the model as a tool-call-rejected system hint, and the model treats that hint as a signal to retry differently. The Phase-2 `between_turns_hooks` mechanism injects the denial as authoritative user context, which carries more detail and steers the model better. We use both because neither alone is sufficient. `permissionDecisionReason` is always delivered but is a terse hint. The between-turns injection carries more detail but can be pre-empted by a concurrent cancel. Together they cover the matrix of (tool denied, task cancelled) × (next turn runs, next turn doesn't).

**Scenario (finding #2):** A user at 3:47 AM is working against an agent that keeps failing on a bad merge. They type `bgagent deny 01KPW... 01KPR... --reason "stop trying to rebase, just abandon the branch"` into Terminal B, press Enter, then immediately run `bgagent cancel 01KPW...` in Terminal C because the agent is not recovering. DenyTaskFn's transaction lands first, flipping the approval to DENIED. The agent's PreToolUse hook is already in the poll loop. A microsecond later the cancel arrives. The `_cancel_between_turns_hook` fires on the next Stop seam and sets the cancel flag, and the flag short-circuits every subsequent between-turns producer, including our `_denial_between_turns_hook`. The user's reason text never reaches the model as an injected turn. If we relied only on the between-turns path, the agent would have seen a bare rejection with no reason. Because `permissionDecisionReason` is set independently (step 25d) with a truncated copy of the sanitized reason, the model still receives "AUTHORITATIVE DENY from human reviewer: stop trying to rebase, just abandon the branch …" at the SDK boundary. The DenyTaskFn DDB write persists the full reason for the audit log regardless of which surface the model saw. No guaranteed surface is lost. The stronger between-turns injection is best-effort.

---

## 5. Cedar policy authoring guide

### 5.1 Policy file layout

Two physical files, each with exactly one tier:

- `agent/policies/hard_deny.cedar` contains ONLY `@tier("hard")` policies
- `agent/policies/soft_deny.cedar` contains ONLY `@tier("soft")` policies

Per-repo customization lives in `blueprint.yaml`:

```yaml
security:
  cedarPolicies:
    hard: |
      @tier("hard")
      @rule_id("block_prod_writes")
      forbid (principal, action == Agent::Action::"write_file", resource)
        when { context.file_path like "prod/**" };
    soft: |
      @tier("soft")
      @rule_id("deploy_staging")
      @approval_timeout_s("900")
      @severity("high")
      @category("destructive")
      forbid (principal, action == Agent::Action::"execute_bash", resource)
        when { context.command like "*terraform apply*" };
    disable:
      # Opt-out of specific soft-deny rules. May include built-in soft-deny
      # rule_ids OR blueprint-added rule_ids. MAY NOT include any built-in
      # hard-deny rule_id — blueprint loader rejects those at task start.
      - write_infrastructure          # example: repo has its own stricter rule
  maxPreApprovalScope: "tool_type_session"   # optional; caps what --pre-approve can grant
  approvalGateCap: 50                         # optional; per-task lifetime cap on gates (1 ≤ N ≤ 500, default 50). See §3 decision #13.
```

**`approvalGateCap` sizing guidance:**

- **Short, well-scoped tasks** (dependency bumps, small refactors): the default of 50 is generous. The typical p99 is under 5 gates. No override is needed.
- **Long-running migrations** (auth rewrites, schema migrations spanning days of agent work): raise to between 100 and 200. The cap is a terminal circuit breaker, not a behavioral control. The per-minute rate limit (decision #14) and soft-deny policies still govern user-prompt frequency.
- **High-risk blueprints** (direct production access, customer-data handling): lower to between 10 and 20. A blueprint that legitimately needs more than 20 user decisions in a single task probably has a policy-design problem (too many soft-deny rules, or missing pre-approval allowlist entries).
- **Hard upper bound: 500.** A task that needs more should be split, not allowed to accumulate more human decisions. The blueprint loader rejects values outside `[1, 500]` at task start.

`PolicyEngine.__init__` concatenates the built-in and blueprint rules per tier, then validates them with a probe `cedarpy.is_authorized()` call. **Any** of the following fails the task at start, with no silent fallback:

- Malformed policy syntax
- Duplicate `@rule_id` values across tiers
- `@approval_timeout_s` below floor (30s) or non-integer
- `@tier` value mismatches the file section (hard rules in soft file or vice versa)
- Missing `@rule_id` on a soft-deny rule
- `disable:` entry naming a built-in hard-deny rule_id (see §15.4 for the built-in list)
- `disable:` entry naming a rule_id that does not exist (blueprint drift safeguard)
- Combined `hard + soft` Cedar text larger than **64 KB** after concatenation (§12.4)

Fail-on-error is the right posture for blueprint misconfiguration. A silent fallback would let broken policies reach production.

**Scenario (finding #9):** A platform operator adds a blueprint `disable: [rm_slash]` directive because a repo does dry-run `rm -rf /tmp/test-build-*` in its CI simulation suite and the built-in `rm_slash` rule is too broad (it matches `rm -rf /tmp/...`). If `disable:` allowed hard-deny suppression, the repo's agent could now execute actual `rm -rf /` commands with nothing to stop them. And because hard-deny is evaluated before the allowlist fast-path, a prompt-injected agent could not be stopped by `--pre-approve`. The blueprint loader therefore rejects `disable: [rm_slash]` at task start with this error: "Cannot disable built-in hard-deny rule 'rm_slash'; hard-deny rules are absolute. If this rule is too broad, file a platform-team ticket to refine the built-in pattern." The repo must instead adjust their CI to not exercise `/tmp/` destructive paths, or the platform team must ship a refined built-in. `disable:` for soft-deny rules is always permitted. The human safety net is intact.

**Scenario (finding #12):** A malicious blueprint author commits a `security.cedarPolicies.soft:` block that is 8 MB of repeated noisy rules, attempting a DoS against the agent's 512 MB policy-engine budget. Without a hard cap, `PolicyEngine.__init__` would attempt to parse and compile all 8 MB at task start, potentially OOM-killing the container and leaving the task stranded in HYDRATING. With the 64 KB combined cap enforced at blueprint load (both at `CreateTaskFn` submit-time validation AND at `PolicyEngine.__init__` as a redundant check), the oversized blueprint is rejected with `VALIDATION_ERROR: cedar_policies exceeds 64 KB cap (8388608 bytes)`. 64 KB fits ~800 medium-complexity Cedar rules, orders of magnitude more than any realistic blueprint needs. The cap applies regardless of blueprint origin (CDK-deployed today, potentially user-uploadable in future §12.4) because future origin changes should not require re-validating every defense.

### 5.2 Annotation reference

| Annotation | Required? | Values | Purpose |
|---|---|---|---|
| `@rule_id("...")` | **Yes on soft-deny**, recommended on hard-deny | Kebab-case or snake_case identifier, unique across both tiers | Stable ID for `--pre-approve rule:X`, for audit trail, and for the `bgagent policies` discovery endpoint. `PolicyEngine.__init__` raises on duplicates. |
| `@tier("hard"\|"soft")` | **Yes** | Exactly one of "hard" or "soft" | Validates that the policy is in the correct file or section. The engine rejects a mismatch at load time. |
| `@approval_timeout_s("N")` | No | Integer seconds ≥ 30 | Per-rule timeout. If absent, uses the task default (**300s** by default, overridable via submit-time `--approval-timeout`, see decision #6). Has no effect on hard-deny rules. Values below the floor are rejected at load time. Values below **120s** emit a blueprint-load WARN but are accepted down to the 30s floor. Almost no human responds to an approval request in under 2 minutes, so sub-120s is usually a policy-authoring mistake (see IMPL-25). Loader policy: STRICT at the floor (30s, reject) and ADVISORY below 120s (warn, accept). |
| `@severity("low"\|"medium"\|"high")` | No | One of the three | Shown in the CLI approval prompt, colored by severity. Default: "medium". |
| `@category("...")` | No | "destructive", "network", "filesystem", "auth", or free-form | UX grouping. The CLI could filter approvals by category. Not enforced. |

### 5.3 Common policy patterns

**Block absolute dangers** (hard-deny):
```cedar
@tier("hard")
@rule_id("rm_slash")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*rm -rf /*" };

@tier("hard")
@rule_id("write_git_internals")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like ".git/*" };

@tier("hard")
@rule_id("write_git_internals_nested")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*/.git/*" };

@tier("hard")
@rule_id("drop_table")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*DROP TABLE*" };
```

**Gate destructive git ops** (soft-deny, part of the built-in starter set):
```cedar
@tier("soft")
@rule_id("force_push_any")
@approval_timeout_s("300")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*git push --force*" };

@tier("soft")
@rule_id("force_push_main")
@approval_timeout_s("600")
@severity("high")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*git push --force origin main*"
      || context.command like "*git push --force origin prod*"
      || context.command like "*git push -f origin main*"
      || context.command like "*git push -f origin prod*" };

@tier("soft")
@rule_id("push_to_protected_branch")
@approval_timeout_s("300")
@severity("medium")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*git push origin main*"
      || context.command like "*git push origin prod*"
      || context.command like "*git push origin master*"
      || context.command like "*git push origin release/*" };
```

A force-push to any branch needs approval in 300s. A force-push to `main` or `prod` gives the user 600s with elevated severity. A non-force push to a protected branch (`main`/`prod`/`master`/`release/*`) also gates. That catches the case where an agent pushes directly instead of opening a PR. If a command matches both `force_push_any` and `force_push_main`, multi-match merging picks `min(300, 600) = 300s` and `max(medium, high) = high`.

**Protect sensitive file paths** (soft-deny, part of the built-in starter set):
```cedar
@tier("soft")
@rule_id("write_env_files")
@approval_timeout_s("600")
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*.env" };

@tier("soft")
@rule_id("write_credentials")
@approval_timeout_s("300")
@severity("high")
@category("auth")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*credentials*" };
```

**Optional patterns, not shipped by default. Copy them into your blueprint if your repo needs them:**
```cedar
// Gate writes under a conventional infrastructure/ directory. Not in the
// built-in set because the "infrastructure/" path is a repo convention,
// not a standard — many repos use cdk/, terraform/, deploy/, etc. Add to
// your blueprint if your repo uses this layout.
// @tier("soft")
// @rule_id("write_infrastructure")
// @approval_timeout_s("900")
// @severity("high")
// @category("filesystem")
// forbid (principal, action == Agent::Action::"write_file", resource)
//   when { context.file_path like "infrastructure/*" };

// Gate all outbound WebFetch. Not in the built-in set because DNS
// Firewall already restricts egress to an allowlist; gating every
// WebFetch produces high-volume approval requests on doc-heavy tasks.
// Add to your blueprint if your repo wants stricter scrutiny.
// @tier("soft")
// @rule_id("webfetch_any")
// @approval_timeout_s("300")
// @severity("medium")
// @category("network")
// forbid (principal, action == Agent::Action::"invoke_tool",
//         resource == Agent::Tool::"WebFetch");

// Gate writes to specific CI config. Example — tune paths per repo.
// @tier("soft")
// @rule_id("write_github_workflows")
// @approval_timeout_s("600")
// @severity("high")
// @category("filesystem")
// forbid (principal, action == Agent::Action::"write_file", resource)
//   when { context.file_path like ".github/workflows/*" };
```

Per the sentinel trick (see §6.2), `invoke_tool` matches on the real tool-name UID. The other actions (`write_file`, `execute_bash`) use a sentinel UID with the real value in `context`.

### 5.4 Policy discovery — shared parser

Because `CreateTaskFn` must validate `rule:<id>` pre-approvals against the target repo's actual policy set, we ship a **shared policy-parsing library** used in both places:

- `cdk/src/handlers/shared/cedar-policy.ts` is a thin wrapper around `@cedar-policy/cedar-wasm@4.12.0` for TypeScript
- `agent/src/policy.py` is the full engine, using `cedarpy`

Both consume the blueprint's `security.cedarPolicies` section. `CreateTaskFn` loads the target repo's blueprint (via the existing `RepoTable` store), concatenates it with the built-in policies, parses the result via `cedar.policyToJson()` (TypeScript, §15.6), and extracts the `rule_id` and `tier` annotations. `--pre-approve rule:X` is validated as follows:

- If `X` exists as some rule's `@rule_id`, the scope is accepted.
- If `X` refers to a hard-deny rule, the request fails with 400 at submit time (hard-deny cannot be bypassed).
- If `X` refers to a soft-deny rule, the scope is accepted and passes through.
- If a blueprint `disable: [X]` names a built-in hard-deny rule `X`, the request fails with 400 at submit time (§5.1, §15.4).

Both engines' outputs must agree on the `(decision, matching_rule_ids)` for any input. The cross-engine parity test enforces this (§15.6 and decision #23). See §15.6 for the golden-file CI pattern.

Runtime enforcement is still the authoritative layer. Submit-time validation is a UX guard. Any drift between the submit-time and runtime-loaded policies (possible if the blueprint changes between them) fails the task at HYDRATING with an error, instead of letting it misbehave silently. `initial_approvals` is re-validated on container start (§4 step 6). See §13.10 for the drift failure mode.

**Scenario (finding #11):** A user submits `bgagent submit ... --pre-approve rule:deploy_staging` at 9:00 AM against a blueprint that has `deploy_staging` as a soft-deny rule. `CreateTaskFn` validates the scope. `deploy_staging` resolves to a soft-deny rule in the blueprint snapshot, so the submit returns 202. At 9:01 AM a platform engineer deploys an updated blueprint that removes the `deploy_staging` rule (perhaps it was consolidated under a broader `deploy_any` rule). At 9:03 AM the container spawns and `PolicyEngine.__init__` loads the NEW blueprint. The allowlist seeding step tries to resolve `rule:deploy_staging`, finds no matching rule_id, and the task fails at HYDRATING with reason `"initial_approvals drift: rule 'deploy_staging' missing from current blueprint"`. The user sees a clear failure and can resubmit with the new rule name. Without this drift re-validation, the task would silently run without the `deploy_staging` pre-approval. It would gate on what the user thought was already allowed, which is worse than failing, because the user believes their policy was applied when it wasn't.

### 5.5 Gotchas for policy authors

**`like` is glob, not regex.** The only wildcards are `*` (zero-or-more) and `?` (exactly-one-char). If you need regex, write multiple `forbid` rules.

**Case sensitivity in Cedar and in the allowlist.** Cedar `like` is case-sensitive. `*rm -rf*` won't match `*Rm -Rf*`. If case-insensitivity matters, write both variants. The `write_path:` and `bash_pattern:` allowlist scopes use Python `fnmatch` at runtime, which accepts more than Cedar `like` (it supports `[seq]` bracket expressions) and is case-sensitive on Linux but case-insensitive on macOS. Agent containers run Linux, so dev-loop validation on macOS can produce inconsistent results. See the finding #15 scenario below.

**Don't match `resource ==` for user-supplied values.** `Bash` commands and file paths go through the sentinel UID. Always use `context.command` or `context.file_path` in the `when` clause, never `resource == ...`.

**`@rule_id` must be globally unique.** That includes across tiers. `PolicyEngine.__init__` raises on duplicates.

**Hard-deny rules shouldn't have `@approval_timeout_s`.** It has no effect. The engine logs a WARN but doesn't reject the rule (for backward compatibility if someone moves a rule between tiers).

**The default ruleset is shared across all tasks.** Per-task overrides live in the Blueprint and are isolated to tasks on that repo. The engine never allows a task to loosen the default hard-deny set via Blueprint. A task can only add to it. The `disable:` list may remove built-in soft-deny rules but may NOT remove built-in hard-deny rules.

**`@approval_timeout_s` values below 30 are rejected at load.** There is no way to configure unusably-short approval windows.

**Scenario (finding #15):** A user developing on a MacBook tests their `write_path:docs/**` pre-approval flow locally by running the agent in dev mode. They write a Bash script that creates `docs/INDEX.md`. Python `fnmatch` on macOS is case-insensitive by default, so `fnmatch("docs/INDEX.md", "docs/**")` returns True. Their local test passes. They deploy the task to the production Lambda-backed agent runtime (Linux). The agent tries to write `docs/INDEX.md`. `fnmatch` on Linux is case-sensitive, and the match still succeeds because both sides are `docs/`. This case works. But on a different task the user writes `write_path:Docs/**` (capital D), tests locally where it matches `docs/readme.md`, and it silently breaks in production where `docs/readme.md` does NOT match `Docs/**`. To avoid this trap: (a) the documentation notes the dev-vs-prod case-sensitivity mismatch in §5.5 and §6.4, (b) the CLI `submit` command emits a WARN when `--pre-approve write_path:<glob>` contains any uppercase character (since Linux casing is canonical and uppercase dir names are unusual), (c) CI tests exercise both macOS and Linux so the drift is caught pre-merge. The alternative, restricting to the Cedar-`like` subset, would remove useful features like `[...]` bracket expressions that users will ask for. Documentation plus telemetry is the pragmatic tradeoff.

---

## 6. Engine implementation

### 6.1 Extended `PolicyDecision` shape

```python
from dataclasses import dataclass
from enum import Enum

class Outcome(str, Enum):
    ALLOW = "allow"
    DENY = "deny"                      # absolute (hard-deny or upstream error or cap-exceeded)
    REQUIRE_APPROVAL = "require_approval"  # soft-deny hit

@dataclass(frozen=True)
class PolicyDecision:
    outcome: Outcome
    reason: str
    # Only populated when outcome == REQUIRE_APPROVAL:
    timeout_s: int | None = None
    severity: str | None = None
    matching_rule_ids: tuple[str, ...] = ()
    duration_ms: float = 0

    @property
    def allowed(self) -> bool:
        """Backward-compat shim for Phase 1a/1b callers."""
        return self.outcome == Outcome.ALLOW
```

### 6.2 `evaluate_tool_use` skeleton

```python
def evaluate_tool_use(self, tool_name: str, tool_input: dict) -> PolicyDecision:
    start = time.monotonic()
    base_context = {"task_type": self._task_type, "repo": self._repo}
    input_sha = _sha256(json.dumps(tool_input, sort_keys=True))

    # STEP 1 — Hard-deny (absolute)
    hard = self._eval_tier(self._hard_policies, tool_name, tool_input, base_context)
    if hard.decision == "deny":
        return PolicyDecision(outcome=Outcome.DENY,
                              reason=f"Hard-deny: {hard.rule_ids}",
                              duration_ms=_elapsed(start))

    # STEP 2 — Allowlist fast-path (covers tool_type, bash_pattern, write_path, all_session)
    if self._allowlist.matches(tool_name, tool_input):
        return PolicyDecision(outcome=Outcome.ALLOW,
                              reason="Pre-approved by allowlist",
                              duration_ms=_elapsed(start))

    # STEP 2.5 — Recent-decision cache (anti-retry-loop, 60s TTL, session-scoped)
    cached = self._recent_decisions.get((tool_name, input_sha))
    if cached is not None:
        return PolicyDecision(outcome=Outcome.DENY,
                              reason=f"Recent decision ({cached.decision}) within 60s: {cached.reason}",
                              duration_ms=_elapsed(start))

    # STEP 3 — Soft-deny (require approval)
    soft = self._eval_tier(self._soft_policies, tool_name, tool_input, base_context)
    if soft.decision == "deny":
        # Rule-scope allowlist check happens AFTER soft-deny eval (rule_ids
        # aren't known until Cedar tells us which policies matched)
        if any(rid in self._allowlist._rule_ids for rid in soft.rule_ids):
            return PolicyDecision(outcome=Outcome.ALLOW,
                                  reason=f"Allowlist rule: {soft.rule_ids}",
                                  duration_ms=_elapsed(start))

        annotations = self._merge_annotations(soft.rule_ids)
        return PolicyDecision(
            outcome=Outcome.REQUIRE_APPROVAL,
            reason=f"Soft-deny: {', '.join(annotations['rule_ids'])}",
            timeout_s=annotations["timeout_s"],
            severity=annotations["severity"],
            matching_rule_ids=tuple(annotations["rule_ids"]),
            duration_ms=_elapsed(start),
        )

    # STEP 4 — Default allow
    return PolicyDecision(outcome=Outcome.ALLOW, reason="permitted",
                          duration_ms=_elapsed(start))
```

The recent-decision cache is a `dict[(tool_name, input_sha), (decision, reason, inserted_at)]` with a 60-second sliding window. The PreToolUse hook adds an entry whenever an approval resolves to DENIED or TIMED_OUT. It adds none on APPROVED, because we don't want to auto-deny a tool call the user just approved. The cache is in-process and **lost on container restart**, so the same recently-denied action can be gated again if the container restarts mid-task. See §12.8 and the finding #3 scenario below.

**Scenario (finding #3):** A developer submits `--task "ship the hotfix to main"` and the agent runs `Bash: git push --force origin main`. The soft-deny rule `force_push_main` fires, and the user clicks deny with reason "open a PR instead of force-pushing main". The agent's recent-decision cache now holds `(Bash, sha256("git push --force origin main"))` for 60 seconds. The agent tries the same command on its next turn (the cache hit auto-denies with no new approval request, which is the purpose of the cache). Now imagine a container restart at this moment (AWS spot interruption, OOM-kill, manual redeploy). The new container's `PolicyEngine` has an empty cache. The agent tries the same command again. The soft-deny fires again. The user gets the same prompt they denied 30 seconds ago. This is annoying but bounded. With the persistent per-task `approvalGateCap` (decision #13, default 50), even with worst-case restart and retry amplification the user sees at most `approvalGateCap` prompts before the task is force-failed. We accept this as a threat-model caveat instead of persisting the cache to DDB because (a) container restarts are rare, (b) DDB persistence would add latency to every denied call's write path, and (c) the persistent gate cap provides the terminal safety regardless of cache state. An operator monitoring the `approval_cap_exceeded` dashboard widget will see anomalous retry patterns if they become systemic. A persistent decision cache is noted in §17 as future work, conditional on restart telemetry that justifies the complexity.

### 6.3 Annotation merging

When multiple soft-deny rules match a single tool call, the engine merges their annotations:

```python
def _merge_annotations(self, policy_ids: list[str]) -> dict:
    rule_ids, timeouts, severities = [], [], []
    for pid in policy_ids:
        ann = self._annotations[pid]
        rule_ids.append(ann.get("rule_id", pid))
        if "approval_timeout_s" in ann:
            try:
                t = int(ann["approval_timeout_s"])
                if t >= FLOOR_30S:
                    timeouts.append(t)
            except ValueError:
                log("WARN", f"malformed @approval_timeout_s on {ann.get('rule_id', pid)}")
        severities.append(ann.get("severity", "medium"))

    # Task default always eligible
    timeouts.append(self._task_default_timeout_s)

    raw_min_timeout = min(timeouts)
    return {
        "rule_ids": rule_ids,
        "timeout_s": max(FLOOR_30S, raw_min_timeout),  # floor enforcement
        "severity": _max_severity(severities),          # "high" > "medium" > "low"
    }
```

**Rationale for the min and max choices:**
- **Timeout takes the minimum (above the floor).** Multiple matching rules mean multiple concerns. Users should have *less* time to decide when stakes are higher. The floor prevents unusable 5s windows.
- **Severity takes the maximum.** The most severe concern governs the UX coloring.

### 6.4 Allowlist data structure

```python
class ApprovalAllowlist:
    def __init__(self, initial_scopes: list[str]):
        self._all_session = False
        self._tool_types: set[str] = set()
        self._tool_groups: set[str] = set()         # file_write → {Write, Edit}
        self._rule_ids: set[str] = set()
        self._bash_patterns: list[str] = []         # glob patterns
        self._write_path_patterns: list[str] = []   # glob patterns, for Write/Edit file_path

        for scope in initial_scopes:
            self.add(scope)

    TOOL_GROUPS = {"file_write": {"Write", "Edit"}}

    def add(self, scope: str) -> None:
        if scope == "all_session":
            self._all_session = True
        elif scope.startswith("tool_type:"):
            self._tool_types.add(scope.split(":", 1)[1])
        elif scope.startswith("tool_group:"):
            group = scope.split(":", 1)[1]
            if group not in self.TOOL_GROUPS:
                raise ValueError(f"unknown tool_group: {group!r}")
            self._tool_groups.add(group)
        elif scope.startswith("rule:"):
            self._rule_ids.add(scope.split(":", 1)[1])
        elif scope.startswith("bash_pattern:"):
            self._bash_patterns.append(scope.split(":", 1)[1])
        elif scope.startswith("write_path:"):
            self._write_path_patterns.append(scope.split(":", 1)[1])
        else:
            raise ValueError(f"unknown scope: {scope!r}")

    def matches(self, tool_name: str, tool_input: dict) -> bool:
        if self._all_session:
            return True
        if tool_name in self._tool_types:
            return True
        for group in self._tool_groups:
            if tool_name in self.TOOL_GROUPS[group]:
                return True
        if tool_name == "Bash":
            cmd = tool_input.get("command", "")
            # fnmatch semantics: case-sensitive on Linux (production),
            # case-insensitive on macOS (dev-only); see §5.5 footgun note.
            # fnmatch supports richer globbing than Cedar `like` (e.g.
            # [seq] bracket expressions). Document as a Cedar-`like`
            # superset rather than restrict — users will want [0-9] et al.
            if any(fnmatch(cmd, pat) for pat in self._bash_patterns):
                return True
        if tool_name in ("Write", "Edit"):
            path = tool_input.get("file_path", "")
            if any(fnmatch(path, pat) for pat in self._write_path_patterns):
                return True
        # rule_ids matched after soft-deny eval — see evaluate_tool_use
        return False
```

### 6.5 PreToolUse hook changes

The PreToolUse hook follows, compressed for this document. The implementation will be more detailed:

```python
async def pre_tool_use_hook(hook_input, tool_use_id, ctx, *,
                            engine, task_id, user_id, progress, sse_adapter,
                            task_default_timeout_s):
    tool_name, tool_input = _extract(hook_input)
    decision = engine.evaluate_tool_use(tool_name, tool_input)

    if decision.outcome == Outcome.ALLOW:
        return _allow()
    if decision.outcome == Outcome.DENY:
        return _deny(decision.reason)

    # REQUIRE_APPROVAL path.
    # Cap + rate-limit check. Per-minute rate limit is per-container; on
    # container restart the counter resets. The per-task approvalGateCap
    # (blueprint-configurable, default 50) is persisted and bounds cumulative
    # damage across restarts (§13.6).
    if engine.approval_gate_count >= engine.approval_gate_cap:
        return _deny(f"approval-gate cap exceeded ({engine.approval_gate_cap}/task)")
    if engine.approvals_in_last_minute >= APPROVAL_RATE_LIMIT:
        return _deny("approval-gate rate limit exceeded (20/min)")

    # Compute effective timeout with floor/ceiling.
    remaining = _remaining_maxlifetime_s()
    effective_timeout = max(
        FLOOR_30S,
        min(decision.timeout_s or task_default_timeout_s,
            task_default_timeout_s,
            remaining - CLEANUP_MARGIN_120S),
    )
    if remaining - CLEANUP_MARGIN_120S < FLOOR_30S:
        return _deny(f"insufficient maxLifetime remaining ({remaining}s) for approval")

    request_id = _ulid()
    engine.approval_gate_count += 1

    row = {
        "task_id": task_id, "request_id": request_id,
        "tool_name": tool_name,
        "tool_input_preview": _strip_ansi(_preview(tool_input))[:256],
        "tool_input_sha256": _sha256(_serialize(tool_input)),
        "reason": decision.reason, "severity": decision.severity,
        "matching_rule_ids": list(decision.matching_rule_ids),
        "status": "PENDING",
        "created_at": _iso_now(),
        "timeout_s": effective_timeout,
        "ttl": int(time.time()) + effective_timeout + CLEANUP_MARGIN_120S,
        "user_id": user_id, "repo": engine.repo,
    }

    # ATOMIC: put approval row + transition TaskTable status in one transaction.
    try:
        await _transact_write_approval_request(task_id, request_id, row)
    except TransactionCanceledException as exc:
        # Either the task was concurrently cancelled, or status wasn't RUNNING.
        _emit("approval_write_failed", {"request_id": request_id, "reason": str(exc)})
        return _deny("approval system unavailable")

    _emit("approval_requested", {
        "request_id": request_id, "tool_name": tool_name,
        "input_preview": row["tool_input_preview"],
        "reason": decision.reason, "severity": decision.severity,
        "timeout_s": effective_timeout,
        "matching_rule_ids": list(decision.matching_rule_ids),
    })

    outcome = await _poll_for_decision(task_id, request_id, effective_timeout)

    # On TIMED_OUT, attempt to write the row to TIMED_OUT so future reads see
    # a terminal state (not orphaned PENDING). The conditional write is guarded
    # by `status = :pending` — if the user's APPROVE landed between our last
    # poll and this write, the condition fails. In that case we MUST re-read
    # the row and honor whatever terminal state won the race; otherwise local
    # `outcome.status = "TIMED_OUT"` is stale and we would deny a call the user
    # just approved ("I approved it" → agent denies). See §13.12 and the
    # scenario below.
    if outcome.status == "TIMED_OUT":
        wrote_timeout = await _best_effort_update_status(
            task_id, request_id, "TIMED_OUT",
            reason=outcome.reason,
            # Returns True on successful write, False on ConditionCheckFailed.
        )
        if not wrote_timeout:
            # Re-read the row with ConsistentRead — user's decision beat us.
            row = await _ddb_get_approval(task_id, request_id, ConsistentRead=True)
            if row is not None and row["status"] == "APPROVED":
                # Late-approve wins. Honor it. Rebuild the outcome so the
                # downstream allow flow (scope propagation, milestone emission,
                # resume transaction) runs identically to the normal approve
                # path.
                outcome = Decided(
                    status="APPROVED",
                    scope=row.get("scope"),
                    decided_by=row.get("user_id"),
                    decided_at=row.get("decided_at"),
                )
                _emit("approval_late_win", {
                    "request_id": request_id,
                    "outcome": "APPROVED",
                    "reason": "user decision landed during TIMED_OUT write",
                })
            elif row is not None and row["status"] == "DENIED":
                outcome = Decided(
                    status="DENIED",
                    reason=row.get("deny_reason") or "denied",
                    decided_at=row.get("decided_at"),
                )
            # If status is still PENDING (rare — concurrent reaper race) or
            # the row is gone (TTL reaped before we could read it), fall
            # through with the original TIMED_OUT outcome; fail-closed deny.

    # ATOMIC: resume TaskTable status RUNNING, conditional on awaiting_approval_request_id matching.
    try:
        await _transact_resume(task_id, request_id)
    except TransactionCanceledException:
        # User cancelled (or some other path) during poll; abandon gracefully.
        _emit("approval_resume_failed", {"request_id": request_id})
        return _deny("task no longer awaiting approval")

    if outcome.status == "APPROVED":
        # this_call adds nothing. tool_type_session and tool_group_session
        # become tool_type:<tool_name> and tool_group:<group of tool_name>
        # (§4 step 25b); every other scope is added as it is.
        for grant in _allowlist_scopes(outcome.scope or "this_call", tool_name):
            engine._allowlist.add(grant)
        _emit("approval_granted", {"request_id": request_id,
                                   "scope": outcome.scope or "this_call",
                                   "decided_at": outcome.decided_at})
        return _allow()

    # DENIED or TIMED_OUT — cache for 60s + queue denial injection.
    engine._recent_decisions.record(
        tool_name, _sha256(_serialize(tool_input)),
        decision="DENIED" if outcome.status == "DENIED" else "TIMED_OUT",
        reason=outcome.reason,
    )
    # Truncated reason for guaranteed-surface permissionDecisionReason.
    # Best-effort richer injection via _denial_between_turns_hook; may be
    # pre-empted by _cancel_between_turns_hook on a concurrently-cancelled
    # task. See §4 "Denial with steering text" scenario.
    permission_decision_reason = _truncate(
        outcome.reason or f"User {outcome.status.lower()}", max_len=500
    )
    if outcome.status == "DENIED":
        # Queue steering injection via Stop hook's between_turns_hooks.
        engine._queue_denial_injection(
            request_id=request_id,
            reason=outcome.reason,  # already sanitized by DenyTaskFn
            decided_at=outcome.decided_at,
        )
    _emit("approval_denied" if outcome.status == "DENIED" else "approval_timed_out",
          {"request_id": request_id, "reason": outcome.reason})
    return _deny(permission_decision_reason)
```

`engine._queue_denial_injection` appends to a list consumed by `_denial_between_turns_hook`. That hook is registered **after** `_nudge_between_turns_hook` in the `between_turns_hooks` list (which itself runs after `_cancel_between_turns_hook`). When the Stop hook next fires, the denial is emitted as `<user_denial>…</user_denial>` XML (sanitized via `_xml_escape` from the shared utility introduced with Phase 2). If a `bgagent cancel` has landed between the deny and the next Stop seam, `_cancel_between_turns_hook` short-circuits the dispatcher and the denial text is NOT injected. In that case the guaranteed surface is `permissionDecisionReason` on the hook return. See the finding #2 scenario in §4 for the cancel-vs-deny race reasoning.

**Scenario (§13.12 VM-throttle + late-approval race).** User Alice hits a soft-deny gate at t=0 with `timeout_s=300`. The AgentCore VM is evicted from its warm CPU share around t=285 due to noisy-neighbor pressure on the host. Poll ticks stretch by ~400ms. Alice, seeing the approval prompt in Terminal A, types `bgagent approve 01KPW... 01KPR...` at t=294. The approve-transaction lands in DDB at t=294.7 (APPROVED). The agent's next poll-tick was due at t=290 but the VM throttle delayed it to t=295.1. The monotonic wall-clock already shows elapsed >300 (actual since-start ~300.3s), so `_poll_for_decision` returns `TimedOut()`. The hook runs `_best_effort_update_status("TIMED_OUT", ... WHERE status = :pending)`. The conditional fails because the row is APPROVED. **Without the re-read**, the hook would proceed with stale local `outcome.status = "TIMED_OUT"`, queue a denial injection, and return `{"permissionDecision": "deny"}`. Alice sees "I approved it" on Terminal B, but the agent denies the tool call anyway. **With the re-read** (the `wrote_timeout` branch in the pseudocode above), the hook fetches the row with ConsistentRead, sees `status = APPROVED`, rebuilds `outcome` from the row (preserving `scope`, `decided_by`, `decided_at`), emits an `approval_late_win` milestone, runs the normal resume transaction and allow flow, and returns `{"permissionDecision": "allow"}`. Alice's tool runs. The cost is one extra strongly-consistent GetItem on the race path. The benefit is that user intent is authoritative. Without this fix, a timer design that is otherwise sound would produce a confounding and unrecoverable UX. See IMPL-24, §13.12, and §15.2 task #43 for the race test.

---

## 7. REST API contract

### 7.1 `POST /v1/tasks/{task_id}/approve`

**Request** (from the CLI through API Gateway to `ApproveTaskFn`):
```http
POST /v1/tasks/01KPW.../approve
Authorization: Bearer <cognito_id_token>
Content-Type: application/json

{
  "request_id": "01KPR...",
  "decision": "approve",
  "scope": "tool_type_session"
}
```

**Responses**:

| Status | Code | When | Body |
|---|---|---|---|
| 202 | — | Success | `{task_id, request_id, status: "APPROVED", scope, decided_at}` |
| 400 | `VALIDATION_ERROR` | Bad scope format, missing fields | `{error, message, field}` |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT | — |
| 404 | `REQUEST_NOT_FOUND` | Row missing OR wrong user (both return 404 to prevent enumeration) | — |
| 409 | `REQUEST_ALREADY_DECIDED` | Approvals row status != PENDING | `{error, message, current_status}` |
| 409 | `TASK_NOT_AWAITING_APPROVAL` | Task's current status is not AWAITING_APPROVAL | `{error, message, current_status}` |
| 429 | `RATE_LIMIT_EXCEEDED` | Per-user > 30 approve/min | — |
| 503 | `SERVICE_UNAVAILABLE` | DDB throttled or upstream failure | — |

**Authorization, state, ownership, and task-state are a single atomic transaction.** Per finding #7, `ApproveTaskFn` uses `TransactWriteItems` across BOTH tables, not separate GetItem+UpdateItem. This closes the "202 approve on a cancelled task" race:

```typescript
// Pseudocode. See cdk/src/handlers/approve-task.ts.
await ddb.transactWriteItems({
  TransactItems: [
    {
      Update: {
        TableName: TASK_APPROVALS_TABLE,
        Key: { task_id, request_id },
        UpdateExpression:
          "SET #status = :approved, decided_at = :now, #scope = :scope",
        ConditionExpression:
          "#status = :pending AND user_id = :caller",
        ExpressionAttributeNames: { "#status": "status", "#scope": "scope" },
        ExpressionAttributeValues: {
          ":approved": "APPROVED",
          ":pending": "PENDING",
          ":now": nowIso,
          ":scope": scope,
          ":caller": cognitoSub,     // verbatim; see ownership note below
        },
      },
    },
    {
      Update: {
        TableName: TASK_TABLE,
        Key: { task_id },
        // No-op update; only purpose is to guard task state atomically.
        UpdateExpression: "SET last_decision_at = :now",
        ConditionExpression:
          "#status = :awaiting AND awaiting_approval_request_id = :rid",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":awaiting": "AWAITING_APPROVAL",
          ":rid": request_id,
          ":now": nowIso,
        },
      },
    },
  ],
});
```

On `TransactionCanceledException`, `ApproveTaskFn` inspects the per-item `CancellationReasons` to distinguish cases:
- If the ApprovalsTable condition failed with `OldImage` absent, it returns 404 `REQUEST_NOT_FOUND`.
- If the ApprovalsTable condition failed with `OldImage.user_id != caller`, it returns 404 (the same code, to prevent an existence oracle).
- If the ApprovalsTable condition failed with `OldImage.status != "PENDING"`, it returns 409 `REQUEST_ALREADY_DECIDED`.
- If the TaskTable condition failed (the status changed), it returns 409 `TASK_NOT_AWAITING_APPROVAL`.

This is symmetric with the agent-side `TransactWriteItems` pattern (§4 step 25a) used for the resume transition. The Lambdas and the agent use the same atomic-update contract.

**Ownership.** The `user_id` stored on TaskApprovalsTable and compared against `caller_user_id` in the ConditionExpression is the Cognito `sub` claim **verbatim**. The Lambda extracts `sub` from the validated JWT and uses it as-is, with no prefix stripping, no tenant mapping, and no format normalization. If we ever introduce per-tenant user ID namespacing, that transformation MUST happen at the **write** path (that is, before the agent writes the row in §4 step 14) and not at compare time, so that the ConditionExpression always compares identical-shape identifiers. See the finding #6 scenario below.

After a successful transaction, `ApproveTaskFn` writes an audit event to `TaskEventsTable` (`approval_decision_recorded` event_type). The Lambda path therefore owns the 90-day audit trail, and the trail does not depend on the agent's milestone emission.

**Scenario (finding #6):** Three months from now, a platform engineer adds a multi-tenant mode where Cognito `sub` becomes `tenant-abc:01JXZ...`. They update the agent's row-write path to prefix-strip: `user_id = sub.split(":", 1)[1]`, storing `01JXZ...` on TaskApprovalsTable. They forget to update `ApproveTaskFn`. Now the Lambda reads `sub = "tenant-abc:01JXZ..."` from the JWT and compares it against the stored `01JXZ...`. The condition fails, every approve returns 404, and all tasks are stranded. The fix as written is "the Cognito sub is compared verbatim; any transformation must happen at write time, not at compare time". If the agent writes the full `sub`, the Lambda compares the full `sub`. If either side transforms, both sides must. The CI assertion is a unit test that extracts `user_id` from a sample row and asserts it matches the `sub` claim of a sample JWT byte-for-byte. This test would fail on the prefix-strip refactor above and force the engineer to update both sides. Without this hard rule, ownership-in-condition silently breaks under any future identity refactor.

**Scenario (finding #7):** A user submits a risky task at 10:00 AM. At 10:05 AM the agent hits a soft-deny gate. At 10:05:30 AM the user on Terminal B runs `bgagent cancel 01KPW...`, which lands as CancelTaskFn writes `status=CANCELLING`. At 10:05:31 AM the user runs `bgagent approve 01KPW... 01KPR...`, either forgetting they just cancelled or working from a different terminal where they didn't see the cancel. Without the cross-table transaction, the Lambda's GetItem on TaskTable (separate call) might read the stale RUNNING state, then UpdateItem on TaskApprovalsTable succeeds because the approvals row is still PENDING, and 202 is returned. The user sees "approved!" but the task is dying. With the TransactWriteItems pattern, both conditions must hold. The TaskTable guard `status = AWAITING_APPROVAL` fails (because the status is now CANCELLING), the entire transaction rolls back, and the Lambda returns 409 `TASK_NOT_AWAITING_APPROVAL` with `current_status: CANCELLING`. The user sees "cannot approve: task is already cancelling" and understands the state. The cost is one extra table in the transaction (two instead of one), which is still within DDB's 100-item limit and far below the 4 MB request size. This is symmetric with the agent's resume transaction, which already does the cross-table guard.

### 7.2 `POST /v1/tasks/{task_id}/deny`

The shape is identical, with `decision: "deny"` and an optional `reason`:

```json
{
  "request_id": "01KPR...",
  "reason": "use force-with-lease instead; force is too risky"
}
```

`DenyTaskFn`:
1. Check auth (Cognito JWT) and extract `sub` verbatim as `caller_user_id`.
2. Run `output_scanner.scan` on the first 20,000 characters of the reason (ten times the stored length, so that the time of the scan does not grow with the size of the request). The scan redacts AWS keys, GitHub PATs, API tokens, and similar secrets from the reason text before persisting.
3. Truncate the sanitized reason to 2000 chars (this matches the Phase 2 nudge limit).
4. Issue the atomic cross-table `TransactWriteItems` (the same shape as approve: ApprovalsTable flip plus TaskTable state guard).
5. Write the audit event to TaskEventsTable.

The agent reads the sanitized reason from DDB. It never sees unscanned user text.

### 7.3 `POST /v1/tasks` — new optional fields

Extended request shape:

```json
{
  "repo": "my-org/my-app",
  "task": "...",
  "task_type": "new_task",
  "approval_timeout_s": 600,
  "initial_approvals": [
    "tool_type:Read",
    "bash_pattern:git status*",
    "write_path:docs/**",
    "rule:safe_read_config",
    "tool_group:file_write"
  ]
}
```

New field reference:

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `approval_timeout_s` | integer seconds | No | **300** | Per-task default approval timeout. Bounded by `[30, min(3600, maxLifetime - 300)]`. Per-rule `@approval_timeout_s` annotations may clip this further (min-wins, see decision #6 and §6.3). Default matches the §10.2 `TaskTable.approval_timeout_s` default. |
| `initial_approvals` | list of scope strings | No | `[]` | Pre-approval allowlist scopes (≤20 entries, ≤128 chars each). Validated per §7.3 rules below. |

`CreateTaskFn` validations:
1. Length cap: ≤20 entries
2. Per-entry length cap: ≤128 chars
3. Scope format parsing: normalized to a known shape, with leading and trailing whitespace trimmed
4. Scope value validation:
   - `tool_type:X`. X must be in the known tool set (Read, Bash, Write, Edit, Glob, Grep, WebFetch, ...)
   - `tool_group:X`. X must be in the known group set (currently `file_write`)
   - `bash_pattern:X`. X ≤128 chars. Reject if X is degenerate (`*`, `**`, `?*`, or patterns where the wildcard-char ratio exceeds 50%). See §7.4.
   - `write_path:X`. Same rules as bash_pattern.
   - `rule:X`. X must exist in the (built-in + target repo's blueprint) soft-deny policy set per the shared policy-parsing library. Hard-deny rule IDs are rejected.
   - `all_session`. Rejected if `Blueprint.security.maxPreApprovalScope` forbids it.
5. `approval_timeout_s` within `[30, min(3600, maxLifetime - 300)]`, that is, capped at 1 hour OR (maxLifetime - 5min), whichever is smaller. This prevents multi-hour slot-exhaustion attacks and keeps approval windows within the TTL budget.
6. Combined `hard + soft + disable + custom` Cedar text size ≤ 64 KB (§12.4). Reject on overflow.

### 7.4 Degenerate-pattern detection

A pattern is degenerate if:
- Length ≤ 2, OR
- Consists only of `*`, `?`, and whitespace, OR
- Ratio of wildcard chars (`*` + `?`) to literal chars exceeds 50%

Degenerate `bash_pattern:` and `write_path:` scopes are rejected at submit with 400 `VALIDATION_ERROR`. Users who want broad permission must use the explicit `all_session` scope (which is subject to the `maxPreApprovalScope` blueprint cap).

Submit-time pattern validation uses Python-compatible `fnmatch` semantics. The runtime allowlist check in `ApprovalAllowlist.matches` (§6.4) uses `fnmatch` too. See finding #15 and §5.5 for the macOS-versus-Linux case-sensitivity trap and its mitigations.

### 7.5 `maxPreApprovalScope` ordering

The blueprint's `maxPreApprovalScope` is a partial order:

```
this_call  <  { tool_type_session, tool_group, bash_pattern, write_path, rule }  <  all_session
```

With `maxPreApprovalScope: "tool_type_session"`, `all_session` is rejected and all other scopes pass. Setting it to `"this_call"` is meaningless and is rejected at blueprint load. When the blueprint sets no value, the scope is unbounded (except that `all_session` requires an explicit `--yes` on the CLI).

### 7.6 `GET /v1/repos/{repo_id}/policies`

A new read-only endpoint serves rule discovery and `bgagent policies list`.

**Response** (200):
```json
{
  "repo_id": "my-org/my-app",
  "policies": {
    "hard": [
      {"rule_id": "rm_slash", "category": "destructive",
       "summary": "Reject rm -rf / and similar"},
      ...
    ],
    "soft": [
      {"rule_id": "force_push_any", "severity": "medium",
       "category": "destructive", "approval_timeout_s": 300,
       "summary": "Force push to any branch"},
      {"rule_id": "write_env_files", "severity": "high",
       "category": "filesystem", "approval_timeout_s": 600,
       "summary": "Write to *.env files"},
      ...
    ]
  }
}
```

The Lambda loads the policies on demand from the target repo's blueprint and the built-in policies. `summary` is the human-readable annotation `@summary("...")` if present. Otherwise it falls back to the first line of the `when` clause rendered as text.

The endpoint is rate-limited to 30/min/user and cached for 5min per repo in the Lambda.

**Onboarding gate (symmetric with `POST /v1/tasks`).** If the target repo is not onboarded in `RepoTable`, this endpoint returns **422 `REPO_NOT_ONBOARDED`**, the same response that `POST /v1/tasks` would return on a task-submit attempt. The gate runs AFTER the rate limit so that the 429 response doesn't leak onboarding status through a 422-vs-200 timing oracle. Rationale: a user who discovers rules for a repo they can't submit tasks against has received misleading information. The 422 tells them the real blocker (onboard the repo first) instead of listing policies that will never fire. This decision was documented and added 2026-05-11 as part of the E2E deploy-readiness hotfix.

### 7.7 `GET /v1/pending` — list pending approvals across user's active tasks

Returns the caller's approvals with `status=PENDING` whose window (`created_at + timeout_s`) has not passed, at most 100. A row can stay `PENDING` after its window when the agent could not close it. Such a row is left out. Backing index: `user_id-status-index` GSI on `TaskApprovalsTable` (see §10.1).

**Request**: `GET /v1/pending` with Cognito auth.

**Response** (200):
```json
{
  "pending": [
    {
      "task_id": "01KPW...",
      "request_id": "01KPR...",
      "tool_name": "Bash",
      "tool_input_preview": "git push --force origin feature-x",
      "severity": "medium",
      "reason": "Cedar soft-deny: force_push_any",
      "created_at": "2026-04-23T14:00:00Z",
      "timeout_s": 300,
      "expires_at": "2026-04-23T14:05:00Z"
    },
    ...
  ]
}
```

**Rate limit**: 60 requests per minute per user (one a second: the operator console polls this route every 10 s in each visible window). The GSI backs the endpoint, so the read is a `Query` (not a `Scan`) on `user_id = :caller AND status = :pending`, repeated only while a page of 100 rows holds requests whose window has passed, for at most 20 pages. See §10.1 and the finding #8 scenario below.

**Scenario (finding #8):** A power user has `watch -n1 bgagent pending` running in a tmux pane so they see incoming approvals. They also have a second terminal open and a shell script that polls `bgagent pending --output json` every 2 seconds. Without a GSI, each `GET /v1/pending` call translates to a DDB `Scan` with `FilterExpression user_id = :caller AND status = :pending`. That is a full table scan that touches every approval row for every task in the account, not just the caller's. At 3 calls per 2 seconds across both terminals, plus the 1-per-second `watch`, the user generates 4-5 Scans per second. TaskApprovalsTable has a burst capacity of some hundreds of RCUs. Sustained Scans can exhaust it and leave the agent poll-loops without capacity. Now imagine 20 concurrent power users in a 50-user org. The table throttles, agent polls start timing out, and unrelated tasks stall in AWAITING_APPROVAL waiting for reads that never come. With the GSI, each query targets the user's partition and scans at most the user's own pending rows (typically 0-3 items). The 60/min/user rate limit is a redundant second control, but the GSI makes it mostly unnecessary. The cost is one additional GSI on the table, an acceptable DDB cost at these volumes.

---

## 8. CLI UX

### 8.1 New commands

```bash
# Approve a specific pending request
bgagent approve <task_id> <request_id> [--scope <scope>] [--output text|json]

# Deny a specific pending request, optionally with a reason the agent sees (sanitized server-side)
bgagent deny <task_id> <request_id> [--reason "..."|--reason-file <path>] [--output text|json]

# List all pending approvals across the user's active tasks (solves request-id lookup)
bgagent pending [--output text|json]

# Discover policies for a repo (solves rule-id lookup)
bgagent policies list --repo <repo_id> [--tier hard|soft] [--output text|json]
bgagent policies show --repo <repo_id> --rule <rule_id> [--output text|json]
```

### 8.2 Extended `submit` / `run` flags

```bash
bgagent submit \
  --repo my-org/my-app \
  --task "..." \
  --approval-timeout 600 \
  --pre-approve tool_type:Read \
  --pre-approve write_path:"docs/**" \
  --pre-approve tool_group:file_write \
  --pre-approve rule:safe_file_read \
  --pre-approve-file ./approvals.yaml

# Shorthand for no approval gates (requires --yes):
bgagent submit --task "..." --pre-approve all_session --yes
```

`--pre-approve-file` reads a YAML or JSON array of scope strings, so a user can supply up to the 20-entry cap without a long command line.

The `--approval-timeout` default (CLI and server) is **300 seconds** (5 min), matching decision #6, §7.3, and the `TaskTable.approval_timeout_s` default in §10.2. The accepted range is `[30, min(3600, maxLifetime - 300)]`. The CLI validates client-side and the server re-validates. `bgagent submit --help` states the default.

### 8.3 Streaming UX

Approval requests appear as:

```text
[14:00:00]  ★ approval_requested: Bash "git push --force origin feature-x" (severity=high)
            reason:   Cedar soft-deny: force_push_any
            respond:  bgagent approve <task-id> 01KPR... [--scope tool_type_session]
                      bgagent deny    <task-id> 01KPR... [--reason "..."]
            timeout:  300s   (or "bgagent pending" to list all)
```

Severity colors the line (respecting the `NO_COLOR` env var). When `NO_COLOR` is set, severity is emitted as a `[HIGH]` prefix.

`bgagent run` streaming has no interactive prompts. The user runs `bgagent approve / deny` in a second terminal.

### 8.4 Safety UX

When `--pre-approve all_session` is passed without `--yes`:

```bash
$ bgagent submit --task "apply terraform plan" --pre-approve all_session
WARNING: --pre-approve all_session disables Cedar soft-deny approval gates
         for this task. Hard-deny policies (rm -rf /, write to .git/, DROP
         TABLE, etc.) still apply.
         Add --yes to skip this prompt.
Continue? [y/N]
```

The warning states that hard-deny still applies, so users don't mistake `all_session` for root.

### 8.5 `bgagent pending` output

```text
Pending approvals (3):

  01KPW0...(task) / 01KPR0...(request)
  ├─ Bash: git push --force origin feature-x
  ├─ severity: high
  ├─ reason: Cedar soft-deny: force_push_any
  ├─ timeout: 4m 32s remaining
  └─ approve|deny

  01KPW1.../01KPR1...
  ├─ Write: /workspace/.../src/.env
  ├─ severity: high
  ├─ timeout: 9m 12s remaining
  ...
```

To act on one, run `bgagent approve` or `bgagent deny` with the listed IDs. At ≥20 pending approvals the output becomes noisy and needs pagination or filtering. That work is deferred (§17), because the per-task `approvalGateCap` (decision #13, default 50) and the per-user 60-RPM rate limit on the endpoint both keep expected volumes well below 20 simultaneous approvals per user in practice. See finding #16.

Shell completion (tab-complete task_id + request_id from `bgagent pending` output) is also future work.

---

## 9. State machine + concurrency

### 9.1 New state: AWAITING_APPROVAL

Transitions added (extending §7 of INTERACTIVE_AGENTS.md):

```
RUNNING → AWAITING_APPROVAL  (on REQUIRE_APPROVAL; via TransactWriteItems)
AWAITING_APPROVAL → RUNNING  (on approve OR deny OR timeout; via TransactWriteItems)
AWAITING_APPROVAL → CANCELLED (on explicit `bgagent cancel`)
AWAITING_APPROVAL → FAILED   (on reconciler detecting stranded approval; new edge)
HYDRATING → AWAITING_APPROVAL  (if a soft-deny gate fires during hydration; rare but possible)
```

There is no direct `AWAITING_APPROVAL → COMPLETED/FINALIZING` transition without RUNNING in between.

### 9.2 TaskApprovalsTable row state machine

TaskApprovalsTable rows are **terminal on first decision**. A row never re-opens after leaving PENDING. Separate requests (even for the same tool call) get distinct `request_id`s.

```mermaid
stateDiagram-v2
    [*] --> PENDING: Agent writes row<br/>(TransactWriteItems with<br/>TaskTable → AWAITING_APPROVAL)
    PENDING --> APPROVED: ApproveTaskFn<br/>(cross-table transaction)
    PENDING --> DENIED: DenyTaskFn<br/>(cross-table transaction)
    PENDING --> TIMED_OUT: Agent poll timeout<br/>(best-effort update)
    PENDING --> STRANDED: Reconciler detects<br/>orphan (age > 2×timeout_s)
    APPROVED --> [*]: terminal
    DENIED --> [*]: terminal
    TIMED_OUT --> [*]: terminal
    STRANDED --> [*]: terminal
    note right of APPROVED
        TTL = created_at + timeout_s + 120s
        DDB reaps row after TTL
    end note
```

### 9.3 Orchestrator impact

- `waitStrategy` adds `AWAITING_APPROVAL` as non-terminal.
- `finalizeTask` recognizes `AWAITING_APPROVAL`.
- `ACTIVE_STATUSES` (used by `GET /tasks?status=active` and `reconcile-concurrency.ts`) gains `AWAITING_APPROVAL`.
- `task_state.py::write_terminal` condition expression accepts `AWAITING_APPROVAL` as a valid source state.

### 9.4 Concurrency slot semantics

**AWAITING_APPROVAL holds the user's concurrency slot.**

Rationale: the Docker container is alive, its memory is allocated, and the AgentCore microVM pool is committed. Releasing the slot while the resource is still held would make the accounting wrong and allow resource exhaustion.

Concrete behavior:

```text
Bob's per-user cap: 10.
t=0:    Bob submits 10 tasks. count=10. 11th submit → 429.
t=2m:   Task #1 → AWAITING_APPROVAL. count still 10.
        Bob's 12th submit → 429. He must approve, cancel, or wait.
t=30m:  Bob approves task #1. task → RUNNING. count still 10.
t=45m:  Task #1 completes. count → 9. Bob can submit task #11.
```

### 9.5 `maxLifetime` clock does not pause

AgentCore Runtime's `maxLifetime = 28800s` (8h) is an absolute timer from session start. It does NOT pause during `AWAITING_APPROVAL`.

As a result, the hook computes an `effective_timeout` bounded by `maxLifetime - remaining - CLEANUP_MARGIN_120S`. If the task has been running 7h55m and hits a soft-deny gate, the effective timeout may be clamped to a value much shorter than the task default. Below the 30s floor the hook returns DENY immediately with reason `"insufficient lifetime"`.

**Lambda MicroVM suspension (ADR-021 P3).** A MicroVM waiting on a gate may be suspended, which freezes the agent's monotonic clock. The gate therefore expires at `min(monotonic budget, created_at + timeout_s)`, evaluated on every poll and on `/resume`, and the row stores `deadline_epoch` so approve and deny reject a decision after the wall-clock deadline. The orchestrator wakes the worker 60 s before that deadline, so a timeout is recorded by the same agent that created the request. The 8-hour `maximumDurationInSeconds` includes suspended time and still bounds the session, exactly as `maxLifetime` does above.

### 9.6 Stranded-approval reconciliation

`reconcile-stranded-tasks.ts` gains an AWAITING_APPROVAL-aware branch:

- Detects tasks in AWAITING_APPROVAL with `age > 2 * timeout_s`
- Sets the TaskApprovalsTable row to `STRANDED` status with a best-effort conditional update
- Transitions TaskTable to `FAILED` with reason `"approval stranded (container eviction)"`
- Emits an `approval_stranded` event to TaskEventsTable

This closes the container-eviction gap. Without this branch, a container restart mid-approval would leave the task hanging until the user manually cancelled.

`reconcile-concurrency.ts` (scheduled every 5 min) already scans for orphaned concurrency counters. With `AWAITING_APPROVAL` added to `ACTIVE_STATUSES` it counts awaiting tasks as active.

### 9.7 Attended vs unattended mode

The design assumes a human is watching. For unattended tasks (scheduled automation, cron-driven runs) the `--pre-approve all_session` path skips soft-deny entirely. No additional mode flag is needed. The set of scopes in `initial_approvals` determines whether a human is expected to attend.

---

## 10. Data model

### 10.1 New DynamoDB table: `TaskApprovalsTable`

```typescript
new dynamodb.Table(this, 'Table', {
  partitionKey: { name: 'task_id',   type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'request_id', type: dynamodb.AttributeType.STRING },  // ULID
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  timeToLiveAttribute: 'ttl',
  stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,  // (evaluated — may drop; see §11)
  removalPolicy: RemovalPolicy.RETAIN,
});

// v1 GSI — backs `GET /v1/pending` and `bgagent pending`.
// Required at v1 ship, not deferred — see finding #8 scenario in §7.7.
table.addGlobalSecondaryIndex({
  indexName: 'user_id-status-index',
  partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'status',  type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: [
    'task_id', 'request_id', 'tool_name', 'tool_input_preview',
    'severity', 'reason', 'created_at', 'timeout_s',
    'matching_rule_ids',
  ],
});
```

**Projection is fixed at design time.** DynamoDB rejects in-place
updates to a GSI's `nonKeyAttributes` (the CloudFormation error
string is "Cannot update GSI's properties other than Provisioned
Throughput and Contributor Insights Specification"). Adding a new
attribute to the pending-view projection post-ship requires either
(a) dropping and recreating the table, which is destructive, invalidates
every in-flight approval row, and is acceptable only in dev, or (b)
creating a parallel GSI under a new name and cutting traffic
over, which is operationally heavy. Any future chunk that extends
TaskApprovalsTable with a field that needs to appear on
`GET /v1/pending` MUST add it to this list BEFORE ship. The list is
locked in by `cdk/test/constructs/task-approvals-table.test.ts` so a
silent regression fails the test run.

Attributes:

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | S | Yes | PK. ULID matching TaskTable |
| `request_id` | S | Yes | SK. ULID minted by the agent |
| `tool_name` | S | Yes | "Bash", "Write", and others |
| `tool_input_preview` | S | Yes | First 256 chars of serialized tool input, ANSI/control-stripped |
| `tool_input_sha256` | S | Yes | Full-input hash for audit + recent-decision cache |
| `reason` | S | Yes | Cedar matching rule description |
| `severity` | S | Yes | "low" \| "medium" \| "high" |
| `matching_rule_ids` | L | Yes | List (not Set, because it can be empty) of soft-deny rule IDs |
| `status` | S | Yes | PENDING \| APPROVED \| DENIED \| TIMED_OUT \| STRANDED |
| `created_at` | S | Yes | ISO8601 |
| `decided_at` | S | No | Set when status != PENDING |
| `scope` | S | No | Set on APPROVED |
| `deny_reason` | S | No | Set on DENIED. Sanitized user text |
| `timeout_s` | N | Yes | Resolved timeout for audit |
| `ttl` | N | Yes | `created_at_epoch + timeout_s + CLEANUP_MARGIN_120S`. Always covers the decision window |
| `user_id` | S | Yes | Cognito `sub` **verbatim**. Used in the ownership check `ConditionExpression` (§7.1 finding #6) |
| `repo` | S | Yes | Denormalized for fan-out |

**TTL sizing.** The TTL is always `timeout_s + 120s`, so a 300s approval window has a 420s TTL and a 3600s window has a 3720s TTL. The row never expires during the decision window. After the decision and a short grace period, DDB's eventual-consistency TTL reaper deletes the row.

**Why `matching_rule_ids` is a list, not a StringSet.** DDB string sets cannot be empty. A pathological soft-deny hit with no matching rule would fail to persist. A list can be empty.

**Why the GSI ships in v1.** Per finding #8, the `bgagent pending` and `GET /v1/pending` access pattern is `user_id = :caller AND status = :pending`. Without the GSI, this requires a full-table `Scan` per call and exhausts DDB burst capacity under `watch -n1`-style polling. The GSI adds a small per-write cost but makes list queries constant-time per user.

### 10.2 `TaskTable` additions

Five new attributes on the existing task row:

| Name | Type | Required | Description |
|---|---|---|---|
| `approval_timeout_s` | N | No | Default timeout for soft-deny gates. Default 300. |
| `initial_approvals` | L | No | List of scope strings from submit time |
| `awaiting_approval_request_id` | S | No | Set when status = AWAITING_APPROVAL. Cleared on the transition back (via joint `UpdateExpression`) |
| `approval_gate_count` | N | No | Running counter of approval gates fired on this task. Used to enforce `approval_gate_cap` (decision #13) |
| `approval_gate_cap` | N | No | Per-task cap on total approval gates, resolved from the blueprint's `security.approvalGateCap` at submit time and **frozen** on the TaskRecord for the life of the task. When omitted (blueprint did not configure an override), the submit path falls back to the platform default of 50. Bounds `[1, 500]`, validated both at CDK synth time (blueprint construct) and at task-submit time (CreateTask handler). Frozen at submit so that mid-task blueprint edits cannot change the cap of a running task (§4 step 5). |

Joint updates on AWAITING_APPROVAL transitions always set or clear `awaiting_approval_request_id` in the same `UpdateExpression` as the status change, either within the TransactWriteItems Put+Update, or in the single UpdateItem on resume.

### 10.3 TaskTable status enum update

```typescript
export const TASK_STATUSES = [
  'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL',
  'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
] as const;

export const ACTIVE_STATUSES = new Set([
  'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING',
]);

export const VALID_TRANSITIONS = {
  // ...existing...
  RUNNING:           ['FINALIZING', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['RUNNING', 'CANCELLED', 'FAILED'],  // FAILED via reconciler only
  HYDRATING:         ['RUNNING', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL'],  // rare but possible
  // ...
};
```

---

## 11. Observability and notification plane

### 11.1 New `agent_milestone` event types

These events are emitted to both `ProgressWriter` (DDB, 90d) and `sse_adapter` (live stream). The REST Lambdas also emit audit events directly to TaskEventsTable. `ApprovalMetricsPublisherFn` (consumer #2 of TaskEventsTable streams) mirrors these into CloudWatch metrics in namespace `ABCA/Cedar-HITL` for the §11.3 dashboard widgets and the future §11.5 alarms. See §11.3 for the metric schema. Naming is consistent: `approval_requested` is followed by `approval_granted` / `approval_denied` / `approval_timed_out` / `approval_stranded`. Never use `approval_decided`. Use the specific outcome. See finding #13.

| Event | Source | Metadata |
|---|---|---|
| `pre_approvals_loaded` | Agent | `{count, scopes[]}` |
| `approval_requested` | Agent | `{request_id, tool_name, input_preview, reason, severity, timeout_s, matching_rule_ids[]}` |
| `approval_granted` | Agent | `{request_id, scope, decided_at, created_at?}`. `created_at` is propagated from the approval row (Chunk 8a) so the metrics publisher can compute `ApprovalDecisionLatencyMs = decided_at − created_at` without a round-trip GetItem. Optional and omitted by default so legacy callers still produce valid events. When it is absent, the publisher skips the latency emit and logs `METRICS_SCHEMA_MISMATCH` instead of emitting `latency=0` (which would corrupt the percentile widgets). |
| `approval_denied` | Agent | `{request_id, reason, decided_at, created_at?}`. See `approval_granted` for the `created_at` rationale. |
| `approval_timed_out` | Agent | `{request_id, timeout_s, created_at?, effective_timeout_s?, matching_rule_ids[]?}`. `created_at` (decision latency), `effective_timeout_s` (the post-clip value used by the `ApprovalTimeoutBreakdown` histogram), and `matching_rule_ids` (rule_id dimension, normalized against an allowlist so unknown rules collapse to `other`) are Chunk 8a additions to support §11.3 metrics. `timeout_s` is retained for backward-compat. `effective_timeout_s` is a separate field (not a rename), so the schema is a pure superset. Missing-field branches skip the specific metric emit and fire `MetricEmitSkipped{reason}` instead of falling back to zero. |
| `approval_stranded` | Reconciler | `{request_id, age_s, reason}` |
| `approval_write_failed` | Agent | `{request_id?, error}` |
| `approval_resume_failed` | Agent | `{request_id, error}` |
| `approval_poll_degraded` | Agent | `{request_id, consecutive_failures}` |
| `approval_timeout_capped` | Agent | `{request_id, requested_timeout_s, effective_timeout_s, reason}`. Emitted **per gate** when min-wins clips the effective timeout below what the task default or user-supplied value would have allowed. `reason ∈ {rule_annotation, maxLifetime_ceiling, runtime_jwt_ceiling}`. **User-visible** via `bgagent watch` and the live SSE stream (see §4 step 16). It was previously backend-only and was promoted in Fix 4. Carries `matching_rule_ids` when `reason == "rule_annotation"`. |
| `approval_timeout_capped_at_submit` | CreateTaskFn | `{requested_timeout_s, effective_timeout_s, reason, clipping_rule_ids[]}`. Emitted at task-submit time when the user's `--approval-timeout` value would be clipped by any rule in the blueprint (min of per-rule `@approval_timeout_s` annotations against the user's default). Lets the user see "your 600s will actually be 300s on rule write_credentials" before the task even starts. Written to `TaskEventsTable` by `CreateTaskFn` and returned on the POST `/v1/tasks` response body alongside `task_id`. |
| `approval_ceiling_shrinking` | Agent | `{request_id, maxLifetime_remaining_s, cleanup_margin_s, task_default_timeout_s}`. Emitted **once per task** when `maxLifetime_remaining_s - cleanup_margin_s < 2 * task_default_timeout_s`. Roughly, the task is near the end of its lifetime and future gates will have smaller and smaller windows. Appears in the live stream so that the user understands why later gates show shorter timeouts. Idempotent per task (emit-once flag on the agent). |
| `approval_cap_exceeded` | Agent | `{request_id, count, cap}`. Emitted when `approval_gate_cap` fires (the cap field reflects the configured value frozen on the TaskRecord at submit time). |
| `approval_rate_limit_exceeded` | Agent | `{request_id, rate, limit}` |
| `approval_late_win` | Agent | `{request_id, outcome, reason}`. Emitted when `_best_effort_update_status("TIMED_OUT", ...)` returns ConditionCheckFailed and the re-read of the approval row returns APPROVED or DENIED (the user's decision beat the agent's timer on a VM-throttle race, §13.12). `outcome` is the terminal state the user's decision established. |
| `approval_decision_recorded` | ApproveTaskFn / DenyTaskFn | `{request_id, status, scope?, reason?, decided_at, caller_user_id}`. Authoritative audit record |

### 11.2 Fan-out plane interaction — Slack button → Cognito mapping

Approval events flow to the fan-out Lambda via TaskEventsTable Streams (the existing Phase 1b path). They are dispatched to the Slack, GitHub, and Email stubs.

**The fan-out Lambda does not consume TaskApprovalsTable Streams.** The approval row is working state, and the audit trail is in TaskEventsTable. Enabling Streams on TaskApprovalsTable would be redundant and add noise. Final design: TaskApprovalsTable DOES NOT have Streams enabled.

Fan-out dispatch rules (extending Phase 1b stubs):
- Slack: on `approval_requested` OR `approval_stranded`, with the message "Agent @task_id requests approval for Bash: `git push --force`"
- Email: on `approval_requested` with `severity: high`
- GitHub: none

**Rate-limited per-user.** 10 approval-related fan-out messages per user per minute. This prevents notification spam from malicious users who drive up the approval-gate count.

**Notification plane is observability, not state (see §13.14).** Notification delivery failures do NOT pause the approval timer. Coupling the two would create a bypass in which an adversary who takes down the webhook gets an unbounded approval window. The timer runs on the agent's local clock keyed to `created_at`. `bgagent pending` is the recovery path for users who suspect notifications are broken (backed by the `user_id-status-index` GSI, §7.7). For the off-hours and unattended trade-off that this posture implies, see §14.8.

**Slack button to Cognito user mapping (critical trust boundary).** Per finding #4, Slack buttons that approve or deny must know which Cognito user is clicking. The naive approach is to have a Slack workspace admin configure `slack_user_id → cognito_sub` mappings. That approach is broken: a compromised Slack admin can map their own Slack identity to a victim's Cognito sub, then approve any of the victim's pending gates by clicking a Slack button. The correct design is **user-initiated mapping via OAuth**:

1. The mapping is stored in a new `SlackUserMappingTable`:

   ```typescript
   new dynamodb.Table(this, 'Table', {
     partitionKey: { name: 'slack_user_id', type: dynamodb.AttributeType.STRING },
     // Only the mapped user's Cognito sub is stored; one row per Slack identity.
     billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
   });
   // GSI for reverse lookup (Cognito → Slack) is NOT provided;
   // the forward direction is the only trust-sensitive lookup.
   ```

2. The mapping is created **only** by the end user via OAuth:
   - The user runs `bgagent notifications configure slack` (or uses the web UI).
   - The CLI opens the Cognito OAuth flow, the user authenticates, and the CLI gets a Cognito ID token.
   - The CLI POSTs `/v1/notifications/slack/link` with the Cognito JWT and a short-lived Slack `link_token` obtained out-of-band.
   - The Lambda validates both tokens and writes `{slack_user_id, cognito_sub, created_at}` to `SlackUserMappingTable`.
   - The `MapSlackUserFn` IAM policy allows `PutItem` only. There is no admin bulk-write API.
3. The Slack app does **not** have `chat:write.admin` scope or any workspace-wide write capability. Only the per-user OAuth flow can create mappings.
4. When a Slack button fires, the fan-out Lambda receives the Slack `user_id`, looks up the mapping, obtains `cognito_sub`, and impersonates the user for the approve or deny call. The fan-out Lambda's IAM role allows `sts:AssumeRole` into a dedicated `SlackApprovalProxyRole` that restricts approve and deny to ONLY `severity: low` or `severity: medium` approvals. `severity: high` gates **cannot** be approved via Slack. They require a CLI approve with a fresh Cognito JWT.
5. The Slack approval button payload is cryptographically signed (Slack's signing secret) and includes the `task_id` and `request_id`. The fan-out Lambda re-verifies the signature on receipt.

```mermaid
flowchart TB
    u([User])
    cli[bgagent CLI]
    cognito[Cognito]
    slack[Slack]
    linkfn[LinkSlackUserFn Lambda]
    mapdb[(SlackUserMappingTable)]

    u -- 1 run configure --> cli
    cli -- 2 OAuth authorization_code --> cognito
    cognito -- 3 id_token carries Cognito sub --> cli
    cli -- 4 user-initiated OAuth --> slack
    slack -- 5 slack_user_id and link_token --> cli
    cli -- 6 POST link endpoint<br/>Bearer id_token<br/>body has both ids --> linkfn
    linkfn -- 7 validate id_token --> cognito
    linkfn -- 8 validate link_token --> slack
    linkfn -- 9 PutItem with attribute_not_exists --> mapdb
    mapdb -- 10 ok --> linkfn
    linkfn -- 11 201 Created --> cli
    cli -- 12 Slack approvals enabled<br/>for low and medium severity --> u

    classDef actor fill:#E8F1FF,stroke:#4A90E2,color:#0B3D91
    classDef ext fill:#F2E8FF,stroke:#8A4ED2,color:#3D1B7A
    classDef lambda fill:#FFF4E0,stroke:#E0A03A,color:#7A4A10
    classDef store fill:#EAF7EA,stroke:#3AA655,color:#1F6B32

    class u,cli actor
    class cognito,slack ext
    class linkfn lambda
    class mapdb store
```

> An admin has no API to create or rewrite mappings. Every row is user-signed (it requires both the Cognito ID token AND a Slack OAuth token for the same user). The mapping is idempotent and write-once.

Together, severity-gated Slack approvals and user-initiated OAuth mapping mean that a compromised Slack admin cannot approve the victim's high-severity gates (they go through the CLI with Cognito only), cannot create impersonation mappings (there is no admin write path), and cannot change an existing mapping (the write is idempotent, with `ConditionExpression: attribute_not_exists`). The worst case is the Slack admin deleting their own workspace's Slack app, which disables Slack approvals for all users but does not compromise any.

**Scenario (finding #4):** An attacker compromises the Slack admin account of `my-org`. They attempt to approve Alice's pending `rule:deploy_staging` gate. Under the naive design (admin-configured mapping table), the attacker could write `{slack_user_id: attacker_slack_id, cognito_sub: alice_cognito_sub}` and then click "Approve" on the Slack notification Alice received. The fan-out Lambda looks up the attacker's Slack ID, finds Alice's Cognito sub, and executes the approve with Alice's identity. The attack succeeds. Under the OAuth user-initiated design, the attacker cannot write to `SlackUserMappingTable` because the only write path is `LinkSlackUserFn`, which requires a valid Cognito ID token from the user whose sub is being written AND a Slack user token from the `slack_user_id` being mapped. The attacker would need both Alice's Cognito credentials AND Alice's Slack login. At that point Slack approvals are the least of Alice's problems. Even if the attacker had mapped their Slack ID to Alice's sub somehow (via a prior legitimate compromise of Alice), severity-gating prevents them from approving `high` gates. Those require a fresh CLI Cognito flow. For `deploy_staging` (typically medium) the attack is still bounded to gates the user considered low-enough risk to automate via Slack. High-severity decisions always go through the CLI.

### 11.3 Dashboard additions

Extend `TaskDashboard` (`cdk/src/constructs/task-dashboard.ts`). These are read-only CloudWatch widgets that show approval behavior to operators. They require no notification channel or on-call action:

- **Approval request rate** (line, 7d): count of `approval_requested` per hour, across all tasks.
- **Outcome distribution** (stacked bar, per hour): granted / denied / timed_out / stranded. Inverts quickly if notifications break.
- **Active AWAITING_APPROVAL tasks** (gauge): current count across the fleet.
- **Per-task approval-gate count distribution** (histogram): spot tasks approaching `approval_gate_cap`. Tracked against the configured cap value (not a hard-coded 50) so blueprints with elevated caps are correctly bucketed.
- **Top soft-deny rules by match frequency** (table): which rules are firing. Informs rule tuning over time.

**New tuning metrics (Fix 6 / IMPL-28).** These exist so operators can distinguish between the four failure modes that all appear as "timeout" on naive dashboards (users slow, default too tight, ceiling clipping, or notifications broken). All metrics are in namespace `ABCA/Cedar-HITL` and are published by `ApprovalMetricsPublisherFn`, a dedicated Lambda that consumes `TaskEventsTable` streams as consumer #2 alongside the existing `FanOutConsumer` and emits CloudWatch EMF. `TaskEventsTable` therefore stays the single source of truth. The publisher Lambda owns the metric schema, so future dashboard iterations don't require agent redeploys.

- **`ApprovalTimeoutClipRate`** (percentage, MathExpression over two counters): rate of approvals whose effective timeout was clipped below the requested value, bucketed by `reason` dimension (`rule_annotation`, `maxLifetime_ceiling`, `runtime_jwt_ceiling`, plus an `unknown` bucket for any future reason value that the publisher does not know). Computed as `IF(requested > 0, 100 * clipped / requested, 0)` so a period with zero approvals renders as 0 instead of NaN (a silent gap). Backing EMF counters: `ClippedApprovalCount` (dim: `reason`) on `approval_timeout_capped`, `ApprovalRequestCount` on `approval_requested`. A sustained non-zero `rule_annotation` rate means blueprints are clipping user-supplied timeouts. A sustained `maxLifetime_ceiling` rate means tasks are hitting gates too late in their life.
- **`ApprovalTimeoutBreakdown`** (histogram, p50 / p90 / p99 of the raw `TimedOutEffectiveTimeout` metric, unit Seconds, dimension `rule_id`). On timed-out approvals only, this is the `effective_timeout_s` that was configured. Separates "the timeout was 30s, obviously the user couldn't respond" from "the timeout was 600s and the user really was unavailable". The `rule_id` dimension is normalized against an allowlist of well-known rules (for example `force_push_any`, `write_credentials`). Unknown rules collapse to `other` and empty rule sets to `none`, which bounds the custom-metric cardinality cost. When several rules of the list matched, the value is the one that stands first in the list's order, whatever order the engine reported them in: `force_push_main`, `force_push_any`, `push_to_protected_branch`, `write_credentials`, `write_env_files`. The publisher writes each value twice: once with the `rule_id` dimension and once without dimensions. The widget's p50 / p90 / p99 read the one without dimensions, because CloudWatch does not aggregate a custom metric across dimensions. Sourced from `approval_timed_out` events (`created_at`, `effective_timeout_s`, and `matching_rule_ids` are all propagated onto the event in Chunk 8a, so the publisher is stateless).
- **`ApprovalDecisionLatency`** (p50 / p90 / p99 of `ApprovalDecisionLatencyMs`, unit Milliseconds, dimension `outcome ∈ {approved, denied, timed_out}`): `decided_at − created_at`. Split by outcome so operators can see "users ARE responding, just slowly" versus "users aren't responding at all". When `created_at` is absent on an outcome event (legacy shape or a container predating Chunk 8a), the publisher skips the emit and counts a `MetricEmitSkipped{reason: missing_created_at}` instead of emitting `latency=0` (which would corrupt the percentile widgets).

**Observability-of-observability.** The publisher Lambda emits two meta-metrics so a silent failure in the publisher path is itself observable:

- `MetricsPublisherHeartbeat` (Count, no dimensions). Emitted once per successful batch. A flat line here means the pipeline is broken (IAM drift, filter-pattern typo, log throttle), not that approval traffic has stopped. It gives operators a "pipeline alive" signal that is independent of approval volume.
- `MetricEmitSkipped` (Count, dim: `reason`). Emitted when a specific metric branch is skipped because of a schema mismatch (missing field on an outcome event), a parse anomaly (missing required keys on the stream record), or an unknown dimension value. Sustained non-zero rates indicate stale agent containers during a deploy rollout, an agent-side regression that drops a required field, or a new value that is not in the allowlist. All three are actionable.

**Dashboard widget layout (IMPL-28).** `ApprovalTimeoutClipRate` and `ApprovalTimeoutBreakdown` share a row side-by-side (12-wide each). `ApprovalDecisionLatency` occupies the next row full-width (24). Operators can see from the dashboard whether timeouts are a policy-authoring problem (clip rate on `rule_annotation`), a task-sizing problem (clip rate on `maxLifetime_ceiling`), a UX problem (decision latency high but within timeout), or a notification problem (decision latency absent, timeouts high).

**Stream consumer budget.** `TaskEventsTable` is consumed by two Lambdas (the fanout dispatcher for Slack, GitHub, and email, and the metrics publisher). DynamoDB Streams support up to 2 concurrent consumers per shard before throughput degrades. Any future third consumer must migrate the table to **Kinesis Data Streams for DynamoDB** (opt-in, different API) instead of adding a third `DynamoEventSource`. See the architectural comment in `cdk/src/constructs/task-events-table.ts`.

### 11.4 OTEL trace integration

Every `agent_milestone("approval_*")` event carries `trace_id` and `span_id`. A span `hitl.approval_wait` covers the PreToolUse poll loop: `span.duration = decided_at - created_at`. `hitl.approval_race_loss` is emitted when the agent's local timeout fired <5s before a late user decision (useful for tuning).

### 11.5 CloudWatch alarms

**DLQ-depth alarms (shipped):** CloudWatch alarms on `ApproximateNumberOfMessagesVisible >= 1` (5-min period, Maximum statistic, `treatMissingData: NOT_BREACHING`) are deployed for:

- **FanOutConsumer DLQ.** Poison-pill DynamoDB Stream records that failed three consecutive Lambda invocations.
- **ApprovalMetricsPublisher DLQ.** The same failure mode for the metrics-publisher consumer.
- **GitHubScreenshotIntegration processor DLQ.** Failed async invocations of the screenshot pipeline (the same threshold-1 shape).

These alarms transition to `ALARM` state in CloudWatch and appear in the console and dashboard. They show operators silent record loss, and they prevent poison records from accumulating unnoticed for the full 14-day DLQ retention window.

**Notification channel wiring (shipped, issue #629):** All three DLQ-depth alarms above are wired to a stack-wide SNS topic via `alarm.addAlarmAction(new SnsAction(topic))`. The topic is provisioned by the reusable `OperationalAlerts` construct (`cdk/src/constructs/operational-alerts.ts`) and its ARN is exported as the `OperationalAlertsTopicArn` stack output.

- **Encryption.** The topic is encrypted with a **customer-managed KMS key**, not the AWS-managed `alias/aws/sns` key. The alarm action depends on this: CloudWatch cannot publish to a topic on the AWS-managed key (its key policy can't be edited to grant the `cloudwatch.amazonaws.com` service principal `kms:Decrypt` / `kms:GenerateDataKey*`), so the alarm action would fail silently at delivery. The CMK grants CloudWatch exactly those actions.
- **Delivery target (configurable).** Pass `-c alertEmail=ops@example.com` at deploy to create an email subscription (AWS sends a confirmation link that must be clicked). With no context set, the topic ships with no subscription. Operators subscribe Slack, PagerDuty, or email manually against the exported topic ARN. Delivery is not hard-coded.

**Additional alarms (not yet shipped):** The following remain deferred. Each is a rate or latency condition that needs metric-math or composite-alarm design beyond the threshold-1 DLQ shape. Now that the notification channel exists, they can be wired to the same `OperationalAlerts` topic as separate follow-ups:

- High approval-timeout rate (users not responding, notifications broken)
- Tasks stuck in AWAITING_APPROVAL beyond `timeout_s + 60s` (reconciler failure)
- High approval-write failure rate (DDB throttled or IAM drift)
- Approval-gate cap hit (suspicious retry loop)
- `MetricEmitSkipped` sustained > 0 (publisher schema mismatch, meaning agent and publisher version skew)
- `MetricsPublisherHeartbeat` flat-line (publisher pipeline broken)

---

## 12. Security model

### 12.1 Trust boundaries

- **Agent container ↔ TaskApprovalsTable.** The IAM role on the runtime has `GetItem`, `PutItem`, and conditional `UpdateItem` on the table. The agent writes pending rows, reads decisions, and writes TIMED_OUT on an internal timeout.
- **User CLI ↔ API Gateway.** Cognito JWT (the same authorizer as `/tasks/*`). Cognito `sub` is the canonical caller identity, used **verbatim** in DDB `ConditionExpression` (§7.1, finding #6).
- **ApproveTaskFn/DenyTaskFn ↔ TaskApprovalsTable + TaskTable.** The Lambda IAM policy allows `UpdateItem` on both tables under `TransactWriteItems`. Authorization is in the ConditionExpression (ownership AND state), not in a separate IAM boundary.
- **Blueprint origin.** Blueprints are CDK-deployed constructs (see `cdk/src/constructs/blueprint.ts`). Platform operators deploy them. Users cannot upload arbitrary blueprint.yaml from the target repo. The security model depends on this property. If blueprint origin ever becomes user-uploaded, the blueprint-injection section (§12.4) must be re-evaluated. The 64 KB text cap (§5.1, finding #12) and `disable:` hard-deny rejection (finding #9) are applied regardless of origin as defense in depth.
- **Slack to ApproveTaskFn.** Mediated by the fan-out Lambda and `SlackUserMappingTable` (§11.2). A Slack admin cannot forge mappings. Slack approvals are capped at `severity: low|medium` (finding #4).

### 12.2 Ownership encoded in ConditionExpression

There is no TOCTOU window. The `TransactWriteItems` (§7.1) encodes conditions across two tables:

- TaskApprovalsTable: `#status = :pending AND user_id = :caller`
- TaskTable: `#status = :awaiting AND awaiting_approval_request_id = :rid`

Authorization, the approvals-state transition, and the task-state transition are all atomic. A compromised internal caller (Lambda with raw DDB access) or a logic bug in a future refactor that forgets the ownership check still can't flip rows without matching the `user_id`. The task-state guard also prevents the "approve succeeds on a cancelled task" race (finding #7).

The `user_id` comparison is against the Cognito `sub` **verbatim**, with byte-for-byte equality. Any future identity transformation (per-tenant prefixing, namespacing) must apply to BOTH the write path (agent-side row write) AND the compare path (Lambda ConditionExpression) simultaneously, or the comparison silently fails under the new format. A unit test (§15.3) enforces this: given a sample JWT, extract `sub`, write a row, then assert the stored `user_id` equals `sub` byte-for-byte.

### 12.3 Race prevention

**Race 1: the user approves at T and the agent times out at T+ε.**
- The agent's poll loop times out and issues the best-effort conditional update `status = TIMED_OUT WHERE status = :pending`.
- The user's CLI writes `APPROVED WHERE status = :pending` (via TransactWriteItems).
- One of the two wins atomically.
- The loser:
  - If TIMED_OUT wins, the user gets 409 `REQUEST_ALREADY_DECIDED` and sees "approval expired".
  - If APPROVED wins, the agent's poll reads APPROVED on the next tick and the agent proceeds.

**Race 2: double-approve.**
- Two CLI invocations run concurrently. The second gets 409 `REQUEST_ALREADY_DECIDED`. The operation is idempotent.

**Race 3: cancel during AWAITING_APPROVAL.**
- The agent writes `RUNNING WHERE status = :awaiting AND awaiting_approval_request_id = :rid`
- The user writes `CANCELLED WHERE status = :awaiting` (via `bgagent cancel`)
- If CANCELLED wins, the agent's resume fails with TransactionCanceledException. The hook emits `approval_resume_failed` and returns DENY. The task is already CANCELLED, and the agent's turn is aborted. The cancel hook pre-empts the denial injection that is queued for the between-turns hook (§4 finding #2 scenario).
- If RUNNING wins, `bgagent cancel` gets 409 `TASK_ALREADY_RUNNING` (or similar), and the user sees "task resumed before cancel landed".

**Race 4: cancel during approve Lambda.**
- The user runs `bgagent cancel` and `bgagent approve` nearly simultaneously from different terminals.
- ApproveTaskFn's `TransactWriteItems` (§7.1) includes a TaskTable guard `status = :awaiting`. If the cancel landed first and set status to CANCELLING, the approve transaction fails with 409 `TASK_NOT_AWAITING_APPROVAL`.
- Previously (separate GetItem + UpdateItem) this race could produce a 202 approve on a dying task (finding #7 scenario).

### 12.4 Blueprint content safety

Under the blueprint trust model (§12.1), blueprint Cedar policies are trusted by construction. The engine still enforces the following for ALL origins (CDK-deployed today, potentially user-uploadable in future):

- Cedar syntax validation at load: fail-on-error
- Duplicate `@rule_id`: fail-on-error
- `@tier` mismatch with physical file or section: fail-on-error
- `@approval_timeout_s < 30`: fail-on-error
- Missing `@rule_id` on soft-deny rule: fail-on-error
- `disable:` entry naming a built-in hard-deny rule_id: fail-on-error (finding #9)
- Combined `cedar_policies` text > **64 KB**: fail-on-error (finding #12)
- Per-`is_authorized` call timeout: 100 ms (protects against pathological backtracking Cedar expressions)

The 64 KB cap is enforced today regardless of blueprint origin. If the blueprint model ever changes to user-uploadable, it needs additional safeguards: a per-blueprint policy count cap (50 rules), a per-user rate limit on blueprint submission, and sandboxed Cedar evaluation memory caps.

### 12.5 `all_session` does not override hard-deny

Hard-deny is evaluated FIRST, before the allowlist fast-path (§6.2). No `initial_approvals` scope can bypass it. No blueprint `disable:` directive can remove a built-in hard-deny rule (§5.1). `CreateTaskFn` rejects `rule:<hard_deny_rule_id>` at submit. These guarantees hold for `all_session`, `tool_type:`, `rule:`, and every other scope type.

### 12.6 Denial reason sanitization in the Lambda

`DenyTaskFn` runs `output_scanner.scan(reason)` **before** persisting to DDB. This is the existing agent-side scanner that redacts AWS keys, GitHub PATs, OAuth tokens, and common secrets.

Sanitization at the Lambda layer means:
- TaskApprovalsTable stores only sanitized text (visible to operators with DDB read)
- TaskEventsTable audit record stores only sanitized text (90d retention)
- Fan-out Slack and email notifications see only sanitized text
- The agent reads sanitized text verbatim and needs no secondary scanning

Both the CLI and the Lambda log `message_length`, not `reason`, in CloudWatch logs (matching the Phase 2 nudge logging discipline). The reason propagated as `permissionDecisionReason` to the SDK (§4 step 25d) is sanitized and truncated to 500 chars.

### 12.7 `tool_input_preview` terminal-escape sanitization

`_strip_ansi` removes:
- ANSI CSI sequences (`\x1b[...m` and similar)
- OSC sequences (`\x1b]...\x07`)
- Control characters below 0x20 except `\t\n`
- DEL (0x7F)

It is applied at two layers:
- **Agent-side at write.** `tool_input_preview` is sanitized before the DDB Put.
- **CLI-side at render.** `bgagent pending`, `bgagent approve` output, and the live stream renderer all pass preview text through `_strip_ansi` before display.

This is defense in depth. Rows written before the agent-side sanitization landed (if any) are still rendered safely.

### 12.8 Recent-decision cache blocks verbatim retry loops (session-scoped)

After a DENIED or TIMED_OUT outcome, the engine caches `(tool_name, tool_input_sha256)` for 60s. The agent's next identical tool call auto-denies without a new approval request. This blocks the naïve retry-loop case where an agent receives a deny and immediately re-invokes the identical command.

After a DENIED outcome the engine also caches `(tool_name, rule_id)` for each rule that gated the call, in a second map with the same 60s TTL and its own bound of 50 entries (§12.9). Another call of that tool that one of those rules gates auto-denies whatever its input. These entries are consulted after the allowlist, so they do not refuse a call that an approval given in the meantime covers (for example with scope `rule:<rule_id>`). The `policy_decision` event of such a hit names the rule in `matched_rule_id`.

This blocks the retry with variations. In end-to-end testing an agent answered a deny by re-issuing the denied command with another branch name and other flags until it ran out of turns (issue #113). A TIMED_OUT outcome is not recorded per rule. The user was away, which is not a refusal.

**What the cache does and does not block:**
- **Does block:** verbatim retry loops (agent sees deny, retries identical command within 60s).
- **Does block, after DENIED:** variations of the denied call that the same rule still gates (another branch name, flag reordering, whitespace), within 60s.
- **Does not block:** input variations after TIMED_OUT, and variations after DENIED that reach the gate through another rule or another tool. Whitespace differences, flag reordering, trailing slashes, or path equivalents all produce different SHA-256 keys, and a timeout records no rule. A motivated adversary (or a model whose sampling varies retries for unrelated reasons) gets a new approval request for each variation. `approvalGateCap` bounds how many (§12.9). v1 does NOT normalize inputs. It matches exactly, to avoid the bugs that a normalizer introduces.
- **Does not block:** retries after the 60s window. The denial text tells the agent not to retry the class of action (§4, "Denial with steering text"). Once the entries have expired, nothing enforces it, and the next call the rule gates opens a new approval request.
- **Does not block:** legitimate retries. If the user denies at turn 3 with "build the Makefile target first" and the agent legitimately needs the same command at turn 5 after doing so, the cache still returns DENY. The agent has no way to distinguish cache-deny from Cedar-deny in v1. This is an accepted UX tradeoff. The 60s TTL keeps the penalty short.

The cache is NOT populated on APPROVED, so that it does not block a call the user just approved.

The cache is **session-scoped (in-process)**. On container restart the cache is cleared and a same-input tool call is gated again. We accept this as a threat-model caveat instead of adding DDB persistence because:

- Container restarts are rare (spot interruption, OOM-kill, manual redeploy). Per-restart telemetry has not justified the additional complexity.
- Cumulative damage across restarts is bounded by the persistent per-task `approvalGateCap` (decision #13), the absolute terminal safety, independent of cache state.
- A DDB-backed cache adds write latency to every denied call and introduces a new consistency problem (cache invalidation across the approve and deny paths).

**Observability note.** Cache hits emit a `policy_decision` event to `TaskEventsTable` with `decision_source="recent_decision_cache"` so the event stream remains complete. A cache hit does NOT write a new row to `TaskApprovalsTable` (by design, because there is no new pending approval) and does NOT increment `approval_gate_count` (the original gate already counted). Without this event emission, cache-driven denies would be invisible in logs and the `approval_cap_exceeded` correlation analysis below would be impossible.

See the finding #3 scenario in §6.2 for the concrete failure pattern. A persistent cache is tracked in §17 as future work, for the case where operator telemetry shows `approval_cap_exceeded` correlating with container restarts in production.

### 12.9 Per-task + per-rate caps

- Per-task hard cap: **default 50 approval gates, per-blueprint configurable via `security.approvalGateCap` (bounded 1 ≤ N ≤ 500, §5.1)**. When it is exceeded, the task moves to FAILED with reason `"approval-gate cap exceeded"`.
- Recent-decision cache memory bound: hard 50 entries (LRU eviction on overflow). **Decoupled from `approvalGateCap`.** A blueprint that raises the gate cap to 200 does not get a larger cache. There are two concerns and two bounds:
  - `approvalGateCap` is the UX and safety ceiling (how many decisions a human can reasonably be asked to make in one task).
  - The cache memory bound is the engine resource limit (how much memory the cache can consume). Earlier revisions conflated the two (the cache was "bounded by the 50-gate cap"). The coupling was coincidental and fragile. With the two decoupled, raising one setting does not silently scale the other.
- Per-minute rate limit: 20 approval-row writes, **per-container best-effort** (the counter resets on restart, see §13.6). When it is exceeded, the gate that tripped it gets a fail-closed deny.
- Fan-out notification cap: 10 approval-related messages per user per minute. When it is exceeded, messages are dropped (and logged).
- `GET /v1/pending`: 60 requests/min/user (§7.7, finding #8).

These caps bound the worst-case behavior of a compromised account or prompt-injected agent. See the finding #10 scenario (§13.6) for the per-minute rate limit's behavior under container restart.

**Re-evaluation criteria for the `approvalGateCap` default.** The default of 50 is an order-of-magnitude estimate, not empirically derived. Revisit the default when any of the following v1 telemetry conditions hold:
- The p99 task gate count exceeds 30 on legitimate tasks: raise the default (the current 50 is too close to the limit for real work).
- Sustained `approval_cap_exceeded` events on tasks that were trending toward success (high commit count, high tool diversity, reasonable per-minute rate): raise the default.
- Prompt-injection incidents are observed reaching 40+ gates before the cap fires: lower the default.
- The p50 blueprint override setting diverges sharply from the default: realign the default to the observed values.
Tracked as IMPL-22. Without these telemetry-driven re-evaluations, 50 will become a fixed magic number.

### 12.10 JWT replay

API Gateway validates the Cognito JWT signature and expiry. The conditional update on the approval row prevents a replay from mutating state. Slack button replays are similarly mediated by `SlackUserMappingTable` (§11.2) and Slack's own request signing.

---

## 13. Failure modes + fail-closed posture

### 13.1 DDB write failure at approval creation

When TransactWriteItems fails, the hook emits `approval_write_failed` and returns DENY. No partial state leaks.

### 13.2 Poll read failures

- Single failed GetItem: log WARN, continue polling
- After 3 consecutive failures: emit `approval_poll_degraded` event
- After 10 consecutive failures: treat as TIMED_OUT, best-effort UpdateItem to TIMED_OUT, fail-closed deny to SDK

### 13.3 Ownership mismatch

When ApproveTaskFn sees a JWT whose `sub` doesn't match the row's `user_id`, the atomic `TransactWriteItems` fails and the Lambda returns 404 `REQUEST_NOT_FOUND` (no existence oracle).

### 13.4 Cedar engine crash mid-evaluation

`evaluate_tool_use` catches all exceptions from `cedarpy.is_authorized` and returns `Outcome.DENY` with reason `"fail-closed: <exception_type>"`. This matches existing behavior. Agent-side (cedarpy) and Lambda-side (cedar-wasm) crashes are independent. A crash in one does not signal that the other has the same bug, but CI parity tests (§15.6, decision #23) ensure that the two engines produce the same decisions on the same inputs before deploy.

### 13.5 Multiple matching rules with conflicting annotations

Covered in §6.3 (min timeout clamped by the floor, max severity).

### 13.6 Container restart mid-approval and per-container rate-limit reset

`reconcile-stranded-tasks.ts` detects this (§9.6) and transitions the task to FAILED with reason `"approval stranded (container eviction)"`. The user sees the failure and can resubmit. There is no silent hang.

On container restart, two in-process counters reset:
- Per-minute rate limit (decision #14): the 20/min counter restarts from 0 in the new container.
- Recent-decision cache (decision #15, §12.8): same-input cached denies are cleared.

The per-task `approvalGateCap` (decision #13, default 50, configurable) is **persisted** on TaskTable (`approval_gate_count` and `approval_gate_cap`, captured at task start), so it survives restarts. This is the terminal bound on cumulative approval-gate damage. In the worst case with a cap of 50, a container restart after 40 gates leaves 10 more before the task force-fails.

**Scenario (finding #10):** An attacker submits a task and attempts to flood the user with approval requests. Without the rate limit, a prompt-injected agent could trigger 1000 soft-deny gates per minute, producing 1000 Slack notifications and 1000 pending approvals on the user's screen. The 20/min rate limit caps this at 20 notifications per minute per container. After roughly `approvalGateCap / 20` minutes of sustained attack (~2.5 min at the default cap of 50), the per-task cap fires and the task is force-failed. Now consider a container restart mid-attack (say AgentCore evicts the container due to memory pressure). The new container's rate-limit counter resets to 0. The attacker's prompt injection retries, in principle with another 20 gates per minute for several minutes before the persistent cap fires. So the worst-case total (before reconciler intervention) is `20/min * restart_count_in_window + trailing_gates_until_cap`. In practice restart-rate is bounded by AgentCore's own eviction rate-limit (at most a few per hour), so the amplification factor is small. If production telemetry shows sustained high restart rates, the per-minute counter can be promoted to DDB-persisted like `approval_gate_count`. That is tracked in §17. For v1 the persistent per-task cap provides the terminal safety regardless of restart count.

### 13.7 Insufficient lifetime remaining for approval

If `remaining_maxLifetime - CLEANUP_MARGIN_120S < FLOOR_30S`, the hook immediately returns DENY with reason `"insufficient maxLifetime for approval"`. The task continues without a gate or, if the task needed the gated call, fails gracefully in RUNNING state.

### 13.8 PreToolUse hook itself crashes

Existing behavior: the hook's outer try/except returns a fail-closed deny. This is extended to log the hook crash with context (request_id if available) for triage.

### 13.9 Resume transition fails (user cancelled during poll)

The hook emits `approval_resume_failed` and returns DENY. The task is already in its new state (CANCELLED), so the hook doesn't attempt to resume. The cancel hook pre-empts the between-turns denial injection (§4 finding #2 scenario).

### 13.10 `initial_approvals` drift at container start

`CreateTaskFn` validates `rule:<id>` scopes against the blueprint at submit time (§5.4). If the blueprint changes between submit and container spawn, the allowlist seeding in `PolicyEngine.__init__` (§4 step 6) re-validates each `initial_approvals` entry. Drift failure mode:

- If a `rule:<id>` no longer resolves to a valid soft-deny rule, the task fails at HYDRATING with reason `"initial_approvals drift: rule '<id>' missing"`. The user sees the failure and can resubmit with updated scopes.
- If a `tool_type:X` or `tool_group:X` references a type that's been removed from the tool catalog, the task fails the same way.
- `bash_pattern:`, `write_path:`, and `all_session` scopes have no schema drift. They pass unconditionally.

We prefer this over a silent WARN-skip. If a pre-approval is dropped silently, a gate fires that the user expects not to fire, which is confusing and violates the principle of least surprise. See the finding #11 scenario (§5.4). Drift is tracked in telemetry (a new milestone `initial_approvals_drift` is emitted on the failure).

### 13.11 Cross-engine policy disagreement (cedarpy vs cedar-wasm)

The parity contract addresses this (decision #23, §15.6). The golden-file CI test runs on every build, and divergence fails the build before deploy. Runtime divergence would appear as `CreateTaskFn` accepting a `rule:X` that the agent's engine doesn't recognize (the same class as §13.10), or the reverse. Both paths fail HYDRATING with a drift message.

### 13.12 VM-throttle + late-approval race

The agent's poll loop computes a local timeout wall-clock (`timeout_s` worth of elapsed monotonic time). If the hypervisor throttles the VM (either an AgentCore noisy-neighbor eviction window or a CPU throttle under memory pressure), poll ticks can stretch past their nominal cadence. In the worst case, the user's APPROVE transaction lands in DDB a few hundred milliseconds before the agent's local clock trips past `timeout_s` and the agent attempts to write `status = TIMED_OUT WHERE status = :pending`. The ConditionCheckFailed path fires (APPROVED already won), but without a re-read the agent's local state is stale: `outcome.status == "TIMED_OUT"` locally while DDB holds APPROVED. The agent would return DENY. The user sees "I approved it" and the agent still blocks. That is a confounding experience, and it violates the design principle that user-observed state is authoritative.

**Mitigation.** The §6.5 pseudocode re-reads the approval row with `ConsistentRead=True` whenever `_best_effort_update_status("TIMED_OUT", ...)` returns ConditionCheckFailed, and honors whatever terminal state the row carries:
- If `status == "APPROVED"`: rebuild the local `outcome` to reflect APPROVED, preserving `scope`, `decided_by`, `decided_at`, and proceed through the normal allow flow (scope-propagation, `approval_granted` milestone, resume transaction, return `{"permissionDecision": "allow"}`). Emit an `approval_late_win` milestone so operator telemetry can count races.
- If `status == "DENIED"`: honor the denial text the user submitted. Agent returns DENY with the user's sanitized reason as `permissionDecisionReason` (the same surface as a normal deny).
- If `status` is still PENDING (rare, a concurrent reaper race) or the row is gone (TTL reaped): fall through with the original TIMED_OUT outcome, a fail-closed deny.

The scenario is bounded by the polling cadence (2-5s ticks) and DDB's strongly-consistent read latency (tens of ms), so the re-read adds at most one extra GetItem to the racing path, an acceptable cost for honoring user intent. See IMPL-24 and §15.2 task #43 (race tests).

### 13.13 Runtime JWT expiry during approval wait

**Context in this codebase (verified 2026-05-06).** The AgentCore Runtime container authenticates outbound AWS API calls (DynamoDB, Secrets Manager, and others) via the container's IAM role, which the SDK resolves through the instance-metadata-service equivalent and auto-refreshes transparently. There is no user-presented JWT with a short rolling expiry consumed by the container's own API calls. `grep -rn -iE 'runtime.jwt|jwt.refresh|token_expiry' agent/src/` returns nothing (only `token_usage` for LLM billing and `GITHUB_TOKEN` for git operations). AgentCore Runtime invocation on the Lambda side uses sigv4 via `InvokeAgentRuntimeCommand` (see `cdk/src/handlers/shared/strategies/agentcore-strategy.ts`). That path also uses auto-refreshed AWS credentials, not a user JWT. The "Runtime-JWT" label in §4 step 6 and the sequence diagrams below refers to the **caller-facing SSE auth** (Terminal A's Cognito ID token presented to API Gateway to stream task events). It does not authenticate the container's own DDB writes.

**Therefore, for v1: no separate Runtime JWT expiry term is required in the ceiling computation.** The `maxLifetime` term (AgentCore's hard lifetime of 8h) is the only upper bound we control. IAM credentials refresh automatically within that window. The ceiling definition in decision #6 stands as `min(1h, maxLifetime_remaining - cleanup_margin)`.

**If the auth model changes** (for example a future design introduces a container-held user JWT to authenticate `permissionDecisionReason` attribution, or to carry the caller's Cognito `sub` end-to-end for per-user DDB conditions), the ceiling MUST be extended to `min(1h, maxLifetime_remaining - 120s, runtime_jwt_expiry - 120s)` and this section updated. Tracked as IMPL-27 so the contract is reviewed whenever the auth shape changes. If this bound is missed, the failure looks like this: the container's IAM calls succeed, but some JWT-gated channel (for example Terminal A's SSE stream) silently returns 403 during the approval wait. The user's decision lands in DDB, but the agent's poll fails to deliver `approval_granted` to the live stream. Today that channel is best-effort observability, not state. A future state-bearing channel would need the ceiling term.

### 13.14 Notification delivery failure

Fan-out delivery failures (Slack down, email bounce, webhook 5xx) do **NOT** pause the approval timer. The timer runs on the agent's local clock, keyed to the `created_at` timestamp on the DDB row. It is independent of whether any notification channel succeeded in alerting the human.

**Rationale (security).** Coupling the timer to notification-plane availability creates a bypass. An adversary who takes down the webhook (or poisons the Slack rate limit) would get an unbounded approval window. Worse, a compromised tenant could deliberately suppress their own notifications to escape gates. Fail-closed on timer expiry is invariant. Delivery is best-effort observability.

**Recovery path for the user.** `bgagent pending` queries `TaskApprovalsTable` directly via the `user_id-status-index` GSI (§7.7, §10.1). It does not depend on notification delivery. A user who suspects notifications are broken can poll `bgagent pending` at any time to see all live approvals. If the notification never landed and the user finds a gate via `bgagent pending`, they can `bgagent approve/deny` normally. The timer still runs against the original `created_at`, not from the time the user found the gate.

**Operational signal.** `approval_timed_out` events carry `timeout_s` and the `created_at`/`decided_at` delta. A rising `approval_timed_out` rate with flat `approval_requested` rate (measured via `ApprovalTimeoutClipRate` and `ApprovalDecisionLatency` in §11.3) is the telemetry that indicates notification breakage, not an unresponsive user.

**The fail-closed posture on timer expiry remains unchanged.** Delivery-availability-aware scheduling is the notification plane's job (see §14.8 and INTERACTIVE_AGENTS.md notification-plane design). The timer does not reason about it.

### 13.15 Fail-closed summary

```mermaid
flowchart LR
    A[PreToolUse hook fires] --> B{Cedar eval<br/>exception?}
    B -->|yes| Z[DENY<br/>fail-closed]
    B -->|no| C{DDB write<br/>exception?}
    C -->|yes| Z
    C -->|no| D{Poll 10<br/>consecutive fails?}
    D -->|yes| Z
    D -->|no| E{Resume<br/>transaction fails?}
    E -->|yes| Z
    E -->|no| F{maxLifetime<br/>under floor?}
    F -->|yes| Z
    F -->|no| G{Per-task gate<br/>cap hit?}
    G -->|yes| Z
    G -->|no| H{Per-min<br/>20-rate hit?}
    H -->|yes| Z
    H -->|no| I[Normal flow<br/>continues]
```

Every exceptional branch terminates in DENY. The only path to ALLOW is the happy path through a valid approval or pre-approval. No failure mode accidentally approves.

### 13.16 Observable blocker signal (#251)

When the agent cannot make progress for an **environmental** reason, it emits a typed, machine-readable **`agent_blocked`** progress event instead of silently using up turns or failing without explanation. Environmental reasons are a missing secret, an egress denial, an unreachable dependency, or a fail-closed *policy-engine error* (as opposed to an intentional hard-deny). This is distinct from the HITL `AWAITING_APPROVAL` pause (§11). That pause is for *policy* decisions a human must make. A blocker is for *environmental* faults that the platform or agent can diagnose or (where safe) fix.

A blocker does **not** introduce a new task status. Blockers appear as events during `RUNNING`. The terminal outcome stays `FAILED` (or `COMPLETED` if self-remediation succeeds), with a precise classification.

**Blocker taxonomy (closed set).** The kind set is defined once, agent-side, in `agent/src/progress_writer.py` (`BLOCKER_KINDS`), and mirrored by the CDK error classifier (`cdk/src/handlers/shared/error-classifier.ts`). Keep all three (code, classifier, and this table) in step.

| kind | meaning | retryable | remediation posture |
|---|---|---|---|
| `missing_secret` | a required secret was never wired into the blueprint | no | report the exact secret name. Never acquire |
| `egress_denied` | a connection to a non-allowlisted host was blocked | no | report the exact host to allowlist. Never widen egress |
| `dependency_unreachable` | transient failure reaching a dependency or registry | yes | bounded retry with backoff, then report |
| `policy_fail_closed` | Cedar engine error or unavailable (NOT an intentional hard-deny, see §13.4, §13.15) | no | report. Distinct from hard-deny |
| `auth_failure` | credential present but rejected | no | report. No self-heal (reserved, no v1 detection site) |
| `unknown_environmental` | environmental fault not otherwise classified | no | report best-effort detail (fallback only) |

**`agent_blocked` event metadata schema:** `{ kind, detail, remediation_hint, retryable: bool, resource?: str }`. `detail` and `remediation_hint` are truncated to the standard preview cap (§10.1).

**Canonical terminal-reason contract (single source of truth).** When a blocker reaches finalization, the agent's `TaskResult.error` carries a canonical string so the orchestrator's `failTask` persists it verbatim and the classifier can attach a precise remedy:

```
BLOCKED[<kind>]: <detail>
BLOCKED[<kind>]: <detail> (resource: <resource>)   # when a resource is named
```

`format_blocker_reason(kind, detail, resource=None)` in `agent/src/progress_writer.py` produces this string. `formatBlockerReason` in `cdk/src/handlers/shared/error-classifier.ts` is the orchestration-side counterpart for reasons written directly by the platform, for example a missing secret detected during hydration. The classifier keys on the `BLOCKED[<kind>]` prefix (case-insensitively) and separately extracts the `(resource: …)` segment, so that the operator-facing remedy names the exact secret or host (for example "wire the secret `OPENAI_API_KEY` into the blueprint", "allowlist the domain `registry.npmjs.org` in the DNS Firewall"). The two are matched independently instead of with one end-anchored regex, so a reason that `failTask` wraps with trailing text or a stack trace still yields the resource. `auth_failure` and `unknown_environmental` are in the closed enum but have no v1 detection site. They are reserved so that callers and the classifier can handle them without a follow-up enum change.

**Bounded self-remediation (safe-by-default).** For `dependency_unreachable` only, repo setup retries the exact same network command (`git clone` or the PR-branch `git fetch`) with capped exponential backoff (`run_cmd_with_backoff` in `agent/src/shell.py`) when the failure signature looks transient (a brief DNS failure, registry 5xx or 429, connection reset). Each retry emits an auditable `agent_blocked` event. On exhaustion the task fails with the canonical `dependency_unreachable` reason. Permanent failures (auth denied, repo not found) fail fast without retry. A **DNS name-resolution failure that names a host** (`could not resolve host: <host>`, `getaddrinfo ENOTFOUND <host>`) leaves backoff immediately. It is not retried and emits no `dependency_unreachable` events. It is reclassified as a non-retryable `egress_denied` that names that host, because a name that cannot be resolved is a firewalled or non-existent endpoint, and retrying never helps. A transient **TCP-connect** failure to an otherwise-reachable host (`failed to connect to <host> … connection timed out`) and a name-resolution failure that names *no* host (`temporary failure in name resolution`) both stay retryable. If a TCP failure persists past the retries it is still reclassified to `egress_denied` at exhaustion. Either way the setup path and the PostToolUse egress detector reach a consistent verdict. `missing_secret` and `egress_denied` are **report-only, never self-healed**. Remediation preserves scope by construction: it re-invokes the same command with the same credentials and DNS rules, grants no new scope, and changes no IAM policy or egress allowlist. Model-issued installs (`npm install` in a Bash tool call) cannot be retried in-hook under the Agent SDK, because PostToolUse fires after execution. They are only *reported* as blockers, not retried.

---

## 14. Sample scenarios

### 14.1 Scenario A: force-push with per-rule timeout

Setup: the `my-org/my-app` blueprint extends soft-deny with `force_push_main` (@approval_timeout_s=600). The task default is 300s.

```bash
$ bgagent run --repo my-org/my-app \
    --task "rebase feature-x onto main and push" \
    --approval-timeout 300
```

The agent force-pushes. Both `force_push_any` and `force_push_main` match. Annotation merge: `min(300, 600, 300) = 300s`, `max(medium, high) = high`.

```
[14:00:00]  ★ approval_requested: Bash "git push --force origin main" (severity=high)
            reason: Cedar soft-deny: force_push_any, force_push_main
            respond: bgagent approve <task-id> 01KPR... [--scope tool_type_session]
            timeout: 300s
```

The user approves with `tool_type_session`. The stream shows:

```
[14:00:08]  ★ approval_granted: request_id=01KPR... scope=tool_type_session
[14:00:08]  ▶ Bash: git push --force origin main
[14:00:10]  ◀ Bash: remote: Force pushed.
```

A later `git status` call takes the allowlist fast-path, with no new approval.

### 14.2 Scenario B: DROP TABLE hits hard-deny

The agent proposes `Bash: psql -c "DROP TABLE test_users;"`. The hard-deny rule `drop_table` matches, so the engine returns DENY immediately with reason `"Hard-deny: drop_table"`. There is no approval request. The task stays in RUNNING.

The recent-decision cache now has `(Bash, sha256(DROP TABLE ...))` for 60s. A retry would auto-deny without re-running Cedar.

The agent adapts and proposes `Bash: psql -c "DELETE FROM test_users; VACUUM test_users;"`. No rule matches. The tool runs.

### 14.3 Scenario C: Trusted automation with `all_session`

```bash
$ bgagent submit --repo my-org/infra \
    --task "apply approved terraform plan for staging-v2" \
    --pre-approve all_session --yes
```

The blueprint on `my-org/infra` allows `maxPreApprovalScope: "all_session"`. The task runs fully autonomously, with zero approval gates. Hard-deny still applies.

The stream shows `[14:20:00]  ★ pre_approvals_loaded: count=1 scopes=[all_session]` at startup so operators see the starting posture.

### 14.4 Scenario D: Denying with steering reason

```bash
$ bgagent run --repo my-org/my-app \
    --task "Delete the old user dashboard; replace with redesigned v2" \
    --approval-timeout 600
```

The agent finishes the rewrite, then tries to publish it by rewriting history on the default branch: `Bash: git push --force origin main`. The soft-deny rule `force_push_main` matches. After `approval_requested`, the user runs:

```bash
$ bgagent deny 01KPW... 01KPR... \
    --reason "don't force-push main; open a PR and keep src/dashboard/v1 around (move it to src/dashboard/v1.deprecated) — we may need it for migrations"
```

`DenyTaskFn` sanitizes the reason (it holds no secrets, so it passes through unchanged) and writes it to DDB. The agent's poll reads DENIED.

The hook executes the atomic resume to RUNNING, queues the denial injection via `between_turns_hooks`, and returns to the SDK with `permissionDecisionReason = "don't force-push main; open a PR..."` (truncated, guaranteed surface).

The next Stop seam fires. The between-turns injector emits the following (best-effort, pre-empted if the cancel hook short-circuits first):

```xml
<user_denial request_id="01KPR..." timestamp="2026-04-23T14:30:08Z">
don't force-push main; open a PR and keep src/dashboard/v1 around (move it to src/dashboard/v1.deprecated) — we may need it for migrations
</user_denial>
```

The agent reads the denial on its next turn and adapts:

```
[14:30:12]  ▶ Bash: git mv src/dashboard/v1 src/dashboard/v1.deprecated
[14:30:13]  ◀ Bash: (success)
[14:30:15]  ▶ Bash: git push origin feat/dashboard-v2   (opens a PR instead of force-pushing main)
[14:30:17]  ◀ Bash: (success)
```

The task proceeds. If the user had concurrently cancelled, `permissionDecisionReason` still carries the reason, so the agent sees enough context to not retry blindly. The more detailed XML injection is best-effort.

### 14.5 Scenario E: AI-DLC phased pre-approvals

A three-phase workflow with escalating trust:

```bash
# Phase 1 — analysis only
$ bgagent submit --repo my-org/new-feature \
    --task "analyze the existing auth module and produce a design doc" \
    --pre-approve tool_type:Read \
    --pre-approve tool_type:Glob \
    --pre-approve tool_type:Grep \
    --pre-approve bash_pattern:"ls *" \
    --pre-approve bash_pattern:"find *"

# Phase 2 — documentation writes
$ bgagent submit --repo my-org/new-feature \
    --task "update docs/auth.md per the approved design doc" \
    --pre-approve tool_type:Read \
    --pre-approve write_path:"docs/**" \
    --pre-approve tool_group:file_write \
    --pre-approve bash_pattern:"git add docs/**" \
    --pre-approve bash_pattern:"git commit *"

# Phase 3 — full implementation
$ bgagent submit --repo my-org/new-feature \
    --task "implement the auth module per approved design + docs" \
    --pre-approve all_session --yes
```

Each phase has an explicit scope. This matches real-world review workflows. Each phase is visible in the audit trail via the `pre_approvals_loaded` event.

### 14.6 Scenario F: VM-throttle + late-approval race (trace)

Setup: the task default is 300s and the force-push gate fires. User Alice approves at the edge of the timeout window while the VM is throttled.

```
t=0.00s    PreToolUse hook fires: Bash "git push --force origin feature-x"
t=0.01s    PolicyDecision(outcome=REQUIRE_APPROVAL, timeout_s=300)
t=0.02s    TransactWriteItems: approval row PENDING + TaskTable AWAITING_APPROVAL
t=0.03s    agent_milestone: approval_requested → Terminal A stream
t=0.04s    _poll_for_decision begins; interval=2s for first 30s, then 5s

... (poll ticks every 5s from t=30 to t=295) ...

t=285.0s   host hypervisor evicts VM from warm CPU share (noisy neighbor).
           Next scheduled poll was t=290.0s; actual scheduling delay ~5.1s.
t=294.7s   Alice's bgagent approve lands at API Gateway.
           ApproveTaskFn TransactWriteItems:
             ApprovalsTable: PENDING → APPROVED (user_id matches, status was PENDING)
             TaskTable: state guard holds (still AWAITING_APPROVAL, rid matches)
           → 202 returned to CLI; Alice sees "approved!" in Terminal B
t=295.1s   agent's delayed poll tick fires. Elapsed wall-clock = 295.1s.
           Monotonic elapsed is 295.1 > timeout_s=300? NO — but the poll
           function computes `elapsed >= timeout_s` and on the NEXT tick
           (t=300.2s) it will exceed.
t=300.2s   next tick: elapsed=300.2 ≥ timeout_s=300 → TimedOut() returned.
           (Alice's APPROVED write at t=294.7s was MISSED — the previous
           poll was due at t=295.0 but the VM throttle stretched it past.)
t=300.3s   _best_effort_update_status("TIMED_OUT", ... WHERE status = :pending)
           → ConditionCheckFailed (row is APPROVED, not PENDING)
           → wrote_timeout = False
t=300.4s   [NEW] re-read row with ConsistentRead=True
           → row["status"] == "APPROVED", scope="tool_type_session"
t=300.5s   outcome rebuilt: Decided(status=APPROVED, scope=..., decided_at=...)
t=300.5s   agent_milestone: approval_late_win {outcome: APPROVED,
                               reason: "user decision landed during TIMED_OUT write"}
t=300.6s   _transact_resume: TaskTable AWAITING_APPROVAL → RUNNING (atomic)
t=300.7s   allowlist.add("tool_type:Bash"), which is what tool_type_session
           stands for after a Bash call; milestone approval_granted
t=300.8s   return {"permissionDecision": "allow"} to SDK
t=300.9s   SDK runs Bash: git push --force origin feature-x
t=302.5s   ◀ Bash: remote: Force pushed. New SHA abc123.
```

Without the re-read at t=300.4s, the agent would have returned DENY at t=300.5s, and Alice would have the confounding experience of "I approved it" followed by a denial from the agent. The mitigation cost is one extra GetItem on the race path. The `ApprovalDecisionLatency` p99 metric (§11.3) includes this re-read, and any operator can see the late-win rate via the new `approval_late_win` events (§11.1). See §13.12 for the full failure-mode description and §15.2 task #43 for the race test.

### 14.7 Scenario G: timeout clipped by a tighter rule annotation

Setup: Bob submits with `--approval-timeout 600`. The blueprint has a `write_credentials` soft-deny rule annotated `@approval_timeout_s("300")`. The agent tries `Write: /etc/aws/credentials`.

```
[16:00:00]  ★ approval_timeout_capped_at_submit: requested=600, effective=300, reason=rule_annotation (write_credentials)
            — emitted at CreateTaskFn submit time; user sees on first POST response and in task metadata.

[16:03:42]  ★ approval_requested: Write "/etc/aws/credentials" (severity=high)
            reason: Cedar soft-deny: write_credentials
            timeout: 300s   (clipped from --approval-timeout=600 by rule annotation)
            respond: bgagent approve <task> 01KPR... [--scope tool_type_session]
            bgagent deny    <task> 01KPR... [--reason "..."]

[16:03:42]  ★ approval_timeout_capped: requested=600, effective=300, reason=rule_annotation
```

Bob sees both the pre-submit warning (`approval_timeout_capped_at_submit`) and the per-gate cap event (`approval_timeout_capped`) so he understands why his 600s didn't apply. Without these milestones, the user sees only `timeout: 300s` in the approval banner and may think the CLI dropped their setting. Both events are captured in the event stream and appear in `bgagent watch`. See §11.1, §11.3 (`ApprovalTimeoutClipRate`), and Fix 4 / IMPL-26 in §16.

### 14.8 Off-hours and unattended tasks (known trade-off)

**Known trade-off: off-hours failure.** Because timeouts are fail-closed (decision #6), a task running overnight with pending approvals will fail if no approver responds in time. This is deliberate. Auto-approve on timeout would make "wait the reviewer out" the attacker's winning strategy. See decision #6 and the §13.15 fail-closed summary.

**For overnight or unattended runs, choose one of:**
- Pass `--pre-approve all_session --yes` to bypass gates entirely for that task (you accept the broader trust grant, see §7.3).
- Configure escalation on the `approval_requested` event via the notification plane (see `docs/design/INTERACTIVE_AGENTS.md` for channel configuration). Route to whoever is on-call. The escalation schedule is the tenant's responsibility, not the timeout engine's.
- Schedule the task during business hours.

The `approvalGateCap` (decision #13) will force-fail the task after approximately `cap × task_default_timeout_s` of unanswered gates. The default worst case is ~4h at cap=50 and timeout=300s.

**Why the timer itself is timezone-unaware.** Business-hours logic belongs in the notification plane, not the authorization engine. Building calendars or on-call rotations into the timer would couple the security boundary to a scheduling system it doesn't own. The same rule is evaluated at 9am and 3am because the security property (an adversary cannot wait out review) is time-invariant. Delivery-availability-aware scheduling is the notification plane's job, through subscribed-channel health and escalation policies.

See §17.18 for the off-hours escalation future work, and §13.14 for the notification-delivery-failure boundary.

---

## 15. Implementation plan

> **Status note (post-implementation):** The v1 core described below is **shipped on `main`**. The 3-outcome engine, hard and soft default policy sets, the approval, deny, pending, and policies Lambdas and their API routes, and the cross-engine parity contract all exist and are tested. The task list and scenarios in this section are retained as the historical design-and-build record. Treat them as a description of what was built, not as outstanding work. Items still explicitly deferred are tracked in §15.1 ("Future work, polish") and §17 (for example CLI inline streaming prompt, `approve --defer` / allowlist revocation, the additional CloudWatch alarms of §11.5, persistent recent-decision cache, persistent per-minute rate limit).

### 15.1 Milestone structure

**v1, core feature (3-4 weeks of work):**
- Day 1: commit the cedarpy annotation round-trip test (agent side, `agent/tests/test_cedarpy_annotations_contract.py`), the `@cedar-policy/cedar-wasm` parse test (Lambda side, `cdk/test/handlers/shared/cedar-policy.test.ts`), and the cross-engine parity golden-file test (`agent/tests/test_cedar_parity.py` and `cdk/test/handlers/shared/cedar-parity.test.ts`, sharing a fixture dir). Both packages were already spiked on 2026-04-24. `cedarpy.policies_to_json_str()` returns annotations verbatim under `staticPolicies.<id>.annotations`. `@cedar-policy/cedar-wasm/nodejs` exports `policySetTextToParts` and `policyToJson(text)`, which together expose the same data (see §15.6).
- Engine refactor (hard + soft + annotations + allowlist + recent-decisions)
- New DDB table + GSI, new Lambdas (with cedar-wasm Lambda layer), new CLI commands
- PreToolUse hook extension (atomic transitions)
- `bgagent policies list` + `bgagent pending` (support UX that unblocks real usage)
- Happy path + fail-closed tests + cross-engine parity tests
- E2E on `backgroundagent-dev`

**Future work, polish (tracked in §17):**
- CLI inline streaming prompt (UX research first)
- `approve --defer` / allowlist revocation (`bgagent revoke-approval`)
- ~~CloudWatch alarm SNS notification wiring (§11.5). DLQ-depth alarms ship without an action target. Add `SnsAction` once a notification channel is provisioned.~~ **Shipped (issue #629):** all three DLQ-depth alarms are wired to the `OperationalAlerts` SNS topic (§11.5)
- More soft-deny policies in the default set based on real usage
- Persistent recent-decision cache (if container-restart telemetry justifies it)
- Persistent per-minute rate limit (if restart amplification becomes significant)

### 15.2 v1 task list

About 37 focused items, ordered by dependency.

| # | Package | File | Change |
|---|---|---|---|
| 1 | agent | Spike | Validate cedarpy.policies_to_json_str() returns annotations. Confirm `diagnostics.reasons` shape for multi-match. If API diverges, update §6 before proceeding. |
| 2 | mise + agent + cdk | `mise.toml`, `agent/pyproject.toml`, `cdk/package.json` | Pin `cedarpy==4.12.2` (agent) and `@cedar-policy/cedar-wasm==4.12.0` (cdk). The binding version strings need not be equal. The pair is verified compatible via the parity fixtures. Both are pinned exactly, not `^` or `~` (decision #23, finding #1). |
| 3 | agent + cdk | `contracts/cedar-parity/*.json` (shared fixture dir, follows the precedent set by `contracts/memory-hash-vectors.json`) | Golden-file parity fixtures: `(policy_set, input) → {decision, matching_rule_ids}`. The agent side loads via `cedarpy`, the Lambda side via `cedar-wasm`. Divergence fails CI. |
| 4 | agent | `src/policy.py` | Extend `PolicyDecision` (outcome/timeout_s/severity/matching_rule_ids/allowed-property). Split `_DEFAULT_POLICIES` into hard + soft. Add annotation parsing. Implement `ApprovalAllowlist` + `RecentDecisionCache` (50-entry LRU cap, independent of `approvalGateCap`). Load-time validation (rule_id uniqueness, tier mismatch, annotation floor, 64 KB cap, disable-list hard-deny rejection, `approvalGateCap` bounds check `1 ≤ N ≤ 500`). `PolicyEngine.__init__` accepts `approval_gate_cap` sourced from blueprint (default 50). |
| 5 | agent | `policies/hard_deny.cedar` (new) | Migrate current hard-deny rules + add DROP TABLE. Annotations. |
| 6 | agent | `policies/soft_deny.cedar` (new) | force-push, *.env, infrastructure/**, credentials. Annotations. |
| 7 | agent | `tests/test_policy.py` | Three-outcome, annotation merging, allowlist (including write_path, tool_group), recent-decision cache, pre-approval seeding, annotation round-trip, 64 KB cap rejection, disable-list hard-deny rejection. |
| 8 | agent + cdk | `tests/test_cedar_parity.py` + `cdk/test/.../cedar-parity.test.ts` | Golden-file parity test. Both sides load the shared fixture, run their respective engine, assert equal `(decision, rule_ids)`. Runs in CI on every commit. |
| 9 | cdk | `src/constructs/task-approvals-table.ts` (new) | Table + GSI (`user_id-status-index`) + TTL + PITR (no Streams). |
| 10 | cdk | `src/constructs/cedar-wasm-layer.ts` (new) | Lambda layer packaging `@cedar-policy/cedar-wasm`. Shared across policy Lambdas. Memory ≥ 512 MB per Lambda. |
| 11 | cdk | `src/handlers/shared/cedar-policy.ts` (new) | Shared policy-parsing library for Lambda-side rule-id validation (consumes cedar-wasm layer). |
| 12 | cdk | `src/handlers/approve-task.ts` (new) | POST /approve with cross-table `TransactWriteItems` (ownership + task-state) + audit event (finding #7). |
| 13 | cdk | `src/handlers/deny-task.ts` (new) | POST /deny with output_scanner sanitization + cross-table `TransactWriteItems` + audit event. |
| 14 | cdk | `src/handlers/get-policies.ts` (new) | GET /v1/repos/{repo}/policies. |
| 15 | cdk | `src/handlers/get-pending.ts` (new) | GET /v1/pending with GSI-backed Query + 60 RPM rate limit. |
| 16 | cdk | `src/handlers/shared/types.ts` | ApprovalRequest/Response/DenyRequest + Scope union + extended CreateTaskRequest. |
| 17 | cdk | `src/handlers/shared/response.ts` | New error codes (REQUEST_NOT_FOUND, REQUEST_ALREADY_DECIDED, TASK_NOT_AWAITING_APPROVAL). |
| 18 | cdk | `src/constructs/task-api.ts` | Wire /approve, /deny, /repos/{}/policies, /pending routes. Grants. |
| 19 | cdk | `src/stacks/agent.ts` | Instantiate TaskApprovalsTable (+ GSI). CedarWasmLayer + layer attachment to CreateTaskFn, ApproveTaskFn, DenyTaskFn, GetPoliciesFn. Env var on runtimes. |
| 20 | cdk | `src/constructs/task-status.ts` | AWAITING_APPROVAL enum + transitions. |
| 21 | cdk | `src/handlers/create-task.ts` | Validate initial_approvals + approval_timeout_s with all safeguards (degenerate patterns, hard-deny rule rejection, maxPreApprovalScope ceiling, blueprint-resolved rule lookup, 64 KB cap). |
| 22 | cdk | `src/handlers/orchestrate-task.ts` | waitStrategy + finalizeTask handle AWAITING_APPROVAL. |
| 23 | cdk | `src/constructs/stranded-task-reconciler.ts` | Detect + transition stranded AWAITING_APPROVAL tasks. |
| 24 | cdk | `src/handlers/fanout-task-events.ts` | Dispatch rules for approval_* events + per-user notification rate limit. |
| 25 | cdk | `src/constructs/slack-user-mapping-table.ts` (new) | SlackUserMappingTable with user-initiated-only write path (§11.2, finding #4). Includes `link-slack-user.ts` Lambda for OAuth-signed mapping creation. |
| 26 | agent | `src/hooks.py` | PreToolUse REQUIRE_APPROVAL path: atomic transitions, caps, poll, resume, denial-injection queue. Include `permissionDecisionReason` guaranteed-surface on deny return. |
| 27 | agent | `src/hooks.py` | `_denial_between_turns_hook` registered AFTER `_nudge_between_turns_hook` (cancel-wins semantics preserved, denial is best-effort on cancelled tasks, finding #2). Shared `_xml_escape`. |
| 28 | agent | `src/task_state.py` | AWAITING_APPROVAL in transition helpers (TransactWriteItems primitive). |
| 29 | agent | `src/progress_writer.py` | `write_approval_*` convenience methods over `write_agent_milestone`. |
| 30 | cli | `src/commands/approve.ts` (new) | + 429 handling, `NO_COLOR` check. |
| 31 | cli | `src/commands/deny.ts` (new) | + `--reason-file` support. |
| 32 | cli | `src/commands/pending.ts` (new) | `bgagent pending` listing across active tasks (uses `GET /v1/pending` endpoint). |
| 33 | cli | `src/commands/policies.ts` (new) | `bgagent policies list` + `policies show`. |
| 34 | cli | `src/commands/submit.ts` + `run.ts` | --approval-timeout, --pre-approve (repeatable), --pre-approve-file, all_session confirmation with --yes bypass. Emit WARN on uppercase-in-glob `write_path:` scopes (finding #15). |
| 35 | cli | `src/api-client.ts` | approveTask, denyTask, listPending, listPolicies, extended createTask. |
| 36 | cli | `src/types.ts` | Mirror CDK types. Scope union + validator. |
| 37 | cdk | `test/handlers/approve-task.test.ts` (new) | Happy path, race, cross-table transaction (ownership + task-state), scope validation, 409/404 distinction, cancel-during-approve race (finding #7). |
| 38 | cdk | `test/handlers/deny-task.test.ts` (new) | Same shape + output_scanner integration. |
| 39 | cdk | `test/handlers/get-policies.test.ts` (new) | Discovery endpoint tests. |
| 40 | cdk | `test/handlers/get-pending.test.ts` (new) | GSI query coverage + rate-limit assertion. |
| 41 | cdk | `test/handlers/create-task.test.ts` | initial_approvals validation (degenerate patterns, hard-deny rule rejection, blueprint resolution, 64 KB cap). |
| 42 | cli | `test/commands/*.test.ts` | CLI command tests. |
| 43 | agent | `tests/test_hooks.py` | REQUIRE_APPROVAL path, atomic transitions, caps, recent-decision cache, denial injection (including cancel-wins short-circuit verification), permissionDecisionReason fallback surface. **Race test (IMPL-24)**: simulate VM-throttle + late-approval. The user's APPROVE transaction lands <200ms before the agent's local poll decides TIMED_OUT. `_best_effort_update_status("TIMED_OUT")` must return ConditionCheckFailed. The hook must re-read with ConsistentRead and honor the APPROVED state (allow flow, `approval_late_win` milestone, resume transaction). Also cover the DENIED variant and the "still PENDING" rare-race fall-through. |
| 44 | agent | `tests/test_policy.py` | Annotation loader sub-120s WARN (IMPL-25): confirm `@approval_timeout_s("90")` loads with WARN log, `@approval_timeout_s("29")` is rejected (below floor), `@approval_timeout_s("120")` and above load silently. |
| 45 | agent | `tests/test_hooks.py` | Milestone emission tests (IMPL-26): assert `approval_timeout_capped` is emitted on clip with correct `reason`, `approval_ceiling_shrinking` is emitted once per task at threshold, `approval_timeout_capped_at_submit` is returned on POST `/v1/tasks` response body when applicable. |
| 46 | cdk | `test/constructs/task-dashboard.test.ts` + `test/handlers/approval-metrics-publisher.test.ts` + `test/handlers/shared/approval-metrics.test.ts` + `test/constructs/approval-metrics-publisher-consumer.test.ts` | Dashboard + publisher wiring tests (IMPL-28): assert `ApprovalTimeoutClipRate`, `ApprovalTimeoutBreakdown`, and `ApprovalDecisionLatency` widgets exist backed by native `ABCA/Cedar-HITL` metrics. EMF builder classifier correctness, including the schema-mismatch skip path and the unknown-dim cardinality cap. Event-source filter pattern structurally validated. DLQ + `reportBatchItemFailures` poison-pill isolation. |
| 47 | docs | `docs/design/INTERACTIVE_AGENTS.md` | Update §7 if needed. Confirm §9.3 cross-link. |

### 15.3 Testing strategy

- **Unit**: ~80% coverage target, matching Phase 2.
- **Integration**:
  - Cedar annotation round-trip test (write, parse, recover all 5 annotations)
  - Full pipeline from PreToolUse through PolicyDecision to DDB
  - Allowlist seeding from initial_approvals (including drift failure on container start)
  - Shared policy-parsing library consistency (Lambda side == agent side)
  - **Cross-engine parity** (decision #23, finding #1): golden-file test in both packages, same fixtures, divergence fails CI
  - Ownership-in-condition byte-equality test: sample JWT `sub` compared verbatim against written `user_id` (finding #6)
- **E2E** on `backgroundagent-dev`: 5 scenarios (A-E from §14). Both RuntimeJwt and Runtime-IAM paths.
- **Race tests**:
  - Approve versus timeout, concurrent
  - Deny versus timeout, concurrent
  - Double-approve
  - Cancel during AWAITING_APPROVAL (agent-side resume race)
  - Cancel during approve Lambda (cross-table transaction catches it, finding #7)
  - Cancel during deny with queued denial injection (between-turns hook pre-empted, `permissionDecisionReason` still delivered, finding #2)
  - Late approval after TIMED_OUT (expect 409)
  - **VM-throttle + late-approve race (IMPL-24, §13.12)**: user's APPROVE lands in DDB before `_best_effort_update_status("TIMED_OUT")` can claim the row. The agent must re-read with ConsistentRead and honor APPROVED (not return stale TIMED_OUT). Includes the DENIED variant and the "still PENDING" fall-through where neither side wins.
- **Chaos tests**:
  - Container restart mid-approval (simulated via kill + reconciler)
  - Container restart mid-recent-decision-cache (verify that the cache resets and `approvalGateCap` fires at the configured value, finding #3)
  - DDB throttle during poll (simulated via mock)
  - Bash retry loop after DENIED (expect recent-decision cache auto-deny)
- **Security tests**:
  - Wrong user JWT returns 404 (not 403)
  - ANSI-injected tool_input_preview is stripped at both layers
  - With malformed Cedar annotations, the task fails to start
  - Degenerate bash_pattern returns 400 at submit
  - Sanitizer-removing-secret test (OUTPUT_SCANNER integration)
  - 64 KB blueprint cap rejection (finding #12)
  - `disable: [rm_slash]` blueprint rejection (finding #9)
  - Slack-user-mapping write without a Cognito JWT returns 401 (finding #4)
  - Slack approval on a `severity: high` request is rejected (finding #4)
- **Lambda memory/size tests**:
  - Each policy Lambda (CreateTaskFn, ApproveTaskFn, DenyTaskFn, GetPoliciesFn) must fit within the Lambda unzipped limit with cedar-wasm via the layer (finding #5)
  - Under a burst of 100 concurrent invocations, each Lambda uses < 80% of allocated memory

### 15.4 Rollout — no feature flag

Cedar-HITL ships as standard functionality, with no per-repo enable or disable flag. The loaded policy set (built-in plus blueprint) and the user's `--pre-approve` scopes at submit time fully determine the safety posture of a task.

Built-in policies shipped with the agent:

**Hard-deny (absolute, cannot be disabled by blueprint)**: `rm_slash`, `write_git_internals`, `write_git_internals_nested`, `drop_table`. These are absolute. No scope bypasses them, and blueprint `disable:` cannot remove them (§5.1, finding #9).

**Soft-deny starter set (require approval by default, may be disabled by blueprint)**:
- `force_push_any`: `like "*git push --force*"`, medium, 300s
- `push_to_protected_branch`: pushes to `main`/`master`/`prod`/`release/*` (non-force), medium, 300s
- `force_push_main`: force-push specifically to `main`/`prod`, high, 600s
- `write_env_files`: `like "*.env"`, high, 600s
- `write_credentials`: `like "*credentials*"`, high, 300s

Users who want fully autonomous execution (no approval gates) pass `--pre-approve all_session --yes` at submit. Repos that want additional gates add them via `Blueprint.security.cedarPolicies.soft`. Repos that want a different policy set can override specific built-in **soft-deny** rules by `@rule_id` via the blueprint's `security.cedarPolicies.disable` list. The `disable:` mechanism is restricted: it may NOT include any built-in hard-deny rule_id, and the blueprint loader rejects such configurations at task start.

Rollout steps:

1. **Implement + merge to main.** Built-in soft-deny ships with the 5-rule starter set above. There is no flag and no global kill switch. Any task on any repo immediately has the gate behavior for rules in the starter set. Any task with `--pre-approve all_session` bypasses soft-deny as it always has.
2. **`backgroundagent-dev` validation.** Deploy the merged code. Run E2E scenarios A to E:
   - A: force-push gated + approved via CLI
   - B: hard-deny path (DROP TABLE blocked, not gated)
   - C: `--pre-approve all_session` bypasses soft-deny
   - D: deny-with-reason steers agent via `<user_denial>` injection (plus `permissionDecisionReason` fallback)
   - E: AI-DLC-style phased pre-approvals
   Confirm Phase 1a/1b/2 regressions still pass. Confirm dashboards render.
3. **Pilot period (2 weeks).** Designate `scoropeza/agent-plugins` as the pilot repo (non-critical, active usage). Monitor:
   - Any stranded tasks, which indicate a reconciler gap
   - Timeout rate on approval_requested
   - Per-task approval-gate count distribution, to spot anomalous retry loops
   - Cross-engine parity: CI must remain green across any dependency updates
   - User-reported friction: "is the gate firing on things it shouldn't?"
   If the starter set is too noisy, tune it. If reliability is good, proceed.
4. **Default for all repos.** Once the pilot is stable, the starter set is already live for everyone. There is no "flip the switch" step because there was no flag. Ongoing tuning happens by modifying built-in policies in code or via repo blueprints.

**Rollback mechanism.** If the pilot finds a bug, remove the problem rule from `soft_deny.cedar` and redeploy (~5 min). There is no flag to flip. If the bug is more fundamental (an engine regression), `git revert` the HITL merge and redeploy. Phase 2 tests continue to pass because the backward-compat shim on `PolicyDecision.allowed` preserves the hook contract.

**Success criteria for "pilot done":**
- Zero stranded tasks in 2 weeks
- <10% timeout rate on `approval_requested`
- Zero `approval_cap_exceeded` events (if any fire, either the cap is wrong or there is adversarial traffic to investigate)
- Zero cross-engine parity test failures (decision #23, finding #1)
- No regressions in Phase 1a/1b/2 tests (CI enforced on every commit)
- User-initiated gates that work: every soft-deny match produces a visible `★ approval_requested` in the stream and a responsive `bgagent approve/deny` cycle

### 15.5 Backward compatibility

- Existing tasks without `initial_approvals` get an empty list, so no pre-approvals, and the default `approval_timeout_s = 300`.
- With existing policies that lack `@rule_id` or `@tier`, the engine fails to start (fail-closed). Blueprint authors must add annotations explicitly during migration.
- The `PolicyDecision.allowed` property provides backward compatibility for existing `if not decision.allowed` callers.
- The hook return shape is unchanged, so Phase 1a/1b tests continue to pass.

### 15.6 Shared Cedar parsing — cross-engine parity contract

The agent runtime uses Python [`cedarpy@4.12.2`](https://pypi.org/project/cedarpy/). The Lambda side (`CreateTaskFn`, `ApproveTaskFn`, `DenyTaskFn`, `GetPoliciesFn`) uses [`@cedar-policy/cedar-wasm@4.12.0`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm), AWS's official WASM-compiled Cedar engine. The two are bindings of the same Rust core. Because these engines evolve independently, we ship a **parity contract** (decision #23, finding #1) to catch drift before deploy.

**Version pinning.** Both engines are pinned exactly (not `^` or `~`) in the monorepo's canonical manifest files. The two bindings are deliberately on **different version lines**. They are NOT required to be equal. `cedarpy` and `cedar-wasm` follow independent release cadences over the shared Cedar Rust core, and the currently-shipped pins (`cedarpy==4.12.2` ↔ `@cedar-policy/cedar-wasm==4.12.0`, both on the Cedar 4.12.0 core) are a tested-compatible pair. The parity fixtures in `contracts/cedar-parity/` certify that this specific pair produces identical `(decision, matching_rule_ids)` on every fixture. The rule is "move together and re-verify parity when you bump either side," not "keep the version strings equal."
- `agent/pyproject.toml`: `cedarpy==4.12.2`
- `cdk/package.json`: `"@cedar-policy/cedar-wasm": "4.12.0"`
- `contracts/cedar-parity/engines/versions.json` names the pair the fixtures were verified against. `cdk/test/constructs/cedar-wasm-layer.test.ts` (part of `mise //cdk:test`, so of the build) fails unless `cdk/package.json`, `cdk/layers/cedar-wasm/package.json` and `agent/pyproject.toml` each pin exactly that version, so an engine bump is always an edit to that file as well

**Lambda layer packaging** (finding #5). The cedar-wasm package is 4.1 MB unzipped. Shipping it in the deployment bundle of each of the 4 policy Lambdas would consume ~16 MB of unzipped bundle size. That is manageable on its own, but it leaves little room for the AWS SDK and other deps as the codebase grows, and it threatens the Lambda 250 MB unzipped limit under realistic growth. The solution is to package cedar-wasm as a **Lambda layer** (`cedar-wasm-layer.ts`, task #10 in §15.2), attached to each policy Lambda. This reduces each Lambda's deployment bundle to the handler code and a thin wrapper around the layer import. Policy Lambdas are configured with ≥ 512 MB memory to accommodate WASM module instantiation under concurrent invocation (measured under 100-concurrent bursts in §15.3 Lambda memory tests).

**Golden-file parity test.** A shared fixture dir (`contracts/cedar-parity/`) contains JSON files of the form shown below. The `contracts/` location follows the precedent set by `contracts/memory-hash-vectors.json`, a neutral directory that neither `agent/` nor `cdk/` owns, so that both test suites read from it in the same way. The sibling `README.md` under `contracts/cedar-parity/` documents the fixture shape and update workflow.

```json
{
  "name": "multi-match-force-push-main",
  "policies": "@tier(\"soft\") @rule_id(\"force_push_any\") ...\n@tier(\"soft\") @rule_id(\"force_push_main\") ...",
  "input": {
    "principal": {"type": "Agent", "id": "a"},
    "action": {"type": "Agent::Action", "id": "execute_bash"},
    "resource": {"type": "Agent::Sentinel", "id": "sentinel"},
    "context": {"command": "git push --force origin main"}
  },
  "expected": {
    "decision": "Deny",
    "matching_rule_ids": ["force_push_any", "force_push_main"]
  }
}
```

Both `tests/test_cedar_parity.py` (agent side, uses `cedarpy`) and `cdk/test/handlers/shared/cedar-parity.test.ts` (Lambda side, uses `cedar-wasm`) load each fixture, run their respective engine, and assert that the decision and sorted rule_ids match `expected`. Any divergence fails the build BEFORE deployment. The test catches:
- Syntax that one engine accepts but the other rejects (for example a new Cedar feature in a minor release)
- Annotation parsing differences
- Multi-match diagnostics divergence (does `diagnostics.reasons` contain policy IDs or rule IDs? Both must agree)
- Any bug fix in one engine that hasn't landed in the other

```mermaid
flowchart LR
    F[(Golden-file fixtures<br/>contracts/cedar-parity/*.json)]
    F --> PY[agent: test_cedar_parity.py<br/>→ cedarpy.is_authorized]
    F --> TS[cdk: cedar-parity.test.ts<br/>→ cedar-wasm isAuthorized]
    PY --> PYR[decision + rule_ids]
    TS --> TSR[decision + rule_ids]
    PYR --> EQ{Assert equal<br/>byte-for-byte<br/>sorted rule_ids}
    TSR --> EQ
    EQ -->|match| OK[CI green<br/>deploy unblocked]
    EQ -->|mismatch| FAIL[CI red<br/>build fails<br/>before deploy]
    FAIL -.remediation.-> R1[pin one engine<br/>back or forward]
    FAIL -.or.-> R2[refresh fixture<br/>if intentional change]
    FAIL -.or.-> R3[file upstream bug<br/>against diverging engine]
```

When policy authors upgrade either engine, the parity fixture must be re-generated (a small helper script dumps decisions from both engines, and the human confirms that the change is intentional).

**What the parity fixtures do not cover.** Each fixture carries its own policy text, so the parity tests compare the two engines and do not exercise the rules shipped in `agent/policies/`. Those are pinned by `agent/tests/test_policy_builtin_rules.py`: for each built-in rule its tier, the calls it must catch (each evaluated for every task type) and one similar call it must leave alone. Removing a rule, moving it to the softer tier, limiting it to some task types or narrowing one of its patterns fails that test.

**Scenario (finding #1, illustrative):** This example uses hypothetical versions (for example cedarpy `4.10.1` to `4.11.0`) to show the *class* of bug the parity contract catches. It does not describe the real shipped pins (`cedarpy==4.12.2` ↔ `cedar-wasm==4.12.0`, documented above). The point is that closeness of version strings, even within the same minor line, is no guarantee of behavioral parity. That is why the golden fixtures, not the version numbers, are the source of truth. A platform engineer bumps cedarpy by hand from 4.10.1 to 4.11.0. They notice cedar-wasm is still 4.10.0 but assume it's fine because both say "4.x". Between these versions, cedarpy added support for a new `context has` operator that cedar-wasm doesn't yet have. A new blueprint soft-deny rule uses `context has "approved_context"`. On deploy:
- Agent-side `PolicyEngine.__init__` parses the rule successfully, and the engine loads normally.
- `CreateTaskFn` on the Lambda side calls cedar-wasm `policyToJson()`, which throws `ParseError: unknown operator 'has' at line 3`.
- A user submits a task against that repo. `CreateTaskFn` crashes mid-validation. The error message is "500 Internal Server Error" (because the Lambda didn't handle the upstream parse error gracefully).
- Users cannot submit any task on the affected repo until someone notices.

With the parity contract, the CI build of that bump runs the parity test, which loads a fixture that uses `context has`. The cedar-wasm side throws, the test fails, and CI is red. The engineer sees the failure BEFORE deploying, pins both engines to the same minor, and files an upstream ticket to track the cedar-wasm feature gap. Users never experience the broken deploy. The parity contract caught a class of bug that unit tests can't, because unit tests test each engine in isolation. Version pinning alone would not have helped. The engineer had to notice the version mismatch manually, and humans miss things during dependency updates. The golden file forces the check.

**Core `cedar-wasm` functions used by the design:**

| Function | Purpose |
|---|---|
| `policySetTextToParts(text: string)` | Split a multi-policy Cedar text into an array of individual policy texts. Returns `{type: "success", policies: string[]}` or `{type: "failure", errors: [...]}` |
| `policyToJson(text: string)` | Parse a single policy text into structured JSON. Returns `{type: "success", json: {annotations, effect, principal, action, resource, conditions}}`. Annotations are preserved verbatim under `json.annotations` as a `Record<string, string>` |
| `isAuthorized({principal, action, resource, context, policies: {staticPolicies: string}, entities: []})` | Main authorization call. Entity references are `{type, id}` objects, **not** string literals. Returns `{type, response: {decision, diagnostics: {reason: string[]}}}`. `diagnostics.reason` is the list of matching policy IDs (for example `["policy1", "policy2"]`) for multi-match |

**Minimal annotation-extraction pattern (the only thing `CreateTaskFn` needs for rule validation):**

```typescript
// cdk/src/handlers/shared/cedar-policy.ts (sketch)
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';   // from Lambda layer

export interface ParsedRule {
  ruleId: string;
  tier: 'hard' | 'soft';
  severity?: 'low' | 'medium' | 'high';
  category?: string;
  approvalTimeoutS?: number;
}

export function parseRules(policiesText: string): ParsedRule[] {
  const splitResult = cedar.policySetTextToParts(policiesText);
  if (splitResult.type !== 'success') {
    throw new Error(`Cedar policy parse failed: ${JSON.stringify(splitResult.errors)}`);
  }
  const rules: ParsedRule[] = [];
  for (const policyText of splitResult.policies ?? []) {
    const jsonResult = cedar.policyToJson(policyText);
    if (jsonResult.type !== 'success') continue;
    const annotations = jsonResult.json.annotations ?? {};
    const tier = annotations.tier;
    const ruleId = annotations.rule_id;
    if (tier !== 'hard' && tier !== 'soft') {
      throw new Error(`Missing or invalid @tier annotation on policy (rule_id=${ruleId})`);
    }
    if (!ruleId) {
      throw new Error(`Missing @rule_id annotation on ${tier}-deny policy`);
    }
    rules.push({
      ruleId,
      tier,
      severity: annotations.severity as ParsedRule['severity'],
      category: annotations.category,
      approvalTimeoutS: annotations.approval_timeout_s ? parseInt(annotations.approval_timeout_s, 10) : undefined,
    });
  }
  return rules;
}

export function isHardDenyRule(rules: ParsedRule[], ruleId: string): boolean {
  return rules.some(r => r.ruleId === ruleId && r.tier === 'hard');
}
```

**API differences from Python cedarpy to be aware of during implementation:**

1. Results are always wrapped in `{type: "success" | "failure", ...}`. Always check `.type` before accessing payload.
2. `isAuthorized` takes a single call object (not 3 positional args). Entities are `{type, id}` objects.
3. The Lambda cold-start penalty is ~30ms for the first `require()` (WASM module instantiation). Keep the import at module scope, not inside the handler, so that subsequent invocations reuse the already-instantiated module. The Lambda layer attachment (task #10 in §15.2) ensures the `.wasm` file is loaded once per container init, not per invocation.
4. The Node binding is CJS. The Lambda bundler (esbuild) treats the `.wasm` file as an external asset handled by the layer. No custom esbuild loader is needed.

---

## 16. Implementation notes (carry-forward tasks)

These are items from the design reviews that are not captured above as design changes. Address them during implementation and remove them from this list once completed. They are P1-P2 findings. P0s have been integrated into the main design body.

**IMPL-1** (data-flow P1-5): Scope string normalization. The CLI and Lambda must agree. Document: trim whitespace, preserve case on `tool_type:` (Bash/Read/Write are canonical, reject case-shifted variants).

**IMPL-2** (data-flow P1-7): Dual-write ordering between `progress_writer` and `sse_adapter` is best-effort. The canonical source is TaskEventsTable. Document this in the implementation guide alongside Phase 2.

**IMPL-3** (data-flow P2-1): Catch `ValueError` in `_merge_annotations` on a malformed `@approval_timeout_s`. Skip the annotation and log a WARN. The engine already fails the task at load time if the value is below the floor, so this is a redundant check.

**IMPL-4** (data-flow P2-4): Test constraint: tests MUST NOT assert specific positional Cedar policy IDs. Use `@rule_id` annotations exclusively.

**IMPL-5** (security SA-11 residual): Both the Lambda (audit event) and the agent (milestone) write approval decisions. The Lambda's write is canonical. The agent's is observational. Tests should verify the Lambda write completes even if agent milestone fails.

**IMPL-6** (security P1-8): Audit trail ownership. `ApproveTaskFn` / `DenyTaskFn` write `approval_decision_recorded` to TaskEventsTable directly (not via agent milestone). Implement as part of the Lambda request flow.

**IMPL-7** (security blind-spot #5): PolicyEngine MUST be instantiated per task, NOT per container. Verify in server.py bootstrap that a new instance is created on each task invocation (even when attach-don't-spawn logic reuses the container).

**IMPL-8** (security blind-spot #6): TaskApprovalsTable Streams are confirmed off (§11.2). Do not subscribe any consumer.

**IMPL-9** (functional P1-3): Runtime allowlist revocation. Not shipped in v1. Placeholder: `bgagent revoke-approval <task_id> <scope>` noted in §17.

**IMPL-10** (functional P1-12): `approval_timeout_s` default 300 documented consistently in §3 #6, §7.3 table, §10.2 attribute description.

**IMPL-11** (functional P2-8): The CLI `run.ts` command exists from Phase 1b. `submit.ts` also exists. The `--pre-approve` and `--approval-timeout` flags are added to both.

**IMPL-12** (functional P2-9): Poll cadence in §3 #3 is reconciled. Describe it as "initial 2s for 30s, then 5s" without specific call count math (it varies with timeout_s).

**IMPL-13** (functional FC-5): `bgagent status <task_id> --allowlist` inspects the current in-process allowlist state. It is useful for debugging "why is this tool being gated again?". Low priority. Add it to `bgagent status` if cheap.

**IMPL-14** (functional FC-6): Tool_use_id correlation. The SDK handles it internally. No hook-side changes are needed. Tests should verify that the hook does not echo tool_use_id in its response.

**IMPL-15** (functional FC-9): Recent-decision cache 60s window: tune after observation. The default of 60s is a reasonable starting point.

**IMPL-16** (CLI UX): ULID length is 26 chars, not 33. Update all CLI help text and error messages.

**IMPL-17** (CLI UX): Shell completion (tab-complete task_id + request_id from `bgagent pending`). Deferred. Document in §17.

**IMPL-18** (FC-7): PolicyEngine freezing is implicit (single `__init__` call, no reload path). Add a test: assert that no code path calls `load_policies` after `__init__` completes.

**IMPL-19** (review 2026-05-06 finding #14): Locked decisions table in §3 previously said "22 locked decisions" while the table had 23 rows. The count is corrected to 23. Decision #23 (cross-engine parity contract) formalizes the existing implicit assumption. There is no design change, only an accurate count.

**IMPL-20** (review 2026-05-06 finding #13): Milestone naming: avoid `approval_decided` as an umbrella event. Use the specific outcome names (`approval_granted` / `approval_denied` / `approval_timed_out` / `approval_stranded`). The authoritative audit event from Lambda is `approval_decision_recorded` (not "decided") and remains unique. `approval_decision_recorded` ≠ `approval_decided`. They are distinct events that serve different purposes (Lambda audit versus agent milestone). Implementation should grep to confirm no stale `approval_decided` references exist in code or docs.

**IMPL-21** (review 2026-05-06 finding #16): `bgagent pending` UX at ≥20 pending approvals (pagination, filtering, interactive selector) is future work. The current tree output, with the 60 RPM endpoint rate limit and `approvalGateCap` (decision #13, default 50), keeps the expected pending count well below 20 per user in practice. Track in §17.

**IMPL-22** (review 2026-05-07 gate-cap tightening): Emit telemetry to enable re-evaluation of the `approvalGateCap` default. Required signals:
- CloudWatch metric: `ApprovalGateCount` (per-task histogram, dimension: blueprint_id).
- CloudWatch metric: `ApprovalCapExceededCount` (counter, dimension: blueprint_id + task_outcome_at_time_of_cap). Split by whether the task was trending toward success (≥3 tool_uses since last `approval_denied`, no `guardrail_blocked` events) or appears adversarial (dense retry pattern).
- Dashboard widget: p50/p90/p99 of `ApprovalGateCount` bucketed per blueprint, plus count of tasks exceeding 80% of their configured cap.
- Quarterly review of the default: if any of the re-evaluation criteria in §12.9 hold, propose a new default in a design-doc patch. Without this process, the number 50 will become fixed.
The intent here is to make 50 a **measurable** default, not a frozen one.

**IMPL-23** (review 2026-05-07 cache observability): Recent-decision cache hits MUST emit `policy_decision` events to TaskEventsTable with `decision_source="recent_decision_cache"` (§12.8). Without this, cache-driven denies are invisible in the event stream and cache and restart correlation analysis is impossible. The event carries `{tool_name, tool_input_sha256, cached_decision, original_decision_ts}`, which is enough to reconstruct why the cache fired without persisting the raw input a second time.

**IMPL-24** (review 2026-05-06 timeout adversarial review, Fix 1): Re-read the approval row with `ConsistentRead=True` when `_best_effort_update_status("TIMED_OUT", ... WHERE status = :pending)` returns ConditionCheckFailed. Do NOT proceed with stale local `outcome.status = "TIMED_OUT"`. If the re-read returns APPROVED, honor it (rebuild outcome, preserve scope/decided_by/decided_at, run normal allow flow, emit `approval_late_win`). If DENIED, honor that. If still PENDING or row gone, fall through with TIMED_OUT (fail-closed). See §6.5 pseudocode, §13.12 VM-throttle + late-approval race, §14.6 trace, and §15.2 task #43 race-test row.

**IMPL-25** (review 2026-05-06 timeout adversarial review, Fix 3): Blueprint loader treats `@approval_timeout_s` below **120s** as ADVISORY: emits a WARN at task-start but ACCEPTS the annotation down to the 30s floor. Below the floor (30s) the loader is STRICT and rejects (existing behavior, unchanged). Rationale: almost no human responds to an approval request in under 2 minutes, so sub-120s is usually a policy-authoring mistake, but there are legitimate exceptions (for example machine-driven CI approvers). A future `bgagent lint-policies` command (§17.14) will show the same WARN before submit so blueprint authors catch the mistake before deploy. See §5.2 annotation reference.

**IMPL-26** (review 2026-05-06 timeout adversarial review, Fix 4): Promote `approval_timeout_capped` from backend-only to user-visible via the live SSE stream and `bgagent watch` (§11.1). Add two new milestones: `approval_timeout_capped_at_submit` (emitted by `CreateTaskFn` when the user's `--approval-timeout` would be clipped by any rule in the blueprint, and returned on the POST `/v1/tasks` response body so the user sees it on submit) and `approval_ceiling_shrinking` (emitted once per task when `maxLifetime_remaining - cleanup_margin < 2 * task_default_timeout_s`, which tells the user why later gates will have small windows). All three events carry `{requested_timeout_s, effective_timeout_s, reason}` with `reason ∈ {rule_annotation, maxLifetime_ceiling, runtime_jwt_ceiling}`. Without these milestones users see only "timeout: 30s" in the approval banner and think the CLI dropped their setting.

**IMPL-27** (review 2026-05-06 timeout adversarial review, Fix 5): The container's AWS API calls authenticate via IAM role (auto-refreshed by the SDK), not a separate user-presented JWT. No Runtime JWT expiry term is required in the ceiling computation for v1 (verified by `grep -rn -iE 'runtime.jwt|jwt.refresh|token_expiry' agent/src/` returning no results, and AgentCore Runtime invocation uses sigv4 via `InvokeAgentRuntimeCommand`, which is also auto-refreshed). If the auth model changes (for example a future design introduces a container-held user JWT for end-to-end caller attribution), the ceiling MUST be extended to `min(1h, maxLifetime_remaining - 120s, runtime_jwt_expiry - 120s)`. Review this IMPL whenever the container's auth shape changes. See §13.13.

**IMPL-28** (review 2026-05-06 timeout adversarial review, Fix 6, updated 2026-05-08 with Chunk 8 Option E architecture): Add three new CloudWatch metrics to `TaskDashboard` in namespace `ABCA/Cedar-HITL` to distinguish between the four failure modes that all appear as "timeout": `ApprovalTimeoutClipRate` (percentage, dimension: `reason`), `ApprovalTimeoutBreakdown` (histogram of `effective_timeout_s` on timed-out approvals, dimension: `rule_id`, and once more without dimensions for the widget), and `ApprovalDecisionLatency` (p50/p90/p99, dimension: `outcome ∈ {approved, denied, timed_out}`). Metrics are published by `ApprovalMetricsPublisherFn`, a dedicated Lambda consumer of `TaskEventsTable` streams that emits CloudWatch EMF on every approval milestone. `TaskEventsTable` remains the single source of truth. The publisher owns the metric schema so future dashboard iterations do not require agent redeploys. Dashboard widget layout: ClipRate + Breakdown side-by-side above DecisionLatency (full row), so that operators can tell whether "timeout" is a policy problem, a sizing problem, a UX problem, or a notification problem. See §11.3.

**IMPL-29** (Chunk 1 spike finding, 2026-05-07): The two Cedar engines expose matching policy IDs under asymmetrically-named fields: `cedarpy` uses `result.diagnostics.reasons` (plural list) while `cedar-wasm` uses `result.response.diagnostics.reason` (singular-named list). Both return the same data (a list of positional policy IDs). The shared policy-parsing library (Chunk 5, `cdk/src/handlers/shared/cedar-policy.ts`) and the agent engine (Chunk 2, `agent/src/policy.py`) must each normalize against their own engine's spelling. The parity fixtures under `contracts/cedar-parity/` are the authoritative test for whether the normalization stays correct across engine upgrades. Do not "fix" this asymmetry inside the engines. Both names are stable upstream APIs and the normalization is cheap.

---

## 17. Future work (not in v1 scope)

These items are tracked for a possible follow-on release but are NOT required for v1 shipment. Items are prioritized by observed usage signal (once v1 ships), not by speculative need.

### 17.1 Multi-user approval

Future: multi-user approval (for example, two of three reviewers must approve for `rule:deploy_prod`). Scope: §9.8 INTERACTIVE_AGENTS.md, Iteration 5.

### 17.2 Per-rule auto-approve on timeout

An `@on_timeout("allow")` annotation was sketched. It is a safety hazard. Revisit if there is demand.

### 17.3 Interactive streaming prompts

This needs UX research first (Phase 2 deferred the same question).

### 17.4 Persistent allowlist across container restarts

Today the allowlist is in-process, and the reconciler fails stranded tasks. A future version could persist it to TaskTable and hydrate on restart. This is not critical, because restarts are rare.

### 17.5 Persistent recent-decision cache

Today the cache is in-process, has a 60s TTL, and is cleared on container restart (§6.2, finding #3). If operational telemetry from v1 shows significant `approval_cap_exceeded` events correlated with container restarts, persist the cache to `TaskApprovalsTable` with a `decision_cache` attribute read at engine load.

### 17.6 Persistent per-minute rate limit

Today the limit is a per-container best-effort counter (§6.5, finding #10), bounded by the persistent per-task `approvalGateCap` (decision #13). If restart amplification becomes significant in practice, promote it to a DDB-persisted counter with a per-minute sliding window.

### 17.7 `bgagent approve --defer`

An escape hatch that means "cancel + release slot". It is clearer than a silent timeout.

### 17.8 Policy hot-reload

Today policies are frozen at task start. A long-running task can't pick up a soft-deny rule added mid-task. This is probably fine, because submission is the authoritative moment.

### 17.9 Severity-based routing

CLI: `bgagent approve --severity high` auto-approves high only and leaves medium and low.

### 17.10 Runtime allowlist revocation

`bgagent revoke-approval <task_id> <scope>`. For the user who realizes "oh wait, I didn't mean to approve ALL Bash". The implementation removes the scope from the in-process allowlist and emits an `approval_revoked` milestone.

### 17.11 Bulk approve

`bgagent approve --all-pending` approves everything pending. A power-user feature. Low priority, but users WILL ask.

### 17.12 Shell completion for task_id / request_id

Tab-complete from `bgagent pending`.

### 17.13 `bgagent pending` pagination and filtering

At ≥20 pending approvals per user the current tree output becomes noisy (§8.5, finding #16). Add `--limit/--offset`, `--severity`, `--task` filters, or an interactive TUI selector when observed pending counts justify the complexity.

### 17.14 Policy linting

`bgagent lint-policies --repo <repo>` validates blueprint Cedar before submission. It catches annotation errors in development instead of at container start.

### 17.15 Richer approval annotations

`@approval_requires_mfa("true")`, `@approval_channel("slack")` for enterprise workflows (step-up auth, audit channel). Good ideas. Deferred.

### 17.16 Cross-task scope inheritance

"Apply the same pre-approvals I used on my last task." A convenience feature.

### 17.17 Soft-fail on `approvalGateCap` exceed (bump-or-cancel)

Today (v1): exceeding `approvalGateCap` force-fails the task (§12.9). All in-progress work (agent reasoning, partial edits, git state) is discarded. This is the simplest terminal circuit breaker and the right default posture, but it's harsh on long-running tasks that hit the cap legitimately (for example a migration that turned out to need 55 soft-deny decisions instead of 50).

Future work: at cap, transition the task to `AWAITING_APPROVAL` with a special event `approval_cap_reached`. Notify the user via all configured channels. The user chooses:
- **Bump.** Raise the session-scoped cap by 50 (or to the blueprint max) and resume. The decision is logged as `approval_cap_bumped` with `new_cap` and `reason`. Capped at the blueprint's `approvalGateCap` hard upper bound (500).
- **Cancel.** Transition to FAILED with reason `"user cancelled after approval-cap reached"`, preserving the reason field for telemetry.
- **Timeout.** If no decision arrives within 24h, transition to FAILED (the same as today's behavior but with a fully audited reason).

This preserves in-progress work for legitimate long-running tasks without weakening the circuit breaker. The user must still make an explicit decision at the cap. Deferred because (a) it adds a new task-state transition, (b) requires new endpoints (`POST /v1/tasks/{id}/bump-cap`), (c) needs UX in the CLI and Slack, and (d) the v1 hard-fail behavior is safer by default. Promote to v1 scope if user feedback shows legitimate tasks frequently hit the cap.

### 17.18 Off-hours escalation mode

An optional blueprint field `security.offHoursEscalation` would configure a pluggable on-call webhook. When it is set, the fan-out Lambda routes `approval_requested` events past the primary Slack/email channel to a tenant-configured escalation webhook (PagerDuty, Opsgenie, custom). This is out of scope for v1 because:

- (a) Escalation-routing semantics depend on each tenant's existing on-call tooling (schedules, rotations, fall-back paths). Building a single escalation policy into the fan-out Lambda would always be wrong for some tenant.
- (b) v1 already delivers the `approval_requested` event to TaskEventsTable Streams. Tenants who need escalation today can subscribe via their own EventBridge rule, filter on `approval_requested`, and dispatch to whatever on-call tool they already use. v1 ships the building blocks. A declarative escalation field is UX polish.

v1 design note: the building blocks exist (§11.2 fan-out plane, §13.14 notification-delivery-failure boundary, §14.8 off-hours trade-off), but the policy does not. A future design patch should specify the blueprint schema, escalation-attempt retry semantics, and how escalation interacts with the timer (it doesn't, the same as §13.14).

### 17.19 `bgagent pending --output json` schema stability

This item is a stability guarantee for the `--output json` schema on `bgagent pending` (and related list endpoints), as a basis for scripted bulk-approve wrappers until native `bgagent approve --all-pending` (§17.11) ships. The contract:

- Additive changes only (new optional fields OK).
- No field removal or rename without a `v` bump in the output envelope.
- The current schema is documented in `cli/src/types.ts` and mirrored in an auto-generated JSON-schema file checked into the CLI repo so consumers can codegen against it.
- Changes to the schema require an entry in `CHANGELOG.md` under a dedicated `cli:json-output` section.

Users who ship their own bulk-approve scripts get a stable contract. The project gets a testable promise, so that integrations don't silently break on a CLI upgrade. This is lightweight, with no new endpoints and no new Lambdas. It is tracked here (not in v1) because the guarantee has not yet been exercised by real scripted consumers. The shape will be settled after v1 ships and users start writing wrappers.

---

## Appendix A — Key file change map

See §15.2. Net new files: ~15. Net modified files: ~15. Total LOC estimate: ~4000 production + ~2500 test = ~6500 lines. This is larger than Phase 2 (+2950 / -34) because of the 4 new Lambdas (adding `get-pending.ts`), the discovery endpoint, the shared parser, the state machine and reconciler updates, the Slack mapping table, the cross-engine parity fixtures, and the cedar-wasm Lambda layer.

## Appendix B — Review checklist (pre-merge)

- [ ] Day-1 cedarpy spike run. Annotation round-trip confirmed
- [ ] All 5 Cedar annotations parse + recover via `policies_to_json_str()` round-trip test
- [ ] Cross-engine parity golden-file test present in both `agent/tests/test_cedar_parity.py` AND `cdk/test/handlers/shared/cedar-parity.test.ts` (finding #1, decision #23)
- [ ] cedarpy + cedar-wasm versions pinned EXACTLY (no `^`/`~`) in `agent/pyproject.toml` + `cdk/package.json`
- [ ] cedar-wasm packaged as Lambda layer (not per-Lambda bundled). Each policy Lambda has ≥ 512 MB memory. The concurrent-burst memory test passes (finding #5)
- [ ] Every hard-deny rule has `@tier("hard")` + `@rule_id`
- [ ] Every soft-deny rule has `@tier("soft")` + `@rule_id` + `@severity` (default medium if missing)
- [ ] `@rule_id` uniqueness enforced at engine load (fail-on-error, not fall-back)
- [ ] `@approval_timeout_s < 30` rejected at load
- [ ] Blueprint `disable:` list rejects any built-in hard-deny rule_id at task start (finding #9)
- [ ] Blueprint combined `cedar_policies` text > 64 KB rejected at task start AND at submit (finding #12)
- [ ] `initial_approvals` re-validated at container start. `rule:<id>` drift fails HYDRATING with a clear error (finding #11)
- [ ] Atomic cross-table `TransactWriteItems` for approval-request creation, ApproveTaskFn, DenyTaskFn, and resume transitions (findings #7, #12 of decisions)
- [ ] Ownership encoded in ConditionExpression on ApproveTaskFn / DenyTaskFn, with `user_id` == Cognito `sub` compared **verbatim** (finding #6). A unit test enforces byte-for-byte equality
- [ ] Scope validation: rejects `rule:<hard_deny_id>`, degenerate patterns, blueprint-maxPreApprovalScope violations
- [ ] `write_path:` / `bash_pattern:` fnmatch semantics documented as Cedar-`like` superset. Uppercase-in-glob emits a WARN in the CLI (finding #15)
- [ ] ANSI/control-char stripping in `tool_input_preview` (both layers)
- [ ] `output_scanner.scan` runs in DenyTaskFn before persisting `reason`. A truncated sanitized copy is propagated as `permissionDecisionReason` (finding #2 guaranteed surface)
- [ ] Recent-decision cache blocks 60s retries. Session-scoped with a documented restart caveat (finding #3)
- [ ] Per-task `approvalGateCap` (default 50, blueprint-configurable, validated 1 ≤ N ≤ 500, persisted on TaskTable) + per-minute rate limit (20, per-container best-effort) + per-user notification cap (10/min) + `/v1/pending` rate limit (60 RPM/user) + recent-decision cache 50-entry LRU (decoupled from `approvalGateCap`)
- [ ] `user_id-status-index` GSI on TaskApprovalsTable ships in v1 backing `GET /v1/pending` (finding #8)
- [ ] Denial injection via Stop hook `between_turns_hooks` registered AFTER `_nudge_between_turns_hook` AFTER `_cancel_between_turns_hook`. This preserves cancel-wins. Denial injection is best-effort on cancelled tasks (finding #2). `permissionDecisionReason` carries the guaranteed surface
- [ ] Stranded-task reconciler transitions AWAITING_APPROVAL > 2×timeout_s to FAILED
- [ ] Race tests pass: approve+timeout, deny+timeout, double-approve, cancel-during-awaiting (agent-side), cancel-during-approve (Lambda-side, cross-table transaction catches it, finding #7), cancel-during-deny (denial between-turns pre-empted, fallback reason delivered, finding #2), late-approval-after-TIMED_OUT
- [ ] SlackUserMappingTable write path requires the Cognito OAuth flow. An admin has no bulk-write API. Slack approvals are capped at `severity: low|medium` (finding #4)
- [ ] Milestone naming consistent: `approval_requested → approval_granted|denied|timed_out|stranded`. No `approval_decided` umbrella event. `approval_decision_recorded` is reserved for the Lambda audit (finding #13)
- [ ] Locked-decisions table in §3 has exactly 23 rows and prose says "23" (finding #14)
- [ ] E2E on `backgroundagent-dev`: Scenarios A-E, both runtime paths
- [ ] `bgagent pending` + `bgagent policies list` functional
- [ ] Dashboard widgets emitting all approval-* metrics
- [ ] `bgagent status <task_id> --allowlist` (if IMPL-13 shipped)
- [ ] Built-in starter soft-deny set loaded (5 rules: force_push_any, force_push_main, push_to_protected_branch, write_env_files, write_credentials)
- [ ] No feature flag. Cedar-HITL is standard functionality. `--pre-approve all_session --yes` is the opt-out
- [ ] Backward compat: Phase 1a/1b tests pass without modification
- [ ] ULID length references are 26 chars throughout CLI + docs
- [ ] **Re-read approval row on TIMED_OUT ConditionCheckFailed (IMPL-24)**: `_best_effort_update_status("TIMED_OUT")` failure path re-reads with ConsistentRead and honors APPROVED/DENIED if the user's decision beat the agent's timer. It emits the `approval_late_win` milestone. See §6.5 pseudocode, §13.12 VM-throttle race, §14.6 trace, §15.2 task #43.
- [ ] **Default `--approval-timeout` is 300s** documented consistently in decision #6, §5.2, §7.3 field table, §8.2 CLI flags, and §10.2 TaskTable schema.
- [ ] **Sub-120s `@approval_timeout_s` emits WARN (IMPL-25)** at blueprint load. Sub-30s is still rejected. `bgagent lint-policies` (§17.14) shows the same WARN before submit.
- [ ] **User-visible timeout milestones (IMPL-26)**: `approval_timeout_capped` (per-gate, on SSE stream), `approval_timeout_capped_at_submit` (on `POST /v1/tasks` response), `approval_ceiling_shrinking` (once per task at lifetime threshold). All carry `{requested_timeout_s, effective_timeout_s, reason}`.
- [ ] **Runtime JWT ceiling (IMPL-27)**: no separate JWT expiry term is required in v1, because the container uses auto-refreshed IAM credentials (verified by grep of `agent/src/`). Ceiling stays `min(1h, maxLifetime_remaining - cleanup_margin)`. Review if container auth shape changes (see §13.13).
- [ ] **Timeout-tuning metrics (IMPL-28)**: `ApprovalTimeoutClipRate` (dim: reason, with an `unknown` bucket), `ApprovalTimeoutBreakdown` (p50/p90/p99 on `TimedOutEffectiveTimeout`, dim: `rule_id` with allowlist + `other`/`none` collapse, and also published without dimensions, which is what the widget reads), `ApprovalDecisionLatency` (p50/p90/p99 on `ApprovalDecisionLatencyMs`, dim: outcome) wired into `TaskDashboard`. Native CloudWatch metrics in namespace `ABCA/Cedar-HITL`, published by `ApprovalMetricsPublisherFn` (consumer #2 of `TaskEventsTable` streams). Heartbeat + skip meta-metrics for observability-of-observability. See §11.3.
- [ ] **Off-hours trade-off documented (§14.8)**: overnight and unattended task failure modes stated explicitly. Notification plane responsibility boundary stated. `--pre-approve all_session --yes` and tenant-side escalation hooks noted as the only workarounds.
- [ ] **Notification delivery failure does NOT pause timer (§13.14)**: bypass-prevention rationale documented. The `bgagent pending` GSI-backed path is confirmed independent of the notification plane.
- [ ] Off-hours escalation noted in §17.18 as future work (not v1). The `bgagent pending --output json` stability guarantee is noted in §17.19.

---

*End of Cedar HITL design doc, rev 5.*
