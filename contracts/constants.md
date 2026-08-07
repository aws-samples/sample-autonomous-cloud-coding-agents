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
| `agent/src/shared_constants.py` | `/app/contracts/constants.json` | import-time |
| `agent/src/policy.py`, `agent/src/jira_reactions.py` | `SHARED_CONSTANTS` | import-time |
| `agent/src/server.py` | `SHARED_CONSTANTS["microvm_platform_config"]`, `SHARED_CONSTANTS["microvm_hook_budgets"]` | import-time |
| `cdk/src/handlers/shared/types.ts`, `jira-app-actor.ts` | `../../../../contracts/constants.json` | synth-time `import` |
| `cdk/src/handlers/shared/strategies/lambda-microvm-strategy.ts` | `microvm_platform_config` | synth-time `import`, read per session start |
| `cdk/src/constructs/lambda-microvm-compute.ts` | `microvm_hook_budgets` | synth-time `import` |
| `cdk/src/constructs/blueprint.ts` | re-exports from `types.ts` | synth-time |
| `cli/test/constants-parity.test.ts` | package-safe literal parity | test-time |

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
  },
  "max_budget_usd": {
    "min": 0.01,
    "max": 100
  },
  "jira_app_actor": {
    "min_secret_length": 32,
    "forge_webtrigger_suffix": ".webtrigger.atlassian.app"
  },
  "microvm_platform_config": {
    "env_by_key": { "task_table_name": "TASK_TABLE_NAME", "...": "..." },
    "required": ["task_table_name", "task_events_table_name",
                 "github_token_secret_arn", "agent_session_role_arn"]
  },
  "microvm_hook_budgets": {
    "ready_hook_timeout_seconds": 300,
    "warmup_total_budget_seconds": 240,
    "warmup_required_timeout_seconds": 120
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
- **`max_budget_usd.min`** — floor for a task's `max_budget_usd` (1 cent).
  Validated server-side (`validation.ts`) and pre-validated by
  `bgagent submit --max-budget` (#258).
- **`max_budget_usd.max`** — ceiling for `max_budget_usd` ($100). Same
  two consumers as `min`.
- **`jira_app_actor.min_secret_length`** — minimum HMAC shared-secret length
  accepted by the agent, CDK, and CLI Jira app-actor clients.
- **`jira_app_actor.forge_webtrigger_suffix`** — hostname suffix required by
  app-actor proxy URL validation to prevent operator-supplied SSRF targets.
- **`microvm_platform_config.env_by_key`** — the Lambda MicroVMs `platform_config`
  allowlist (ADR-021 P2): each wire key (snake_case) mapped to the environment
  variable the agent installs it as (UPPER_SNAKE). This block is unlike the
  others — it is a **security allowlist**, not a tuning bound. The MicroVM image
  is a snapshot whose env is frozen at build time, so the agent's non-secret
  platform env arrives in the `/run` hook payload instead; the values land in
  `os.environ`, which makes an unrecognised key an env-injection attempt. The
  consumer (`agent/src/server.py`) therefore **rejects** any `platform_config`
  carrying a key that is not in this map. Values are non-secret identifiers
  (table/bucket names, secret ARNs, role ARNs) only.
- **`microvm_platform_config.required`** — the subset without which a task cannot
  run (task + event tables, GitHub secret ARN, session role ARN). A `/run` hook
  whose `platform_config` misses or blanks any of these is rejected with HTTP 400.

Both `microvm_platform_config` fields are validated for shape (snake_case keys,
UPPER_SNAKE unique env names, `required ⊆ env_by_key`) by
`scripts/check-constants-sync.ts` **and** by `agent/src/server.py` at import time,
so a malformed contract fails the drift check *and* the MicroVM image build.

- **`microvm_hook_budgets.ready_hook_timeout_seconds`** — the `/ready` build-hook
  budget the CDK construct declares to `CreateMicrovmImage`
  (`READY_HOOK_TIMEOUT_SECONDS` in `cdk/src/constructs/lambda-microvm-compute.ts`).
  300 s, not 60 s, because as of ADR-021 P2-F5 `/ready` does real work: it warms the
  225 MiB `claude` binary so its pages are resident when the snapshot is taken.
- **`microvm_hook_budgets.warmup_total_budget_seconds`** — the agent's ceiling for
  the WHOLE `/ready` warm-up (`_READY_WARMUP_TOTAL_BUDGET_SECONDS` in
  `agent/src/server.py`): required command plus every best-effort one, which share
  the remainder rather than each getting a fresh budget.
- **`microvm_hook_budgets.warmup_required_timeout_seconds`** — the required
  warm-up's own slice (`_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS`). Generous on
  purpose: a cold 225 MiB `exec` has no predictable duration, which is the lesson of
  P2-F5.

Unlike every other block here, these three are not independent tuning bounds — they
are a **relationship**: `warmup_required < warmup_total < ready_hook`. The warm-up
must finish inside the budget the service holds the hook to, or a fix for a runtime
failure turns into a build failure. A relationship cannot be enforced from one side,
which is why both halves live in the contract even though each has a single
consumer. `scripts/check-constants-sync.ts` asserts the ordering and rejects a
literal re-declaration on **either** side — the Python constants *and*
`READY_HOOK_TIMEOUT_SECONDS` in the TypeScript construct — and
`agent/src/server.py` re-checks the same ordering at import time, so a bad contract
fails the drift check *and* the image build.

The published CLI package contains only `lib/`, so it cannot load the repository
contract at runtime. It mirrors these values as literals and
`cli/test/constants-parity.test.ts` makes drift a CI failure. The standalone
Forge app is deployed outside the workspaces; it keeps a named copy of the
minimum length in `proxy.js`.

## Adding new constants

1. Add the key + nested object to `constants.json`.
2. Wire each consumer (Python, TS) to read the same key.
3. Update `scripts/check-types-sync.ts` (or successor drift check) to
   assert the new key is consumed where expected.
4. Bump this README's schema section.

Do not introduce new top-level literal declarations of the same
constant in code; the drift check exists to catch that.

## Lint enforcement (AI007, #258)

Inline magic numbers are caught by linters in all three packages:

- **TypeScript** — `@typescript-eslint/no-magic-numbers` in
  `cdk/eslint.config.mjs` and `cli/eslint.config.mjs` (blocking `error`).
- **Python** — ruff `PLR2004` (magic-value-comparison) in
  `agent/pyproject.toml` (blocking).

When one of these rules fires, name the value as a constant in the
owning module — or, if the value must agree across Python and
TypeScript, add it to `constants.json` and wire the consumers as
described above. The allowlists (0/1/-1, HTTP status codes, radix and
unit-conversion factors) live next to each rule's config.
