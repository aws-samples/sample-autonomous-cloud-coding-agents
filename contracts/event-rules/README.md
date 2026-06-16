# Event governance contracts

Cross-language contracts for event-driven governance (issue #230).

## Layout

| Path | Purpose |
|------|---------|
| `event-catalog/v1.json` | Normative event names (top-level, milestones, checkpoints) |
| `event-rules/schema.json` | JSON Schema for event rule packs |
| `event-rules/fixtures/` | Golden fixtures for Python + TypeScript evaluator parity |
| `policy-decision/schema.json` | Unified `PolicyDecisionEvent` metadata schema |

## Consumers

| Caller | Path |
|--------|------|
| `agent/src/event_governance/` | Runtime catalog + rule evaluation |
| `cdk/src/handlers/shared/event-rule-evaluator.ts` | Async evaluation in FanOutConsumer |
| `cli/src/commands/rules.ts` | `bgagent rules eval --fixture` |

Design reference: [EVENT_GOVERNANCE.md](../docs/design/EVENT_GOVERNANCE.md).
