# Workflow validation parity fixtures

Golden-file test vectors for the workflow cross-field validator (issue #248).
Each fixture is a workflow file body paired with its **expected verdict** —
`valid`, or the exact set of violation codes the validator must report.

**Design reference:** [`docs/design/WORKFLOWS.md`](../../docs/design/WORKFLOWS.md)
§"Single source of truth and validator parity" and §"Validation rules";
[ADR-014](../../docs/decisions/ADR-014-workflow-driven-tasks.md).

## Why this lives in `contracts/`

A workflow file is validated on more than one side of the platform. In Phases
1–3 there is exactly **one** cross-field implementation
(`agent/src/workflow/validator.py`, run at author/CI time), so the drift hazard
does not yet exist. This corpus exists **from Phase 1 anyway**, so the
expected-verdict contract is fixed *before* Phase 4 (#246) adds a second,
out-of-band publish-path validator (likely in another language). At that point
both implementations must reproduce every verdict here — exactly the mechanism
[`contracts/cedar-parity/`](../cedar-parity/README.md) uses for the two Cedar
engines.

This is a neutral location both validators reach into; neither `agent/` nor the
future registry service owns the contract — it is an agreement *between* them.

## Fixture shape

Each `<name>.json` file is a single object:

```json
{
  "name": "short-identifier",
  "description": "One-sentence purpose of this fixture",
  "workflow": { ...a full workflow file body... },
  "expected": {
    "valid": false,
    "violations": ["rule-2"]
  }
}
```

- `expected.valid` — `true` iff the validator must report **zero** violations.
- `expected.violations` — the exact sorted set of violation codes
  (`"schema"`, `"rule-1"`, … `"rule-14"`) the validator must return. Must be
  `[]` when `valid` is `true`, and non-empty when `valid` is `false`.

Codes match the numbered rules in WORKFLOWS.md §"Validation rules". `"schema"`
covers any JSON-Schema (shape) failure. Rule 13 (model allow-list) is checked at
the create-task boundary, not by the file-local validator, so it never appears
here (documented in `validator.py`). Rule 10 (single production per id lineage)
is a cross-file/registry property, not a single-file check, so it is also out of
scope for this corpus.

## Consumers

- **Agent (Python):** [`agent/tests/test_workflow_validation_corpus.py`](../../agent/tests/test_workflow_validation_corpus.py)
  loads every `*.json` file, runs `workflow.validate_workflow(fixture.workflow)`,
  and asserts the observed violation set equals `expected`.
- **Registry service (Phase 4, #246):** when the second validator lands, it must
  load the same fixtures and reproduce every verdict, or CI fails before deploy.

If a fixture's `expected` no longer matches the validator, CI fails before the
change ships — either the validator regressed or the fixture must be updated as
a recorded decision.
