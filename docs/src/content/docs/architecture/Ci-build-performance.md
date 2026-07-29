---
title: Ci build performance
---

# CI build performance

The `build` workflow (`.github/workflows/build.yml`) is the gating CI check on every pull request and in the merge queue. This document records how its cost is distributed, the levers for reducing it, and the sequence in which we are applying them. It exists so that each optimization is a measurable, independently-reviewable experiment rather than ad-hoc tuning.

## How the time is spent

Profiling `merge_group` runs on the default **4-core, 15Gi** runner shows the `build` step dominated by a single mise task: `//cdk:test` is the long pole. Once both type-check-removal (#1, below) and Lambda-bundling-disable (#371) landed, the picture is much tighter than the original profile suggested.

Per-task **end offsets** inside the `build` step of run [`30412723686`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30412723686) (4-core `merge_group`, 2026-07-28):

| Task (inside `mise run build`) | Ends at | Notes |
|---|---|---|
| `//cdk:test` | +171s | long pole; ~125s of run alone |
| `//cdk:synth:quiet` | +142s | 98.5s task; starts after `//cdk:compile` finishes at +43.5s |
| `//cdk:eslint` | +83s | overlaps |
| `//agent:test` | +74s | overlaps |
| `//cdk:compile` | +43.5s | gates synth |

The mise parallel DAG already overlaps every task it can. The original "everything else finishes in the first ~90s then sits idle for ~200s" framing has expired: `//cdk:synth:quiet` (98.5s) now runs **nearly co-terminal** with `//cdk:test`, finishing at +142s versus the suite's +171s. The genuine idle window against the long pole is roughly **29s**, not ~200s.

**Consequence for sharding (#2):** because synth ends at +142s, even a *perfect* shard of `//cdk:test` cannot pull the build below ~142s. **`//cdk:synth:quiet` is the next binding constraint** once the suite is parallelized, and any sharding plan must name and account for it rather than treating `//cdk:test` as the sole floor.

## Why `//cdk:test` was so expensive

The Jest transform (`ts-jest`) type-checked every file at test time. The fix was to make the test transform **transpile-only** (`isolatedModules`).

**Scope of the "paid for twice" claim (a tradeoff, not a free lunch).** `//cdk:compile` runs `tsc --build tsconfig.json`, and `cdk/tsconfig.json` sets `"include": ["src/**/*.ts"]` — so its authoritative type-check covers `src/` only; **test files sit outside that program**. Before this change, `ts-jest` type-checked the tests via `tsconfig.jest.json` (which extends `tsconfig.dev.json`, and *that* config does include `test/**/*.ts`). So the net effect is asymmetric:

- **`src/`**: type-checked **twice → once** (the genuine redundancy this change removes).
- **`test/`**: type-checked **once → zero** by `tsc`. This is a real coverage reduction, not just deduplication — do **not** read "`//cdk:compile` is the sole type-check gate" as meaning it type-checks the tests.

The reduction is partly backstopped: `cdk/eslint.config.mjs` runs type-aware rules over `test/**/*.ts` with `project: './tsconfig.dev.json'`, so some classes of type error still surface in `//cdk:eslint` — but that is **narrower** than full `tsc` diagnostics. **Follow-up lever (deferred):** if test-file type coverage proves worth restoring, add a cheap `tsc --noEmit -p tsconfig.dev.json` gate; it type-checks `test/**` without re-emitting `src/` and stays off the `//cdk:test` critical path.

> **Key insight:** the speedup comes from *not type-checking twice*, not from any particular transform engine. A transpile-only `ts-jest` and a Rust-based transform (`@swc/jest`) land at essentially the same wall time. The engine choice is therefore decided by *risk*, not speed — and `isolatedModules` keeps `require()` in source order, avoiding the ES-spec import-hoisting behaviour that would otherwise break tests relying on `const` / `process.env` set before the module-under-test is imported.

## Recommendations — status and sequence

Two landed changes cut the suite, and the ledger credits each its own delta rather than lumping them together. Figures below are dated because they drift: an early `~710s → ~346s` read was accurate on **2026-06-16**, but PR [#371](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/371) (`perf(test): disable Lambda bundling in CDK unit-test synths`, merged 2026-06-17) cut it again, so any single "post-#1" number is stale.

| # | Recommendation | Status | Effect (with source) |
|---|---|---|---|
| 1 | Skip the redundant jest type-check (transpile-only transform) — [#359](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/359) | ✅ Done | build step ~710s → ~346s; `//cdk:test` ~649s → ~298s (measured 2026-06-16) |
| 1b | Disable Lambda bundling in CDK unit-test synths (~15× per synth) — [#371](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/371) | ✅ Done | further cut on top of #1; combined result is the current baseline below |
| 2 | Shard the CDK suite across a job matrix (`jest --shard=N/M`) | **Deferred** | see [item #2 design](#item-2--sharding-the-cdk-suite-design-deferred); on current numbers **net-neutral-to-slower** — deferred, not recommended-now |
| 3 | Gate `collectCoverage` to `merge_group` only (skip on PR push) | Open | trims instrumentation on the high-frequency PR event |
| 4 | Bump the default runner (4-core → 8/16-core; label path already exists) | Open | direct win for jest workers + parallel synth |
| 5 | Path-filtered builds so docs/CLI/agent-only PRs skip `//cdk:test` | Open | biggest win for the long tail of non-CDK PRs |
| 6 | Investigate `yarn install --check-files` and whether the CI caches earn their restore cost | Open | **measured: install cost is cache-independent** — restoring hits is net-neutral-to-*slower* (see Implementer notes), so this is a "delete or fix" investigation, not a "faster cache" win |
| 7 | Drop / narrow the `Free Disk Space` step (dominant addressable overhead) | Open | **new — the single biggest addressable pre-build cost:** `Free Disk Space` is **47–67%** of per-job overhead (see Implementer notes); the experiment the measurement protocol demands |

### Current baseline (post #1 + #1b)

Measured on 4-core `merge_group` runs, 2026-07-28/29:

| Run | `Build completed in` | `//cdk:test` |
|---|---|---|
| [`30412723686`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30412723686) | 171s | `Time: 125.08 s` (136 suites) |
| [`30409171662`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30409171662) | 186s | — |
| [`30400147506`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30400147506) | 148s | — |

So the working figures are **build ~148–186s** and **`//cdk:test` ~125s** — not the ~346s / ~298s an unsplit "post-#1" ledger would imply.

### Suggested sequencing

Re-ranked against the current baseline (`//cdk:test` ~125s, per-job overhead 120–220s). At these numbers a 4-way shard lands *at or above* the whole build (see the [shard math](#mechanism)), so sharding is demoted:

1. **#7 (drop/narrow `Free Disk Space`)** — the largest addressable slice of the 120–220s overhead (**47–67%** of it; see Implementer notes). One `sudo rm -rf` step accounts for 75–148s per job on the sampled runs. Run it as the experiment the [measurement protocol](#measurement-protocol) demands — drop the step (or narrow to `/usr/local/lib/android` + `/usr/share/dotnet`, keeping `/opt/hostedtoolcache`) and report peak disk + 4-core before/after. This is the one change that pulls `fixed_overhead` down materially, and it directly feeds the shard math below.
2. **#4 (bigger runner)** — one line; jest workers and synth are both CPU-bound, so more cores helps the two remaining constraints (`//cdk:test`, `//cdk:synth:quiet`) at once. Recurring per-run cost, so A/B it.
3. **#5 (path filters)** — orthogonal; removes the whole CDK tax from docs/CLI/agent-only PRs.
4. **#3 (PR-only coverage)** — smallest win; fold in opportunistically.
5. **#6 (cache investigation)** — **not a speed win.** Measurement shows the install cost is cache-independent: comparing runs with the identical `yarn.lock` hash, the cache-*hit* path is net *slower* (`Cache *` restore 1s→9s, yarn 48.35s→55.09s, `Install dependencies` 56s→60s). `mise.toml` `[tasks.install]` runs `yarn install --check-files`, which re-verifies every restored file and discards the benefit; `uv sync` already installs 127 packages in 121ms, so a venv cache costing ~3s cannot pay for itself either. Treat #6 as a "delete or fix `--check-files`" investigation, not a hit-rate chase.
6. **#2 (shard)** — **deferred.** On current numbers it does not beat the whole build (overhead dominates a ~125s suite). Revisit only if `//cdk:test` grows past **~250s** (roughly 2× today), at which point a 4-way slice (~62s + overhead) can plausibly clear the build's other constraints. **The ~250s trigger is conditional on overhead staying 120–220s — if #7 lands and overhead drops toward ~60–100s, move the trigger down accordingly.** Keep the design (below) so it is ready to re-cost when that trigger fires.

## Implementer notes

These constraints are easy to miss and expensive to get wrong:

- **The cost shape shifted after #1 + #1b, and the long pole no longer stands alone.** On the current baseline `//cdk:test` (~125s) still finishes last (+171s in run `30412723686`), but `//cdk:synth:quiet` finishes only ~29s earlier (+142s). So parallelizing the suite (#2) faces a hard floor at synth's ~142s finish — **synth is the next binding constraint**, and any suite-level win below that is unreachable without also attacking synth or the job-setup tax.

- **The dominant pre-build cost is `Free Disk Space`, not cache misses (finding → #7).** From authoritative per-step timings (`gh api repos/.../actions/jobs/<job_id>`, `.steps[].started_at/completed_at`, not log arithmetic): run `30412723686` (job `90452344735`) spends **148s** of a 220s job-start→`build` overhead on `Free Disk Space` (**67%**); run `30419878840` (job `90474296240`) **97s** of 179s (**54%**); run `30418865914` (job `90471207016`) **75s** of 158s (**47%**). One `sudo rm -rf` step is 47–67% of the per-job overhead — overhead the naive shard math treats as fixed, but this slice is squarely *addressable*. It also deletes `/opt/hostedtoolcache`, so the later `Setup Node.js` step re-downloads Node 22.23.1 from `actions/node-versions` — only ~4–5s, so a *smell* (the step pays ~100s to delete a tool cache it immediately needs part of back), not overhead. We are **not** claiming the step is unnecessary — no `ENOSPC` evidence appeared in the sampled logs, but absence of evidence is not proof the build fits without it. Frame it as the experiment this doc's measurement protocol demands: drop the step (or narrow it to `/usr/local/lib/android` + `/usr/share/dotnet`, keeping `/opt/hostedtoolcache`), then report peak disk and 4-core wall before/after. This belongs ahead of #6 in sequencing and feeds the shard math directly: cut it and `fixed_overhead` drops from 120–220s toward ~60–100s — the one change that could make item #2 worth re-costing before the ~250s trigger fires.

- **Cache hits do not save time here — the install cost is cache-independent (finding → #6).** All three sampled runs logged `node_modules=miss, venv=miss, jest=miss` on `merge_group`, but that is largely *structural*, not a misconfiguration: per GitHub's cache docs a cache created by a `pull_request` run is scoped to the merge ref (`refs/pull/.../merge`) and can only be restored by re-runs of that PR, so merge-queue refs cannot read PR-branch caches. More importantly, fixing hit-rate buys nothing. Comparing a missing-cache `merge_group` run (`30412723686`) against a *hitting* `pull_request` run (`30419878840`) with the **identical** `yarn.lock` hash: `Cache *` restore steps 1s → **9s**, yarn `Done in 48.35s` → `55.09s`, `Install dependencies` 56s → 60s — the hit path is net **slower**. Cause: `mise.toml` `[tasks.install]` runs `yarn install --check-files`, which re-verifies every restored file in `node_modules` and discards the benefit of restoring it. On the miss run `uv sync` reported `Prepared 127 packages in 1.77s`, `Installed 127 packages in 121ms`, so a venv cache costing ~3s to restore cannot pay for itself either. Treat #6 as a "delete or fix `--check-files`" investigation, not a hit-rate chase — it shaves roughly zero off the job-setup tax.

- **`fixed_overhead` must be measured from job start, not from install.** The per-job overhead a shard pays is not just checkout + install + cache-restore; a real shard job also pays `Set up job`, `Free Disk Space`, tool setup, artifact upload, and post-job cache saves. Measured job-start → `build`-step-start: run `30412723686` **220s** (`Install completed in 56s`), run `30409171662` **122s** (`Install completed in 57s`), run `30400147506` **220s** (`Install completed in 81s`). Use **120–220s**, not ~95s, when costing any fan-out.

- **The `build` check is *required* and must report on `merge_group`.** Marking it required without it running on the `merge_group` event would deadlock the merge queue (the check would never report). This shapes #2 and #5:
  - **#2 (shard):** the *required* check must **aggregate** shard results. Either keep one `build` job that runs shards internally, or add a gate job that `needs:` all shards and is the one marked required. Do **not** mark individual shard jobs required. Watch that per-shard fixed overhead (120–220s, above) does not erode the win; measure wall-clock, not sum-of-shards.
  - **#5 (path filter):** you cannot simply skip the `build` job for docs-only PRs (the required check would never report). Keep the job and make the *expensive steps* conditional (e.g. `dorny/paths-filter` gating `//cdk:test`), emitting success when CDK paths are untouched. Annotate what was skipped so a skipped suite is not mistaken for a covered one.

- **Coverage thresholds are the merge gate (#3).** Thresholds live in `cdk/package.json` / `cli/package.json` and the agent pytest `fail_under`, kept in sync via `contracts/coverage-thresholds.json` and the `check:coverage-thresholds-sync` drift check. If `collectCoverage` is skipped on `pull_request`, thresholds must still be enforced on `merge_group` so nothing merges under-covered.

- **Runner sizing is one line (#4).** `build.yml` already resolves the runner from `vars.DEFAULT_RUNNER_LABEL` and PR labels (`self-hosted`, `ubuntu-latest-4-cores`). Jest workers scale with cores (`maxWorkers` defaults to cores−1) and synth is CPU-bound, so more cores helps both — weighed against the recurring per-run cost.

## Item #2 — sharding the CDK suite (design, DEFERRED)

> **Status: deferred, not recommended on current numbers.** With `//cdk:test` at ~125s and per-job overhead at 120–220s, sharding does **not** beat the current whole build — see the recomputed math below. The design is retained so it can be re-costed quickly if the suite grows (trigger: `//cdk:test` > ~250s). Backing issue: [#363](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/363).

### Mechanism

Jest 30 supports `--shard=<index>/<total>`, which deterministically partitions the test files into `total` groups and runs only group `index`. Running N shards as N parallel CI jobs turns a single suite into N jobs of roughly `slice/N + fixed_overhead` seconds, where `fixed_overhead` is the **full per-job wall time from job start to the `build` step starting** — checkout, `Set up job`, `Free Disk Space`, tool setup, install, cache restore, plus post-job artifact upload and cache saves. Measured today that is **120–220s**, of which `Free Disk Space` alone is **75–148s** and install is a cache-independent **~56–60s** (see Implementer notes) — so the overhead is mostly *addressable*, not the ~90–100s an install-only estimate assumes. **Re-measure `fixed_overhead` before costing any fan-out:** the ~250s deferral trigger below assumes overhead stays at 120–220s, so if the `Free Disk Space` step is dropped or narrowed (#7), the trigger should move down accordingly.

Recomputing the doc's own `slice + fixed_overhead` formula with **measured** inputs (`//cdk:test` ~125s, overhead 120–220s):

| Shards | Ideal test slice | + fixed overhead (120–220s) | Approx. shard wall |
|---|---|---|---|
| 1 (today) | ~125s | n/a | whole build **148–186s** |
| 2 | ~63s | 120–220s | ~183–283s |
| 4 | ~31s | 120–220s | ~151–251s |

> **Insight — the overhead swamps a ~125s suite.** A 4-way shard job lands **at or above** the current *entire* build (148–186s), and that is before the aggregate job's own overhead, the extra runner-minutes, and the coverage-merge complexity. So on today's numbers sharding is **net-neutral-to-slower**. It only becomes attractive once the suite is large enough that `slice/N` dominates the fixed overhead — hence the **~250s trigger** in the sequencing section. But most of that fixed overhead is *addressable*: cut the `Free Disk Space` step (#7) and it drops toward ~60–100s, which lowers the trigger. Until then, attack overhead directly (#7) and add cores (#4) first — both help without any of sharding's fan-out cost. **Cache hit-rate (#6) is not on this list: measurement shows the install cost is cache-independent (see Implementer notes), so restoring hits saves ~zero.**

### Required-check wiring (the part that's easy to get wrong)

`build` is a **required** status check and must report on the `merge_group` event (see the comment block atop `build.yml` and #327). This is a **required-context change, not a workflow-only change** — get the check-run *name* wrong and the merge queue deadlocks even if the YAML is otherwise correct.

**The required context in this repo is `build (agentcore)`, not `build`.** `build.yml` already carries `strategy: matrix: compute_type: [agentcore]` on the `build` job, and a single-value matrix *still* emits a parenthesized suffix. Confirmed on PR [#672](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/672) (`gh pr view 672 --json statusCheckRollup`) and in ruleset `14980587`:

```json
[{"context":"build (agentcore)"},{"context":"Secrets, deps, and workflow scan"}]
```

Two corrections to the naive plan follow from this:

1. **Matrix suffixes list every dimension in declaration order.** Adding a `shard` dimension to the existing `compute_type` matrix yields `build (agentcore, 1)`, `build (agentcore, 2)`, … — **`build (1)` never appears.** Marking those per-shard runs required is fragile (recount changes contexts); marking none required defeats the gate.
2. **An aggregate job named plain `build` emits check `build`, which does NOT match the required `build (agentcore)` context.** The required check would then never report and the merge queue deadlocks — the exact failure mode #327 and the comment block atop `build.yml` warn about.

So the aggregate job must **either** retain the `compute_type` matrix (keeping the emitted name `build (agentcore)`) **or** be paired with a coordinated ruleset update (`14980587`) to whatever new context name it emits. Do not ship the shard workflow without also planning the required-context change.

The robust pattern is **fan-out + aggregate gate**:

```
build-shard (matrix: compute_type × shard)   # e.g. build (agentcore, 1..N); NOT individually required
        │
        ▼
build (agentcore)  (needs: build-shard)      # single required context; always runs,
                                             # fails if any shard failed
```

- The matrix job (`build-shard`) runs `jest --shard=${{ matrix.shard }}/N` and uploads its `cdk.out` / coverage artifacts.
- The aggregate job keeps the `compute_type: [agentcore]` matrix so it emits the required **`build (agentcore)`** context (one stable name regardless of shard count). Its gate must use GitHub's documented pattern: **`if: ${{ always() }}` on the job, with the pass/fail decision moved into a step.** `contains()` is **not** one of GitHub's four status-check functions (`success()`, `always()`, `cancelled()`, `failure()`), so a bare `if: ${{ contains(needs.*.result, 'failure') }}` silently becomes `success() && contains(needs.*.result, 'failure')` — a contradiction that **never runs on either outcome**, admitting failing shards once it is the required context:

  ```yaml
  build:
    needs: [build-shard]
    strategy:
      matrix:
        compute_type: [agentcore]   # keeps the required "build (agentcore)" name
    if: ${{ always() }}             # job must always run so it always reports
    steps:
      - name: Gate on shard results
        if: ${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}
        run: exit 1
  ```

- Coverage must be **merged across shards** before the threshold gate runs (each shard only sees its slice). Collect per-shard `coverage-final.json`, merge (e.g. `nyc merge` / `istanbul-merge`), then enforce `coverageThreshold` once on the merged report — otherwise every shard fails its own threshold.
- The **self-mutation check** (drift detection) should run once in the aggregate job (or a dedicated single job), not per-shard, to avoid N redundant `git diff` runs and racy artifact uploads.

### Open design questions for the implementer

- **Synth + non-test tasks:** `//cli:*`, `//docs:build`, `//agent:quality` finish early (~74–83s) and are easy to keep off the critical path. **`//cdk:synth:quiet` is different** — at +142s it is the *next binding constraint* (see [How the time is spent](#how-the-time-is-spent)), so wherever it runs (aggregate job, a dedicated job, or shard 1) it, not the sharded suite, sets the new floor. Decide its placement deliberately and measure against ~142s, not the suite.
- **Artifact strategy:** the deploy pipeline consumes `cdk-agentcore-out`. Sharding test execution should not change synth output; ensure exactly one job still produces the deploy artifact.
- **Shard balance:** `--shard` partitions by file count, not by runtime. A few heavy suites (full `App` + cdk-nag synth) can skew one shard. If imbalance is material, consider ordering/grouping heavy suites or a runtime-aware splitter; measure first.

## Measurement protocol

Every change here must report a real **4-core CI** before/after (the apples-to-apples gate), not just a local figure. Local machines have more cores and will understate the CI win; the CI number is the one that matters for the merge-queue experience. Read the `build` step duration and the per-task `Time:` line from the run log. For sharding specifically, report **wall-clock of the slowest shard + aggregate job**, not the sum of shard times.
