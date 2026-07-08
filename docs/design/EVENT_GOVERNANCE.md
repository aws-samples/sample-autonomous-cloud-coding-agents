# Event-Driven Governance and Actions

> **Status:** Active design (issue #230)
> **Last updated:** 2026-06-12

---

## Executive summary

Today, human-in-the-loop (HITL) and most governance controls are **synchronous and tool-centric**: Cedar policies in `PreToolUse` gate Bash, Write, Read, etc. Operators configure bash patterns and tool shapes — not semantic moments like "plan ready", "PR opened", or "cumulative cost exceeded $25".

Meanwhile, **observability and notifications are already event-driven** via `TaskEventsTable` and `FanOutConsumer`, but that plane cannot prevent side effects unless something blocked earlier on the hot path.

This document defines a unified **Event Governance** layer: a normative event catalog, declarative **event rules** (condition → action), **sync** (in-agent, can block) vs **async** (stream consumer, react only) evaluation modes, **registry-native configuration** (versioned `event-rule-pack` assets pinned by blueprints), and **UX as a first-class requirement** (`bgagent submit` governance preview, unified `bgagent pending` for event- and tool-sourced approvals). Tool-level Cedar HITL remains the fail-closed safety net for execution.

**Related:** [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md), [INTERACTIVE_AGENTS.md](./INTERACTIVE_AGENTS.md), [ORCHESTRATOR.md](./ORCHESTRATOR.md), [SECURITY.md](./SECURITY.md).

---

## 1. Two planes, one catalog

### 1.1 Normative event catalog

Stable names and schemas for lifecycle, execution, milestone, checkpoint, and policy events. Machine-readable catalog at `contracts/event-catalog/v1.json` with additive versioning (`catalog_version`).

### 1.2 Event rules

Each rule has:

| Field | Description |
|-------|-------------|
| `id` | Stable rule identifier |
| `on` | Event name (top-level `event_type` or milestone/checkpoint name) |
| `when` | Optional field matchers and aggregate conditions |
| `action` | `require_approval`, `notify`, `escalate`, `cancel_task`, `inject_nudge`, `observe_only` |
| `mode` | `observe_only` or `enforce` |
| `evaluation` | `sync` (in-agent) or `async` (stream consumer) |

Schema: `contracts/event-rules/schema.json`.

### 1.3 Sync evaluation

In-agent at pipeline checkpoints (`checkpoint:before_execution`, `checkpoint:before_open_pr`, etc.). Same latency class as Cedar; can transition to `AWAITING_APPROVAL` when `mode: enforce` and `action: require_approval`.

### 1.4 Async evaluation

`TaskEventsTable` stream consumer (folded into `FanOutConsumer` — no third Lambda until Kinesis migration). Tens–hundreds of ms; must not imply blocking unless UX is explicit.

### 1.5 Precedence

1. Tool Cedar **hard-deny** always wins.
2. Async never overrides sync deny.
3. Composable with existing `TaskApprovalsTable` / `bgagent approve` / `deny`.
4. Idempotency key: `(task_id, rule_id, correlation_id)`.

---

## 2. PolicyDecisionEvent

Unified audit schema at `contracts/policy-decision/schema.json`. Top-level `event_type: policy_decision` on `TaskEventsTable`.

| Field | Purpose |
|-------|---------|
| `decision` | `allow`, `deny`, `require_approval`, `observe` |
| `source` | `cedar_tool`, `event_rule`, `submission` |
| `enforcement_mode` | `observe_only`, `enforce` |
| `rule_id`, `rule_pack_id` | Rule attribution |
| `event_type`, `correlation_id` | Trigger context |
| `matching_rule_ids` | Cedar parity where applicable |
| `reason`, `severity`, `timeout_s` | HITL metadata |

---

## 3. Configuration

### 3.1 Inline (Phase 0–2)

Blueprint `security.eventRules` — array of rules persisted in RepoTable, frozen on TaskRecord at submit time (same pattern as `approval_gate_cap`).

### 3.2 Registry-native (Phase 3)

Blueprint `security.eventRulePack: { id, version }` resolves from agent asset registry. Inline rules merge as overrides; pack rules take precedence unless overridden per-rule.

---

## 4. Checkpoints

Pipeline-owned, not agent-declared:

| Checkpoint | When |
|----------|------|
| `checkpoint:before_execution` | After repo setup, before agent loop |
| `checkpoint:before_open_pr` | Before PR creation step |

Emitted as `agent_milestone` with `metadata.checkpoint`.

---

## 5. Data model extensions

### TaskApprovalsTable

| Field | Values |
|-------|--------|
| `source` | `tool` (default), `event` |
| `event_type` | Trigger event when `source=event` |
| `checkpoint` | Checkpoint name when applicable |
| `rule_pack_id`, `rule_id` | Rule attribution |

GSI `user_id-status-index` projects new fields for `bgagent pending`.

### TaskRecord

| Field | Purpose |
|-------|---------|
| `event_rules` | Frozen rules at submit time |
| `event_rule_pack_id`, `event_rule_pack_version` | Registry pin (Phase 3) |

---

## 6. Stream consumer strategy

`FanOutConsumer` evaluates async event rules before channel dispatch. No third DDB stream consumer until Kinesis migration (see `task-events-table.ts` architectural note).

---

## 7. UX

| Surface | Behavior |
|---------|----------|
| `bgagent watch` | Renders `policy_decision` events; `[observe]` prefix for observe-only |
| `bgagent pending` | Unified queue — tool and event gates differ in trigger context |
| `bgagent rules eval --fixture` | Local rule evaluation (Phase 3) |
| Submit preview | Governance preview from resolved rules (future) |

Async `require_approval` after `pr_created` must state that the PR already exists.

---

## 8. Phased delivery

| Phase | Scope | Outcome |
|-------|-------|---------|
| 0 | Catalog + observe_only + PolicyDecisionEvent | "Would have fired" in watch stream |
| 1 | Async notify/fan-out + webhook | Ping on PR/cost without new HITL |
| 2 | Sync checkpoints + enforce | Plan review before code |
| 3 | Registry-native event-rule-pack | Org-wide versioned rollout |
| 4 | Advanced aggregates + async cancel | Operator automation |

---

## 9. Out of scope

- Replacing tool Cedar with event rules
- Cedar-on-events (rejected — see §10; declarative matchers are permanent)
- Stream-only HITL (race with fast agents)
- EventBridge as primary internal bus
- Separate approve commands for event vs tool gates

---

## 10. Open questions

| Question | Resolution |
|----------|------------|
| Rule language | **Resolved: declarative field matchers are the permanent language; Cedar-on-events is rejected.** Cedar is an *authorization* language (`principal-action-resource-context` → permit/forbid) with no aggregation — it cannot express `cost_usd_gte` / `turn_count_gte`, and event actions (`notify`/`escalate`/`cancel_task`/`inject_nudge`) are ECA automation, not authorization decisions. A Cedar port would still need a bespoke action layer, and it would add a third Cedar runtime alongside the two we already must bump in lockstep (`cedar-wasm`, `cedarpy`) for zero gain. The two-plane split stands: Cedar governs tool execution (fail-closed); the declarative matcher governs events. The matcher already has cross-language parity, schema validation, and fixture parity tests. |
| Checkpoint trust | Pipeline-emitted only |
| Scope algebra (tool + event overlap) | Idempotency key; document in runbooks |
