# Cedar cross-engine parity fixtures

Golden-file test vectors shared by the agent-side Python `cedarpy` engine
and the CDK-side TypeScript `@cedar-policy/cedar-wasm` engine. Both engines
implement the same Cedar language on the same Rust core but ship as
independent bindings. This directory catches drift between the two engines
before deploy.

**Design reference:** [`docs/design/CEDAR_HITL_GATES.md`](../../docs/design/CEDAR_HITL_GATES.md)
§15.6 (cross-engine parity contract), decision #23, finding #1.

## Engine pair

[`engines/versions.json`](./engines/versions.json) names the one pair of engine
versions these fixtures were verified against. The test file
[`cdk/test/constructs/cedar-wasm-layer.test.ts`](../../cdk/test/constructs/cedar-wasm-layer.test.ts),
which is part of `mise //cdk:test` and so of the build,
fails unless `cdk/package.json`, `cdk/layers/cedar-wasm/package.json` and
`agent/pyproject.toml` each pin exactly that version. To move to another Cedar
release, bump both engines and that file in one change, and keep every fixture
here passing on both runners.

The file sits in a subdirectory because both runners load every `*.json` file
directly in this directory as a fixture.

## Why this lives in `contracts/`

Neither `agent/` nor `cdk/` owns the parity contract. It is an agreement
*between* them. This directory is a neutral location that both test suites
read from. The sibling file `contracts/memory-hash-vectors.json` uses the
same pattern for cross-language SHA-256 parity.

## Consumers

- **Agent (Python).** [`agent/tests/test_cedar_parity.py`](../../agent/tests/test_cedar_parity.py)
  loads every `*.json` file, runs `cedarpy.is_authorized`, and asserts that the
  observed `(decision, matching_rule_ids)` matches `expected`.
- **CDK (TypeScript).** [`cdk/test/handlers/shared/cedar-parity.test.ts`](../../cdk/test/handlers/shared/cedar-parity.test.ts)
  loads the same fixtures and runs them through `cedar-wasm`'s
  `isAuthorized`.

If a fixture's `expected` no longer matches either engine, CI fails before
the change ships.

These fixtures carry their own policy text. They compare the two engines and
do not exercise the rules shipped in `agent/policies/`.
[`agent/tests/test_policy_builtin_rules.py`](../../agent/tests/test_policy_builtin_rules.py)
pins those rules.

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
Both tests map the engine-internal positional IDs (for example `policy0`) to
the `@rule_id` annotation before comparison, because the authoritative identity
of every rule is its annotation, not its position.

## Annotation surface expectations

The engines use different field names inside their diagnostics:

- `cedarpy`: `result.diagnostics.reasons` (plural)
- `cedar-wasm`: `result.response.diagnostics.reason` (singular)

Both return a list of the positional IDs of the matching policies. The parity
tests normalize that list before they compare it to `matching_rule_ids`. See
[`CEDAR_HITL_GATES.md`](../../docs/design/CEDAR_HITL_GATES.md) §15.6 for
the full API.

## Updating fixtures

1. **Adding a fixture.** Add a new `<name>.json` file. Both engines pick
   it up on the next CI run. Keep `name` unique, because the Python test uses
   it as the `pytest.mark.parametrize` id.
2. **Intentional Cedar behavior change.** Run both engines again against the
   updated policy text, confirm that the new `(decision, rule_ids)` is
   correct, and update the fixture's `expected`. Both tests then pass again.
3. **Engine version bump** (either `cedarpy` or `cedar-wasm`). Run the
   parity test locally first. Any divergence fails CI. Find out whether
   it is an engine regression (file an upstream issue and pin back) or an
   intentional behavior change (update the fixtures).

Every fixture is tracked in Git, so `git log contracts/cedar-parity/` shows
drift over time.
