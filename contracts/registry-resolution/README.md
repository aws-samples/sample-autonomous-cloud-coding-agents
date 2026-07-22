# Registry resolution parity fixtures

Golden-file test vectors for the #246 registry URI grammar and resolution
semantics. Each fixture is a `registry://` ref (and, for resolution fixtures, a
catalog of candidate versions) paired with its **expected verdict**.

**Design reference:** [`docs/design/REGISTRY.md`](../../docs/design/REGISTRY.md)
§6 (grammar) and §5 (resolution semantics);
[ADR-018](../../docs/decisions/ADR-018-agent-asset-registry.md).

## Why this lives in `contracts/`

A `registry://` ref is parsed on **two** sides of the platform in different
languages: the Python agent validator (`agent/src/workflow/validator.py`
`_REGISTRY_REF`, run at author/CI time) and the TypeScript resolver
(`cdk/src/handlers/shared/registry-resolver.ts` `parseRef`, run at the
create-task boundary). This is exactly the two-language drift hazard the repo
learned from twice — Cedar bindings and workflow validation. This corpus is the
neutral agreement both implementations must reproduce; neither `agent/` nor the
registry service owns it.

Mirrors [`contracts/cedar-parity/`](../cedar-parity/README.md) and
[`contracts/workflow-validation/`](../workflow-validation/README.md).

## Fixture shape

Two fixture families share one directory, distinguished by their top-level keys.

### Grammar fixtures — `grammar-*.json`

Test the URI regex only (no catalog). Both `_REGISTRY_REF.match()` (Python) and
`parseRef()` (TypeScript) must agree on `valid`.

```json
{
  "name": "short-identifier",
  "description": "One-sentence purpose",
  "ref": "registry://mcp_server/acme/pdf-tools@^1.4.1",
  "expected": { "valid": true }
}
```

- `expected.valid` — `true` iff the ref matches the grammar (REGISTRY.md §6).
- When `valid` is `true`, `expected.parsed` MAY give the decomposed
  `{ kind, namespace, name, constraint }` the TS parser must return.

### Resolution fixtures — `resolve-*.json`

Test the full resolve (grammar + semver match + status rules, REGISTRY.md §5)
against an in-memory catalog.

```json
{
  "name": "short-identifier",
  "description": "One-sentence purpose",
  "ref": "registry://mcp_server/acme/pdf-tools@^1.0.0",
  "catalog": [
    { "version": "1.0.0", "status": "approved" },
    { "version": "1.2.0", "status": "approved" },
    { "version": "2.0.0", "status": "approved" }
  ],
  "expected": { "version": "1.2.0", "warnings": [] }
}
```

- `expected.version` — the version that must win, or `null` on failure.
- `expected.reason` — required when `version` is `null`: one of
  `NO_MATCHING_VERSION`, `REMOVED`, `INVALID_CONSTRAINT`, `INVALID_REGISTRY_REF`.
- `expected.warnings` — e.g. `["DEPRECATED"]` when the winning version is
  `deprecated`.

## Consumers

- **Agent (Python):** loads every `grammar-*.json` and asserts
  `bool(_REGISTRY_REF.match(ref)) == expected.valid`.
- **Registry resolver (TypeScript):** loads every fixture; `parseRef` must agree
  on grammar, and `resolveRef` against the fixture catalog must reproduce the
  resolution verdict.

If a fixture's `expected` no longer matches an implementation, CI fails before
the change ships — either an implementation regressed or the fixture must be
updated as a recorded decision.
