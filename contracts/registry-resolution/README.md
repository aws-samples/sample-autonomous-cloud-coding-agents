# registry:// grammar and resolution fixtures (#246)

Golden vectors of the TypeScript `registry://` parser and resolver
(`cdk/src/handlers/shared/registry/`). There is no second implementation: the
agent receives the assets the orchestrator resolved. Two corpora, each with one
runner:

**1. Grammar** — `cases.json`, golden `(ref) → verdict`:
[`cdk/test/handlers/shared/registry-resolution-parity.test.ts`](../../cdk/test/handlers/shared/registry-resolution-parity.test.ts)
runs each `ref` through `parseRef`.

**2. Resolution ranking** — `resolution-cases.json`, golden `(candidates, constraint) → winner`:
[`cdk/test/handlers/shared/registry-resolution-ranking-parity.test.ts`](../../cdk/test/handlers/shared/registry-resolution-ranking-parity.test.ts)
runs each case through `selectHighest`.

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

The parser must return the expected `ok`, the `reason` when `ok:false`, and every
parsed field when `ok:true`.

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
> This corpus pins the **strict** #246 grammar (`parseRef`), which
> is what resolution enforces.
