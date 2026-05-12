# Cedar cross-engine parity fixtures

Golden-file test vectors shared by the agent-side Python `cedarpy` engine
and the CDK-side TypeScript `@cedar-policy/cedar-wasm` engine. Both engines
implement the same Cedar language on the same Rust core but ship as
independent bindings; this directory is how we catch drift between them
before deploy.

**Design reference:** [`docs/design/CEDAR_HITL_GATES.md`](../../docs/design/CEDAR_HITL_GATES.md)
§15.6 (cross-engine parity contract), decision #23, finding #1.

## Why this lives in `contracts/`

Neither `agent/` nor `cdk/` owns the parity contract — it's an agreement
*between* them. This directory is a neutral location that both test suites
reach into. The sibling file `contracts/memory-hash-vectors.json` uses the
same pattern for cross-language SHA-256 parity.

## Consumers

- **Agent (Python):** [`agent/tests/test_cedar_parity.py`](../../agent/tests/test_cedar_parity.py)
  loads every `*.json` file, runs `cedarpy.is_authorized`, and asserts the
  observed `(decision, matching_rule_ids)` matches `expected`.
- **CDK (TypeScript):** [`cdk/test/handlers/shared/cedar-parity.test.ts`](../../cdk/test/handlers/shared/cedar-parity.test.ts)
  loads the same fixtures and runs them through `cedar-wasm`'s
  `isAuthorized`.

If a fixture's `expected` no longer matches either engine, CI fails before
the change ships.

## Fixture shape

Each `<name>.json` file is a single object:

```json
{
  "name": "short-identifier",
  "description": "One-sentence purpose of this fixture",
  "policies": "<Cedar policy set text>",
  "input": {
    "principal": { "type": "Agent::TaskAgent", "id": "<task-type>" },
    "action":    { "type": "Agent::Action",    "id": "<action>"    },
    "resource":  { "type": "Agent::<Sentinel>", "id": "<resource>" },
    "context":   { "<key>": "<value>" }
  },
  "expected": {
    "decision": "allow" | "deny",
    "matching_rule_ids": ["<rule_id>", ...]
  }
}
```

`matching_rule_ids` is the **sorted** list of `@rule_id` annotation values
recovered from the policies whose IDs appear in the engine's diagnostics.
Both tests map the engine-internal positional IDs (e.g. `policy0`) to the
`@rule_id` annotation before comparison — the authoritative identity for
every rule is its annotation, not its position.

## Annotation surface expectations

The engines use slightly different field names inside their diagnostics:

- `cedarpy`: `result.diagnostics.reasons` (plural)
- `cedar-wasm`: `result.response.diagnostics.reason` (singular)

Both return a list of matching policy positional IDs. The parity tests
normalize this before comparing to `matching_rule_ids`. See
[`CEDAR_HITL_GATES.md`](../../docs/design/CEDAR_HITL_GATES.md) §15.6 for
the full API surface.

## Updating fixtures

1. **Adding a fixture:** drop a new `<name>.json` file. Both engines pick
   it up on the next CI run. Keep `name` unique; the Python test uses it
   as the `pytest.mark.parametrize` id.
2. **Intentional Cedar behavior change:** re-run both engines against the
   updated policy text, confirm the new `(decision, rule_ids)` is
   correct, update the fixture's `expected`. Both tests then pass again.
3. **Engine version bump** (either `cedarpy` or `cedar-wasm`): run the
   parity test locally first. Any divergence fails CI; investigate whether
   it's a genuine engine regression (file upstream issue, pin back) or an
   intentional behavior change (update fixtures).

Every fixture is tracked in Git; drift over time is visible via
`git log contracts/cedar-parity/`.
