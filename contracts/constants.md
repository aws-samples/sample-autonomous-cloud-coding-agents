# Cross-language constants

`constants.json` is the single source of truth for the numeric and textual
constants that must agree across Python (agent runtime), TypeScript
(CDK synth and CLI), and tests. Hard-coding the same value in three
places produced the `APPROVAL_GATE_CAP` triplication (S9 in the review of
PR #88). This file replaces that pattern.

**Design reference:** Option C in the PR #88 design discussion thread
([issuecomment-4463943269](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/88)).

## Why this lives in `contracts/`

The rationale is the same as for `cedar-parity/`. Neither `agent/` nor `cdk/`
owns the contract. This directory is the neutral location that both runtimes
read.

## Consumers

| Caller | Path | Phase |
|---|---|---|
| `agent/src/shared_constants.py` | `/app/contracts/constants.json` | import-time |
| `agent/src/policy.py`, `agent/src/jira_reactions.py` | `SHARED_CONSTANTS` | import-time |
| `agent/src/server.py` | `SHARED_CONSTANTS["microvm_platform_config"]`, `SHARED_CONSTANTS["microvm_hook_budgets"]` | import-time |
| `cdk/src/handlers/shared/types.ts`, `jira-app-actor.ts` | `../../../../contracts/constants.json` | synth-time `import` |
| `cdk/src/handlers/shared/strategies/lambda-microvm-strategy.ts` | `microvm_platform_config` | synth-time `import`, read per session start |
| `cdk/src/constructs/lambda-microvm-compute.ts` | `microvm_hook_budgets`, `microvm_lifecycle` | synth-time `import` |
| `agent/src/microvm_http.py` | `SHARED_CONSTANTS["microvm_hook_budgets"]` (lifecycle handler/hook budgets) | import-time |
| `cdk/src/handlers/shared/microvm/image-capability.ts` | `microvm_lifecycle` (protocol version, image marker) | synth-time `import` |
| `cdk/src/constructs/blueprint.ts` | re-exports from `types.ts` | synth-time |
| `cli/test/constants-parity.test.ts` | package-safe literal parity | test-time |
| `agent/tests/test_constants_parity.py` | value each agent constant holds after import | test-time |

The agent reads the file at runtime, from `Path(__file__) / "../../contracts/..."`
in dev and from `/app/contracts/...` in the deployed image (the Dockerfile
copies `contracts/` to `/app/contracts/`). The CDK side imports the
JSON at TypeScript compile time through `resolveJsonModule`.

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
  "monthly_budgets": {
    "config_period": "CONFIG",
    "config_record_type": "CONFIG",
    "config_index_name": "record_type-scope_key-index",
    "user_prefix": "USER#",
    "team_prefix": "TEAM#",
    "task_prefix": "TASK#",
    "rollup_period": "ROLLUP",
    "rollup_retention_days": 400,
    "warning_percent": 80,
    "exceeded_percent": 100,
    "warning_alert_marker": "alerted_80_at",
    "exceeded_alert_marker": "alerted_100_at"
  },
  "jira_app_actor": {
    "min_secret_length": 32,
    "forge_webtrigger_suffix": ".webtrigger.atlassian.app"
  },
  "microvm_platform_config": {
    "env_by_key": { "task_table_name": "TASK_TABLE_NAME", "...": "..." },
    "required": ["task_table_name", "task_events_table_name",
                 "github_token_secret_arn", "agent_session_role_arn"],
    "arn_keys": ["github_token_secret_arn", "linear_oauth_secret_arn",
                 "jira_oauth_secret_arn", "agent_session_role_arn"],
    "account_anchor_key": "agent_session_role_arn"
  },
  "microvm_hook_budgets": {
    "ready_hook_timeout_seconds": 300,
    "warmup_total_budget_seconds": 240,
    "warmup_required_timeout_seconds": 120
  }
}
```

- **`approval_gate_cap.min`.** Minimum acceptable bound on a blueprint's
  approval gate cap. The floor is 1, because zero would disable the gate, and
  the three-outcome Cedar model relies on the gate.
- **`approval_gate_cap.max`.** Maximum acceptable bound. The ceiling is 500,
  because PolicyEngine performance falls off above it. Values up to 1k were
  tested but not validated in production.
- **`approval_gate_cap.default`.** Value applied when a blueprint omits
  the field. 50 is the design-decision default (see
  `docs/design/CEDAR_HITL_GATES.md` decision #13).
- **`approval_timeout_s.min`.** Floor for `approval_timeout_s` (§6
  decision #6), 30 seconds. Below this, humans cannot realistically
  respond to an approval prompt.
- **`approval_timeout_s.max`.** Absolute ceiling for `approval_timeout_s`
  before the `maxLifetime - 300` clip is applied (§7.3). 3600 seconds
  (1 hour).
- **`approval_timeout_s.default`.** Value applied when the submit payload
  omits `approval_timeout_s`. 300 seconds (5 minutes), from §6 decision #6.
- **`max_budget_usd.min`.** Floor for a task's `max_budget_usd` (1 cent).
  The server validates it (`validation.ts`), and
  `bgagent submit --max-budget` validates it before the request (#258).
- **`max_budget_usd.max`.** Ceiling for `max_budget_usd` ($100). It has the
  same two consumers as `min`.
- **`monthly_budgets`.** The DynamoDB key prefixes, config index, rollup
  retention, alert thresholds, and claim-marker names shared by the CDK
  admission and rollup path and the operator CLI. CDK reads this object
  directly. The published CLI mirrors it as literals, and its constants-parity
  test makes drift a CI failure.
- **`jira_app_actor.min_secret_length`.** Minimum HMAC shared-secret length
  accepted by the agent, CDK, and CLI Jira app-actor clients.
- **`jira_app_actor.forge_webtrigger_suffix`.** Hostname suffix that app-actor
  proxy URL validation requires, to prevent operator-supplied SSRF targets.
- **`microvm_platform_config.env_by_key`.** The Lambda MicroVMs `platform_config`
  allowlist (ADR-021 P2). It maps each wire key (snake_case) to the environment
  variable that the agent installs it as (UPPER_SNAKE). This block is unlike the
  others. It is a **security allowlist**, not a tuning bound. The MicroVM image
  is a snapshot whose environment is frozen at build time, so the agent's
  non-secret platform environment arrives in the `/run` hook payload instead.
  The values go into `os.environ`, so an unrecognised key is an env-injection
  attempt. The consumer (`agent/src/server.py`) therefore **rejects** any
  `platform_config` that carries a key that is not in this map. Values are only
  non-secret identifiers (table and bucket names, secret ARNs, role ARNs).
- **`microvm_platform_config.required`.** The subset without which a task cannot
  run (task and event tables, GitHub secret ARN, session role ARN). A `/run` hook
  whose `platform_config` misses or blanks any of these is rejected with HTTP 400.
- **`microvm_platform_config.arn_keys`.** The subset of `env_by_key` whose values
  are ARNs. The agent therefore checks them for partition and account agreement
  before it installs them. The key allowlist stops a payload from setting an
  unrecognised variable. It does not stop a payload from pointing an
  **allowlisted** key at a different resource, and `github_token_secret_arn` is
  fetched with the unscoped execution role and cached into `GITHUB_TOKEN`. Any
  value that is malformed, or that disagrees with the anchor below on partition
  or account, is rejected (HTTP 400 `MICROVM_RUN_PLATFORM_CONFIG_INVALID`). This
  check is **fail-fast plus defence in depth, not an ownership proof**. The
  account-scoped IAM grants are what deny a foreign read, and an in-account
  redirect is deliberately *not* covered. See `MICROVM_PLATFORM_CONFIG_ARN_KEYS`
  in `agent/src/server.py` for the full statement of what this check does and
  does not provide.
- **`microvm_platform_config.account_anchor_key`.** The `arn_keys` entry that
  supplies the expected partition and account. It must be
  `agent_session_role_arn`-shaped, that is, a payload key and not `os.environ`
  or an `sts:GetCallerIdentity`. The reason is that the environment is empty by
  construction on this backend (the snapshot bakes nothing), and that this
  check runs on the path that must make zero AWS calls beyond the S3 payload
  fetch. Two invariants follow, and both are enforced: the anchor must be in
  `arn_keys`, **and** it must be in `required`. An optional anchor would let a
  payload disable the whole check by omitting it.

`scripts/check-constants-sync.ts` validates all four `microvm_platform_config`
fields for shape (snake_case keys, UPPER_SNAKE unique env names,
`required ⊆ env_by_key`, `arn_keys ⊆ env_by_key` non-empty,
`account_anchor_key ∈ arn_keys ∩ required`), **and** `agent/src/server.py`
validates them the same way at import time. A malformed contract therefore fails the drift check *and* the MicroVM image
build. The duplication is deliberate. A malformed entry here would silently
**widen** what the agent accepts from a network payload, so neither side is
trusted to be the only gate.

- **`microvm_hook_budgets.ready_hook_timeout_seconds`.** The `/ready` build-hook
  budget that the CDK construct declares to `CreateMicrovmImage`
  (`READY_HOOK_TIMEOUT_SECONDS` in `cdk/src/constructs/lambda-microvm-compute.ts`).
  The value is 300 s, not 60 s, because as of ADR-021 P2-F5 `/ready` does real
  work. It warms the 225 MiB `claude` binary so that its pages are resident when
  the snapshot is taken.
- **`microvm_hook_budgets.warmup_total_budget_seconds`.** The agent's ceiling for
  the whole `/ready` warm-up (`_READY_WARMUP_TOTAL_BUDGET_SECONDS` in
  `agent/src/server.py`). The ceiling covers the required command and every
  best-effort one. The best-effort commands share the remainder, and none gets
  a fresh budget.
- **`microvm_hook_budgets.warmup_required_timeout_seconds`.** The required
  warm-up's own share of that ceiling (`_READY_WARMUP_REQUIRED_TIMEOUT_SECONDS`).
  It is generous on purpose, because a cold 225 MiB `exec` has no predictable
  duration, as P2-F5 showed.

Unlike every other block here, these three are not independent tuning bounds.
They are a **relationship**: `warmup_required < warmup_total < ready_hook`. The
warm-up must finish inside the budget that the service holds the hook to, or a
fix for a runtime failure becomes a build failure. A relationship cannot be
enforced from one side, so both halves are in the contract even though each has
a single consumer. `scripts/check-constants-sync.ts` asserts the ordering and
rejects a literal re-declaration on **either** side, the Python constants *and*
`READY_HOOK_TIMEOUT_SECONDS` in the TypeScript construct.
`agent/src/server.py` checks the same ordering again at import time, so a bad
contract fails the drift check *and* the image build.

- **`microvm_hook_budgets.lifecycle_hook_timeout_seconds` and `lifecycle_handler_budget_seconds`.**
  The `/suspend` and `/resume` hook timeout declared to the image (30 s) and the
  agent handler's own budget inside it (20 s). The handler must leave time to send
  its answer, so `scripts/check-constants-sync.ts` and `microvm_http.py` both require
  handler < hook.
- **`microvm_lifecycle`.** The lifecycle protocol version and the image marker
  environment name (`ABCA_MICROVM_LIFECYCLE_PROTOCOL`) that the image declares and
  `/validate` checks, the hook port, and the 28,800 s `maximumDurationInSeconds`.
  The coordinator suspends only images whose launched version declares this protocol.
- **`microvm_sleep_after_s`.** Per-task delay, during an approval wait, before the
  MicroVM sleeps (`min` 0 means off, `max` 3,600, `default` 60). The default is
  chosen against `approval_timeout_s.default` (300 s). The supervisor wakes 60 s
  before the deadline and never suspends for less than 30 s, so a default gate
  sleeps from 60 s to 240 s.

The published CLI package contains only `lib/`, so it cannot load the repository
contract at runtime. It mirrors these values as literals, and
`cli/test/constants-parity.test.ts` makes drift a CI failure. The standalone
Forge app is deployed outside the workspaces. It keeps a named copy of the
minimum length in `proxy.js`.

## Adding new constants

1. Add the key and its nested object to `constants.json`.
2. Make each consumer (Python, TS) read the same key.
3. Register the consumer with the drift checks. For a constant that the agent
   holds, add its name and contract key to `OWNED_PYTHON_NAMES` in
   `scripts/check-constants-sync.ts` and a row to `_OWNED` in
   `agent/tests/test_constants_parity.py`. The script fails until the test
   names the constant. For a literal that the CLI mirrors, add it to
   `cli/test/constants-parity.test.ts`.
4. Update the schema section of this README.

Do not assign an owned constant anything but a plain read of its contract
key (`NAME = <contract section>["key"]`, optionally inside one conversion).
`scripts/check-constants-sync.ts` scans every file under `agent/src` and
fails on a literal, arithmetic on the contract value or another key, in
whichever file the assignment stands.

Declare an owned constant once, in the module that owns it, and import it
elsewhere. The script reads the source text and cannot tell which mapping
a subscript reads, so a second declaration passes when it is a plain
subscript read ending in the constant's key, whatever it reads from.
`agent/tests/test_constants_parity.py` compares the value that a constant
holds with the contract, for the owning module only.

## Lint enforcement (AI007, #258)

Linters catch inline magic numbers in all three packages:

- **TypeScript.** `@typescript-eslint/no-magic-numbers` in
  `cdk/eslint.config.mjs` and `cli/eslint.config.mjs` (blocking `error`).
- **Python.** ruff `PLR2004` (magic-value-comparison) in
  `agent/pyproject.toml` (blocking).

When one of these rules fires, name the value as a constant in the
owning module. If the value must agree across Python and TypeScript, add it
to `constants.json` instead and connect the consumers as described above.
The allowlists (0, 1 and -1, HTTP status codes, radix and
unit-conversion factors) are next to each rule's config.
