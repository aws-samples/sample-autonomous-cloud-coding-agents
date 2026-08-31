# registry:// grammar parity fixtures (#246)

Golden vectors shared by the two `registry://` implementations. There are two
corpora, each run by a dual TS/Python runner:

**1. Grammar** — `cases.json`, golden `(ref) → verdict`:

- **Agent (Python):** [`agent/tests/test_registry_resolution_corpus.py`](../../agent/tests/test_registry_resolution_corpus.py)
  runs each `ref` through `registry.ref.parse_ref`.
- **CDK (TypeScript):** [`cdk/test/handlers/shared/registry-resolution-parity.test.ts`](../../cdk/test/handlers/shared/registry-resolution-parity.test.ts)
  runs the same refs through `parseRef`.

**2. Resolution ranking** — `resolution-cases.json`, golden `(candidates, constraint) → winner`:

- **Agent (Python):** [`agent/tests/test_registry_resolution_ranking_corpus.py`](../../agent/tests/test_registry_resolution_ranking_corpus.py)
  runs each case through `registry.resolver.select_highest`.
- **CDK (TypeScript):** [`cdk/test/handlers/shared/registry-resolution-ranking-parity.test.ts`](../../cdk/test/handlers/shared/registry-resolution-ranking-parity.test.ts)
  runs the same cases through `selectHighest`.

Ranking runs in both languages (TS handler for the API, Python for the
orchestrator's direct port), so caret/tilde/prerelease semantics must stay in
lockstep — this second corpus is how we catch a ranking drift before deploy.

Both parsers implement the identical grammar in different languages; this corpus
is how we catch drift before deploy — the same mechanism
[`contracts/cedar-parity/`](../cedar-parity/README.md) uses for the two Cedar
engines and [`contracts/workflow-validation/`](../workflow-validation/README.md)
anticipates for the publish-path validator.

## Why this lives in `contracts/`

The `registry://` grammar is enforced on both sides of the platform: the
orchestrator/handlers (TS) validate refs at publish and resolve time, and the
agent (Python) parses resolved refs at load time. Neither `agent/` nor `cdk/`
owns the grammar — it is an agreement *between* them, so it lives in this neutral
directory both test suites reach into.

## Fixture shape

A single `cases.json` with a `cases` array. Each case:

```jsonc
{
  "name": "short-identifier",
  "ref": "registry://kind/namespace/name@constraint",
  "expected": {
    // success:
    "ok": true,
    "kind": "mcp_server", "namespace": "acme", "name": "pdf-tools",
    "op": "exact",           // exact | caret | tilde
    "major": 1, "minor": 4, "patch": 1,
    "prerelease": null       // or the tag without the leading '-'
    // failure (instead of the above):
    // "ok": false, "reason": "INVALID_REGISTRY_REF" | "INVALID_CONSTRAINT"
  }
}
```

Both parsers must agree on `ok`, on `reason` when `ok:false`, and on every parsed
field when `ok:true`.

## Grammar (authoritative)

```
registry://<kind>/<namespace>/<name>@<constraint>
  kind       = [a-z][a-z0-9_]*            snake_case: mcp_server, cedar_policy_module
  namespace  = [a-z][a-z0-9-]*
  name       = [a-z0-9][a-z0-9._-]*
  constraint = [^~]?MAJOR.MINOR.PATCH[-prerelease]   exact / caret / tilde only
```

The `@<constraint>` pin is **mandatory** (fail-closed — no implicit "latest").
Floating constraints (`*`, `latest`, `>=`, `<=`, x-ranges, partial versions) are
rejected with `INVALID_CONSTRAINT`; anything that does not match the ref shape is
`INVALID_REGISTRY_REF`.

> **Note.** The workflow validator's `_REGISTRY_REF` (in `agent/src/workflow/
> validator.py`) is a deliberately *looser* acceptance check that also admits the
> legacy 2-segment illustrative form used by `contracts/workflow-validation/`.
> This corpus pins the **strict** #246 grammar (`parse_ref` / `parseRef`), which
> is what resolution enforces.
