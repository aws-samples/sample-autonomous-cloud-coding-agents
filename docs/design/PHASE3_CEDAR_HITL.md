# Phase 3 — Cedar-driven HITL Approval Gates

> **Status:** Detailed design, pre-implementation.
> **Companion:** [`INTERACTIVE_AGENTS.md`](./INTERACTIVE_AGENTS.md) §5.6 (CLI commands), §8.2 (state machine).
> **Visual:** [`../diagrams/phase3-cedar-hitl.drawio`](../diagrams/phase3-cedar-hitl.drawio).
> **Rev:** 3 (2026-04-29 — hard-gate-only v1; notification-plane UX).
> **Implementation:** not started.

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
11. [Observability](#11-observability)
12. [Security model](#12-security-model)
13. [Failure modes + fail-closed posture](#13-failure-modes--fail-closed-posture)
14. [Sample scenarios](#14-sample-scenarios)
15. [Implementation plan](#15-implementation-plan)
16. [Implementation notes (carry-forward tasks)](#16-implementation-notes-carry-forward-tasks)
17. [Deferred / out of scope](#17-deferred--out-of-scope)

---

## 1. What we are building, in one paragraph

When the agent is about to call a tool (Bash, Write, Edit, WebFetch, etc.), our Cedar policy engine decides **Allow** or **Deny**. Phase 3 adds a third outcome — **Require-approval** — that pauses the tool call, writes an approval request to a DynamoDB table **atomically with the task state transition**, dispatches a notification through the fan-out plane (Slack with action buttons, email, GitHub issue comment), and awaits a human response via a new REST endpoint + CLI command. The agent polls DynamoDB for the user's decision with strongly-consistent reads; on approval it proceeds, on denial (or timeout) the decision text is injected into the agent's context via the Phase 2 Stop-hook mechanism so the agent adapts rather than spinning. At task-submit time the user can also *pre-approve* scopes (specific tools, bash patterns, rule IDs, path patterns, or `all_session`) so low-risk agents run without any interactive gates. Cedar policies are tagged with a `@tier("hard-gate")` annotation to mark rules that should trigger an approval instead of an absolute deny — the same Cedar language, two policy files, one new outcome.

**v1 ships hard gates only.** The agent pauses indefinitely for a decision (bounded only by the task's `maxLifetime`); on timeout it fail-closed denies with steering. There is no "proceed with default if no response" mode in v1 — see §17 for the deferred `@tier("advise")` semantics that would add non-blocking advisory events post-v1.

---

## 2. The three-outcome model

### Cedar's native model is binary

The [Cedar authorization engine](https://www.cedarpolicy.com/) answers one question per call: given a `(principal, action, resource, context)` tuple, is the action **Allowed**, **Denied**, or **NoDecision** (no policy matched)? Our engine treats `NoDecision` as deny (fail-closed) and returns a boolean `allowed` to callers. That's the baseline Phase 3 extends.

### What we add

We layer a **three-outcome abstraction** on top of Cedar by running **two evaluations per tool call** against two separate policy sets:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  PolicyEngine.evaluate_tool_use(tool_name, tool_input)                   │
│                                                                          │
│  1. Cedar eval against HARD_DENY_POLICIES                                │
│       └─ Deny → return PolicyDecision(outcome=DENY, reason=...)          │
│          Absolute. No allowlist can override.                            │
│                                                                          │
│  2. In-process allowlist fast-path                                       │
│       └─ match → return PolicyDecision(outcome=ALLOW, reason=...)        │
│          Pre-approved (from --pre-approve) or previously approved        │
│          with scope != this_call.                                        │
│                                                                          │
│  2.5. Recent-decision cache (anti-retry-loop)                            │
│       └─ cached DENIED/TIMED_OUT for (tool_name, input_sha) within 60s  │
│          → auto-deny with same reason (prevents re-gate storms)         │
│                                                                          │
│  3. Cedar eval against HARD_GATE_POLICIES                                │
│       └─ Deny → return PolicyDecision(outcome=REQUIRE_APPROVAL,          │
│                                       reason, timeout_s, severity,      │
│                                       matching_rule_ids)                │
│          Human must approve before the tool runs. Agent waits            │
│          indefinitely (bounded by task maxLifetime); timeout             │
│          fail-closed denies with steering.                               │
│                                                                          │
│  4. Default ALLOW                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

Each evaluation is a Cedar call — sub-millisecond. No network hop. No AWS API. The "approval wait" (step 3's downstream handling) is entirely inside our `PreToolUse` hook coroutine.

The SDK never sees `REQUIRE_APPROVAL` — after the wait, our hook returns the SDK's native `{"permissionDecision": "allow" | "deny"}` shape. The three-outcome model is an internal engine abstraction.

### Why two policy sets, not one

Cedar doesn't have a `require_approval` effect. We encode the tiering as a physical split into two policy files (`hard_deny.cedar`, `hard_gate.cedar`), validated by a `@tier("hard-deny" | "hard-gate")` annotation on each rule.

Key properties:

- **Security reviewers can read the hard-deny file alone.** Most review effort lives there because those rules are absolute; hard-gate rules have a human safety net.
- **Rule authors know where a rule lives by which file it's in.** No "forbid-with-marker" patterns that can be accidentally miscategorized.
- **Forward-compatible with a future `@tier("advise")` tier** (see §17) — a third file for non-blocking advisory rules can be added without changing the engine's outer loop.

---

## 3. Design decisions

| # | Decision | Summary |
|---|---|---|
| 1 | **Cedar encoding: two policy sets** | Physical split into `hard_deny.cedar` and `hard_gate.cedar`, validated via `@tier("hard-deny" \| "hard-gate")` annotation. Forward-compatible with a future `@tier("advise")` set (see §17). |
| 2 | **Hook point: extend `PreToolUse`, not `can_use_tool`** | PreToolUse is already async-compatible, already wired to Cedar, and already owns the tool-governance boundary. |
| 3 | **Wait mechanism: DDB strongly-consistent polling, 2s → 5s backoff** | Initial 2s cadence for the first 30s, then 5s. `ConsistentRead=True` so the agent never misses an approval that already landed. Agent waits indefinitely (bounded by `maxLifetime`). |
| 4 | **Scope allowlist: in-process, seeded from persisted `initial_approvals`** | Runtime escalation lives in the `PolicyEngine` instance. Submit-time `--pre-approve` flags persist on TaskTable and seed the allowlist at container startup. Lost on restart (rare; reconciler fails stranded tasks). |
| 5 | **CLI UX: standalone `bgagent approve/deny` + `--pre-approve <scope>` + `bgagent policies list` + `bgagent pending`** | All REST-polling; no streaming prompts. User discovers pending approvals via `pending` or via the fan-out plane (Slack action buttons, email link). |
| 6 | **Timeouts: per-task default + per-rule Cedar annotation override, min wins, bounded floor + ceiling, fail-closed** | Floor: 30s (engine-enforced on both task default and rule annotations). Ceiling: `min(1h, maxLifetime - remaining_cleanup_margin)` — sized so the TTL on the approval row always covers the decision window. On timeout → fail-closed DENY with steering injected as a user turn. Never auto-approve, never proceed-with-default. |
| 7 | **Concurrency slots: AWAITING_APPROVAL holds the slot** | Matches PAUSED semantics. Container is alive, consuming memory. |
| 8 | **Hard-deny is absolute** | No `--pre-approve` scope can bypass it. CreateTaskFn validates and rejects `rule:<hard_deny_rule_id>`. |
| 9 | **Submit-time scope cap: 20 entries, ≤128 chars each** | Keeps audit trail legible, bounds allowlist check cost, limits abuse-vector damage. |
| 10 | **Cedar annotations** | `@rule_id(...)`, `@tier("hard-deny" \| "hard-gate")`, `@approval_timeout_s(...)`, `@severity(...)`, `@category(...)`. Recoverable via `cedarpy.policies_to_json_str()` → JSON. Multi-match merging: min timeout wins (clamped by floor), max severity wins. |
| 11 | **Atomic state transitions via DDB TransactWriteItems** | The approval-request row write and the TaskTable status transition are a single atomic transaction. No partial-failure states. |
| 12 | **Ownership encoded in ConditionExpression, not fetch-then-check** | `ApproveTaskFn` / `DenyTaskFn` put `user_id = :caller` into the ConditionExpression on TaskApprovalsTable. Authorization and state transition are atomic. |
| 13 | **Per-task approval-gate cap: 50, fail-task on exceed** | Prevents denial-loop storms. Matches Phase 2 nudge cap. |
| 14 | **Per-minute approval-creation rate limit: 20/task** | Agent-side throttle independent of per-task lifetime cap. |
| 15 | **Recent-decision cache: deny an identical (tool, input) for 60s after DENIED/TIMED_OUT** | Prevents retry-loop amplification on the same destructive action. |
| 16 | **Denial reason sanitized in the Lambda, before persisting** | `DenyTaskFn` runs `output_scanner` on the reason before writing to DDB. The agent never sees unscanned text. |
| 17 | **`tool_input_preview` stripped of ANSI/control characters at agent-side write + CLI render** | Defense in depth against approver-confusion attacks where a prompt-injected tool input overwrites the CLI prompt with a different command. |
| 18 | **Deny-as-steering injected via Stop hook `between_turns_hooks`, not via `permissionDecisionReason`** | Reuses the validated Phase 2 nudge mechanism. `<user_denial>` XML block wrapped by the same `_xml_escape` utility. |
| 19 | **`rule:` discovery via new endpoint** | `GET /v1/repos/{repo_id}/policies` + `bgagent policies list` surfaces the rule IDs + annotations + whether each rule is hard-deny or hard-gate. Solves the otherwise-undiscoverable `rule:X` pre-approval scope. |
| 20 | **`write_path:<glob>` scope** | Added so users can pre-approve file writes under specific path patterns (e.g., `write_path:docs/**`) without needing to grant all Writes. |
| 21 | **`tool_group:file_write` convenience scope** | Resolves to `{Write, Edit}`. Prevents the surprise of pre-approving `Write` and still getting gated on `Edit`. |
| 22 | **Pre-implementation spike: cedarpy annotation round-trip** | Day 1 of implementation validates that `policies_to_json_str()` returns annotations in the expected shape. If the API has changed, fall back to policy-ID prefix conventions. |
| 23 | **Approval notifications via the fan-out plane** | `approval_required` events flow through `FanOutConsumer` → Slack/email/GitHub dispatchers. Slack messages include `Approve` / `Deny` action buttons that POST to the REST API. No streaming CLI prompts. |

---

## 4. End-to-end request flow

Narrative walk-through of the happy path. Sequence diagrams in [phase3-cedar-hitl.drawio pages 3-6](../diagrams/phase3-cedar-hitl.drawio).

### Setup (task start)

1. User runs `bgagent submit --repo my-org/my-app --task "rebase feature-x onto main and push" --approval-timeout 600 --pre-approve tool_type:Read --pre-approve bash_pattern:"git status*"`.
2. CLI validates each scope string client-side (format, ≤128 chars, cap 20). Rejects invalid syntax without round-trip.
3. CLI POSTs `/v1/tasks` with `{repo, task, initial_approvals: [...], approval_timeout_s: 600}`.
4. `CreateTaskFn` validates `initial_approvals`:
   - max 20 entries, ≤128 chars each
   - rejects `rule:<id>` where `<id>` names a hard-deny rule (resolved via shared policy-parsing library against the repo's blueprint; see §5.4)
   - rejects degenerate `bash_pattern`/`write_path` scopes that match too broadly (see §7.3)
   - honors `Blueprint.security.maxPreApprovalScope` (see §7.3)
   - normalizes scope strings (trim whitespace; case-sensitive as documented)
5. Task persists. `approval_timeout_s` and `initial_approvals` become DDB attributes on the task row.
6. Container spawns on the AgentCore Runtime. `PolicyEngine.__init__` loads:
   - `HARD_DENY_POLICIES` (built-in + repo blueprint's `security.cedarPolicies.hard`)
   - `HARD_GATE_POLICIES` (built-in + repo blueprint's `security.cedarPolicies.hard_gate`)
   - Annotation lookup table: `{policy_id: {annotation: value}}` built from `cedarpy.policies_to_json_str()` once, cached for the task lifetime
   - Rule-ID map: `{rule_id_annotation: policy_id}` to resolve `--pre-approve rule:<rule_id>` → internal Cedar policy ID
   - Allowlist seeded from `initial_approvals`
   - Annotation validation: `@rule_id` uniqueness enforced (duplicate = task fails to start); `@approval_timeout_s` must be integer ≥ 30 (malformed or below floor = task fails to start)
7. Container emits `agent_milestone("pre_approvals_loaded", {count: 2, scopes: ["tool_type:Read", "bash_pattern:git status*"]})` so Terminal A's stream shows the starting posture.
8. Agent begins normal work.

### First approval gate (hard-gate hit)

9. Agent decides to run `Bash(command="git push --force origin feature-x")`.
10. SDK fires `PreToolUse` hook with `tool_name="Bash"`, `tool_input={command: "..."}`.
11. Hook calls `PolicyEngine.evaluate_tool_use`:
    - Hard-deny eval: matches nothing → `allowed=True`
    - Allowlist fast-path: `tool_type:Bash`? no. `bash_pattern` matches `git push --force ...`? `git status*` doesn't match `git push --force ...` → skip
    - Recent-decision cache: no matching `(Bash, sha256(input))` in cache → skip
    - Hard-gate eval: policy `push_to_protected_branch` matches. `diagnostics.reasons == ["policy1"]`. Lookup: `policy1` → annotations `{rule_id: "push_to_protected_branch", approval_timeout_s: "300", severity: "medium"}`.
    - Returns `PolicyDecision(outcome=REQUIRE_APPROVAL, reason="Cedar hard-gate: push_to_protected_branch", timeout_s=300, severity="medium", matching_rule_ids=["push_to_protected_branch"])`.

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
    If `maxLifetime_remaining_s - CLEANUP_MARGIN_120S < FLOOR_30S`, hook returns DENY immediately with reason `"insufficient lifetime for approval"` (§13.7).

12. Hook checks per-task approval-gate cap (50) and per-minute rate limit (20/task). If either exceeded → DENY with reason `"approval-gate cap exceeded"` (fail-closed).
13. Hook mints `request_id = _ulid()` (26-char ULID).
14. Hook builds the approval row payload:
    ```python
    row = {
      "task_id": "01KPW...",
      "request_id": "01KPR...",
      "tool_name": "Bash",
      "tool_input_preview": strip_ansi("git push --force origin feature-x")[:256],
      "tool_input_sha256": "abc123...",
      "reason": "Cedar hard-gate: push_to_protected_branch",
      "severity": "medium",
      "matching_rule_ids": ["push_to_protected_branch"],        # list, not set — supports empty
      "status": "PENDING",
      "created_at": "2026-04-23T14:00:00Z",
      "timeout_s": 300,
      "ttl": 1734567890,  # created_at + timeout_s + CLEANUP_MARGIN_120S; always covers the decision window
      "user_id": "...",
      "repo": "my-org/my-app"
    }
    ```
15. **Atomic transition** — hook issues `TransactWriteItems` with two operations:
    - Put on `TaskApprovalsTable` (new row with status=PENDING)
    - ConditionalUpdate on `TaskTable`: `status = :awaiting, awaiting_approval_request_id = :rid WHERE status = :running`
    Both succeed or both fail. On `TransactionCanceledException` (most likely the TaskTable condition fails because another process moved the status), the hook emits `approval_write_failed` and returns DENY.
16. Hook emits `agent_milestone("approval_requested", {...})` to both `ProgressWriter` (DDB audit) and `sse_adapter` (live stream). Best-effort emission — transactional write has already committed; milestone failure is observability degradation, not state degradation.
17. Terminal A stream renders:
    ```
    [14:00:00]  ★ approval_requested: Bash "git push --force origin feature-x" (medium)
                reason: Cedar hard-gate: push_to_protected_branch
                bgagent approve <task_id> 01KPR... [--scope ...]
                bgagent deny <task_id> 01KPR... [--reason "..."]
                timeout 300s
    ```
    Severity colors the line (respecting `NO_COLOR` env var).
18. Hook enters poll loop with strongly-consistent reads:
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
19. The approval CAP and local-timeout paths ALWAYS attempt to write the row to TIMED_OUT (best-effort conditional update `status = :pending`) before returning. This prevents orphan PENDING rows when the agent bails internally.

### User responds

20. User in Terminal B runs `bgagent approve <task_id> <req_id> --scope tool_type_session`.
21. CLI validates scope syntax client-side.
22. CLI POSTs `/v1/tasks/{task_id}/approve` with `{request_id, decision: "approve", scope: "tool_type_session"}`.
23. `ApproveTaskFn`:
    - Validates Cognito JWT, extracts `sub` as `caller_user_id`.
    - Single `UpdateItem` on `TaskApprovalsTable` with compound ConditionExpression:
      ```
      #status = :pending AND user_id = :caller AND task_id = :task_id
      ```
      If all three conditions hold → atomic flip to APPROVED. Ownership + state + existence check in a single call. No TOCTOU.
    - On `ConditionalCheckFailedException` with `ReturnValuesOnConditionCheckFailure=ALL_OLD`: distinguishes between (a) row missing (404 `REQUEST_NOT_FOUND`), (b) wrong user (404 `REQUEST_NOT_FOUND` — don't leak existence), (c) wrong status (409 `REQUEST_ALREADY_DECIDED`).
    - Records audit event to TaskEventsTable directly (`approval_decision_recorded`) so the 90-day audit trail is owned by the Lambda, not dependent on agent milestones.
    - Returns 202 `{task_id, request_id, status: "APPROVED", scope, decided_at}` or error.
24. Agent's poll reads the `APPROVED` row on next tick (within 2-5s).
25. Hook executes decision in this order:
    - a. **Atomic resume transition**: `TransactWriteItems` — TaskTable `status = :running, REMOVE awaiting_approval_request_id WHERE status = :awaiting AND awaiting_approval_request_id = :rid`. If this fails (likely because user cancelled during the poll gap), hook skips allowlist mutation and returns DENY with reason `"task no longer awaiting approval"`.
    - b. **Allowlist mutation** (only if `scope != "this_call"`): `PolicyEngine._allowlist.add(scope)`. Synchronously logged.
    - c. **Milestone emission** (best-effort): `approval_granted` to both writers.
    - d. **Return to SDK**: `{"permissionDecision": "allow"}`.
26. SDK runs the tool. Stream shows:
    ```
    [14:00:12]  ★ approval_granted: request_id=01KPR... scope=tool_type_session
    [14:00:12]  ▶ Bash: git push --force origin feature-x
    [14:00:14]  ◀ Bash: remote: Force pushed. New SHA abc123.
    ```

### Continuation

27. Agent continues with its turn, hits another `Bash` call (say `git log --oneline -5`).
28. PreToolUse hook → PolicyEngine.evaluate_tool_use:
    - Hard-deny: no match
    - Allowlist: `tool_type:Bash` ← matches. Returns ALLOW fast-path.
29. No new approval request. Tool runs immediately.
30. Eventually agent reaches task completion, opens PR, writes memory, task → `COMPLETED`.

### Denial with steering text

If instead the user runs `bgagent deny <task_id> <req_id> --reason "use --force-with-lease instead"`:
- `DenyTaskFn` runs `output_scanner.scan(reason)` to redact any accidental secrets/PII from the reason **before** writing it to DDB.
- Flips row to DENIED with sanitized reason, atomic ownership check.
- Agent's poll reads DENIED row.
- Hook execution order:
  - a. Atomic resume transition to RUNNING (same as approve path).
  - b. **Inject denial into agent context** via the Phase 2 `between_turns_hooks` registry. The hook appends a synthetic `<user_denial nudge_id="..." timestamp="..." request_id="...">sanitized reason</user_denial>` block to the next Stop-seam injection. This reuses the validated nudge mechanism (§5 below) — the agent sees the denial as authoritative context on its next turn boundary.
  - c. Milestone emission: `approval_denied`.
  - d. Return to SDK: `{"permissionDecision": "deny", "permissionDecisionReason": "User denied — see next-turn context for reason"}`. The SDK's denial text is a terse fallback; the steering text arrives via the robust Stop-hook injection, not via `permissionDecisionReason`.

Why this dual path: the Claude Agent SDK's `permissionDecisionReason` reaches the model as a tool-call-rejected system hint, which the model treats as a reason-to-retry-differently signal but is NOT the guaranteed steering surface the Phase 2 nudge pattern uses. By layering the denial as a between-turns user message, we guarantee the steering text becomes authoritative context. The `permissionDecisionReason` remains there as belt-and-suspenders for model versions that don't emit a Stop between the rejected tool call and the next turn.

---

## 5. Cedar policy authoring guide

### 5.1 Policy file layout

Two physical files, each with exactly one tier:

- `agent/policies/hard_deny.cedar` — contains ONLY `@tier("hard-deny")` policies
- `agent/policies/hard_gate.cedar` — contains ONLY `@tier("hard-gate")` policies

Per-repo customization lives in `blueprint.yaml`:

```yaml
security:
  cedarPolicies:
    hard_deny: |
      @tier("hard-deny")
      @rule_id("block_prod_writes")
      forbid (principal, action == Agent::Action::"write_file", resource)
        when { context.file_path like "prod/**" };
    hard_gate: |
      @tier("hard-gate")
      @rule_id("deploy_staging")
      @approval_timeout_s("900")
      @severity("high")
      @category("destructive")
      forbid (principal, action == Agent::Action::"execute_bash", resource)
        when { context.command like "*terraform apply*" };
  maxPreApprovalScope: "tool_type_session"   # optional; caps what --pre-approve can grant
```

`PolicyEngine.__init__` concatenates built-in + blueprint rules per tier, validates with a probe `cedarpy.is_authorized()` call. **Any** of the following cause task-start failure (not silent-fallback):
- Malformed policy syntax
- Duplicate `@rule_id` values across tiers
- `@approval_timeout_s` below floor (30s) or non-integer
- `@tier` value mismatches the file section (rules whose @tier disagrees with the file they live in)
- Missing `@rule_id` on a hard-gate rule

Fail-on-error is the right posture for blueprint misconfiguration — silent-fallback would let broken policies slip into production.

### 5.2 Annotation reference

| Annotation | Required? | Values | Purpose |
|---|---|---|---|
| `@rule_id("...")` | **Yes on hard-gate**, recommended on hard-deny | Kebab-case or snake_case identifier, unique across both tiers | Stable ID for `--pre-approve rule:X`, for audit trail, and for the `bgagent policies` discovery endpoint. `PolicyEngine.__init__` raises on duplicates. |
| `@tier("hard-deny"\|"hard-gate")` | **Yes** | Exactly one of "hard-deny" or "hard-gate" | Validates policy is in the correct file/section. Engine rejects mismatch at load time. |
| `@approval_timeout_s("N")` | No | Integer seconds ≥ 30 | Per-rule timeout. If absent, uses task default. Has no effect on hard-deny rules. Values below the floor are rejected at load time. |
| `@severity("low"\|"medium"\|"high")` | No | One of the three | Shown in CLI approval prompt, colored by severity. Default: "medium". |
| `@category("...")` | No | "destructive", "network", "filesystem", "auth", or free-form | UX grouping. CLI could filter approvals by category. Not enforced. |

### 5.3 Common policy patterns

**Block absolute dangers** (hard-deny):
```cedar
@tier("hard-deny")
@rule_id("rm_slash")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*rm -rf /*" };

@tier("hard-deny")
@rule_id("write_git_internals")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like ".git/*" };

@tier("hard-deny")
@rule_id("write_git_internals_nested")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*/.git/*" };

@tier("hard-deny")
@rule_id("drop_table")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*DROP TABLE*" };
```

**Absolute deny on destructive git ops** (hard-deny — part of the built-in starter set):
```cedar
@tier("hard-deny")
@rule_id("force_push_main")
@severity("high")
@category("destructive")
forbid (principal, action == Agent::Action::"execute_bash", resource)
  when { context.command like "*git push --force origin main*"
      || context.command like "*git push --force origin prod*"
      || context.command like "*git push -f origin main*"
      || context.command like "*git push -f origin prod*" };
```

Force-pushing to `main` or `prod` is the canonical "you almost certainly don't want this" action. Absolute deny; not bypassable via `--pre-approve`. A repo that legitimately needs this (release automation) adds an override in its blueprint and removes this rule from the policy set.

**Gate non-force pushes to protected branches** (hard-gate — part of the built-in starter set):
```cedar
@tier("hard-gate")
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

A non-force push to a protected branch gates — catches the case where an agent tries to push directly rather than opening a PR. Low frequency, high impact → worth waiting for a human.

**Absolute deny on credential writes** (hard-deny — part of the built-in starter set):
```cedar
@tier("hard-deny")
@rule_id("write_credentials")
@severity("high")
@category("auth")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*credentials*" };
```

Writing a file with "credentials" in the path is a strong signal of accidental secret persistence. Absolute deny.

**Gate `.env` writes** (hard-gate — part of the built-in starter set):
```cedar
@tier("hard-gate")
@rule_id("write_env_files")
@approval_timeout_s("600")
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*.env" };
```

`.env` writes are plausibly intentional (template scaffolding, `.env.example` generation) but high-impact enough to warrant a human decision.

**Optional patterns (not shipped by default — copy into your blueprint if your repo needs them):**
```cedar
// Gate writes under a conventional infrastructure/ directory. Not in the
// built-in set because the "infrastructure/" path is a repo convention,
// not a standard — many repos use cdk/, terraform/, deploy/, etc. Add to
// your blueprint if your repo uses this layout.
// @tier("hard-gate")
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
// @tier("hard-gate")
// @rule_id("webfetch_any")
// @approval_timeout_s("300")
// @severity("medium")
// @category("network")
// forbid (principal, action == Agent::Action::"invoke_tool",
//         resource == Agent::Tool::"WebFetch");

// Gate writes to specific CI config. Example — tune paths per repo.
// @tier("hard-gate")
// @rule_id("write_github_workflows")
// @approval_timeout_s("600")
// @severity("high")
// @category("filesystem")
// forbid (principal, action == Agent::Action::"write_file", resource)
//   when { context.file_path like ".github/workflows/*" };
```

Per the sentinel trick (see §6.2), `invoke_tool` matches on the real tool-name UID. The other actions (`write_file`, `execute_bash`) use a sentinel UID with the real value in `context`.

### 5.4 Policy discovery — shared parser

Because `CreateTaskFn` needs to validate `rule:<id>` pre-approvals against the target repo's actual policy set, we ship a **shared policy-parsing library** used in both places:

- `cdk/src/handlers/shared/cedar-policy.ts` — thin wrapper around cedarpy's JSON form for TypeScript
- `agent/src/policy.py` — the full engine

Both consume the blueprint's `security.cedarPolicies` section. `CreateTaskFn` loads the target repo's blueprint (via the existing `RepoTable` store), concatenates with the built-in policies, parses via `cedarpy.policies_to_json_str()`, and extracts `rule_id` + `tier` annotations. `--pre-approve rule:X` is validated:
- `X` exists as some rule's `@rule_id` → ok
- `X` refers to a hard-deny rule → 400 at submit time (hard-deny cannot be bypassed)
- `X` refers to a hard-gate rule → ok; passes through

Runtime enforcement is still the authoritative layer. Submit-time validation is a UX guard — any drift between submit-time and runtime-loaded policies (possible if blueprint changes between them) causes the task to fail at container start with a clear error, not silently misbehave.

### 5.5 Gotchas for policy authors

**`like` is glob, not regex.** Only `*` (zero-or-more) and `?` (exactly-one-char) wildcards. If you need regex, write multiple `forbid` rules.

**Case sensitivity.** `like` is case-sensitive. `*rm -rf*` won't match `*Rm -Rf*`. If case-insensitivity matters, write both variants.

**Don't match `resource ==` for user-supplied values.** `Bash` commands and file paths go through the sentinel UID. Always use `context.command` / `context.file_path` in the `when` clause, never `resource == ...`.

**`@rule_id` must be globally unique.** Including across tiers. `PolicyEngine.__init__` raises on duplicates.

**Hard-deny rules shouldn't have `@approval_timeout_s`.** It has no effect. Engine logs WARN but doesn't reject (backward compatibility if someone moves a rule between tiers).

**The default ruleset is shared across all tasks.** Per-task overrides live in the Blueprint and are isolated to tasks on that repo. The engine never allows a task to loosen the default hard-deny set via Blueprint — only add to it.

**`@approval_timeout_s` values below 30 are rejected at load.** There is no way to configure unusably-short approval windows.

---

## 6. Engine implementation

### 6.1 Extended `PolicyDecision` shape

```python
from dataclasses import dataclass
from enum import Enum

class Outcome(str, Enum):
    ALLOW = "allow"
    DENY = "deny"                      # absolute (hard-deny or upstream error or cap-exceeded)
    REQUIRE_APPROVAL = "require_approval"  # hard-gate hit

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

    # STEP 2.5 — Recent-decision cache (anti-retry-loop, 60s TTL)
    cached = self._recent_decisions.get((tool_name, input_sha))
    if cached is not None:
        return PolicyDecision(outcome=Outcome.DENY,
                              reason=f"Recent decision ({cached.decision}) within 60s: {cached.reason}",
                              duration_ms=_elapsed(start))

    # STEP 3 — Hard-gate (require approval)
    gate = self._eval_tier(self._hard_gate_policies, tool_name, tool_input, base_context)
    if gate.decision == "deny":
        # Rule-scope allowlist check happens AFTER hard-gate eval (rule_ids
        # aren't known until Cedar tells us which policies matched)
        if any(rid in self._allowlist._rule_ids for rid in gate.rule_ids):
            return PolicyDecision(outcome=Outcome.ALLOW,
                                  reason=f"Allowlist rule: {gate.rule_ids}",
                                  duration_ms=_elapsed(start))

        annotations = self._merge_annotations(gate.rule_ids)
        return PolicyDecision(
            outcome=Outcome.REQUIRE_APPROVAL,
            reason=f"Hard-gate: {', '.join(annotations['rule_ids'])}",
            timeout_s=annotations["timeout_s"],
            severity=annotations["severity"],
            matching_rule_ids=tuple(annotations["rule_ids"]),
            duration_ms=_elapsed(start),
        )

    # STEP 4 — Default allow
    return PolicyDecision(outcome=Outcome.ALLOW, reason="permitted",
                          duration_ms=_elapsed(start))
```

The recent-decision cache is a simple `dict[(tool_name, input_sha), (decision, reason, inserted_at)]` with a 60-second sliding window. Entries are added by the PreToolUse hook whenever an approval resolves to DENIED or TIMED_OUT — not on APPROVED (we don't want to accidentally auto-deny a tool call the user just approved). Cache is in-process, lost on restart.

### 6.3 Annotation merging

When multiple hard-gate rules match a single tool call:

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

**Rationale for min/max choices**:
- **Timeout → min (above floor)**: multiple rules matching means multiple concerns. Users should have *less* time to decide when stakes are higher. Floor prevents unusable 5s windows.
- **Severity → max**: the most severe concern governs the UX coloring.

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
            if any(fnmatch(cmd, pat) for pat in self._bash_patterns):
                return True
        if tool_name in ("Write", "Edit"):
            path = tool_input.get("file_path", "")
            if any(fnmatch(path, pat) for pat in self._write_path_patterns):
                return True
        # rule_ids matched after hard-gate eval — see evaluate_tool_use
        return False
```

### 6.5 PreToolUse hook changes

Phase 3 PreToolUse hook (compressed for doc; implementation will be richer):

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
    # Cap + rate-limit check.
    if engine.approval_gate_count >= APPROVAL_GATE_CAP_PER_TASK:
        return _deny("approval-gate cap exceeded (50/task)")
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
    # a terminal state (not orphaned PENDING).
    if outcome.status == "TIMED_OUT":
        await _best_effort_update_status(task_id, request_id, "TIMED_OUT",
                                         reason=outcome.reason)

    # ATOMIC: resume TaskTable status RUNNING, conditional on awaiting_approval_request_id matching.
    try:
        await _transact_resume(task_id, request_id)
    except TransactionCanceledException:
        # User cancelled (or some other path) during poll; abandon gracefully.
        _emit("approval_resume_failed", {"request_id": request_id})
        return _deny("task no longer awaiting approval")

    if outcome.status == "APPROVED":
        if outcome.scope and outcome.scope != "this_call":
            engine._allowlist.add(outcome.scope)
        _emit("approval_granted", {"request_id": request_id,
                                   "scope": outcome.scope or "this_call",
                                   "decided_at": outcome.decided_at})
        return _allow()

    # DENIED or TIMED_OUT — cache for 60s + inject denial via Stop hook path.
    engine._recent_decisions.record(
        tool_name, _sha256(_serialize(tool_input)),
        decision="DENIED" if outcome.status == "DENIED" else "TIMED_OUT",
        reason=outcome.reason,
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
    return _deny(f"User {outcome.status.lower()}: see next turn context for details")
```

`engine._queue_denial_injection` appends to a list consumed by a new `_denial_between_turns_hook` — registered alongside `_nudge_between_turns_hook` in the Phase 2 `between_turns_hooks` list. At the next Stop hook fire, the denial is emitted as `<user_denial>…</user_denial>` XML (sanitized via `_xml_escape` from the shared utility introduced with Phase 2).

---

## 7. REST API contract

### 7.1 `POST /v1/tasks/{task_id}/approve`

**Request** (CLI → API Gateway → `ApproveTaskFn`):
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
| 401 | `UNAUTHORIZED` | Missing/invalid JWT | — |
| 404 | `REQUEST_NOT_FOUND` | Row missing OR wrong user (both surfaces 404 to prevent enumeration) | — |
| 409 | `REQUEST_ALREADY_DECIDED` | Status != PENDING | `{error, message, current_status}` |
| 409 | `TASK_NOT_AWAITING_APPROVAL` | Task's current status is not AWAITING_APPROVAL | `{error, message, current_status}` |
| 429 | `RATE_LIMIT_EXCEEDED` | Per-user > 30 approve/min | — |
| 503 | `SERVICE_UNAVAILABLE` | DDB throttled or upstream failure | — |

**Authorization + state + existence check is a single DDB operation**:
```python
response = ddb.update_item(
  TableName=TASK_APPROVALS_TABLE,
  Key={"task_id": task_id, "request_id": request_id},
  UpdateExpression="SET #s = :approved, decided_at = :now, #sc = :scope",
  ConditionExpression="#s = :pending AND user_id = :caller",
  ExpressionAttributeNames={"#s": "status", "#sc": "scope"},
  ExpressionAttributeValues={
      ":approved": "APPROVED", ":pending": "PENDING",
      ":now": now_iso, ":scope": scope, ":caller": cognito_sub,
  },
  ReturnValuesOnConditionCheckFailure="ALL_OLD",
)
```

On `ConditionalCheckFailedException`:
- If `OldImage` is absent → row never existed → 404 `REQUEST_NOT_FOUND`
- If `OldImage.user_id != caller` → 404 (same code, prevent existence oracle)
- If `OldImage.status != "PENDING"` → 409 `REQUEST_ALREADY_DECIDED`

In addition, the Lambda does a separate GetItem on `TaskTable` to check `status == "AWAITING_APPROVAL"` — if the task has already moved (e.g., was cancelled), return 409 `TASK_NOT_AWAITING_APPROVAL` before even attempting the update. This check is belt-and-suspenders; the atomic UpdateItem handles the rest.

After successful update, `ApproveTaskFn` writes an audit event to `TaskEventsTable` (`approval_decision_recorded` event_type), ensuring the 90-day audit trail is owned by the Lambda path — not dependent on the agent's milestone emission.

### 7.2 `POST /v1/tasks/{task_id}/deny`

Identical shape with `decision: "deny"` and optional `reason`:

```json
{
  "request_id": "01KPR...",
  "reason": "use force-with-lease instead; force is too risky"
}
```

`DenyTaskFn`:
1. Auth check (Cognito JWT)
2. Run `output_scanner.scan(reason)` — redacts AWS keys, GitHub PATs, API tokens, etc. from the reason text before persisting
3. Truncate sanitized reason to 2000 chars (matches Phase 2 nudge limit for consistency)
4. Atomic conditional update (same shape as approve)
5. Write audit event to TaskEventsTable

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

`CreateTaskFn` validations:
1. Length cap: ≤20 entries
2. Per-entry length cap: ≤128 chars
3. Scope format parsing: normalized to known shape; leading/trailing whitespace trimmed
4. Scope value validation:
   - `tool_type:X` — X must be in known tool set (Read, Bash, Write, Edit, Glob, Grep, WebFetch, ...)
   - `tool_group:X` — X must be in known group set (currently `file_write`)
   - `bash_pattern:X` — X ≤128 chars; reject if X is degenerate (`*`, `**`, `?*`, or patterns where wildcard-char ratio exceeds 50%) — see §7.4
   - `write_path:X` — same rules as bash_pattern
   - `rule:X` — X must exist in the (built-in + target repo's blueprint) hard-gate policy set per the shared policy-parsing library; hard-deny rule IDs rejected
   - `all_session` — rejected if `Blueprint.security.maxPreApprovalScope` forbids
5. `approval_timeout_s` within `[30, min(3600, maxLifetime - 300)]` — cap at 1 hour OR (maxLifetime - 5min), whichever is smaller. Prevents multi-hour slot-exhaustion attacks and keeps approval windows within the TTL budget.

### 7.4 Degenerate-pattern detection

A pattern is considered degenerate if:
- Length ≤ 2, OR
- Consists only of `*`, `?`, and whitespace, OR
- Ratio of wildcard chars (`*` + `?`) to literal chars exceeds 50%

Degenerate `bash_pattern:` and `write_path:` scopes are rejected at submit with 400 `VALIDATION_ERROR`. Users wanting broad permission must use the explicit `all_session` scope (which is subject to `maxPreApprovalScope` blueprint cap).

### 7.5 `maxPreApprovalScope` ordering

Blueprint's `maxPreApprovalScope` is a partial order:

```
this_call  <  { tool_type_session, tool_group, bash_pattern, write_path, rule }  <  all_session
```

If `maxPreApprovalScope: "tool_type_session"`, `all_session` is rejected. All other scopes pass. Setting it to `"this_call"` (meaningless) is rejected at blueprint load. Blueprint absence defaults to unbounded (except `all_session` requires explicit `--yes` on CLI).

### 7.6 `GET /v1/repos/{repo_id}/policies`

New read-only endpoint for rule discovery and `bgagent policies list`:

**Response** (200):
```json
{
  "repo_id": "my-org/my-app",
  "policies": {
    "hard_deny": [
      {"rule_id": "rm_slash", "category": "destructive",
       "summary": "Reject rm -rf / and similar"},
      {"rule_id": "force_push_main", "category": "destructive",
       "summary": "Reject force-push to main/prod"},
      {"rule_id": "write_credentials", "category": "auth",
       "summary": "Reject writes to paths containing 'credentials'"},
      ...
    ],
    "hard_gate": [
      {"rule_id": "push_to_protected_branch", "severity": "medium",
       "category": "destructive", "approval_timeout_s": 300,
       "summary": "Non-force push to a protected branch"},
      {"rule_id": "write_env_files", "severity": "high",
       "category": "filesystem", "approval_timeout_s": 600,
       "summary": "Write to *.env files"},
      ...
    ]
  }
}
```

Loaded by the Lambda on demand from the target repo's blueprint + built-in policies. `summary` is a human-readable annotation `@summary("...")` if present, else falls back to the first line of the `when` clause rendered as text.

Rate-limited 30/min/user; cached 5min per repo in-Lambda.

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
bgagent policies list --repo <repo_id> [--tier hard-deny|hard-gate] [--output text|json]
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

`--pre-approve-file` reads a YAML/JSON array of scope strings — supports the 20-entry cap without command-line bloat.

### 8.3 Notification UX

Approval requests surface through the fan-out plane (see [`INTERACTIVE_AGENTS.md`](./INTERACTIVE_AGENTS.md) §6) — not through a CLI stream. When the agent emits an `approval_required` event to `TaskEventsTable`, `FanOutConsumer` routes it per the user's notification config:

- **Slack**: posts a message to the configured channel with `Approve` / `Deny` action buttons. Button click invokes an interaction-callback Lambda that writes to `TaskApprovalsTable` via the same path `bgagent approve` uses.
- **Email**: sends a one-line summary with a link that deep-links to the approve/deny REST endpoint (optional authenticated click-through).
- **GitHub issue comment**: appends to the in-place comment that the task is waiting for approval (visible to anyone watching the issue).
- **CLI via `bgagent watch`**: the event shows up in the polling stream as any other event:

```text
[14:00:00]  ★ approval_requested: Bash "git push origin main" (severity=medium)
            reason:   Cedar hard-gate: push_to_protected_branch
            respond:  bgagent approve <task-id> 01KPR... [--scope tool_type_session]
                      bgagent deny    <task-id> 01KPR... [--reason "..."]
            timeout:  300s   (or "bgagent pending" to list all)
```

`bgagent watch` formats the line with severity color (respecting `NO_COLOR`; emits `[HIGH]` prefix when set). No interactive prompt in the watch stream — approval responses are always explicit commands.

**Discovery path.** A user who wasn't watching at all finds pending approvals via:

- `bgagent pending` — lists every open approval across the user's tasks.
- Slack button click — zero commands, one-tap response.
- Inbound from email link → REST API.

### 8.4 Safety UX

When `--pre-approve all_session` is passed without `--yes`:

```bash
$ bgagent submit --task "apply terraform plan" --pre-approve all_session
WARNING: --pre-approve all_session disables Cedar hard-gate approval gates
         for this task. Hard-deny policies (rm -rf /, write to .git/, DROP
         TABLE, etc.) still apply.
         Add --yes to skip this prompt.
Continue? [y/N]
```

Hard-deny enforcement is clearly called out so users don't mistake `all_session` for root.

### 8.5 `bgagent pending` output

```text
Pending approvals (3):

  01KPW0...(task) / 01KPR0...(request)
  ├─ Bash: git push --force origin feature-x
  ├─ severity: high
  ├─ reason: Cedar hard-gate: push_to_protected_branch
  ├─ timeout: 4m 32s remaining
  └─ approve|deny

  01KPW1.../01KPR1...
  ├─ Write: /workspace/.../src/.env
  ├─ severity: high
  ├─ timeout: 9m 12s remaining
  ...
```

Picking one (`bgagent approve` or `bgagent deny` with the listed IDs) is straightforward. Shell completion (tab-complete task_id + request_id from `bgagent pending` output) is a Phase 3b enhancement.

---

## 9. State machine + concurrency

### 9.1 New state: AWAITING_APPROVAL

Transitions added (extending §7 of INTERACTIVE_AGENTS.md):

```
RUNNING → AWAITING_APPROVAL  (on REQUIRE_APPROVAL; via TransactWriteItems)
AWAITING_APPROVAL → RUNNING  (on approve OR deny OR timeout; via TransactWriteItems)
AWAITING_APPROVAL → CANCELLED (on explicit `bgagent cancel`)
AWAITING_APPROVAL → FAILED   (on reconciler detecting stranded approval; new edge)
HYDRATING → AWAITING_APPROVAL  (if a hard-gate gate fires during hydration; rare but possible)
```

No direct `AWAITING_APPROVAL → COMPLETED/FINALIZING` without RUNNING in between.

### 9.2 Orchestrator impact

- `waitStrategy` adds `AWAITING_APPROVAL` as non-terminal.
- `finalizeTask` recognizes `AWAITING_APPROVAL`.
- `ACTIVE_STATUSES` (used by `GET /tasks?status=active` and `reconcile-concurrency.ts`) gains `AWAITING_APPROVAL`.
- `task_state.py::write_terminal` condition expression accepts `AWAITING_APPROVAL` as a valid source state.

### 9.3 Concurrency slot semantics

**AWAITING_APPROVAL holds the user's concurrency slot.**

Rationale: the Docker container is alive. Memory allocated. The AgentCore microVM pool is committed. Releasing the slot while the resource is still held lies to accounting and opens a resource-exhaustion vector.

Concrete behavior:

```text
Bob's per-user cap: 10.
t=0:    Bob submits 10 tasks. count=10. 11th submit → 429.
t=2m:   Task #1 → AWAITING_APPROVAL. count still 10.
        Bob's 12th submit → 429. He must approve, cancel, or wait.
t=30m:  Bob approves task #1. task → RUNNING. count still 10.
t=45m:  Task #1 completes. count → 9. Bob can submit task #11.
```

### 9.4 `maxLifetime` clock does not pause

AgentCore Runtime's `maxLifetime = 28800s` (8h) is an absolute timer from session start. It does NOT pause during `AWAITING_APPROVAL`.

This has a concrete implication: the hook computes an `effective_timeout` bounded by `maxLifetime - remaining - CLEANUP_MARGIN_120S`. If the task has been running 7h55m and hits a hard-gate gate, the effective timeout might be clamped to a much shorter value than the task default. Below the 30s floor → immediate DENY with reason `"insufficient lifetime"`.

### 9.5 Stranded-approval reconciliation

`reconcile-stranded-tasks.ts` gains an AWAITING_APPROVAL-aware branch:

- Detects tasks in AWAITING_APPROVAL with `age > 2 * timeout_s`
- Best-effort conditional-updates TaskApprovalsTable row → `STRANDED` status
- Transitions TaskTable → `FAILED` with reason `"approval stranded (container eviction)"`
- Emits `approval_stranded` event to TaskEventsTable

This closes the Phase 3a container-eviction gap. Without this, a container restart mid-approval would leave the task hanging until the user manually cancelled.

`reconcile-concurrency.ts` (scheduled every 5 min) already scans for orphaned concurrency counters; with `AWAITING_APPROVAL` added to `ACTIVE_STATUSES` it correctly counts awaiting tasks as active.

### 9.6 Attended vs unattended mode

The design assumes a human is watching. For truly unattended tasks (scheduled automation, cron-driven runs) the `--pre-approve all_session` path skips hard-gate entirely. No additional mode flag needed — the set of scopes in `initial_approvals` dictates the attendance expectation.

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
```

Attributes:

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | S | Yes | PK; ULID matching TaskTable |
| `request_id` | S | Yes | SK; ULID minted by agent |
| `tool_name` | S | Yes | "Bash", "Write", etc. |
| `tool_input_preview` | S | Yes | First 256 chars of serialized tool input, ANSI/control-stripped |
| `tool_input_sha256` | S | Yes | Full-input hash for audit + recent-decision cache |
| `reason` | S | Yes | Cedar matching rule description |
| `severity` | S | Yes | "low" \| "medium" \| "high" |
| `matching_rule_ids` | L | Yes | List (not Set — can be empty) of hard-gate rule IDs |
| `status` | S | Yes | PENDING \| APPROVED \| DENIED \| TIMED_OUT \| STRANDED |
| `created_at` | S | Yes | ISO8601 |
| `decided_at` | S | No | Set when status != PENDING |
| `scope` | S | No | Set on APPROVED |
| `deny_reason` | S | No | Set on DENIED; sanitized user text |
| `timeout_s` | N | Yes | Resolved timeout for audit |
| `ttl` | N | Yes | `created_at_epoch + timeout_s + CLEANUP_MARGIN_120S` — always covers the decision window |
| `user_id` | S | Yes | Used in ownership check `ConditionExpression` |
| `repo` | S | Yes | Denormalized for fan-out |

**TTL sizing**: the TTL is always `timeout_s + 120s`, so a 300s approval window has a 420s TTL, a 3600s window has a 3720s TTL. The row never expires during the decision window. After the decision + a short grace period, DDB's eventual-consistency TTL reaper cleans up.

**Why a list, not a StringSet, for `matching_rule_ids`**: DDB string sets cannot be empty. Pathological no-match hard-gate hits would fail to persist. Lists handle empty gracefully.

**Why no GSI in v1**: query pattern is always `(task_id, request_id)` for agent polls; the `bgagent pending` listing is implemented as a Scan with FilterExpression `user_id = :caller AND status = :pending` — acceptable at current scale. When pending-approval volume grows, add a GSI on `user_id`.

### 10.2 `TaskTable` additions

Four new attributes on the existing task row:

| Name | Type | Required | Description |
|---|---|---|---|
| `approval_timeout_s` | N | No | Default timeout for hard-gate gates. Default 300. |
| `initial_approvals` | L | No | List of scope strings from submit time |
| `awaiting_approval_request_id` | S | No | Set when status = AWAITING_APPROVAL; cleared on transition back (via joint `UpdateExpression`) |
| `approval_gate_count` | N | No | Running counter of approval gates fired on this task; used to enforce the 50-gate cap |

Joint updates on AWAITING_APPROVAL transitions always set/clear `awaiting_approval_request_id` in the same `UpdateExpression` as the status change — either within the TransactWriteItems Put+Update, or in the single UpdateItem on resume.

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

## 11. Observability

### 11.1 New `agent_milestone` event types

Emitted to both `ProgressWriter` (DDB, 90d) and `sse_adapter` (live stream). Plus audit events emitted by the REST Lambdas directly to TaskEventsTable.

| Event | Source | Metadata |
|---|---|---|
| `pre_approvals_loaded` | Agent | `{count, scopes[]}` |
| `approval_requested` | Agent | `{request_id, tool_name, input_preview, reason, severity, timeout_s, matching_rule_ids[]}` |
| `approval_granted` | Agent | `{request_id, scope, decided_at}` |
| `approval_denied` | Agent | `{request_id, reason, decided_at}` |
| `approval_timed_out` | Agent | `{request_id, timeout_s}` |
| `approval_stranded` | Reconciler | `{request_id, age_s, reason}` |
| `approval_write_failed` | Agent | `{request_id?, error}` |
| `approval_resume_failed` | Agent | `{request_id, error}` |
| `approval_poll_degraded` | Agent | `{request_id, consecutive_failures}` |
| `approval_timeout_capped` | Agent | `{requested: N, effective: M, reason}` — surfaces when min-wins clips user's requested timeout |
| `approval_cap_exceeded` | Agent | `{request_id, count, cap}` — when 50-gate cap fires |
| `approval_rate_limit_exceeded` | Agent | `{request_id, rate, limit}` |
| `approval_decision_recorded` | ApproveTaskFn / DenyTaskFn | `{request_id, status, scope?, reason?, decided_at, caller_user_id}` — authoritative audit record |

### 11.2 Fan-out plane — primary UX channel for approvals

Approval events flow to the `FanOutConsumer` router via `TaskEventsTable` DDB Streams (see [`INTERACTIVE_AGENTS.md`](./INTERACTIVE_AGENTS.md) §6). The router invokes per-channel dispatcher Lambdas (`SlackDispatchFn`, `EmailDispatchFn`, `GitHubDispatchFn`) according to the user's notification config.

**`TaskApprovalsTable` Streams are NOT consumed by the fan-out router.** The approval row is working state; the audit trail is in `TaskEventsTable`. Enabling Streams on `TaskApprovalsTable` would duplicate events for no benefit. Final design: `TaskApprovalsTable` does not have Streams enabled.

**Per-channel event routing for approval events:**

| Channel | Events subscribed by default | Payload notes |
|---|---|---|
| **Slack** | `approval_required`, `approval_decided` (granted/denied), `approval_timed_out` | Messages include `Approve` / `Deny` action buttons on `approval_required`. Button click → Slack interaction-callback Lambda → POSTs to `/v1/tasks/{id}/approvals/{request_id}` via the user's Cognito-mapped identity. |
| **Email (SES)** | `approval_required` with `severity: high` | Deep-link URL to the REST endpoint; user signs in once, decision routed. |
| **GitHub issue comment** | `approval_required` appended to the in-place comment | Visible to anyone watching the originating issue. |

**Rate-limited per-user**: 10 approval-related fan-out messages per user per minute. Prevents notification spam. Rate-limit counter shared with other approval-related events (requested, stranded, decided); enforced in the router before dispatcher invocation.

**Slack button security**: `approve` / `deny` button payloads are signed by Slack; the interaction-callback Lambda validates the signing secret before writing. User mapping from Slack user ID → Cognito user ID is configured per workspace via `bgagent notifications configure --workspace <id>`.

### 11.3 Dashboard additions

Extend `TaskDashboard` (`cdk/src/constructs/task-dashboard.ts`). These are read-only CloudWatch widgets that surface approval behavior to operators; no notification channel or on-call action required:

- **Approval request rate** (line, 7d): count of `approval_requested` per hour, across all tasks.
- **Approval response time** (line + p50/p99): `decided_at - created_at`, per decision; plotted for the three outcome types.
- **Outcome distribution** (stacked bar, per hour): granted / denied / timed_out / stranded. Inverts quickly if notifications break.
- **Active AWAITING_APPROVAL tasks** (gauge): current count across the fleet.
- **Per-task approval-gate count distribution** (histogram): spot tasks approaching the 50-gate cap.
- **Top hard-gate rules by match frequency** (table): which rules are firing; informs rule tuning over time.

### 11.4 OTEL trace integration

Every `agent_milestone("approval_*")` event carries `trace_id` / `span_id`. A span `hitl.approval_wait` brackets the PreToolUse poll loop: `span.duration = decided_at - created_at`. `hitl.approval_race_loss` emitted when the agent's local timeout fired <5s before a late user decision (useful for tuning).

### 11.5 CloudWatch alarms — deferred

Operator-facing CloudWatch alarms that would page on:
- High approval-timeout rate (users not responding, notifications broken)
- Tasks stuck in AWAITING_APPROVAL beyond `timeout_s + 60s` (reconciler failure)
- High approval-write failure rate (DDB throttled or IAM drift)
- Approval-gate cap hit (suspicious retry loop)

…are **out of scope for Phase 3a** because the project does not yet have a notification channel (Slack / PagerDuty / SNS topic / email distribution list) configured for operational alerts. Adding alarms without a notification channel produces CloudWatch widgets that nobody sees — no safety benefit.

If / when an operational channel is added to the stack, these alarms become a small follow-up: wire CloudWatch metric filters on the milestone event types already emitted (§11.1), then an alarm + SNS action per threshold. The supporting metric data already flows (decisions 3-15 guarantee it); only the plumbing is deferred.

---

## 12. Security model

### 12.1 Trust boundaries

- **Agent container ↔ TaskApprovalsTable**: IAM role on the runtime has `GetItem` / `PutItem` / conditional `UpdateItem` on the table. Agent writes pending, reads decisions, writes TIMED_OUT on internal timeout.
- **User CLI ↔ API Gateway**: Cognito JWT (same authorizer as `/tasks/*`).
- **ApproveTaskFn/DenyTaskFn ↔ TaskApprovalsTable**: Lambda IAM policy allows `UpdateItem` with authorization condition (`user_id = :caller`) built into the ConditionExpression.
- **Blueprint origin**: blueprints are CDK-deployed constructs (see `cdk/src/constructs/blueprint.ts`). Platform operators deploy them. Users cannot upload arbitrary blueprint.yaml from the target repo. This property is load-bearing for the security model — if blueprint origin ever becomes user-uploaded, the blueprint-injection section (§12.4) must be re-evaluated.

### 12.2 Ownership encoded in ConditionExpression

No TOCTOU window. The single `UpdateItem` on `TaskApprovalsTable` encodes:

```
#status = :pending AND user_id = :caller
```

Authorization and state transition are atomic. A compromised internal caller (Lambda with raw DDB access) or a logic bug in a future refactor that forgets the ownership check still can't flip rows without matching the `user_id`.

### 12.3 Race prevention

**Race 1 — user approves at T, agent times out at T+ε**:
- Agent's poll loop times out → best-effort conditional update `status = TIMED_OUT WHERE status = :pending`
- User's CLI writes `APPROVED WHERE status = :pending`
- One wins atomically
- The loser:
  - If TIMED_OUT wins: user gets 409 `REQUEST_ALREADY_DECIDED`. User sees "approval expired".
  - If APPROVED wins: agent's poll reads APPROVED on next tick. Agent proceeds.

**Race 2 — double-approve**:
- Two concurrent CLI invocations. Second gets 409 `REQUEST_ALREADY_DECIDED`. Idempotent.

**Race 3 — cancel during AWAITING_APPROVAL**:
- Agent writes `RUNNING WHERE status = :awaiting AND awaiting_approval_request_id = :rid`
- User writes `CANCELLED WHERE status = :awaiting` (via `bgagent cancel`)
- If CANCELLED wins: agent's resume fails with TransactionCanceledException. Hook emits `approval_resume_failed` and returns DENY. Task is already CANCELLED; agent's turn is aborted.
- If RUNNING wins: `bgagent cancel` gets 409 `TASK_ALREADY_RUNNING` (or similar) — user sees "task resumed before cancel landed".

### 12.4 Blueprint content safety

The blueprint trust model (§12.1) means blueprint Cedar policies are trusted by construction. Nonetheless the engine enforces:

- Cedar syntax validation at load → fail-on-error
- Duplicate `@rule_id` → fail-on-error
- `@tier` mismatch with physical file/section → fail-on-error
- `@approval_timeout_s < 30` → fail-on-error
- Missing `@rule_id` on hard-gate rule → fail-on-error

These guard against blueprint misconfiguration, not malicious intent. If the blueprint model ever changes to user-uploadable, additional safeguards needed: per-blueprint policy count cap (50), total policy text size cap (64KB), per-eval timeout on `is_authorized` (100ms).

### 12.5 `all_session` does not override hard-deny

Hard-deny is evaluated FIRST, before the allowlist fast-path (§6.2). No `initial_approvals` scope can bypass it. `CreateTaskFn` rejects `rule:<hard_deny_rule_id>` at submit.

### 12.6 Denial reason sanitization in the Lambda

`DenyTaskFn` runs `output_scanner.scan(reason)` — the existing agent-side scanner that redacts AWS keys, GitHub PATs, OAuth tokens, and common secrets — **before** persisting to DDB.

Sanitization at the Lambda layer means:
- TaskApprovalsTable stores only sanitized text (visible to operators with DDB read)
- TaskEventsTable audit record stores only sanitized text (90d retention)
- Fan-out Slack/email notifications only see sanitized text
- Agent reads sanitized text verbatim; no secondary scanning needed

Additionally, both CLI and Lambda log `message_length` not `reason` in CloudWatch logs (matching Phase 2 nudge logging discipline).

### 12.7 `tool_input_preview` terminal-escape sanitization

`_strip_ansi` removes:
- ANSI CSI sequences (`\x1b[...m`, etc.)
- OSC sequences (`\x1b]...\x07`)
- Control characters below 0x20 except `\t\n`
- DEL (0x7F)

Applied at two layers:
- **Agent-side at write**: `tool_input_preview` is sanitized before DDB Put
- **CLI-side at render**: `bgagent pending`, `bgagent approve` output, and the live stream renderer all pass preview text through `_strip_ansi` before display

Defense in depth: rows written before the agent-side sanitization landed (if any) are still rendered safely.

### 12.8 Recent-decision cache prevents approval-gate storms

After a DENIED or TIMED_OUT outcome, the engine caches `(tool_name, tool_input_sha256)` for 60s. The agent's next identical tool call auto-denies without a new approval request. A prompt-injected agent cannot burn through approval gates with the same destructive action.

Cache is NOT populated on APPROVED (don't want to cache-block a just-approved call).

### 12.9 Per-task + per-rate caps

- Per-task hard cap: 50 approval gates. Exceeded → task → FAILED with reason `"approval-gate cap exceeded"`.
- Per-minute rate limit: 20 approval-row writes. Exceeded → fail-closed deny on the gate that tripped it.
- Fan-out notification cap: 10 approval-related messages per user per minute. Exceeded → messages dropped (logged).

These caps bound the worst-case behavior of a compromised account or prompt-injected agent.

### 12.10 JWT replay

Cognito JWT with signature + expiry validation on API Gateway. Approval row conditional-update prevents replay from mutating state.

---

## 13. Failure modes + fail-closed posture

### 13.1 DDB write failure at approval creation

TransactWriteItems fails → hook emits `approval_write_failed` and returns DENY. No partial-state leakage.

### 13.2 Poll read failures

- Single failed GetItem: log WARN, continue polling
- After 3 consecutive failures: emit `approval_poll_degraded` event
- After 10 consecutive failures: treat as TIMED_OUT, best-effort UpdateItem to TIMED_OUT, fail-closed deny to SDK

### 13.3 Ownership mismatch

ApproveTaskFn sees JWT whose sub doesn't match row's user_id: atomic conditional-update fails → returns 404 `REQUEST_NOT_FOUND` (no existence oracle).

### 13.4 Cedar engine crash mid-evaluation

`evaluate_tool_use` catches all exceptions from `cedarpy.is_authorized` and returns `Outcome.DENY` with reason `"fail-closed: <exception_type>"`. Matches existing behavior.

### 13.5 Multiple matching rules with conflicting annotations

Covered in §6.3 (min timeout clamped by floor; max severity).

### 13.6 Container restart mid-approval

Detected by `reconcile-stranded-tasks.ts` (§9.5). Transitions task to FAILED with reason `"approval stranded (container eviction)"`. User sees clear failure, can resubmit. No silent hang.

### 13.7 Insufficient lifetime remaining for approval

If `remaining_maxLifetime - CLEANUP_MARGIN_120S < FLOOR_30S`, hook immediately returns DENY with reason `"insufficient maxLifetime for approval"`. Task continues without a gate — or, if the gate was load-bearing, fails gracefully in RUNNING state.

### 13.8 PreToolUse hook itself crashes

Existing behavior: hook's outer try/except returns fail-closed deny. Extended in Phase 3 to log hook crash with context (request_id if available) for triage.

### 13.9 Resume transition fails (user cancelled during poll)

Hook emits `approval_resume_failed` and returns DENY. Task is already in its new state (CANCELLED); hook doesn't attempt to resume.

---

## 14. Sample scenarios

### 14.1 Scenario A: force-push with per-rule timeout

Setup: repo `my-org/my-app` blueprint extends hard-gate with `force_push_main` (@approval_timeout_s=600). Task default is 300s.

```bash
$ bgagent submit --repo my-org/my-app \
    --task "merge feature-x into main and push" \
    --approval-timeout 300
```

Agent runs `git push origin main`. `push_to_protected_branch` matches (non-force push to a protected branch). Annotations: `timeout_s=300`, `severity=medium`.

```
[14:00:00]  ★ approval_requested: Bash "git push origin main" (severity=medium)
            reason: Cedar hard-gate: push_to_protected_branch
            respond: bgagent approve <task-id> 01KPR... [--scope tool_type_session]
            timeout: 300s
```

User approves with `tool_type_session` (either via `bgagent approve` or a Slack button). Events:

```
[14:00:08]  ★ approval_granted: request_id=01KPR... scope=tool_type_session
[14:00:08]  ▶ Bash: git push origin main
[14:00:10]  ◀ Bash: Everything up-to-date
```

Later `git status` call → allowlist fast-path → no new approval.

### 14.2 Scenario B: Force-push to main hits hard-deny

Agent proposes `Bash: git push --force origin main`. Hard-deny rule `force_push_main` matches → immediate DENY with reason `"Hard-deny: force_push_main"`. No approval request. Task stays in RUNNING.

Recent-decision cache now has `(Bash, sha256("git push --force origin main"))` for 60s — a retry would auto-deny without re-running Cedar.

Agent adapts, opens a PR via `gh pr create` instead. No rule matches. Tool runs.

### 14.3 Scenario C: Trusted automation with `all_session`

```bash
$ bgagent submit --repo my-org/infra \
    --task "apply approved terraform plan for staging-v2" \
    --pre-approve all_session --yes
```

Blueprint on `my-org/infra` allows `maxPreApprovalScope: "all_session"`. Task runs fully autonomously. Zero approval gates. Hard-deny still enforces.

Stream shows `[14:20:00]  ★ pre_approvals_loaded: count=1 scopes=[all_session]` at startup so operators see the starting posture.

### 14.4 Scenario D: Denying with steering reason

```bash
$ bgagent submit --repo my-org/my-app \
    --task "Update the deployment scripts to use the new release branch" \
    --approval-timeout 600
```

Agent tries `Bash: git push origin release/v2`. Hard-gate rule `push_to_protected_branch` hits. `approval_requested` → user:

```bash
$ bgagent deny 01KPW... 01KPR... \
    --reason "move it to src/dashboard/v1.deprecated instead of deleting; we may need to reference it in migrations"
```

`DenyTaskFn` sanitizes (no secrets in this reason, passes through unchanged), writes to DDB. Agent's poll reads DENIED.

Hook executes: atomic resume to RUNNING → queue denial injection via `between_turns_hooks` → return to SDK with fallback deny reason.

Next Stop seam fires. The between-turns injector emits:

```xml
<user_denial request_id="01KPR..." timestamp="2026-04-23T14:30:08Z">
move it to src/dashboard/v1.deprecated instead of deleting; we may need to reference it in migrations
</user_denial>
```

Agent reads the denial on its next turn, adapts:

```
[14:30:12]  ▶ Bash: git mv src/dashboard/v1 src/dashboard/v1.deprecated
[14:30:13]  ◀ Bash: (success)
```

Task proceeds. Denial-as-steering worked via the same robust path Phase 2 nudges use.

### 14.5 Scenario E: AI-DLC phased pre-approvals

Three-phase workflow with escalating trust:

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

Each phase has explicit scope. Matches real-world review workflows. Visible in audit via `pre_approvals_loaded` event.

---

## 15. Implementation plan

### 15.1 Milestone structure

**Phase 3a** — core feature (3-4 weeks of work):
- Day 1: commit the cedarpy annotation round-trip test (agent side, `agent/tests/test_cedarpy_annotations_contract.py`) + the `@cedar-policy/cedar-wasm` parse test (Lambda side, `cdk/test/handlers/shared/cedar-policy.test.ts`). Both packages already spiked 2026-04-24: `cedarpy.policies_to_json_str()` returns annotations verbatim under `staticPolicies.<id>.annotations`; `@cedar-policy/cedar-wasm/nodejs` exports `policySetTextToParts` + `policyToJson(text)` which together expose the same data (see §15.6).
- Engine refactor (hard-deny + hard-gate + annotations + allowlist + recent-decisions)
- New DDB table, new Lambdas, new CLI commands
- PreToolUse hook extension (atomic transitions)
- `bgagent policies list` + `bgagent pending` (support UX that unblocks real usage)
- Happy path + fail-closed tests
- E2E on `backgroundagent-dev`

**Phase 3b** — polish (1-2 weeks):
- CLI inline streaming prompt (UX research first)
- `approve --defer` / allowlist revocation (`bgagent revoke-approval`)
- CloudWatch alarm plumbing (§11.5) — deferred until an operational notification channel is available
- More hard-gate policies in the default set based on real usage

### 15.2 Phase 3a task list

~35 focused items. Ordered by dependency.

| # | Package | File | Change |
|---|---|---|---|
| 1 | agent | Spike | Validate cedarpy.policies_to_json_str() returns annotations. Confirm `diagnostics.reasons` shape for multi-match. If API diverges, update §6 before proceeding. |
| 2 | agent | `src/policy.py` | Extend `PolicyDecision` (outcome/timeout_s/severity/matching_rule_ids/allowed-property). Split `_DEFAULT_POLICIES` into hard-deny + hard-gate. Add annotation parsing. Implement `ApprovalAllowlist` + `RecentDecisionCache`. Load-time validation (rule_id uniqueness, tier mismatch, annotation floor). |
| 3 | agent | `policies/hard_deny.cedar` (new) | Migrate current hard-deny rules + add DROP TABLE. Annotations. |
| 4 | agent | `policies/hard_gate.cedar` (new) | force-push, *.env, infrastructure/**, credentials. Annotations. |
| 5 | agent | `tests/test_policy.py` | Three-outcome, annotation merging, allowlist (incl. write_path, tool_group), recent-decision cache, pre-approval seeding, annotation round-trip. |
| 6 | cdk | `src/constructs/task-approvals-table.ts` (new) | Table + TTL + PITR (no Streams). |
| 7 | cdk | `src/handlers/shared/cedar-policy.ts` (new) | Shared policy-parsing library for Lambda-side rule-id validation. |
| 8 | cdk | `src/handlers/approve-task.ts` (new) | POST /approve with ownership-in-condition + audit event. |
| 9 | cdk | `src/handlers/deny-task.ts` (new) | POST /deny with output_scanner sanitization + audit event. |
| 10 | cdk | `src/handlers/get-policies.ts` (new) | GET /v1/repos/{repo}/policies. |
| 11 | cdk | `src/handlers/shared/types.ts` | ApprovalRequest/Response/DenyRequest + Scope union + extended CreateTaskRequest. |
| 12 | cdk | `src/handlers/shared/response.ts` | New error codes (REQUEST_NOT_FOUND, REQUEST_ALREADY_DECIDED, TASK_NOT_AWAITING_APPROVAL). |
| 13 | cdk | `src/constructs/task-api.ts` | Wire /approve, /deny, /repos/{}/policies routes. Grants. |
| 14 | cdk | `src/stacks/agent.ts` | Instantiate TaskApprovalsTable. Env var on runtimes. |
| 15 | cdk | `src/constructs/task-status.ts` | AWAITING_APPROVAL enum + transitions. |
| 16 | cdk | `src/handlers/create-task.ts` | Validate initial_approvals + approval_timeout_s with all safeguards (degenerate patterns, hard-deny rule rejection, maxPreApprovalScope ceiling, blueprint-resolved rule lookup). |
| 17 | cdk | `src/handlers/orchestrate-task.ts` | waitStrategy + finalizeTask handle AWAITING_APPROVAL. |
| 18 | cdk | `src/constructs/stranded-task-reconciler.ts` | Detect + transition stranded AWAITING_APPROVAL tasks. |
| 19 | cdk | `src/handlers/fanout-task-events.ts` | Dispatch rules for approval_* events + per-user notification rate limit. |
| 20 | agent | `src/hooks.py` | PreToolUse REQUIRE_APPROVAL path: atomic transitions, caps, poll, resume, denial-injection queue. |
| 21 | agent | `src/hooks.py` | `_denial_between_turns_hook` registered alongside `_nudge_between_turns_hook`. Shared `_xml_escape`. |
| 22 | agent | `src/task_state.py` | AWAITING_APPROVAL in transition helpers (TransactWriteItems primitive). |
| 23 | agent | `src/progress_writer.py` | `write_approval_*` convenience methods over `write_agent_milestone`. |
| 24 | cli | `src/commands/approve.ts` (new) | + 429 handling, `NO_COLOR` check. |
| 25 | cli | `src/commands/deny.ts` (new) | + `--reason-file` support. |
| 26 | cli | `src/commands/pending.ts` (new) | `bgagent pending` listing across active tasks. |
| 27 | cli | `src/commands/policies.ts` (new) | `bgagent policies list` + `policies show`. |
| 28 | cli | `src/commands/submit.ts` + `run.ts` | --approval-timeout, --pre-approve (repeatable), --pre-approve-file, all_session confirmation with --yes bypass. |
| 29 | cli | `src/api-client.ts` | approveTask, denyTask, listPending, listPolicies, extended createTask. |
| 30 | cli | `src/types.ts` | Mirror CDK types. Scope union + validator. |
| 31 | cdk | `test/handlers/approve-task.test.ts` (new) | Happy path, race, ownership-in-condition, scope validation, 409/404 distinction. |
| 32 | cdk | `test/handlers/deny-task.test.ts` (new) | Same shape + output_scanner integration. |
| 33 | cdk | `test/handlers/get-policies.test.ts` (new) | Discovery endpoint tests. |
| 34 | cdk | `test/handlers/create-task.test.ts` | initial_approvals validation (degenerate patterns, hard-deny rule rejection, blueprint resolution). |
| 35 | cli | `test/commands/*.test.ts` | CLI command tests. |
| 36 | agent | `tests/test_hooks.py` | REQUIRE_APPROVAL path, atomic transitions, caps, recent-decision cache, denial injection. |
| 37 | docs | `docs/design/INTERACTIVE_AGENTS.md` | Confirm §5.6 (approval CLI commands) and §8.2 (state machine) reflect Phase 3 wiring. |

### 15.3 Testing strategy

- **Unit**: ~80% coverage target, matching Phase 2.
- **Integration**:
  - Cedar annotation round-trip test (write, parse, recover all 5 annotations)
  - Full PreToolUse → PolicyDecision → DDB pipeline
  - Allowlist seeding from initial_approvals
  - Shared policy-parsing library consistency (Lambda side == agent side)
- **E2E** on `backgroundagent-dev`: 5 scenarios (A-E from §14). Both RuntimeJwt and Runtime-IAM paths.
- **Race tests**:
  - Approve vs. timeout concurrent
  - Deny vs. timeout concurrent
  - Double-approve
  - Cancel during AWAITING_APPROVAL
  - Late approval after TIMED_OUT (expect 409)
- **Chaos tests**:
  - Container restart mid-approval (simulated via kill + reconciler)
  - DDB throttle during poll (simulated via mock)
  - Bash retry loop after DENIED (expect recent-decision cache auto-deny)
- **Security tests**:
  - Wrong user JWT → 404 (not 403)
  - ANSI-injected tool_input_preview → stripped at both layers
  - Malformed Cedar annotations → task fails to start
  - Degenerate bash_pattern → 400 at submit
  - Sanitizer-removing-secret test (OUTPUT_SCANNER integration)

### 15.4 Rollout — no feature flag

Cedar-HITL is shipped as standard functionality — no per-repo enable/disable flag. The safety posture of a given task is determined entirely by the content of the loaded policy set (built-in + blueprint) and the user's `--pre-approve` scopes at submit time.

Built-in policies shipped with the agent:

**Hard-deny (absolute, no scope bypasses them)**:
- `rm_slash` — `rm -rf /`
- `write_git_internals`, `write_git_internals_nested` — writes under `.git/`
- `drop_table` — SQL destructive DDL
- `force_push_main` — `git push --force` (or `-f`) to `main`/`prod`
- `write_credentials` — writes to files with `credentials` in the path

**Hard-gate starter set (require approval by default)**:
- `push_to_protected_branch` — non-force push to `main`/`master`/`prod`/`release/*` — medium, 300s
- `write_env_files` — `like "*.env"` — high, 600s

Users who want fully autonomous execution (no approval gates) pass `--pre-approve all_session --yes` at submit. Repos that want additional gates add them via `Blueprint.security.cedarPolicies.hard_gate`. Repos that want a different policy set can override specific built-in rules by `@rule_id` via the blueprint's `security.cedarPolicies.disable` list (see §17 for the disable-by-id mechanism, implemented as part of 3a).

Rollout steps:

1. **Implement + merge to main.** Built-in policies ship with the hard-deny + hard-gate sets above. No flag, no global kill switch. Any task on any repo instantly has the gate behavior for rules in the starter set; any task with `--pre-approve all_session` bypasses hard-gate rules (hard-deny rules remain enforced regardless).
2. **`backgroundagent-dev` validation.** Deploy merged code. Run E2E scenarios A–E:
   - A: force-push gated + approved via CLI
   - B: hard-deny path (DROP TABLE blocked, not gated)
   - C: `--pre-approve all_session` bypasses hard-gate
   - D: deny-with-reason steers agent via `<user_denial>` injection
   - E: AI-DLC-style phased pre-approvals
   Confirm Phase 1a/1b/2 regressions still pass. Confirm dashboards render.
3. **Pilot period (2 weeks).** Designate `scoropeza/agent-plugins` as the pilot repo (non-critical, active usage). Monitor:
   - Any stranded tasks → indicates reconciler gap
   - Timeout rate on approval_requested
   - Per-task approval-gate count distribution — spot anomalous retry loops
   - User-reported friction: "is the gate firing on things it shouldn't?"
   If the starter set is too noisy, tune. If reliability is solid, proceed.
4. **Default for all repos.** Once the pilot is stable, the starter set is already live for everyone — no "flip the switch" step because there was no flag. Ongoing tuning happens by modifying built-in policies in code or via repo blueprints.

**Rollback mechanism.** If the pilot surfaces a bug: remove the problem rule from `hard_gate.cedar` and redeploy (~5 min). No flag to flip. If the bug is more fundamental (engine regression), `git revert` the Phase 3 merge and redeploy — Phase 2 tests continue to pass because the backward-compat shim on `PolicyDecision.allowed` preserves the hook contract.

**Success criteria for "pilot done":**
- Zero stranded tasks in 2 weeks
- <10% timeout rate on `approval_requested`
- Zero `approval_cap_exceeded` events (if any fire, either the cap is wrong or adversarial traffic to investigate)
- No regressions in Phase 1a/1b/2 tests (CI enforced on every commit)
- User-initiated gates that work: every hard-gate match produces a visible `★ approval_requested` in the stream and a responsive `bgagent approve/deny` cycle

### 15.5 Backward compatibility

- Existing tasks without `initial_approvals` → empty list → no pre-approvals, default `approval_timeout_s = 300`
- Existing policies without `@rule_id` / `@tier` → engine fails to start (fail-closed). Blueprint authors must add annotations explicitly during migration.
- `PolicyDecision.allowed` property provides backward compat for existing `if not decision.allowed` callers
- Hook return shape unchanged — Phase 1a/1b tests continue to pass

### 15.6 Shared Cedar parsing — `@cedar-policy/cedar-wasm` API quickref

The Lambda side (`CreateTaskFn`, `ApproveTaskFn`, `GetPoliciesFn`) uses [`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm) — AWS's official WASM-compiled Cedar engine. Same Rust core as the Python `cedarpy` binding we already use in the agent. Spiked + verified 2026-04-24.

**Package:** `@cedar-policy/cedar-wasm@4.10.0` (or latest major 4.x).
**Size:** 4.1 MB unzipped / ~1.5 MB zipped — well under Lambda limits.
**Import:** `const cedar = require('@cedar-policy/cedar-wasm/nodejs');` — use the CJS nodejs sub-export, NOT the default ESM export (ESM fails with `ERR_UNKNOWN_FILE_EXTENSION` on the `.wasm` file in Node 22).

**Core functions used by the design:**

| Function | Purpose |
|---|---|
| `policySetTextToParts(text: string)` | Split a multi-policy Cedar text into an array of individual policy texts. Returns `{type: "success", policies: string[]}` or `{type: "failure", errors: [...]}` |
| `policyToJson(text: string)` | Parse a single policy text into structured JSON. Returns `{type: "success", json: {annotations, effect, principal, action, resource, conditions}}` — annotations preserved verbatim under `json.annotations` as a `Record<string, string>` |
| `isAuthorized({principal, action, resource, context, policies: {staticPolicies: string}, entities: []})` | Main authorization call. Entity references are `{type, id}` objects, **not** string literals. Returns `{type, response: {decision, diagnostics: {reason: string[]}}}` — `diagnostics.reason` is the list of matching policy IDs (e.g. `["policy1", "policy2"]`) for multi-match |

**Minimal annotation-extraction pattern (the only thing `CreateTaskFn` needs for rule validation):**

```typescript
// cdk/src/handlers/shared/cedar-policy.ts (sketch)
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

export interface ParsedRule {
  ruleId: string;
  tier: 'hard-deny' | 'hard-gate';
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
    if (tier !== 'hard-deny' && tier !== 'hard-gate') {
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
3. The Lambda cold-start penalty is ~30ms for the first `require()` (WASM module instantiation). Keep the import at module scope — not inside the handler — so subsequent invocations reuse the already-instantiated module.
4. The Node binding is CJS; the Lambda bundler (esbuild) treats the `.wasm` file as an external asset and Lambda's layer mechanism handles it automatically. No custom esbuild loader needed.

---

## 16. Implementation notes (carry-forward tasks)

Items from the 2026-04-24 design review not captured above as design changes — to be addressed during implementation and removed from this list once completed. These are P1-P2 findings; P0s have been integrated into the main design body.

**IMPL-1** (data-flow P1-5): Scope string normalization. CLI + Lambda must agree. Document: trim whitespace, preserve case on `tool_type:` (Bash/Read/Write are canonical; reject case-shifted variants).

**IMPL-2** (data-flow P1-7): Dual-write ordering between `progress_writer` and `sse_adapter` is best-effort; canonical source is TaskEventsTable. Document this in the implementation guide alongside Phase 2.

**IMPL-3** (data-flow P2-1): Catch `ValueError` in `_merge_annotations` on malformed `@approval_timeout_s`; skip the annotation, log WARN. Engine already fails the task at load time if below floor, so this is a belt-and-suspenders.

**IMPL-4** (data-flow P2-4): Test constraint — tests MUST NOT assert specific positional Cedar policy IDs. Use `@rule_id` annotations exclusively.

**IMPL-5** (security SA-11 residual): Both the Lambda (audit event) and the agent (milestone) write approval decisions. The Lambda's write is canonical; the agent's is observational. Tests should verify the Lambda write completes even if agent milestone fails.

**IMPL-6** (security P1-8): Audit trail ownership. `ApproveTaskFn` / `DenyTaskFn` write `approval_decision_recorded` to TaskEventsTable directly (not via agent milestone). Implement as part of the Lambda request flow.

**IMPL-7** (security blind-spot #5): PolicyEngine MUST be instantiated per task, NOT per container. Verify in server.py bootstrap that a new instance is created on each task invocation (even when attach-don't-spawn logic reuses the container).

**IMPL-8** (security blind-spot #6): TaskApprovalsTable Streams — confirmed off (§11.2). Do not subscribe any consumer.

**IMPL-9** (functional P1-3): Runtime allowlist revocation. Not shipped in 3a. Placeholder: `bgagent revoke-approval <task_id> <scope>` noted in §17.

**IMPL-10** (functional P1-12): `approval_timeout_s` default 300 documented consistently in §3 #6, §7.3 table, §10.2 attribute description.

**IMPL-11** (functional P2-8): CLI `submit.ts` gains `--pre-approve` / `--approval-timeout` flags.

**IMPL-12** (functional P2-9): Poll cadence in §3 #3 reconciled — describe as "initial 2s for 30s, then 5s" without specific call count math (it varies with timeout_s).

**IMPL-13** (functional FC-5): `bgagent status <task_id> --allowlist` — inspects current in-process allowlist state. Useful for debugging "why is this tool being gated again?". Low priority; add to `bgagent status` if cheap.

**IMPL-14** (functional FC-6): Tool_use_id correlation. SDK handles internally. No hook-side changes needed; tests should verify the hook does not echo tool_use_id in its response.

**IMPL-15** (functional FC-9): Recent-decision cache 60s window — tune after observation. Default 60s is a reasonable starting point.

**IMPL-16** (CLI UX): ULID length is 26 chars, not 33. Update all CLI help text and error messages.

**IMPL-17** (CLI UX): Shell completion (tab-complete task_id + request_id from `bgagent pending`). Deferred to 3b; document in §17.

**IMPL-18** (FC-7): PolicyEngine freezing is implicit (single `__init__` call, no reload path). Add a test: assert that no code path calls `load_policies` after `__init__` completes.

---

## 17. Deferred / out of scope

### 17.1 Multi-user approval

Future: multi-user approval (e.g., two of three reviewers must approve for `rule:deploy_prod`). Scope: §9.8 INTERACTIVE_AGENTS.md, Iteration 5.

### 17.2 Per-rule auto-approve on timeout

`@on_timeout("allow")` annotation sketched. Safety footgun. Revisit in 3b if demand.

### 17.3 `@tier("advise")` — non-blocking advisory rules

A third policy tier for rules that should surface but not block. Semantics sketch:

- Cedar matches → emit `agent_milestone("advise_matched", {rule_ids, severity, tool_name, input_preview})` via `ProgressWriter` + fan-out.
- **No block.** Tool call proceeds immediately as if ALLOWED.
- **No timeout, no approval row, no state transition.** The engine never pauses.
- `PolicyDecision` gains `Outcome.ADVISE` but `evaluate_tool_use` returns ALLOW to the hook (internal tier, not a new SDK `permissionDecision`).
- Event framing: past-tense ("agent did X, matched rule Y"). Fan-out to Slack/email is FYI — no action buttons, audit-only.
- File layout: `agent/policies/advise.cedar`. Third file alongside `hard_deny.cedar` + `hard_gate.cedar`.

Deferred because (a) shipping with gate-or-not is the simpler mental model for v1 users, (b) we want to observe whether hard-gates alone produce acceptable UX before introducing a third outcome, and (c) a concrete "I want to know but not be blocked" use case hasn't surfaced yet. First candidate rule if we ship it: `push_to_protected_branch` (force-push to any branch — informational for feature-branch workflows where force-pushing is routine).

### 17.4 Interactive streaming prompts

UX research first. Unlikely to ship — the async-only direction for the platform suggests notification-plane delivery is the right shape.

### 17.4 Persistent allowlist across container restarts

Today: in-process; reconciler fails stranded tasks. Phase 3b could persist to TaskTable + hydrate on restart. Not critical given rare restarts.

### 17.5 `bgagent approve --defer`

Escape hatch: "cancel + release slot". Clearer than silent timeout. Phase 3b.

### 17.6 Policy hot-reload

Today: policies frozen at task start. A long-running task can't benefit from a fresh hard-gate rule added mid-task. Probably fine; submission is the authoritative moment. Not a Phase 3 goal.

### 17.7 Severity-based routing

CLI: `bgagent approve --severity high` auto-approves high only, leaves medium/low. Phase 3b.

### 17.8 Runtime allowlist revocation

`bgagent revoke-approval <task_id> <scope>`. User realization "oh wait, I didn't mean to approve ALL Bash". Phase 3b — implementation is straightforward (remove from in-process allowlist + emit `approval_revoked` milestone).

### 17.9 Bulk approve

`bgagent approve --all-pending` to approve everything pending. Power-user. Low priority; users WILL ask.

### 17.10 Shell completion for task_id / request_id

Tab-complete from `bgagent pending`. Deferred to 3b.

### 17.11 Policy linting

`bgagent lint-policies --repo <repo>` to validate blueprint Cedar before submission. Catches annotation errors in development rather than at container start. Phase 3b.

### 17.12 Richer approval annotations

`@approval_requires_mfa("true")`, `@approval_channel("slack")` for enterprise workflows (step-up auth, audit channel). Good ideas; deferred.

### 17.13 Cross-task scope inheritance

"Apply the same pre-approvals I used on my last task." Convenience. Phase 3b.

---

## Appendix A — Key file change map

See §15.2. Net new files: ~13. Net modified files: ~15. Total LOC estimate: ~3500 production + ~2000 test = ~5500 lines. Larger than Phase 2 (+2950 / -34) because of the new Lambda × 3 + discovery endpoint + shared parser + state machine + reconciler updates.

## Appendix B — Review checklist (pre-merge)

- [ ] Day-1 cedarpy spike run; annotation round-trip confirmed
- [ ] All 5 Cedar annotations parse + recover via `policies_to_json_str()` round-trip test
- [ ] Every hard-deny rule has `@tier("hard-deny")` + `@rule_id`
- [ ] Every hard-gate rule has `@tier("hard-gate")` + `@rule_id` + `@severity` (default medium if missing)
- [ ] `@rule_id` uniqueness enforced at engine load (fail-on-error, not fall-back)
- [ ] `@approval_timeout_s < 30` rejected at load
- [ ] Atomic TransactWriteItems for approval-request creation and resume transitions
- [ ] Ownership encoded in ConditionExpression on ApproveTaskFn / DenyTaskFn
- [ ] Scope validation: rejects `rule:<hard_deny_id>`, degenerate patterns, blueprint-maxPreApprovalScope violations
- [ ] ANSI/control-char stripping in `tool_input_preview` (both layers)
- [ ] `output_scanner.scan` runs in DenyTaskFn before persisting `reason`
- [ ] Recent-decision cache blocks 60s retries
- [ ] Per-task cap (50) + per-minute rate limit (20) + per-user notification cap (10/min)
- [ ] Denial injection via Stop hook `between_turns_hooks` (not `permissionDecisionReason` alone)
- [ ] Stranded-task reconciler transitions AWAITING_APPROVAL > 2×timeout_s to FAILED
- [ ] Race tests pass: approve+timeout, deny+timeout, double-approve, cancel-during-awaiting, late-approval-after-TIMED_OUT
- [ ] E2E on `backgroundagent-dev`: Scenarios A-E, both runtime paths
- [ ] `bgagent pending` + `bgagent policies list` functional
- [ ] Dashboard widgets emitting all approval-* metrics
- [ ] `bgagent status <task_id> --allowlist` (if IMPL-13 shipped)
- [ ] Built-in starter set loaded: hard-deny = {rm_slash, write_git_internals, write_git_internals_nested, drop_table, force_push_main, write_credentials}; hard-gate = {push_to_protected_branch, write_env_files}
- [ ] No feature flag — Cedar-HITL is standard functionality; `--pre-approve all_session --yes` is the opt-out
- [ ] Backward compat: Phase 1a/1b tests pass without modification
- [ ] ULID length references are 26 chars throughout CLI + docs

---

*End of Phase 3 design doc, rev 2.*
