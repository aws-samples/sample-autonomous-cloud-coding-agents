# Event governance rules

Event rule packs, schema, and cross-language parity fixtures for event-driven
governance (issue #230). Authored here alongside `agent/workflows/` — one asset
tree, one authoring UX. The related event-catalog and policy-decision schemas
stay under the repo-root `contracts/` tree.

## Layout

| Path | Purpose |
|------|---------|
| `schema.json` | JSON Schema for event rule packs |
| `packs/*.json` | Versioned rule packs pinned by `Blueprint.security.eventRulePack` |
| `fixtures/` | Golden fixtures for Python + TypeScript evaluator parity |

## Consumers

| Caller | Path | Reads |
|--------|------|-------|
| `cdk/src/handlers/shared/event-rule-pack-resolver.ts` | Bundles `packs/*.json` at build time (future `RegistryService.resolve`) | packs |
| `cdk/test/.../event-rule-evaluator.test.ts`, `event-rules-parity.test.ts` | TypeScript evaluator + parity | fixtures |
| `agent/tests/test_event_rules_parity.py`, `test_event_governance_evaluator.py` | Python evaluator + parity | fixtures |
| `cli/src/commands/rules.ts` | `bgagent rules eval --fixture` | fixtures |

The agent runtime does **not** read these files: it receives already-resolved
`event_rules` frozen on the TaskRecord at submit time, so both evaluation planes
consume one source (the CDK-resolved rules).

Design reference: [EVENT_GOVERNANCE.md](../../docs/design/EVENT_GOVERNANCE.md).
