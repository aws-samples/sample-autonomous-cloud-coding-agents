# CI build performance

The `build` workflow (`.github/workflows/build.yml`) is the gating CI check on every pull request and in the merge queue. This document records where the workflow spends its time, the recommendations for reducing that time, and the order in which we apply them. The document exists so that each optimization is an experiment that is measured and reviewed on its own, not ad hoc tuning.

## How the time is spent

Profiles of `merge_group` runs on the default **4-core, 15Gi** runner show that one mise task dominates the `build` step. `//cdk:test` finishes last and sets the length of the step. After the type-check removal (#1, below) and the disabling of Lambda bundling (#371) landed, the tasks finish much closer together than the original profile suggested.

The table shows the **end offset** of each task inside the `build` step of run [`30412723686`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30412723686) (4-core `merge_group`, 2026-07-28).

| Task (inside `mise run build`) | Ends at | Notes |
|---|---|---|
| `//cdk:test` | +171s | Finishes last. Runs for ~125s by itself |
| `//cdk:synth:quiet` | +142s | 98.5s task. Starts after `//cdk:compile` finishes at +43.5s |
| `//cdk:eslint` | +83s | overlaps |
| `//agent:test` | +74s | overlaps |
| `//cdk:compile` | +43.5s | gates synth |

The mise parallel DAG already overlaps every task that it can. The original description, "everything else finishes in the first ~90s then sits idle for ~200s", no longer holds. `//cdk:synth:quiet` (98.5s) now finishes at +142s, **close to the suite's finish** at +171s. The idle window before `//cdk:test` finishes is roughly **29s**, not ~200s.

**Consequence for sharding (#2).** Synth ends at +142s, so even a perfect shard of `//cdk:test` cannot bring the build below ~142s. Once the suite is parallelized, **`//cdk:synth:quiet` is the next binding constraint**. Any sharding plan must name `//cdk:synth:quiet` and account for it, and must not treat `//cdk:test` as the only floor.

## Why `//cdk:test` was so expensive

The Jest transform (`ts-jest`) type-checked every file at test time. The fix was to make the test transform **transpile-only** (`isolatedModules`).

**Scope of the "paid for twice" claim.** The change is a tradeoff, and it has a cost. `//cdk:compile` runs `tsc --build tsconfig.json`, and `cdk/tsconfig.json` sets `"include": ["src/**/*.ts"]`. The authoritative type-check of `//cdk:compile` therefore covers `src/` only, and **test files are outside that program**. Before this change, `ts-jest` type-checked the tests through `tsconfig.jest.json`. That file extends `tsconfig.dev.json`, which does include `test/**/*.ts`. The net effect differs for the two trees:

- **`src/`.** Type-checked **once instead of twice**. This is the redundancy that the change removes.
- **`test/`.** Type-checked by `tsc` **zero times instead of once**. This is a real reduction in coverage, not only deduplication. Do **not** read "`//cdk:compile` is the sole type-check gate" as meaning that `//cdk:compile` type-checks the tests.

ESLint covers part of the reduction. `cdk/eslint.config.mjs` runs type-aware rules over `test/**/*.ts` with `project: './tsconfig.dev.json'`, so `//cdk:eslint` still reports some classes of type error. That coverage is **narrower** than full `tsc` diagnostics. **Follow-up change (landed).** `mise //cdk:typecheck` and `mise //cli:typecheck` type-check `test/**` again, as part of each package's build. `mise //cdk:typecheck` runs `tsc --noEmit -p tsconfig.typecheck.json`. That configuration is `tsconfig.dev.json` with bundler-style module resolution. The two tasks emit nothing, start after `compile`, and run beside the tests, so they stay off the `//cdk:test` critical path.

> **Key insight.** The speedup comes from not type-checking twice, not from any particular transform engine. A transpile-only `ts-jest` and a Rust-based transform (`@swc/jest`) take about the same wall time. Risk therefore decides the engine choice, not speed. `isolatedModules` keeps `require()` in source order. That order avoids the import hoisting of the ES specification, which would break tests that rely on `const` or `process.env` being set before the module under test is imported.

## Recommendations — status and sequence

Two landed changes cut the suite time, and the table credits each change with its own delta instead of combining them. The figures below carry dates because they drift. An early `~710s → ~346s` reading was accurate on **2026-06-16**, but PR [#371](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/371) (`perf(test): disable Lambda bundling in CDK unit-test synths`, merged 2026-06-17) cut the time again. Any single "post-#1" number is therefore stale.

| # | Recommendation | Status | Effect (with source) |
|---|---|---|---|
| 1 | Skip the redundant jest type-check (transpile-only transform). Issue [#359](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/359) | ✅ Done | Build step ~710s → ~346s and `//cdk:test` ~649s → ~298s (measured 2026-06-16) |
| 1b | Disable Lambda bundling in CDK unit-test synths (~15× per synth). PR [#371](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/371) | ✅ Done | Further cut on top of #1. The combined result is the current baseline below |
| 2 | Shard the CDK suite across a job matrix (`jest --shard=N/M`) | **Deferred** | See [item #2 design](#item-2--sharding-the-cdk-suite-design-deferred). On current numbers **net-neutral-to-slower**, so deferred and not recommended now |
| 3 | Gate `collectCoverage` to `merge_group` only (skip on PR push) | Open | Removes instrumentation from the high-frequency PR event |
| 4 | Use a larger default runner, 4-core → 8-core or 16-core (the label path already exists) | Open | Helps the jest workers, once `JEST_MAX_WORKERS` is raised with the runner, and parallel synth |
| 5 | Path-filtered builds, so that PRs that touch only docs, the CLI, or the agent skip `//cdk:test` | Open | Biggest win for the many PRs that do not touch CDK |
| 6 | Investigate `yarn install --check-files` and whether the CI caches save more time than their restore costs | Open | **Measured: install cost is cache-independent.** A cache hit is net-neutral-to-slower (see Implementer notes), so this is a "delete or fix" investigation, not a "faster cache" win |
| 7 | Drop or narrow the `Free Disk Space` step (dominant addressable overhead) | Open | **New. The biggest addressable pre-build cost.** `Free Disk Space` is **47–67%** of per-job overhead (see Implementer notes). This is the experiment that the measurement protocol requires |

### Current baseline (post #1 + #1b)

The figures were measured on 4-core `merge_group` runs on 2026-07-28 and 2026-07-29.

| Run | `Build completed in` | `//cdk:test` |
|---|---|---|
| [`30412723686`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30412723686) | 171s | `Time: 125.08 s` (136 suites) |
| [`30409171662`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30409171662) | 186s | — |
| [`30400147506`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/30400147506) | 148s | — |

The working figures are therefore **build ~148–186s** and **`//cdk:test` ~125s**, not the ~346s and ~298s that a single "post-#1" row would imply.

### Suggested sequencing

The list is re-ranked against the current baseline (`//cdk:test` ~125s, per-job overhead 120–220s). At these numbers a 4-way shard takes as long as the whole build or longer (see the [shard math](#mechanism)), so sharding moves to the end.

1. **#7 (drop or narrow `Free Disk Space`).** This step is the largest addressable part of the 120–220s overhead, **47–67%** of it (see Implementer notes). One `sudo rm -rf` step accounts for 75–148s per job on the sampled runs. Run the change as the experiment that the [measurement protocol](#measurement-protocol) requires. Drop the step, or narrow it to `/usr/local/lib/android` and `/usr/share/dotnet` and keep `/opt/hostedtoolcache`. Then report peak disk and the 4-core time before and after. This is the one change that lowers `fixed_overhead` materially, and `fixed_overhead` is an input of the shard math below.
2. **#4 (bigger runner).** The change is two lines, the runner label and `JEST_MAX_WORKERS` in `build.yml`. Jest workers and synth are both CPU-bound, so more cores help the two remaining constraints (`//cdk:test` and `//cdk:synth:quiet`) at once. A bigger runner has a recurring per-run cost, so A/B test it.
3. **#5 (path filters).** This item is independent of the others. It removes the whole CDK cost from PRs that touch only docs, the CLI, or the agent.
4. **#3 (PR-only coverage).** The smallest win. Do it when convenient.
5. **#6 (cache investigation).** **Not a speed win.** Measurement shows that the install cost is cache-independent. Between runs with the identical `yarn.lock` hash, the cache-hit path is net slower: `Cache *` restore went from 1s to 9s, yarn from 48.35s to 55.09s, and `Install dependencies` from 56s to 60s. `mise.toml` `[tasks.install]` runs `yarn install --check-files`, which verifies every restored file again and discards the benefit. `uv sync` already installs 127 packages in 121ms, so a venv cache that costs ~3s also costs more than it saves. Treat #6 as a "delete or fix `--check-files`" investigation, not as an attempt to raise the hit rate.
6. **#2 (shard).** **Deferred.** On current numbers sharding is not faster than the whole build, because overhead dominates a ~125s suite. Revisit it only if `//cdk:test` grows past **~250s** (roughly 2× today). At that size a 4-way slice (~62s + overhead) can plausibly clear the build's other constraints. **The ~250s trigger assumes that overhead stays at 120–220s. If #7 lands and overhead drops toward ~60–100s, lower the trigger accordingly.** Keep the design (below) so that it can be re-costed when that trigger fires.

## Implementer notes

These constraints are easy to miss and expensive to get wrong:

- **The distribution of cost changed after #1 and #1b, and `//cdk:test` is no longer the only constraint.** On the current baseline `//cdk:test` (~125s) still finishes last (+171s in run `30412723686`), but `//cdk:synth:quiet` finishes only ~29s earlier (+142s). Parallelizing the suite (#2) therefore has a hard floor at synth's ~142s finish. **Synth is the next binding constraint**, and no suite-level win can go below that floor unless synth or the job-setup cost is also reduced.

- **The dominant pre-build cost is `Free Disk Space`, not cache misses (the finding behind #7).** The figures come from authoritative per-step timings (`gh api repos/.../actions/jobs/<job_id>`, `.steps[].started_at/completed_at`), not from log arithmetic. Run `30412723686` (job `90452344735`) spends **148s** of the 220s from job start to the `build` step on `Free Disk Space` (**67%**). Run `30419878840` (job `90474296240`) spends **97s** of 179s (**54%**). Run `30418865914` (job `90471207016`) spends **75s** of 158s (**47%**). One `sudo rm -rf` step is 47–67% of the per-job overhead. The naive shard math treats that overhead as fixed, but this part of it is addressable. The step also deletes `/opt/hostedtoolcache`, so the later `Setup Node.js` step downloads Node 22.23.1 again from `actions/node-versions`. The download takes only ~4–5s, so it is a sign of waste and not overhead. The step spends ~100s to delete a tool cache, and the job needs part of that cache back immediately. We do **not** claim that the step is unnecessary. The sampled logs show no `ENOSPC` evidence, but that absence does not prove that the build fits without the step. Treat the change as the experiment that this document's measurement protocol requires. Drop the step, or narrow it to `/usr/local/lib/android` and `/usr/share/dotnet` and keep `/opt/hostedtoolcache`. Then report peak disk and the 4-core wall time before and after. This item belongs ahead of #6 in the sequence, and it changes an input of the shard math. Without the step, `fixed_overhead` drops from 120–220s toward ~60–100s. This item is the one change that could make item #2 worth re-costing before the ~250s trigger fires.

- **Cache hits do not save time here, because the install cost is cache-independent (the finding behind #6).** All three sampled runs logged `node_modules=miss, venv=miss, jest=miss` on `merge_group`. Those misses are largely structural, not a misconfiguration. According to GitHub's cache documentation, a cache that a `pull_request` run creates is scoped to the merge ref (`refs/pull/.../merge`), and only re-runs of that PR can restore it. Merge-queue refs therefore cannot read PR-branch caches. More importantly, a higher hit rate saves nothing. Compare a `merge_group` run that missed the cache (`30412723686`) with a `pull_request` run that hit it (`30419878840`), both with the **identical** `yarn.lock` hash. The `Cache *` restore steps went from 1s to **9s**, yarn from `Done in 48.35s` to `55.09s`, and `Install dependencies` from 56s to 60s. The hit path is net **slower**. The cause is that `mise.toml` `[tasks.install]` runs `yarn install --check-files`, which verifies every restored file in `node_modules` again and discards the benefit of restoring it. On the miss run `uv sync` reported `Prepared 127 packages in 1.77s`, `Installed 127 packages in 121ms`, so a venv cache that costs ~3s to restore also costs more than it saves. Treat #6 as a "delete or fix `--check-files`" investigation, not as an attempt to raise the hit rate. A higher hit rate removes roughly zero from the job-setup cost.

- **`fixed_overhead` must be measured from job start, not from install.** The per-job overhead of a shard is more than checkout, install, and cache restore. A real shard job also runs `Set up job`, `Free Disk Space`, tool setup, artifact upload, and post-job cache saves. Measured from job start to the start of the `build` step, the overhead is **220s** for run `30412723686` (`Install completed in 56s`), **122s** for run `30409171662` (`Install completed in 57s`), and **220s** for run `30400147506` (`Install completed in 81s`). Use **120–220s**, not ~95s, when you cost any fan-out.

- **The `build` check is required and must report on `merge_group`.** If the check is marked required but does not run on the `merge_group` event, it never reports and the merge queue deadlocks. This constraint affects #2 and #5:
  - **#2 (shard).** The required check must **aggregate** the shard results. Either keep one `build` job that runs the shards internally, or add a gate job that `needs:` all shards and is the one marked required. Do **not** mark individual shard jobs required. Check that the per-shard fixed overhead (120–220s, above) does not erode the win. Measure wall-clock time, not the sum of the shard times.
  - **#5 (path filter).** You cannot skip the `build` job for docs-only PRs, because the required check would never report. Keep the job and make the expensive steps conditional, for example with `dorny/paths-filter` in front of `//cdk:test`. Emit success when CDK paths are untouched. Annotate what was skipped, so that nobody mistakes a skipped suite for a covered one.

- **Coverage thresholds are the merge gate (#3).** The thresholds are in `cdk/package.json`, `cli/package.json`, `web/vite.config.ts`, the agent pytest `fail_under`, and the test script of `integrations/jira-forge-app`. `contracts/coverage-thresholds.json` and the `check:coverage-thresholds-sync` drift check keep them in sync. The contract pins more than the numbers. It also pins that coverage is collected (`collectCoverage`), the scope that coverage is measured over, each package's test script verbatim, pytest's `addopts`, and the five mise test tasks. The check also fails on a committed mise, yarn, or npm rc file next to one of those manifests, and on a `node:coverage` comment in the Forge app's `src/`. Skipping `collectCoverage` on `pull_request` ([#676](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/676)) therefore needs a change to the contract first. The thresholds must still be enforced on `merge_group`, so that nothing merges under-covered.

- **Runner sizing is two lines (#4): the runner label and `JEST_MAX_WORKERS`.** `build.yml` already resolves the runner from `vars.DEFAULT_RUNNER_LABEL` and PR labels (`self-hosted`, `ubuntu-latest-4-cores`). Jest does not use extra cores by itself here. Its worker count is the `JEST_MAX_WORKERS` that `build.yml` sets (see the next note), so raise that number with the runner. Synth is CPU-bound, so more cores help both jest and synth. Weigh that gain against the recurring per-run cost.

- **The jest worker count is set in `build.yml`, not derived from the runner.** Since [#695](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/695) the cdk test script passes `--maxWorkers=${JEST_MAX_WORKERS:-25%}` to jest, and 25% of a 4-core runner is **one** worker. With the variable unset, the suite ran serially. Run [`42716472700`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/actions/runs/42716472700) (4-core `merge_group`, 2026-11-09) spent **1044s** of a 1137s build in `//cdk:test` (243 suites). `build.yml` now sets `JEST_MAX_WORKERS=3`, which leaves one core to the other build tasks. The baseline figures above predate both changes, so re-measure `//cdk:test` on a 4-core run before you cost anything against them. The same job cancels the superseded run when a pull request gets a new push. A `merge_group` run or a manual run is never cancelled. The job stops after 45 minutes. `//web:build` and the cdk synth share one `vite build` (`//web:bundle`).

## Item #2 — sharding the CDK suite (design, DEFERRED)

> **Status: deferred, not recommended on current numbers.** With `//cdk:test` at ~125s and per-job overhead at 120–220s, sharding is **not** faster than the current whole build. See the recomputed math below. We keep the design so that it can be re-costed quickly if the suite grows (trigger: `//cdk:test` > ~250s). Backing issue: [#363](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/363).

### Mechanism

Jest 30 supports `--shard=<index>/<total>`, which deterministically partitions the test files into `total` groups and runs only group `index`. Running N shards as N parallel CI jobs turns a single suite into N jobs of roughly `slice/N + fixed_overhead` seconds. `fixed_overhead` is the **full per-job wall time from job start to the start of the `build` step**. It covers checkout, `Set up job`, `Free Disk Space`, tool setup, install, and cache restore, plus post-job artifact upload and cache saves. Measured today, that overhead is **120–220s**, of which `Free Disk Space` alone is **75–148s** and install is a cache-independent **~56–60s** (see Implementer notes). The overhead is therefore mostly addressable, and it is not the ~90–100s that an install-only estimate assumes. **Re-measure `fixed_overhead` before you cost any fan-out.** The ~250s deferral trigger below assumes that overhead stays at 120–220s, so if the `Free Disk Space` step is dropped or narrowed (#7), the trigger should move down accordingly.

The table recomputes this document's `slice + fixed_overhead` formula with **measured** inputs (`//cdk:test` ~125s, overhead 120–220s).

| Shards | Ideal test slice | + fixed overhead (120–220s) | Approx. shard wall |
|---|---|---|---|
| 1 (today) | ~125s | n/a | whole build **148–186s** |
| 2 | ~63s | 120–220s | ~183–283s |
| 4 | ~31s | 120–220s | ~151–251s |

> **Insight. The overhead dominates a ~125s suite.** A 4-way shard job takes **as long as the current entire build (148–186s) or longer**, and that excludes the aggregate job's own overhead, the extra runner-minutes, and the complexity of merging coverage. On today's numbers sharding is therefore **net-neutral-to-slower**. Sharding becomes attractive only when the suite is large enough that `slice/N` dominates the fixed overhead. That is the reason for the **~250s trigger** in the sequencing section. But most of that fixed overhead is addressable. Without the `Free Disk Space` step (#7), the overhead drops toward ~60–100s, and the trigger drops with it. Until then, reduce the overhead directly (#7) and add cores (#4) first. Both help without any of sharding's fan-out cost. **Cache hit rate (#6) is not on this list. Measurement shows that the install cost is cache-independent (see Implementer notes), so a cache hit saves ~zero.**

### Required-check wiring (the part that's easy to get wrong)

`build` is a **required** status check and must report on the `merge_group` event (see the comment on the `merge_group` trigger in `build.yml` and #327). Sharding is a **required-context change, not a workflow-only change**. If the check-run name is wrong, the merge queue deadlocks even when the YAML is otherwise correct.

**The required context in this repo is `build (agentcore)`, not `build`.** `build.yml` already has `strategy: matrix: compute_type: [agentcore]` on the `build` job, and a single-value matrix still emits a parenthesized suffix. PR [#672](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/672) (`gh pr view 672 --json statusCheckRollup`) and ruleset `14980587` confirm it:

```json
[{"context":"build (agentcore)"},{"context":"Secrets, deps, and workflow scan"}]
```

Two corrections to the naive plan follow:

1. **Matrix suffixes list every dimension in declaration order.** Adding a `shard` dimension to the existing `compute_type` matrix yields `build (agentcore, 1)`, `build (agentcore, 2)`, and so on. **`build (1)` never appears.** Marking those per-shard runs required is fragile, because a change of the shard count changes the contexts. Marking none of them required defeats the gate.
2. **An aggregate job named plain `build` emits the check `build`, which does NOT match the required `build (agentcore)` context.** The required check then never reports and the merge queue deadlocks. #327 and the comment on the `merge_group` trigger in `build.yml` warn about exactly this failure.

The aggregate job must therefore **either** keep the `compute_type` matrix, which keeps the emitted name `build (agentcore)`, **or** ship together with an update of the ruleset (`14980587`) to the new context name that the job emits. Do not ship the shard workflow without a plan for the required-context change.

The robust pattern is **fan-out + aggregate gate**:

```
build-shard (matrix: compute_type × shard)   # e.g. build (agentcore, 1..N); NOT individually required
        │
        ▼
build (agentcore)  (needs: build-shard)      # single required context; always runs,
                                             # fails if any shard failed
```

- The matrix job (`build-shard`) runs `jest --shard=${{ matrix.shard }}/N` and uploads its coverage artifact.
- The aggregate job keeps the `compute_type: [agentcore]` matrix, so it emits the required **`build (agentcore)`** context, one stable name for any shard count. Its gate must use GitHub's documented pattern: **`if: ${{ always() }}` on the job, with the pass or fail decision moved into a step.** `contains()` is **not** one of GitHub's four status-check functions (`success()`, `always()`, `cancelled()`, `failure()`), so a bare `if: ${{ contains(needs.*.result, 'failure') }}` silently becomes `success() && contains(needs.*.result, 'failure')`. That condition contradicts itself and **never runs on either outcome**. Once the job is the required context, it admits failing shards:

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

- Coverage must be **merged across shards** before the threshold gate runs, because each shard sees only its slice. Collect the per-shard `coverage-final.json` files, merge them (for example with `nyc merge` or `istanbul-merge`), then enforce `coverageThreshold` once on the merged report. Otherwise every shard fails its own threshold.
- The **self-mutation check** (drift detection) should run once, in the aggregate job or in a dedicated single job, not per shard. That avoids N redundant `git diff` runs and racing artifact uploads.

### Open design questions for the implementer

- **Synth and non-test tasks.** `//cli:*`, `//docs:build`, and `//agent:quality` finish early (~74–83s) and are easy to keep off the critical path. **`//cdk:synth:quiet` is different.** At +142s it is the next binding constraint (see [How the time is spent](#how-the-time-is-spent)). Wherever it runs (the aggregate job, a dedicated job, or shard 1), `//cdk:synth:quiet` sets the new floor, not the sharded suite. Decide deliberately where it runs, and measure against ~142s, not against the suite.
- **Shard balance.** `--shard` partitions by file count, not by runtime. A few heavy suites (full `App` + cdk-nag synth) can make one shard slower than the others. If the imbalance is material, consider ordering or grouping the heavy suites, or a runtime-aware splitter. Measure first.

## Measurement protocol

Every change here must report a real **4-core CI** figure before and after, not only a local figure. The comparison on the same 4-core runner is the gate. Local machines have more cores and understate the CI win. The CI number is the one that matters for the merge queue. Read the `build` step duration and the per-task `Time:` line from the run log. For sharding, report the **wall-clock time of the slowest shard plus the aggregate job**, not the sum of the shard times.
