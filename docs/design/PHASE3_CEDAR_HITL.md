# Phase 3 — Cedar-driven HITL Approval Gates

> **Status:** Detailed design, pre-implementation.
> **Companion:** [`INTERACTIVE_AGENTS.md`](./INTERACTIVE_AGENTS.md) §9.3 (now pointing here), §7 (state machine), §11 (implementation plan).
> **Visual:** [`../phase3-cedar-hitl.drawio`](../phase3-cedar-hitl.drawio) (12 pages).
> **Design locked:** 2026-04-23 (Sam ↔ assistant discussion).
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
16. [Open questions / deferred](#16-open-questions--deferred)

---

## 1. What we are building, in one paragraph

When the agent is about to call a tool (Bash, Write, Edit, WebFetch, etc.), our existing Cedar policy engine today decides **Allow** or **Deny**. Phase 3 adds a third outcome — **Require-approval** — that pauses the tool call, writes an approval request to a new DynamoDB table, transitions the task to `AWAITING_APPROVAL`, and awaits a human response via a new REST endpoint + CLI command. The agent polls DynamoDB for the user's decision (2–5s cadence), then either proceeds with the tool call or receives a denial the agent can adapt to. At task-submit time the user can also *pre-approve* scopes (specific tools, bash patterns, rule IDs, or `all_session`) so low-risk agents run without any interactive gates. The same Cedar policy language is reused with a new `@tier("soft")` annotation to mark rules that should trigger approval instead of absolute denial — no new language, broader semantics.

---

## 2. The three-outcome model

### Cedar's native model is binary

The [Cedar authorization engine](https://www.cedarpolicy.com/) answers exactly one question on every call: given a `(principal, action, resource, context)` tuple, is the action **Allowed**, **Denied**, or is there **NoDecision** (no policy matched)? Our existing engine in `agent/src/policy.py` treats `NoDecision` as deny (fail-closed) and returns a boolean `allowed` to callers. That's the Phase 1a baseline.

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
│  3. Cedar eval against SOFT_DENY_POLICIES                                │
│       └─ Deny → return PolicyDecision(outcome=REQUIRE_APPROVAL,          │
│                                       reason, timeout_s, severity,      │
│                                       matching_rule_ids)                │
│          Human must approve before the tool runs.                       │
│                                                                          │
│  4. Default ALLOW                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

Each evaluation is a Cedar call — sub-millisecond. No network hop. No AWS API. The "approval wait" (step 3's downstream handling) is entirely inside our `PreToolUse` hook coroutine.

The SDK never sees `REQUIRE_APPROVAL` — after the wait, our hook returns the SDK's native `{"permissionDecision": "allow" | "deny"}` shape. The three-outcome model is an internal engine abstraction.

### Why not a single policy set with a custom "require approval" outcome

Cedar doesn't have a `require_approval` effect. Options considered:

- **Cedar annotations without policy-set split**: mark some `forbid` rules with `@require_approval("true")` and let the engine introspect the matched policy. Works, but it means every `forbid` is a potential approval — a maintenance hazard (rule authors forgetting to mark approval rules, accidentally converting hard-denies into soft-denies). Rejected.
- **Context-encoded re-evaluation**: pass `context.allow_approval: bool` and check twice. Clever but opaque; policy authors write dual conditions. Rejected.
- **Two policy sets**: the chosen design. Physical split. Policy authors know exactly where a rule lives by which file it's in. `@tier("hard"|"soft")` annotation acts as a double-check.

The winning property: **policy authors can put on their "security-review-approved" hat and read the hard-deny file alone**, without being distracted by approval-eligible rules. Most review effort is on the hard-deny set because soft-deny rules have a human safety net.

---

## 3. Design decisions (locked)

Settled during the 2026-04-23 design discussion. Each has detailed rationale in that conversation; summary here for implementers.

| # | Decision | Summary |
|---|---|---|
| 1 | **Cedar encoding: two policy sets** | Physical hard-deny vs soft-deny split, validated via `@tier(...)` annotation. |
| 2 | **Hook point: extend `PreToolUse`, not `can_use_tool`** | PreToolUse is already async-compatible, already wired to Cedar, and already owns the tool-governance boundary. No reason to add a second hook with overlapping responsibilities. |
| 3 | **Wait mechanism: DDB polling, 2s → 5s backoff** | Initial 2s cadence for the first 30s, then 5s for the remainder. ~60-150 GetItem calls over a 5-min timeout; cheap on on-demand DDB. |
| 4 | **Scope allowlist: in-process, seeded from persisted `initial_approvals`** | Runtime escalation (from mid-task `bgagent approve --scope tool_type_session`) lives in the `PolicyEngine` instance. Submit-time `--pre-approve` flags persist as `initial_approvals` on TaskTable and seed the allowlist at container startup. Lost on restart (rare; 8h maxLifetime + attach-don't-spawn). |
| 5 | **CLI UX: standalone `bgagent approve/deny` + `--pre-approve <scope>` on `submit`/`run`** | No inline interactive prompt in the streaming CLI for v1 (too much UX risk with the stream rolling). |
| 6 | **Timeouts: per-task default + per-rule Cedar annotation override, fail-closed** | `--approval-timeout <seconds>` at submit, bounded `[30s, maxLifetime - 5min]`. Per-rule `@approval_timeout_s("N")` annotation overrides. On timeout → deny (never auto-approve). |
| 7 | **Concurrency slots: AWAITING_APPROVAL holds the slot** | Matches PAUSED semantics. Container is alive, consuming memory. See §9 for worked example. |
| 8 | **Hard-deny is absolute** | No `--pre-approve` scope can bypass it; CreateTaskFn validates and rejects `rule:<hard_deny_rule_id>`. |
| 9 | **Submit-time scope cap: 20 entries, ≤128 chars each** | Keeps audit trail legible, bounds allowlist check cost, limits abuse-vector damage. |
| 10 | **Cedar annotations (verified working)** | `@rule_id(...)`, `@tier(...)`, `@approval_timeout_s(...)`, `@severity(...)`, `@category(...)`. Recoverable via `cedarpy.policies_to_json_str()` → JSON. Multi-match merging: min timeout wins, max severity wins. |

---

## 4. End-to-end request flow

Narrative walk-through of the happy path. Sequence diagrams in [phase3-cedar-hitl.drawio pages 3-6](../phase3-cedar-hitl.drawio).

### Setup (task start)

1. User runs `bgagent run --repo my-org/my-app --task "rebase feature-x onto main and push" --approval-timeout 600 --pre-approve tool_type:Read --pre-approve bash_pattern:"git status*"`.
2. CLI validates each scope string client-side (format, ≤128 chars, cap 20). Rejects invalid syntax without round-trip.
3. CLI POSTs `/v1/tasks` with `{repo, task, initial_approvals: [...], approval_timeout_s: 600}`.
4. `CreateTaskFn` validates `initial_approvals`:
   - max 20 entries, ≤128 chars each
   - rejects `rule:<id>` where `<id>` names a hard-deny rule
   - honors `Blueprint.security.maxPreApprovalScope` (see §5.3)
   - rejects `all_session` if blueprint prohibits it
5. Task persists. `approval_timeout_s` and `initial_approvals` become DDB attributes on the task row.
6. Container spawns on Runtime-JWT. `PolicyEngine.__init__` loads:
   - `HARD_DENY_POLICIES` (built-in + repo blueprint's `security.cedarPolicies.hard`)
   - `SOFT_DENY_POLICIES` (built-in + repo blueprint's `security.cedarPolicies.soft`)
   - Annotation lookup table: `{policy_id: {annotation: value}}` built from `cedarpy.policies_to_json_str()` once, cached for the task lifetime
   - Rule-ID map: `{rule_id_annotation: policy_id}` to resolve `--pre-approve rule:<rule_id>` → internal Cedar policy ID
   - Allowlist seeded from `initial_approvals`
7. Container emits `agent_milestone("pre_approvals_loaded", {count: 2, scopes: ["tool_type:Read", "bash_pattern:git status*"]})` so Terminal A's stream shows the starting posture.
8. Agent begins normal work.

### First approval gate (soft-deny hit)

9. Agent decides to run `Bash(command="git push --force origin feature-x")`.
10. SDK fires `PreToolUse` hook with `tool_name="Bash"`, `tool_input={command: "..."}`.
11. Hook calls `PolicyEngine.evaluate_tool_use`:
    - Hard-deny eval: matches nothing → `allowed=True`
    - Allowlist fast-path: `tool_type:Bash`? no. `bash_pattern` matches `git push --force ...`? `git status*` doesn't match `git push --force ...` → skip
    - Soft-deny eval: policy `force_push_any` matches (`like "*git push --force*"`). `diagnostics.reasons == ["policy1"]`. Lookup: `policy1` → annotations `{rule_id: "force_push_any", approval_timeout_s: "300", severity: "medium"}`.
    - Returns `PolicyDecision(outcome=REQUIRE_APPROVAL, reason="Cedar soft-deny: force_push_any", timeout_s=300, severity="medium", matching_rule_ids=["force_push_any"])`.

    The 300s timeout is from the annotation, not the task default of 600s. Min of `(task_default, rule_annotation)` wins — the stricter one for safety.

12. Hook mints `request_id = _ulid()` (33-char ULID).
13. Hook writes to `TaskApprovalsTable`:
    ```python
    {
      "task_id": "01KPW...",
      "request_id": "01KPR...",
      "tool_name": "Bash",
      "tool_input_preview": "git push --force origin feature-x",  # truncated to 256 chars
      "tool_input_sha256": "abc123...",  # full-input hash for audit
      "reason": "Cedar soft-deny: force_push_any",
      "severity": "medium",
      "matching_rule_ids": ["force_push_any"],
      "status": "PENDING",
      "created_at": "2026-04-23T14:00:00Z",
      "timeout_s": 300,
      "ttl": 1734567890,   # created_at + 1h
      "user_id": "...",
      "repo": "my-org/my-app"
    }
    ```
14. Hook conditionally updates `TaskTable.status`: `RUNNING → AWAITING_APPROVAL` with `ConditionExpression: #status = :running` (fail-closed on race — §12.3).
15. Hook emits `agent_milestone("approval_requested", {...})` to both `ProgressWriter` (DDB audit) and `sse_adapter` (live stream).
16. Terminal A stream renders:
    ```
    [14:00:00]  ★ approval_requested: Bash "git push --force origin feature-x" (medium)
                reason: Cedar soft-deny: force_push_any
                bgagent approve <task_id> 01KPR... [--scope ...]
                bgagent deny <task_id> 01KPR... [--reason "..."]
                timeout 300s
    ```
17. Hook enters poll loop:
    ```python
    async def _poll_for_decision(task_id, request_id, timeout_s):
        start = time.monotonic()
        interval = 2
        while True:
            elapsed = time.monotonic() - start
            if elapsed > timeout_s:
                return TimedOut()
            if elapsed > 30:
                interval = 5  # backoff
            row = await _ddb_get_approval(task_id, request_id)
            if row["status"] != "PENDING":
                return Decided(row)
            await asyncio.sleep(interval)
    ```

### User responds

18. User in Terminal B runs `bgagent approve <task_id> <req_id> --scope tool_type_session`.
19. CLI validates scope syntax client-side.
20. CLI POSTs `/v1/tasks/{task_id}/approve` with `{request_id, decision: "approve", scope: "tool_type_session"}`.
21. `ApproveTaskFn`:
    - Validates Cognito JWT, ownership check (`TaskTable.user_id == caller`)
    - Looks up row in `TaskApprovalsTable`. If not found → 404. If already decided → 409 CONFLICT.
    - Conditional update: `UpdateExpression: SET #status = :approved, decided_at = :now, scope = :scope WITH ConditionExpression: #status = :pending`
    - On success: returns 202 `{task_id, request_id, status: "APPROVED", scope, decided_at}`
    - On ConditionalCheckFailedException: returns 409 `TASK_ALREADY_DECIDED`
22. Agent's poll reads the `APPROVED` row on next tick (within 2-5s).
23. Hook:
    - Emits `agent_milestone("approval_granted", {request_id, scope, decided_at})`
    - If `scope != "this_call"`: adds scope to `PolicyEngine._allowlist`. Subsequent matching tool calls skip Cedar soft-deny entirely.
    - Conditional update `TaskTable.status`: `AWAITING_APPROVAL → RUNNING`
    - Returns `{"permissionDecision": "allow"}` to SDK
24. SDK runs the tool. Stream shows:
    ```
    [14:00:12]  ★ approval_granted: request_id=01KPR... scope=tool_type_session
    [14:00:12]  ▶ Bash: git push --force origin feature-x
    [14:00:14]  ◀ Bash: remote: Force pushed. New SHA abc123.
    ```

### Continuation

25. Agent continues with its turn, hits another `Bash` call (say `git log --oneline -5`).
26. PreToolUse hook → PolicyEngine.evaluate_tool_use:
    - Hard-deny: no match
    - Allowlist: `tool_type:Bash` ← matches. Returns ALLOW fast-path.
27. No new approval request. Tool runs immediately.

28. Eventually agent reaches task completion, opens PR, writes memory, task → `COMPLETED`.

---

## 5. Cedar policy authoring guide

### 5.1 Policy file layout

Two physical files, each with exactly one tier:

- `agent/policies/hard_deny.cedar` — contains ONLY `@tier("hard")` policies
- `agent/policies/soft_deny.cedar` — contains ONLY `@tier("soft")` policies

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
  maxPreApprovalScope: "tool_type_session"   # optional; caps what --pre-approve can grant
```

`PolicyEngine.__init__` concatenates built-in + blueprint rules per tier, validates with a probe `cedarpy.is_authorized()` call, falls back to defaults if blueprint rules are malformed (logs WARN).

### 5.2 Annotation reference

| Annotation | Required? | Values | Purpose |
|---|---|---|---|
| `@rule_id("...")` | Yes on soft-deny, recommended on hard-deny | Kebab-case or snake_case identifier, unique across both tiers | Stable ID for `--pre-approve rule:X` and for audit trail. Must be unique across ALL loaded policies; `PolicyEngine.__init__` raises on duplicates. |
| `@tier("hard"\|"soft")` | Yes | Exactly one of "hard" or "soft" | Validates policy is in the correct file/section. Engine rejects mismatch at load time. |
| `@approval_timeout_s("N")` | No | Integer seconds | Per-rule timeout. If absent, uses task default. Has no effect on hard-deny rules. |
| `@severity("low"\|"medium"\|"high")` | No | One of the three | Shown in CLI approval prompt, colored by severity. Default: "medium". |
| `@category("...")` | No | "destructive", "network", "filesystem", "auth", or free-form | UX grouping. CLI could filter approvals by category. Not enforced. |

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
```

**Gate destructive git ops** (soft-deny, medium severity):
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
  when { context.command like "*git push --force origin main*" };
```

A force-push to any branch needs approval in 300s. A force-push specifically to `origin main` gives the user 600s and elevates severity. If the command matches both rules, multi-match merging picks `min(300, 600) = 300s` and `max(medium, high) = high`.

**Protect sensitive file paths** (soft-deny):
```cedar
@tier("soft")
@rule_id("write_env_files")
@approval_timeout_s("600")
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*.env" };

@tier("soft")
@rule_id("write_infrastructure")
@approval_timeout_s("900")
@severity("high")
@category("filesystem")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "infrastructure/*" };

@tier("soft")
@rule_id("write_credentials")
@approval_timeout_s("300")
@severity("high")
@category("auth")
forbid (principal, action == Agent::Action::"write_file", resource)
  when { context.file_path like "*credentials*" };
```

**Gate whole tools** (soft-deny):
```cedar
@tier("soft")
@rule_id("webfetch_any")
@approval_timeout_s("300")
@severity("medium")
@category("network")
forbid (principal, action == Agent::Action::"invoke_tool",
        resource == Agent::Tool::"WebFetch");
```

Per the sentinel trick (see §6.2), `invoke_tool` matches on the real tool-name UID. The other actions (`write_file`, `execute_bash`) use a sentinel UID with the real value in `context`.

### 5.4 Gotchas for policy authors

**`like` is glob, not regex.** Only `*` (zero-or-more) and `?` (exactly-one-char) wildcards. If you need regex, write multiple `forbid` rules.

**Case sensitivity.** `like` is case-sensitive. `*rm -rf*` won't match `*Rm -Rf*`. If case-insensitivity matters, write both variants.

**Don't match `resource ==` for user-supplied values.** `Bash` commands and file paths go through the sentinel UID. Always use `context.command` / `context.file_path` in the `when` clause, never `resource == ...`.

**`@rule_id` must be globally unique.** Including across tiers. `PolicyEngine.__init__` raises on duplicates to prevent confusion.

**Hard-deny rules shouldn't have `@approval_timeout_s`.** It has no effect. Engine warns but doesn't reject (backward compatibility if someone moves a rule between tiers).

**The default ruleset is shared across all tasks.** Per-task overrides live in the Blueprint and are isolated to tasks on that repo. The engine never allows a task to loosen the default hard-deny set via Blueprint — only add to it.

---

## 6. Engine implementation

### 6.1 Extended `PolicyDecision` shape

```python
from dataclasses import dataclass
from enum import Enum

class Outcome(str, Enum):
    ALLOW = "allow"
    DENY = "deny"                      # absolute (hard-deny or upstream error)
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
```

### 6.2 `evaluate_tool_use` skeleton

```python
def evaluate_tool_use(self, tool_name: str, tool_input: dict) -> PolicyDecision:
    start = time.monotonic()
    base_context = {"task_type": self._task_type, "repo": self._repo}

    # STEP 1 — Hard-deny (absolute)
    hard = self._eval_tier(self._hard_policies, tool_name, tool_input, base_context)
    if hard.decision == "deny":
        return PolicyDecision(outcome=Outcome.DENY,
                              reason=f"Hard-deny: {hard.rule_ids}",
                              duration_ms=_elapsed(start))

    # STEP 2 — Allowlist fast-path
    if self._allowlist.matches(tool_name, tool_input, self._rule_id_map):
        return PolicyDecision(outcome=Outcome.ALLOW,
                              reason="Pre-approved by allowlist",
                              duration_ms=_elapsed(start))

    # STEP 3 — Soft-deny (require approval)
    soft = self._eval_tier(self._soft_policies, tool_name, tool_input, base_context)
    if soft.decision == "deny":
        annotations = self._merge_annotations(soft.rule_ids)
        return PolicyDecision(
            outcome=Outcome.REQUIRE_APPROVAL,
            reason=f"Soft-deny: {', '.join(annotations['rule_ids'])}",
            timeout_s=annotations["timeout_s"],       # min across matches, capped by task default
            severity=annotations["severity"],         # max across matches
            matching_rule_ids=tuple(annotations["rule_ids"]),
            duration_ms=_elapsed(start),
        )

    # STEP 4 — Default allow
    return PolicyDecision(outcome=Outcome.ALLOW, reason="permitted",
                          duration_ms=_elapsed(start))
```

Each `_eval_tier` call does up to three Cedar `is_authorized` calls (invoke_tool + optional write_file + optional execute_bash), identical to today's engine. The only change is returning structured `rule_ids` from `diagnostics.reasons` instead of throwing it away.

### 6.3 Annotation merging

When multiple soft-deny rules match a single tool call:

```python
def _merge_annotations(self, policy_ids: list[str]) -> dict:
    rule_ids, timeouts, severities = [], [], []
    for pid in policy_ids:
        ann = self._annotations[pid]
        rule_ids.append(ann.get("rule_id", pid))
        if "approval_timeout_s" in ann:
            timeouts.append(int(ann["approval_timeout_s"]))
        severities.append(ann.get("severity", "medium"))

    # Task default is applied if a matched rule has no annotation.
    timeouts.append(self._task_default_timeout_s)

    return {
        "rule_ids": rule_ids,
        "timeout_s": min(timeouts),  # stricter wins
        "severity": _max_severity(severities),  # "high" > "medium" > "low"
    }
```

**Rationale for min/max choices**:
- **Timeout → min**: multiple rules matching means multiple concerns. Users should have *less* time to decide when stakes are higher. A 60s `@approval_timeout_s` rule for `DROP TABLE` combined with a 600s rule for `write_file` means: "we have two reasons to be cautious, decide faster".
- **Severity → max**: likewise — the most severe concern governs the UX coloring.

### 6.4 Allowlist data structure

```python
class ApprovalAllowlist:
    def __init__(self, initial_scopes: list[str]):
        self._all_session = False
        self._tool_types: set[str] = set()
        self._rule_ids: set[str] = set()
        self._bash_patterns: list[str] = []  # glob patterns, matched via fnmatch

        for scope in initial_scopes:
            self.add(scope)

    def add(self, scope: str) -> None:
        if scope == "all_session":
            self._all_session = True
        elif scope.startswith("tool_type:"):
            self._tool_types.add(scope.split(":", 1)[1])
        elif scope.startswith("rule:"):
            self._rule_ids.add(scope.split(":", 1)[1])
        elif scope.startswith("bash_pattern:"):
            self._bash_patterns.append(scope.split(":", 1)[1])
        else:
            raise ValueError(f"unknown scope: {scope!r}")

    def matches(self, tool_name: str, tool_input: dict,
                rule_id_map: dict[str, str]) -> bool:
        if self._all_session:
            return True
        if tool_name in self._tool_types:
            return True
        if tool_name == "Bash":
            cmd = tool_input.get("command", "")
            if any(fnmatch(cmd, pat) for pat in self._bash_patterns):
                return True
        # rule_ids are matched against the soft-deny rules that WOULD have
        # fired — checked after soft-deny eval, not before. See note in
        # evaluate_tool_use step 3 (rule-match allowlist interleave).
        return False
```

**Note on `rule:` scope matching**: unlike `tool_type` / `bash_pattern` / `all_session` which can be checked before Cedar, `rule:X` needs to know *which rule* would have fired. We handle this by running soft-deny eval unconditionally and checking `rule_id ∈ allowlist._rule_ids` before returning REQUIRE_APPROVAL:

```python
# Inside evaluate_tool_use STEP 3 (soft-deny):
if soft.decision == "deny":
    annotations = self._merge_annotations(soft.rule_ids)
    # Rule-scope allowlist check happens AFTER soft-deny eval
    if any(rid in self._allowlist._rule_ids for rid in annotations["rule_ids"]):
        return PolicyDecision(outcome=Outcome.ALLOW,
                              reason=f"Allowlist rule: {annotations['rule_ids']}")
    return PolicyDecision(outcome=Outcome.REQUIRE_APPROVAL, ...)
```

This means `rule:` scopes cost one extra soft-deny eval compared to `tool_type:` scopes. Acceptable — soft-deny eval is the same sub-ms Cedar call.

### 6.5 PreToolUse hook changes

Current (Phase 1a/1b):
```python
async def pre_tool_use_hook(...) -> dict:
    decision = engine.evaluate_tool_use(tool_name, tool_input)
    if decision.allowed:
        return {"hookSpecificOutput": {"permissionDecision": "allow"}}
    return {"hookSpecificOutput": {
        "permissionDecision": "deny",
        "permissionDecisionReason": decision.reason,
    }}
```

Phase 3:
```python
async def pre_tool_use_hook(hook_input, tool_use_id, ctx, *,
                            engine, task_id, progress, sse_adapter,
                            task_default_timeout_s):
    decision = engine.evaluate_tool_use(tool_name, tool_input)

    if decision.outcome == Outcome.ALLOW:
        return _allow()
    if decision.outcome == Outcome.DENY:
        return _deny(decision.reason)

    # REQUIRE_APPROVAL path
    request_id = _ulid()
    timeout_s = min(decision.timeout_s or task_default_timeout_s,
                    task_default_timeout_s)

    await _write_approval_request(
        task_id, request_id, tool_name, tool_input,
        reason=decision.reason, severity=decision.severity,
        matching_rule_ids=decision.matching_rule_ids, timeout_s=timeout_s)
    await _transition_to_awaiting_approval(task_id)

    progress.write_agent_milestone("approval_requested", {
        "request_id": request_id, "tool_name": tool_name,
        "input_preview": _preview(tool_input), "reason": decision.reason,
        "severity": decision.severity, "timeout_s": timeout_s,
        "matching_rule_ids": list(decision.matching_rule_ids),
    })
    sse_adapter.write_agent_milestone(...)  # same payload

    outcome = await _poll_for_decision(task_id, request_id, timeout_s)
    await _transition_to_running(task_id)  # always, whether approved or denied

    if outcome.status == "APPROVED":
        progress.write_agent_milestone("approval_granted", {...})
        if outcome.scope and outcome.scope != "this_call":
            engine._allowlist.add(outcome.scope)
        return _allow()

    # DENIED or TIMED_OUT
    reason = outcome.reason or f"timeout (no response in {timeout_s}s)"
    progress.write_agent_milestone(
        "approval_denied" if outcome.status == "DENIED" else "approval_timed_out",
        {...})
    return _deny(f"User {outcome.status.lower()}: {reason}")
```

Cedar policy eval latency stays sub-millisecond. The "wait" is a coroutine park — the agent's asyncio loop continues processing other things (SSE queue drain, health checks, keepalives).

---

## 7. REST API contract

Two new endpoints. Both Cognito JWT-authenticated on API Gateway (same pattern as existing `/tasks/*`).

### 7.1 `POST /v1/tasks/{task_id}/approve`

**Request** (CLI → API Gateway → `ApproveTaskFn`):
```http
POST /v1/tasks/01KPW.../approve HTTP/1.1
Authorization: Bearer <cognito_id_token>
Content-Type: application/json

{
  "request_id": "01KPR...",
  "decision": "approve",
  "scope": "tool_type_session"     // optional; defaults to "this_call"
}
```

**Responses**:

| Status | Code | When | Body |
|---|---|---|---|
| 202 | (none) | Success | `{task_id, request_id, status: "APPROVED", scope, decided_at}` |
| 400 | `VALIDATION_ERROR` | Bad scope format, missing fields | `{error, message, field}` |
| 401 | `UNAUTHORIZED` | Missing/invalid JWT | — |
| 403 | `FORBIDDEN` | Task owned by another user | — |
| 404 | `REQUEST_NOT_FOUND` | `task_id` + `request_id` row not in `TaskApprovalsTable` | — |
| 409 | `REQUEST_ALREADY_DECIDED` | Status is not PENDING (already APPROVED / DENIED / TIMED_OUT) | `{error, message, current_status}` |
| 503 | `SERVICE_UNAVAILABLE` | DDB throttled or upstream failure | — |

**Scope validation** (server-side):
- `this_call` — always allowed
- `tool_type:<tool_name>` — `tool_name` must be in the known tool list (Read, Bash, Write, Edit, Glob, Grep, WebFetch, ...)
- `bash_pattern:<glob>` — glob ≤128 chars, no embedded newlines, basic sanity
- `rule:<rule_id>` — `rule_id` must exist in the loaded soft-deny policy set AND be annotated with `@tier("soft")` (never `@tier("hard")`)
- `all_session` — allowed unless Blueprint sets `maxPreApprovalScope < all_session`

**Atomicity**: ApproveTaskFn uses a single `UpdateItem` on `TaskApprovalsTable` with `ConditionExpression: #status = :pending`. Either the status flips atomically or the call fails with 409. No read-then-write race. If the row doesn't exist, ConditionalCheckFailedException → we distinguish "not found" vs "already decided" by a `GetItem` retry (or by using `ReturnValuesOnConditionCheckFailure=ALL_OLD`).

### 7.2 `POST /v1/tasks/{task_id}/deny`

Mirrors `/approve` but writes `status = "DENIED"` and expects an optional `reason` field:

```json
{
  "request_id": "01KPR...",
  "reason": "use force-with-lease instead; force is too risky"   // optional, ≤1000 chars
}
```

The reason is stored on the row and surfaced to the agent verbatim when it reads the denial. This is effectively **steering via denial** — the agent gets the text and can adjust.

### 7.3 `POST /v1/tasks` — new optional fields

Extended request shape:

```json
{
  "repo": "my-org/my-app",
  "task": "...",
  "task_type": "new_task",
  "approval_timeout_s": 600,              // optional, default 300, range [30, maxLifetime - 300]
  "initial_approvals": [                  // optional, max 20 entries, each ≤128 chars
    "tool_type:Read",
    "bash_pattern:git status*",
    "rule:safe_read_config"
  ]
}
```

`CreateTaskFn` validations:
1. Length cap (20 entries)
2. Per-entry length cap (128 chars)
3. Scope format parsing (same rules as §7.1)
4. `rule:<id>` must name a soft-deny rule (not hard-deny)
5. `maxPreApprovalScope` ceiling from blueprint
6. `approval_timeout_s` within `[30, maxLifetime - 300]` — the lower bound prevents unusable timeouts; upper bound leaves 5 min after max approval for cleanup

---

## 8. CLI UX

### 8.1 New commands

```bash
# Approve a specific pending request
bgagent approve <task_id> <request_id> [--scope <scope>] [--output text|json]

# Deny a specific pending request, optionally with a reason the agent sees
bgagent deny <task_id> <request_id> [--reason "..."] [--output text|json]
```

### 8.2 Extended `submit` / `run` flags

```bash
bgagent submit \
  --repo my-org/my-app \
  --task "..." \
  --approval-timeout 600 \
  --pre-approve tool_type:Read \
  --pre-approve bash_pattern:"git status*" \
  --pre-approve rule:safe_file_read

# Shorthand for no approval gates (requires --yes):
bgagent submit --task "..." --pre-approve all_session --yes
```

### 8.3 Streaming UX changes

No interactive prompts in `bgagent run` streaming. Approval requests surface as:

```text
[14:00:00]  ★ approval_requested: Bash "git push --force origin feature-x" (severity=medium)
            reason:   Cedar soft-deny: force_push_any
            respond:  bgagent approve <task-id> 01KPR... [--scope tool_type_session]
                      bgagent deny    <task-id> 01KPR... [--reason "..."]
            timeout:  300s
```

Terminal B (or a different window/tab) runs `bgagent approve` / `deny`. Terminal A continues streaming.

Severity colors the line:
- `high` → red background or bold-red prefix
- `medium` → yellow prefix
- `low` → default

### 8.4 Safety UX

When the user passes `--pre-approve all_session`:

```bash
$ bgagent submit --task "apply terraform plan" --pre-approve all_session
WARNING: --pre-approve all_session disables all approval gates for this task.
         The agent will run tools autonomously without any confirmation,
         subject only to hard-deny policies (rm -rf /, write to .git/, etc).
         Add --yes to skip this prompt.
Continue? [y/N]
```

Unless `--yes` is present. Hard confirmation stops accidental auto-submit.

### 8.5 Denying with a reason is steering

A common pattern: user says no, but suggests an alternative.

```bash
bgagent deny 01KPW... 01KPR... --reason "use --force-with-lease instead; it's safer"
```

The agent reads `"User DENIED: use --force-with-lease instead; it's safer"` as its next tool-use context. It adapts. This is the approval equivalent of a Phase 2 nudge — mid-task steering through a denial channel.

---

## 9. State machine + concurrency

### 9.1 New state: AWAITING_APPROVAL

Transitions added (extending §7 of INTERACTIVE_AGENTS.md):

```
RUNNING → AWAITING_APPROVAL  (on REQUIRE_APPROVAL from engine)
AWAITING_APPROVAL → RUNNING  (on approve OR deny OR timeout; the hook returns
                              to SDK in all three cases and the turn continues)
AWAITING_APPROVAL → CANCELLED (on explicit `bgagent cancel`)
```

No direct `AWAITING_APPROVAL → COMPLETED/FAILED`. Terminal transitions always flow through `RUNNING → FINALIZING → terminal`.

### 9.2 Orchestrator impact

The durable orchestrator (`orchestrate-task.ts`) polls `TaskTable.status` every 30s looking for terminal states. Three updates needed:

1. `waitStrategy` adds `AWAITING_APPROVAL` as a valid non-terminal state.
2. `finalizeTask` recognizes `AWAITING_APPROVAL` — must NOT hit "Unexpected state" fallback.
3. `ACTIVE_STATUSES` set (used by `GET /tasks?status=active` and `reconcile-concurrency.ts`) gains `AWAITING_APPROVAL`.
4. `task_state.py::write_terminal` condition expression accepts `AWAITING_APPROVAL` as a valid source state (currently only allows RUNNING/HYDRATING/FINALIZING).

### 9.3 Concurrency slot semantics

**AWAITING_APPROVAL holds the user's concurrency slot.**

Rationale: the Docker container is alive. Memory is allocated. The AgentCore microVM pool is committed to it. Releasing the slot while the resource is still held lies to the concurrency accounting and opens up a resource-exhaustion vector (see discussion log in `project_phase3_cedar_hitl_design.md`).

Concrete behavior:

```text
Bob's per-user cap: 10.
t=0:    Bob submits 10 tasks. count=10. 11th submit → 429.
t=2m:   Task #1 hits AWAITING_APPROVAL. count still 10.
        Bob's 12th submit → 429. He must approve, cancel, or wait.
t=30m:  Bob approves task #1. task → RUNNING. count still 10.
t=45m:  Task #1 completes. count → 9. Bob can submit task #11.
```

**No escape hatch in v1.** If Bob can't respond for hours, he either times out (→ denied, task resumes with denial context) or `bgagent cancel`s the task to free the slot.

Future work: `bgagent approve --defer` = "I can't respond right now, cancel the task and release the slot". Clearer than silent timeout. Deferred.

### 9.4 `maxLifetime` clock keeps ticking

AgentCore Runtime's `maxLifetime = 28800s` (8h) is an absolute timer from session start. It does NOT pause during `AWAITING_APPROVAL`. If a user takes 7 hours to approve, only 1 hour remains. The approval timeout is also bounded: `approval_timeout_s ≤ maxLifetime - 300` (5-min cleanup margin) at submit time so we can't configure a timeout that can't fit.

### 9.5 Reconciliation

`reconcile-concurrency.ts` (scheduled every 5 min) already scans for orphaned concurrency counters. With `AWAITING_APPROVAL` added to `ACTIVE_STATUSES`, it'll correctly count awaiting tasks as active.

`reconcile-stranded-tasks.ts` (Phase 1b) fails interactive tasks stuck without an SSE subscriber for ≥300s. Doesn't apply to AWAITING_APPROVAL — the task isn't stranded; it's waiting on the user. Reconciler must skip `AWAITING_APPROVAL` tasks (add to exclusion list).

---

## 10. Data model

### 10.1 New DynamoDB table: `TaskApprovalsTable`

```typescript
// cdk/src/constructs/task-approvals-table.ts
new dynamodb.Table(this, 'Table', {
  partitionKey: { name: 'task_id',   type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'request_id', type: dynamodb.AttributeType.STRING },  // ULID
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  timeToLiveAttribute: 'ttl',  // 1h retention
  stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,  // for fan-out hooks (§11)
  removalPolicy: RemovalPolicy.RETAIN,
});
```

Attributes:

| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | S | Yes | PK; ULID matching TaskTable |
| `request_id` | S | Yes | SK; ULID minted by agent |
| `tool_name` | S | Yes | "Bash", "Write", etc. |
| `tool_input_preview` | S | Yes | First 256 chars of serialized tool input |
| `tool_input_sha256` | S | Yes | Full-input hash for audit |
| `reason` | S | Yes | Cedar matching rule description |
| `severity` | S | Yes | "low" \| "medium" \| "high" |
| `matching_rule_ids` | SS | Yes | Set of soft-deny rule IDs that matched |
| `status` | S | Yes | PENDING \| APPROVED \| DENIED \| TIMED_OUT |
| `created_at` | S | Yes | ISO8601 |
| `decided_at` | S | No | Set when status != PENDING |
| `scope` | S | No | Set on APPROVED; one of this_call \| tool_type:X \| bash_pattern:X \| rule:X \| all_session |
| `deny_reason` | S | No | Set on DENIED; user-provided message |
| `timeout_s` | N | Yes | Resolved timeout for audit |
| `ttl` | N | Yes | Unix epoch seconds; `created_at + 3600` |
| `user_id` | S | Yes | For GSI and ownership checks |
| `repo` | S | Yes | Denormalized for fan-out |

**Why 1h TTL:** approval rows are never read again once the agent has polled the decision. Keeping them for 1h gives operators a short debugging window without the cost of long retention. Long-term audit goes through `TaskEventsTable` (90d TTL on the `agent_milestone("approval_*")` events).

**No GSI in v1.** Query pattern is always `(task_id, request_id)` known. If we add a "list all pending approvals for user" endpoint later, add GSI on `user_id`.

### 10.2 `TaskTable` additions

Three new attributes on the existing task row:

| Name | Type | Required | Description |
|---|---|---|---|
| `approval_timeout_s` | N | No | Default timeout for soft-deny gates. Default 300. |
| `initial_approvals` | SS | No | Scope strings from submit time |
| `awaiting_approval_request_id` | S | No | Set when status = AWAITING_APPROVAL; cleared on transition back |

`awaiting_approval_request_id` is a convenience pointer so consumers (dashboards, orchestrator) can resolve the active request without scanning `TaskApprovalsTable`.

### 10.3 TaskTable status enum update

Add `AWAITING_APPROVAL` to the `TaskStatus` enum in `cdk/src/constructs/task-status.ts`:

```typescript
export const TASK_STATUSES = [
  'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL',  // NEW
  'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
] as const;

export const ACTIVE_STATUSES = new Set([
  'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING',
]);

export const VALID_TRANSITIONS = {
  // ...existing...
  RUNNING: ['FINALIZING', 'CANCELLED', 'TIMED_OUT', 'FAILED',
            'AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['RUNNING', 'CANCELLED'],
  // ...
};
```

---

## 11. Observability

### 11.1 New `agent_milestone` event types

Emitted by the PreToolUse hook to both `ProgressWriter` (DDB, 90d) and `sse_adapter` (live stream). See §8.4 of INTERACTIVE_AGENTS.md for the event type taxonomy.

| Event | Metadata | Purpose |
|---|---|---|
| `pre_approvals_loaded` | `{count, scopes[]}` | Emit at container start so the stream shows the starting posture |
| `approval_requested` | `{request_id, tool_name, input_preview, reason, severity, timeout_s, matching_rule_ids[]}` | Stream marker for Terminal A + DDB audit |
| `approval_granted` | `{request_id, scope, decided_at}` | Shown in stream when agent resumes |
| `approval_denied` | `{request_id, reason, decided_at}` | Shown in stream when agent resumes |
| `approval_timed_out` | `{request_id, timeout_s}` | Shown in stream when agent resumes |
| `approval_write_failed` | `{request_id, error}` | Fired when DDB write to TaskApprovalsTable fails (fail-closed → deny) |

### 11.2 Fan-out hook event types

`TaskApprovalsTable` has DDB Streams enabled. `fanout-task-events.ts` consumes the stream and dispatches to slack/github/email stubs. New dispatch rules:

- Slack: on `status: PENDING → *` — "Agent @task_id requests approval for Bash: `git push --force`"
- Email: on `status: PENDING` with `severity: high` — only high-severity approvals generate emails to prevent noise
- GitHub: none (not applicable)

These are stubs in Phase 3a (fan-out plane from Phase 1b §8.9 is already "skeletal" — approvals ride the same shape). Real integrations later.

### 11.3 Dashboard additions

Extend `TaskDashboard` (`cdk/src/constructs/task-dashboard.ts`):

- **Approval request rate**: count of `approval_requested` per hour
- **Approval response time**: p50/p99 of (`decided_at - created_at`)
- **Approval outcome distribution**: granted vs denied vs timed-out (stacked bar)
- **Tasks stuck in AWAITING_APPROVAL**: alarm when a task has been awaiting >timeout_s + 1min

### 11.4 Alarms

New CloudWatch alarms in `task-dashboard.ts`:

- `HighApprovalTimeoutRate`: >50% of approval_requested in 1h end in TIMED_OUT → "users not responding, check notifications or reduce gating"
- `StuckAwaitingApproval`: task in AWAITING_APPROVAL >timeout_s + 1min → "approval poll may be hung"
- `HighApprovalWriteFailureRate`: >1% of approval_write_failed events → "DDB throttled or IAM drift"

### 11.5 OTEL trace integration

Every `agent_milestone("approval_*")` event carries `trace_id` / `span_id` (§8.5 existing). A span `hitl.approval_wait` bracketing the PreToolUse poll loop makes approval latency visible in X-Ray: `span.duration = decided_at - created_at`.

---

## 12. Security model

### 12.1 Trust boundaries

- **Agent container ↔ TaskApprovalsTable (write pending, poll decisions)**: IAM role on the runtime has `GetItem` / `PutItem` on the table, scoped by `task_id` partition key (see 12.4).
- **User CLI ↔ API Gateway**: Cognito JWT (same authorizer as /tasks/*).
- **ApproveTaskFn/DenyTaskFn ↔ TaskApprovalsTable**: Lambda IAM policy allows `UpdateItem` conditional on `user_id == caller`.

### 12.2 Ownership enforcement

Before flipping an approval row to APPROVED/DENIED, `ApproveTaskFn` must verify the caller owns the task:

1. `GetItem` on `TaskTable` by `task_id`.
2. Check `TaskTable.user_id == cognito_sub_from_jwt`.
3. If mismatch → return 403 FORBIDDEN. Log `approval_unauthorized` event on TaskEventsTable (not TaskApprovalsTable — don't leak that a row exists).

### 12.3 Race prevention

Two potential races:

**Race 1: user approves at T while agent times out at T+ε.**
- Agent's poll times out → hook writes `TIMED_OUT` via conditional update `status = :pending`.
- User's CLI writes `APPROVED` via conditional update `status = :pending`.
- **Only one succeeds atomically** (DDB conditional write). Second call gets ConditionalCheckFailedException → 409.
- If APPROVED wins: user gets 202, agent reads APPROVED on next poll (hasn't timed out yet from agent's perspective if poll happens in the <1s window). Agent proceeds.
- If TIMED_OUT wins: user gets 409 REQUEST_ALREADY_DECIDED with `current_status: "TIMED_OUT"`. User sees "approval expired". Agent already denied the tool call.

**Race 2: user approves twice in rapid succession (double-click).**
- Same mechanism: second UpdateItem fails with ConditionalCheckFailedException. Second CLI invocation gets 409. Idempotent.

**Race 3: agent resumes task (AWAITING_APPROVAL → RUNNING) concurrently with user cancel.**
- Agent writes `RUNNING` via conditional update `status = :awaiting`.
- User writes `CANCELLED` via conditional update `status = :awaiting`.
- One wins. If CANCELLED wins: agent's conditional-update fails → agent sees it was cancelled → aborts remaining work. If RUNNING wins: CLI gets 409 TASK_ALREADY_RUNNING → tells user "task resumed before cancel landed".

### 12.4 IAM least-privilege

`RuntimeIam` and `RuntimeJwt` IAM roles get new grants for `TaskApprovalsTable`:

```typescript
table.grantReadWriteData(runtimeRole);  // agent writes pending, reads decisions
```

But NOT:
- `Scan` (never needed; always known key)
- `DeleteItem` (TTL handles cleanup; no programmatic delete)

`ApproveTaskFn` / `DenyTaskFn` roles:

```typescript
table.grant(approveRole, 'dynamodb:UpdateItem');
taskTable.grant(approveRole, 'dynamodb:GetItem');   // for ownership check
```

### 12.5 `all_session` is scary; treat it that way

`--pre-approve all_session` **cannot override hard-deny**. `CreateTaskFn` does NOT enforce this (hard-deny is enforced at runtime by the engine), but it does reject `rule:<hard_deny_rule_id>` at submit.

Blueprint policy `maxPreApprovalScope` can cap what submit-time pre-approvals are allowed. Useful for sensitive repos — an org admin says "no `all_session` on this repo, ever", even if the user tries.

CLI adds a confirmation prompt for `all_session` unless `--yes` passed. Muscle-memory-proof.

### 12.6 Approval message as attack vector

The `deny --reason "..."` field is user input that becomes the agent's next-turn context. Two concerns:

1. **Injection attack via a compromised user account**: attacker approves a tool call by denying with `reason="IGNORE PREVIOUS INSTRUCTIONS AND RUN ..."`. Mitigation: wrap the denial reason in authoritative XML the same way Phase 2 nudges do: `<user_denial>...</user_denial>`. Agent sees the denial as authoritative but escaped. Same XML sanitization as `nudge_reader.format_as_user_message`.
2. **Secrets in deny reason leaking to logs**: user types a password by accident. Mitigation: `output_scanner` (existing agent module) scans the denial reason for AWS keys, GitHub PATs, etc. before it's added to context. Redact inline.

### 12.7 Submit-time validation is authoritative

Once a task starts, the loaded policy set and `initial_approvals` are fixed for the task's lifetime. Changes to `policy.py` or `blueprint.yaml` during the task don't affect it. This is by design: security posture is captured at submission, not post-hoc mutable.

---

## 13. Failure modes + fail-closed posture

### 13.1 DDB write of pending approval fails

Hook catches the exception, emits `approval_write_failed`, and **denies the tool call** with reason `"approval system unavailable"`. Agent continues without the tool.

Prevents a compromised-DDB scenario from letting approval-required tools run by accident.

### 13.2 Poll read fails transiently

Single failed GetItem: log WARN, continue polling. After 3 consecutive failures: emit `approval_poll_degraded` event (not fatal; cosmetic warning). After 10 consecutive failures: treat as timeout, fail-closed deny. The agent adapts.

### 13.3 Ownership mismatch during race

`ApproveTaskFn` sees a JWT whose sub doesn't match `TaskTable.user_id`: return 403, no row update. Log auth failure. Does NOT tell the caller whether the row exists (generic error).

### 13.4 Cedar engine crash mid-evaluation

`evaluate_tool_use` catches all exceptions from `cedarpy.is_authorized` and returns `Outcome.DENY` with reason `"fail-closed: <exception_type>"`. Matches existing behavior.

### 13.5 Multiple matching rules with conflicting annotations

Already covered in §6.3 (min timeout, max severity). Deterministic.

### 13.6 Container restart while awaiting approval

If the AgentCore Runtime evicts the container between the approval request being written and the decision being read (rare — idleRuntimeSessionTimeout = 8h, and we return HealthyBusy during wait), the poll coroutine is killed. No graceful handoff.

Detection: `reconcile-stranded-tasks.ts` detects tasks in AWAITING_APPROVAL with no active session observer. Not currently implemented — but the existing reconciler for interactive tasks without SSE has the same shape and can be extended.

For v1: accept restart → stranded-approval loss, require user to `bgagent cancel` and resubmit. Document as a known gap.

### 13.7 User approves a task that's already transitioned

E.g., task failed while user was typing the approve command. `ApproveTaskFn` checks `TaskTable.status == AWAITING_APPROVAL` before updating. On mismatch → 409 TASK_NOT_AWAITING_APPROVAL.

---

## 14. Sample scenarios

### 14.1 Scenario A: force-push with per-rule timeout

**Setup**: Repo `my-org/my-app` blueprint extends soft-deny with `force_push_main` (@approval_timeout_s=600). Task default is 300s.

```bash
$ bgagent run --repo my-org/my-app \
    --task "rebase feature-x onto main and push" \
    --approval-timeout 300
```

At the point the agent wants to force-push:

```
[14:00:00]  ★ approval_requested: Bash "git push --force origin main" (severity=high)
            reason:   Cedar soft-deny: force_push_any, force_push_main
            respond:  bgagent approve <task-id> 01KPR... [--scope tool_type_session]
            timeout:  300s   # min(300, 600) — stricter rule wins
```

User approves:
```bash
$ bgagent approve 01KPW... 01KPR... --scope tool_type_session
Approved: tool_type_session scope granted; all subsequent Bash calls auto-approved for this task.
```

Stream:
```
[14:00:08]  ★ approval_granted: request_id=01KPR... scope=tool_type_session
[14:00:08]  ▶ Bash: git push --force origin main
[14:00:10]  ◀ Bash: remote: Force pushed.
```

Later in the task: agent runs `Bash: git status`. Allowlist fast-path fires. No new approval.

### 14.2 Scenario B: DROP TABLE hits hard-deny

```bash
$ bgagent run --repo my-org/my-db --task "clean up test tables"
```

Agent writes and tries to run a SQL script:
```
[14:10:00]  ▶ Bash: psql -c "DROP TABLE test_users;"
```

PreToolUse hook:
- Hard-deny eval → matches `drop_table_any` rule (`like "*DROP TABLE*"`).
- Returns `DENY` immediately. No approval request created. No state transition.

Agent receives deny with reason `"Hard-deny: drop_table_any"`. Tries a different approach:
```
[14:10:01]  ▶ Bash: psql -c "DELETE FROM test_users; VACUUM test_users;"
```

This one doesn't match any rule. Tool runs. Task completes.

**Key property demonstrated**: hard-deny is not a friction point — it's a boundary. The user never sees it. The agent adapts.

### 14.3 Scenario C: Trusted automation with `all_session`

```bash
$ bgagent submit --repo my-org/infra \
    --task "apply approved terraform plan for staging-v2" \
    --pre-approve all_session \
    --yes   # skip the warning prompt

Submitted: 01KPW...
```

Blueprint on `my-org/infra` has `security.maxPreApprovalScope: "all_session"` (explicitly allowed on this repo).

Task starts, container loads:
```
[14:20:00]  ★ pre_approvals_loaded: count=1 scopes=[all_session]
```

Agent runs terraform apply, opens a PR with the plan output, task → COMPLETED. **Zero approval gates fire.** Hard-deny would still enforce if the agent tried to `rm -rf /` but no soft-deny rule gates anything.

### 14.4 Scenario D: Denying with steering reason

```bash
$ bgagent run --repo my-org/my-app \
    --task "Delete the old user dashboard; replace with redesigned v2" \
    --approval-timeout 600
```

Agent decides to run `Bash: rm -rf src/dashboard/v1` (hits `rm_rf_path` soft-deny rule).

```
[14:30:00]  ★ approval_requested: Bash "rm -rf src/dashboard/v1" (severity=medium)
```

User knows better:
```bash
$ bgagent deny 01KPW... 01KPR... \
    --reason "move it to src/dashboard/v1.deprecated instead of deleting; we may need to reference it in migrations"
```

Agent reads the denial in its next-turn context:
```
User DENIED this tool call. Reason: move it to src/dashboard/v1.deprecated
instead of deleting; we may need to reference it in migrations
```

Agent adapts:
```
[14:30:08]  ▶ Bash: git mv src/dashboard/v1 src/dashboard/v1.deprecated
[14:30:09]  ◀ Bash: (success)
```

Task proceeds down the new path.

**Key property demonstrated**: denying is steering. Users shouldn't feel like saying "no" is a refusal; it's a redirect.

### 14.5 Scenario E: AI-DLC pattern with per-phase pre-approvals

A workflow that runs three agents in sequence, with escalating trust:

```bash
# Phase 1: read-only analysis — gate all writes
$ bgagent submit --repo my-org/new-feature \
    --task "analyze the existing auth module and produce a design doc" \
    --pre-approve tool_type:Read \
    --pre-approve tool_type:Glob \
    --pre-approve tool_type:Grep \
    --pre-approve bash_pattern:"ls *" \
    --pre-approve bash_pattern:"find *"
# Any Write or destructive Bash hits soft-deny → gate

# Phase 2: documentation updates — open filesystem writes to docs/
$ bgagent submit --repo my-org/new-feature \
    --task "update docs/auth.md per the approved design doc" \
    --pre-approve tool_type:Read \
    --pre-approve tool_type:Write \
    --pre-approve bash_pattern:"git add docs/**" \
    --pre-approve bash_pattern:"git commit *"
# Writes to infrastructure/ or .env still gate. Pushes still gate.

# Phase 3: full implementation — relaxed, with reviewer safety net
$ bgagent submit --repo my-org/new-feature \
    --task "implement the auth module per approved design + docs" \
    --pre-approve all_session
    # (repo blueprint bans all_session for sensitive repos; rejected here
    #  if applied to prod repos)
```

Each task's security posture is declared at submission. No interactive gating needed for the routine parts. Mirrors real-world review workflows.

---

## 15. Implementation plan

### 15.1 Milestone structure

Ship as two milestones:

**Phase 3a** — core feature (3-4 weeks of work)
- Engine extension (hard + soft policy sets, annotations, three-outcome model)
- TaskApprovalsTable + new Lambdas + routes
- PreToolUse hook async wait
- `bgagent approve/deny` CLI commands
- `--pre-approve` on `submit` / `run`
- Happy path + fail-closed tests
- E2E on `backgroundagent-dev`

**Phase 3b** — polish (1-2 weeks)
- CLI inline streaming prompt (if UX research says yes)
- `approve --defer` escape hatch
- Dashboard additions + CloudWatch alarms
- More soft-deny policies in the default set based on real usage

### 15.2 Phase 3a task list

Roughly maps to the old §11 list but updated for the Cedar model. Order matters — later tasks depend on earlier ones.

| # | Package | File | Change |
|---|---|---|---|
| 1 | agent | `src/policy.py` | Extend `PolicyDecision` with `outcome/timeout_s/severity/matching_rule_ids`. Split `_DEFAULT_POLICIES` into `_HARD_DENY_POLICIES` + `_SOFT_DENY_POLICIES`. Add annotation parsing via `policies_to_json_str`. Implement `ApprovalAllowlist` class. |
| 2 | agent | `policies/hard_deny.cedar` (new) | Move current hard-deny rules (rm-rf, .git writes, force-push removed); add `@tier("hard")` + `@rule_id` annotations. |
| 3 | agent | `policies/soft_deny.cedar` (new) | Seed with force-push, `*.env`, `infrastructure/**`, credentials paths. Full annotations. |
| 4 | agent | `tests/test_policy.py` | Extend existing tests: three-outcome model, annotation merging, allowlist, pre-approval seeding. |
| 5 | cdk | `src/constructs/task-approvals-table.ts` (new) | DDB table construct with DDB Streams. |
| 6 | cdk | `src/handlers/approve-task.ts` (new) | POST /approve Lambda handler. |
| 7 | cdk | `src/handlers/deny-task.ts` (new) | POST /deny Lambda handler. |
| 8 | cdk | `src/handlers/shared/types.ts` | Add `ApprovalRequest`/`ApprovalResponse`/`DenyRequest`/scope validation types. |
| 9 | cdk | `src/handlers/shared/response.ts` | Add `REQUEST_ALREADY_DECIDED`, `REQUEST_NOT_FOUND`, `TASK_NOT_AWAITING_APPROVAL` codes. |
| 10 | cdk | `src/constructs/task-api.ts` | Wire `/approve` + `/deny` routes. Add grants. |
| 11 | cdk | `src/stacks/agent.ts` | Instantiate TaskApprovalsTable; pass table name as env to both runtimes. |
| 12 | cdk | `src/constructs/task-status.ts` | Add `AWAITING_APPROVAL` to status enum, ACTIVE_STATUSES, VALID_TRANSITIONS. |
| 13 | cdk | `src/handlers/create-task.ts` | Validate `initial_approvals` (scope syntax, cap, hard-deny rejection, blueprint max). Persist on TaskTable. |
| 14 | cdk | `src/handlers/shared/types.ts` | Extend `CreateTaskRequest` with `approval_timeout_s` + `initial_approvals`. |
| 15 | cdk | `src/handlers/orchestrate-task.ts` | Add `AWAITING_APPROVAL` to `waitStrategy` + `finalizeTask`. |
| 16 | cdk | `src/constructs/stranded-task-reconciler.ts` | Exclude `AWAITING_APPROVAL` tasks from stranded detection. |
| 17 | cdk | `src/handlers/fanout-task-events.ts` | Add dispatch rules for `approval_requested` + `approval_granted`/`denied`/`timed_out`. |
| 18 | agent | `src/hooks.py` | PreToolUse hook: handle REQUIRE_APPROVAL path — write row, transition status, poll loop, emit milestones. |
| 19 | agent | `src/task_state.py` | Add `AWAITING_APPROVAL` to state-transition helpers. |
| 20 | agent | `src/progress_writer.py` | Add `write_approval_request` / `write_approval_decision` convenience methods (thin wrappers around `write_agent_milestone`). |
| 21 | cli | `src/commands/approve.ts` (new) | `bgagent approve` command. |
| 22 | cli | `src/commands/deny.ts` (new) | `bgagent deny` command. |
| 23 | cli | `src/commands/submit.ts` + `run.ts` | Add `--approval-timeout` + `--pre-approve` flags. Client-side scope validation + all_session confirmation. |
| 24 | cli | `src/api-client.ts` | Add `approveTask` + `denyTask` + extended `createTask` methods. |
| 25 | cli | `src/types.ts` | Mirror CDK type changes. `Scope` union type + validator. |
| 26 | cdk | `test/handlers/approve-task.test.ts` (new) | Unit tests: happy path, race, ownership, scope validation. |
| 27 | cdk | `test/handlers/deny-task.test.ts` (new) | Same shape. |
| 28 | cdk | `test/handlers/create-task.test.ts` | Extend with `initial_approvals` validation tests. |
| 29 | cli | `test/commands/approve.test.ts` (new) | CLI command tests. |
| 30 | cli | `test/commands/deny.test.ts` (new) | CLI command tests. |
| 31 | agent | `tests/test_hooks.py` | Extend with REQUIRE_APPROVAL path tests (DDB mock). |
| 32 | docs | `docs/design/INTERACTIVE_AGENTS.md` | Replace §9.3 with cross-link to this doc. Update §7 (state machine) if needed. |

That's ~32 focused items. Typical size — Phase 2 was ~28.

### 15.3 Testing strategy

- **Unit tests**: every module gets direct tests. ~80% coverage target, matching Phase 2.
- **Integration tests**: Cedar eval + annotation merging, allowlist seeding, full PreToolUse-to-PolicyDecision pipeline.
- **E2E**: submit a task on `backgroundagent-dev`, trigger a soft-deny-matching tool, approve via CLI, verify flow. Repeat for deny, timeout, pre-approval.
- **Race tests**: parallel approve+timeout calls; assert only one wins.
- **Security tests**: call `/approve` with wrong user's JWT → 403.

### 15.4 Deployment order

Same pattern as Phase 2: ship as one atomic commit with feature flag default-off (`Blueprint.features.hitl_approval: false`). Enable per-repo for pilot. Observe. Roll out.

### 15.5 Backward compatibility

- Existing tasks without `initial_approvals` → empty list → no pre-approvals, default approval_timeout_s = 300
- Existing policies without `@rule_id` / `@tier` → engine logs WARN and treats them as hard-deny (safest default). Users should migrate.
- `pre_tool_use_hook` stays synchronous-compatible until a soft-deny hit; adding async wait is a behavior change but not a contract change (hook still returns the same dict shape).

---

## 16. Open questions / deferred

### 16.1 Multi-user approval

Today: task has one owner; they approve. Future: multi-user approval (e.g., two of three reviewers must approve for `rule:deploy_prod`). Defer — multi-user is §9.8 of INTERACTIVE_AGENTS.md, scoped for Iteration 5.

### 16.2 Per-rule auto-approve on timeout

For low-stakes rules, "timeout → auto-approve" could be useful. But it's a safety footgun that's hard to reverse. Shipped *without* this opt-in; revisit in 3b if there's demand. `@on_timeout("allow")` annotation sketched but not implemented.

### 16.3 Interactive stream prompts

In Phase 2 we deferred terminal UX research. Same question applies here: should `bgagent run` prompt interactively on approval requests? Probably yes eventually, but needs UX research. Phase 3b.

### 16.4 Persistent allowlist across container restarts

Currently: in-process. If a container gets evicted mid-task, allowlist is lost. Phase 3b could persist allowlist state to TaskTable and hydrate on restart. Not critical given rare restarts.

### 16.5 `bgagent approve --defer`

Escape hatch: "I can't respond, cancel + release slot". Clearer UX than silent timeout. Phase 3b.

### 16.6 Policy hot-reload

Today: policies loaded at task start, immutable for task lifetime. A long-running task (7h) can't benefit from a fresh soft-deny rule added mid-task. Probably fine — submission is the authoritative moment. Not a Phase 3 goal.

### 16.7 Severity-based routing

CLI could filter approvals: `bgagent approve --severity high` auto-approves high only, leaves medium/low. Useful for triage. Phase 3b.

### 16.8 Cedar annotations for things we haven't thought of yet

`@category`, `@severity`, `@approval_timeout_s`, `@tier`, `@rule_id` are shipped. Future: `@approval_requires_mfa("true")` for sensitive actions that need step-up auth. Great idea; deferred.

---

## Appendix A — File change map

(Tentative; refine during implementation.)

See §15.2 table. Net new files: 10. Net modified files: 13. Total LOC estimate: ~2500 lines production + ~1500 lines test = ~4000 lines. Comparable to Phase 2 (+2950 / -34).

## Appendix B — Review checklist

Before merging:

- [ ] All 8 Cedar annotations parse + recover via `policies_to_json_str()` round-trip test
- [ ] Every hard-deny rule has `@tier("hard")` + `@rule_id`
- [ ] Every soft-deny rule has `@tier("soft")` + `@rule_id` + `@severity` (default medium if missing)
- [ ] `@rule_id` uniqueness enforced at engine load
- [ ] Scope validation rejects `rule:<hard_deny_id>` at `CreateTaskFn`
- [ ] `maxPreApprovalScope` honored
- [ ] Race tests pass: approve+timeout, double-approve, cancel-during-awaiting
- [ ] E2E on `backgroundagent-dev`: scenarios A, B, C, D, E from §14
- [ ] Dashboard additions emit on schedule
- [ ] `reconcile-stranded-tasks` does NOT flag `AWAITING_APPROVAL` tasks
- [ ] DDB Streams on TaskApprovalsTable wired to fan-out Lambda
- [ ] CLI confirmation prompt on `--pre-approve all_session`

---

*End of Phase 3 design doc.*
