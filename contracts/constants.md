# Cross-language constants

`constants.json` is the single source of truth for numeric/textual
constants that must agree across Python (agent runtime), TypeScript
(CDK synth + CLI), and tests. Hard-coding the same value in three
places is how the `APPROVAL_GATE_CAP` triplication crept in (S9 in
PR #88's review); this file replaces that pattern.

**Design reference:** PR #88 design discussion thread
([issuecomment-4463943269](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/88))
— Option C.

## Why this lives in `contracts/`

Same rationale as `cedar-parity/`: neither `agent/` nor `cdk/` owns
the contract. This is the neutral location both runtimes read.

## Consumers

| Caller | Path | Phase |
|---|---|---|
| `agent/src/policy.py` | `/app/contracts/constants.json` | import-time |
| `cdk/src/handlers/shared/types.ts` | `../../../../contracts/constants.json` | synth-time `import` |
| `cdk/src/constructs/blueprint.ts` | re-exports from `types.ts` | synth-time |

The agent reads at runtime via `Path(__file__) / "../../contracts/..."`
in dev / `/app/contracts/...` in the deployed image (the Dockerfile
copies `contracts/` to `/app/contracts/`). The CDK side imports the
JSON at TypeScript compile time via `resolveJsonModule`.

## Schema

```json
{
  "approval_gate_cap": {
    "min": 1,
    "max": 500,
    "default": 50
  },
  "approval_timeout_s": {
    "min": 30,
    "max": 3600,
    "default": 300
  }
}
```

- **`approval_gate_cap.min`** — minimum acceptable bound on a blueprint's
  approval gate cap. Floor: 1 (zero would disable the gate, which the
  three-outcome Cedar model relies on).
- **`approval_gate_cap.max`** — maximum acceptable bound. Ceiling: 500
  (PolicyEngine performance falls off above this; tested to 1k but not
  validated in production).
- **`approval_gate_cap.default`** — value applied when a blueprint omits
  the field. 50 is the design-decision default (see
  `docs/design/CEDAR_HITL_GATES.md` decision #13).
- **`approval_timeout_s.min`** — floor for `approval_timeout_s` (§6
  decision #6). 30 seconds — below this, humans cannot realistically
  respond to an approval prompt.
- **`approval_timeout_s.max`** — absolute ceiling for `approval_timeout_s`
  before the `maxLifetime - 300` clip is applied (§7.3). 3600 seconds
  (1 hour).
- **`approval_timeout_s.default`** — value applied when the submit payload
  omits `approval_timeout_s`. 300 seconds (5 minutes) per §6 decision #6.

## Adding new constants

1. Add the key + nested object to `constants.json`.
2. Wire each consumer (Python, TS) to read the same key.
3. Update `scripts/check-types-sync.ts` (or successor drift check) to
   assert the new key is consumed where expected.
4. Bump this README's schema section.

Do not introduce new top-level literal declarations of the same
constant in code; the drift check exists to catch that.
