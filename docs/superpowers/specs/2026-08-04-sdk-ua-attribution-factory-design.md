# Design — SDK User-Agent attribution: reconcile #345, route all clients through a factory

- **Date:** 2026-08-04
- **Backing issue:** [#319](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/319) (`approved`, P0)
- **PR:** [#345](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/345) (`feat/319-sdk-user-agent-appid`)
- **Status:** design approved (brainstorming); pending spec review before writing the implementation plan
- **Artifact disposition:** local planning artifact only — **drop this commit / `git rm` this file before #345 is pushed** so the PR diff stays code + real docs. `docs/superpowers/specs/` is not an established doc location in this repo.
- **Supersedes prior approach:** #338 (`/`-separated, non-native) — rejected

## Problem

ABCA must attribute every outbound AWS SDK call to the solution via the SDK-native
`AWS_SDK_UA_APP_ID` (`app/` segment) plus a static `md/` per-surface segment. PR #345 introduced
that mechanism, but three forces have made it stale and incomplete:

1. **Staleness.** `main` advanced ~241 files since the branch point (`a287364b`), most recently the
   #695 orchestration arc. The PR conflicts in 8 files and merges `CONFLICTING/DIRTY`.
2. **Incomplete coverage.** A census against `main` (tip `4357c353`) finds **142 AWS SDK client
   construction sites, 0 attributed** — the attribution infra lives only on the branch. Of those,
   **5 sites are new** and the stale PR never saw them:
   - `cdk/src/handlers/orchestration-reconciler.ts:79`
   - `cdk/src/handlers/reconcile-stranded-orchestrations.ts:72`
   - `cdk/src/handlers/iteration-heartbeat-sweep.ts:43`
   - `cli/src/linear-auth-health.ts:238` and `:362`
3. **A decaying pattern.** The latest review (theagenticguy, 2026-07-30, **COMMENT**) proved the PR's
   "zero naked clients remain" claim false (14 remained) and showed the new `ABCA_COMPONENT` labels
   were no-ops where handlers built naked clients. The deeper cause: attribution is **opt-in per call
   site** (`new S3Client({ ...abcaUserAgent() })`), and omission has **no failure mode** — it
   compiles, tests pass, the client works, attribution is silently lost. That is why 5 naked sites
   appeared on `main` *during this PR's own review*.

## Goals

- Reconcile #345 onto current `main` (post-#695).
- Introduce a **client factory** as the single attributed construction path, and route **all 142
  sites** through it (89 cdk + 38 cli + 15 agent), including the 5 new sites.
- Resolve **every** open item from the 2026-07-30 review.
- Keep the deliberate omission of the per-request `#{TRACE}` correlation plane (owned by X-Ray /
  #245).

## Non-goals (explicitly out of scope for this PR)

- **The CI enforcement guard** (`scripts/check-ua-coverage.*` drift check, ESLint
  `no-restricted-syntax` rule, ruff/semgrep Python rule, prek hook + `mise` `drift-prevention`
  wiring). This is net-new CI infrastructure — AGENTS.md classifies that as "ask first" — and it
  deserves its own `approved` issue and PR. **This PR builds the factory the guard will later
  enforce; the guard is a fast-follow.** See "Prevention: the fast-follow" below.
- Re-introducing the per-request trace handle dropped by #345.

## Design

### Decision 1 — Prevention mechanism: **Factory + CI guard** (guard deferred)

The chosen prevention model (from brainstorming) is *both* an easy attributed path (factory) *and* a
hard CI gate. This PR ships the factory; the guard follows. The factory alone is a convention with a
weak guarantee (it is how the current opt-in pattern already decayed) — the guard is what makes the
invariant non-regressable — so the two are sequenced, not either/or.

### Decision 2 — PR scope: **split** (attribution now, guard follows)

Rationale above. Keeps #345 to "reconcile + attribute + review fixes" and defers net-new CI infra to
an issue-backed follow-up.

### The factory — one attributed way to build a client

**TypeScript (cdk + cli).** Add a generic `makeClient` to the existing `ua.ts` in each package,
wrapping the already-present `abcaUserAgent()`:

```ts
// cdk/src/handlers/shared/ua.ts  (mirrored in cli/src/ua.ts)
export function makeClient<C>(
  Ctor: new (cfg: any) => C,
  cfg: Record<string, unknown> = {},
): C {
  return new Ctor({ ...cfg, ...abcaUserAgent() });
}
// call site:  const s3 = makeClient(S3Client, { region });
```

For the ~44 `DynamoDBDocumentClient.from(new DynamoDBClient({}))` wrappers, add a paired
`makeDocClient(cfg)` that returns the attributed document client in one call:

```ts
export function makeDocClient(cfg: Record<string, unknown> = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(makeClient(DynamoDBClient, cfg));
}
```

`abcaUserAgent()` stays exported (the future ESLint rule will still permit the raw spread for genuine
edge cases), but `makeClient`/`makeDocClient` become the documented default.

**Python (agent).** The factory half-exists: `aws_session.tenant_client()` / `tenant_resource()` are
the tenant-isolation path, but 8 sites call `boto3.client(...)` directly and bypass them. This PR:

1. Extends `tenant_client`/`tenant_resource` to attach the `md/` UA via the PR's `ua.py`
   `client_config()` (merged with any caller `Config` using the corrected `_merge_ua_config`).
2. Routes the 8 direct callers through the helper. Sites that genuinely cannot be tenant-scoped
   (`config.py` secrets bootstrap, `server.py`/`telemetry.py`/`shell.py` CloudWatch Logs,
   `bedrock_creds_helper.py` STS assume-role) route through a thin **unscoped** `client()` shim in
   `aws_session.py` that still attaches the UA — so "unscoped" never means "unattributed."

Net: in every language there is exactly one attributed constructor, and the UA is attached *inside*
it rather than spread at the call site.

### Merge reconciliation

The 8 conflicting files, and the reconciliation stance for each:

| File | Conflict source | Stance |
|---|---|---|
| `cdk/src/constructs/ecs-agent-cluster.ts` | #695 orchestration touched same construct | Take both: keep main's orchestration changes, re-apply the aspect/UA env wiring |
| `cdk/src/handlers/confirm-uploads.ts` | client-init block moved | Re-route through `makeClient`/`makeDocClient` |
| `cdk/src/handlers/github-webhook-processor.ts` | same | Re-route through factory |
| `cdk/src/handlers/linear-webhook-processor.ts` | same | Re-route through factory |
| `cdk/src/handlers/shared/create-task-core.ts` | conditional client init reworked on main | Re-route each conditional client through factory |
| `cdk/src/handlers/shared/strategies/ecs-strategy.ts` | main refactor | Re-route `getS3Client()` + ECS client through factory |
| `cdk/src/stacks/agent.ts` | main added orchestration Lambdas | Take both; ensure `SolutionUaAspect` still applied at `AspectPriority.MUTATING` and covers new Lambdas |
| `cdk/test/stacks/agent.test.ts` | main added Lambdas; test asserted counts | Rewrite the coverage assertion (see review item 3 below) |

After reconciliation, the 5 new sites and any other post-branch naked sites are routed through the
factory too — the merge is not "done" until the census re-run reports 0 naked sites.

### Review-comment resolution (2026-07-30 review — all items)

| Review item | Resolution |
|---|---|
| **"Zero naked clients" claim false (14+ remain)** | Moot by construction — all 142 sites go through the factory. PR description rewritten to drop the claim; the "Honest coverage gaps" section is reduced to the genuine cases (CDK framework-owned CR provider Lambdas; and — now closed — the STS helper, which routes through the unscoped shim). |
| **`ABCA_COMPONENT` labels are no-ops** | The Jira + api-key handlers now build via the factory, so `webhook`/`api` labels land in a real `md/` segment. Verified by a test asserting the emitted label per surface. |
| **Synth test `/CustomResourceProviderHandler/` filter catches 2 of 3; `toBeGreaterThan(10)` loose** | Replace with an explicit framework-Lambda id allowlist and assert an **exact** count of ABCA-authored Lambdas (updated for #695's orchestration Lambdas), so dropping an integration construct fails the test. |
| **`sanitizeAppId` trailing `#` on 50-char clip** | Strip a trailing separator after clipping (cosmetic, override-only). |
| **`_merge_ua_config` collision branch discards other Config keys** | Rebuild the merged `Config` from the caller's full `_user_provided_options` plus the combined UA string, not from the UA string alone. |

### Error handling & failure posture

- **Fail-open on attribution, never fail-open on the client.** Attribution is observability metadata;
  a malformed component label must never break a client. `sanitizeUaValue` already coerces any
  non-token char to `-`, so a hostile/empty label degrades to a safe segment rather than throwing.
- **Customer opt-out preserved.** `-c sdkUaAppId=''` (aspect no-op) and `AWS_SDK_UA_APP_ID=''` (CLI)
  continue to suppress the `app/` segment; the factory only ever *adds* `md/`.
- **Unscoped ≠ unattributed** (Python): the `client()` shim guarantees UA on sites that cannot be
  tenant-scoped.

## Components & isolation

- `cdk/src/handlers/shared/ua.ts` — owns `SOLUTION_ID`, `abcaUserAgent()`, `makeClient`,
  `makeDocClient`; no CDK/aspect dependency (pure client-config helper).
- `cli/src/ua.ts` — parity module; identical solution id, wire format, sanitization.
- `agent/src/ua.py` + `agent/src/aws_session.py` — `client_config()`/`static_user_agent_extra()` and
  the tenant/unscoped factories; `aws_session` is the only module that calls raw `boto3`.
- `cdk/src/constructs/solution-ua-aspect.ts` — owns the `app/` segment via `AWS_SDK_UA_APP_ID`;
  unchanged in contract, only extended to cover new Lambdas.

Each unit has one purpose, a documented call signature, and can be tested without the others. The
three `md/` sanitizers must stay byte-for-byte equivalent in charset and wire format (a parity risk
the guard PR will later lock down with a cross-language fixture).

## Testing

- **Factory unit tests (all three packages):** attributed UA present in constructed client config;
  caller-supplied opts (region, timeouts) preserved; `makeDocClient` wrapper attributed; Python
  `tenant_client`/unscoped `client()` both attach UA and preserve caller `Config`.
- **Retain** the branch's `#`-preservation cases and the `_merge_ua_config` concat test (rewritten
  per review item 5).
- **Tightened synth-coverage test:** every ABCA-authored Lambda (incl. new #695 orchestration
  Lambdas) carries `AWS_SDK_UA_APP_ID`; explicit framework-id allowlist; exact-count assertion.
- **Label tests:** api-key surface emits `md/…#api`, webhook surface emits `md/…#webhook`.

## Verification gates (AGENTS.md)

Run from the rebased worktree, in order:

1. `MISE_EXPERIMENTAL=1 mise //cdk:eslint` and `mise //cli:eslint` (both `--fix`) → commit any
   autofix (CI "Fail build on mutation" rejects uncommitted lint output).
2. `mise run build` (includes `drift-prevention`).
3. `mise //cdk:test`, `mise //cli:test`, `mise //agent:quality`.
4. `mise run security:sast` (clean; allowlist intentional fallbacks with inline `nosemgrep`) and
   `mise run security:secrets` scoped to the diff.
5. **Census re-run:** grep for naked `new *Client(` / `boto3.client(` / `boto3.resource(` across
   `cdk/src`, `cli/src`, `agent/src` (excluding the helper modules and tests) → must be empty. This
   is the acceptance test for "all SDK calls" and the manual stand-in for the future guard.

## Documentation

- `AGENTS.md` — the #319 note becomes "construct AWS SDK clients via `makeClient`/`makeDocClient`
  (TS) or `tenant_client`/`client` (Python); naked construction loses solution attribution."
- Package `AGENTS.md` files (cdk/cli/agent) — one line each pointing at the factory.
- Regenerate the Starlight mirror (`mise //docs:sync`) if any `docs/guides` or `docs/design` prose
  changes.
- PR description rewritten (drop the false "zero" claim; accurate honest-gaps section).

## Prevention: the fast-follow (separate issue + PR)

Filed as a new `approved` issue after this PR. Scope, per the codebase's established
"invariant-regression" pattern:

- `scripts/check-ua-coverage.mjs` modeled on `scripts/check-types-sync.ts` — scans TS + Python for
  naked client construction outside the helper modules, exits non-zero on any. Wired into
  `mise.toml` `drift-prevention` (a `build` dependency) and a `repo:local` prek hook.
- ESLint `no-restricted-syntax` entry `NewExpression[callee.name=/Client$/]` in both
  `cdk/eslint.config.mjs` and `cli/eslint.config.mjs`, with an override disabling it in the helper
  file (TS side, sharper than the script).
- Python side via ruff `flake8-tidy-imports` banned-api or a semgrep rule under `.semgrep/`
  (the latter gives the `# nosemgrep: <rule-id> -- <reason>` allowlist the repo already documents).
- Optional ratchet-baseline variant (modeled on `check-deadcode-ratchet.mjs`) only if any debt must
  remain temporarily; the goal here is a clean 0, so a hard gate should be feasible immediately.

## Risks & mitigations

- **Rebase drift on a large moving base.** Mitigation: reconcile against a fresh `origin/main`,
  re-run the census as the acceptance test, and re-run eslint `--fix` + commit before `build`.
- **Cross-language sanitizer drift.** Mitigation: keep the three `md/` sanitizers identical now; the
  guard PR adds a shared fixture to lock it.
- **Factory generic typing (`makeClient<C>`) fighting SDK v3 constructor overloads.** Mitigation:
  the `new (cfg: any) => C` shape matches every v3 client constructor; if a specific client rejects
  it, fall back to the raw spread for that one site (still attributed) and note it.
