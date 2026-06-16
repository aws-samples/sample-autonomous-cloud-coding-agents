---
title: Ci build performance
---

# CI build performance

The `build` workflow (`.github/workflows/build.yml`) is the gating CI check on every pull request and in the merge queue. This document records how its cost is distributed, the levers for reducing it, and the sequence in which we are applying them. It exists so that each optimization is a measurable, independently-reviewable experiment rather than ad-hoc tuning.

## How the time is spent

Profiling a representative `merge_group` run on the default **4-core, 15Gi** runner showed the job is dominated by a single mise task. The `build` step is the overwhelming majority of the job, and inside it `//cdk:test` is the long pole — everything else (agent quality, CDK compile/synth/eslint, CLI, docs, drift checks) finishes in roughly the first 90 seconds and then sits idle while the CDK Jest suite runs alone.

| Task (inside `mise run build`) | Original wall time | Share of build step |
|---|---|---|
| `//cdk:test` | ~649s | ~91% |
| `//cli:test` | ~105s | (overlaps) |
| `//cdk:synth:quiet` | ~96s | (overlaps) |
| `//cdk:eslint` | ~78s | (overlaps) |
| `//cdk:compile` | ~58s | (overlaps) |
| `//docs:build` | ~50s | (overlaps) |
| `//agent:quality`, `//cli:*`, drift checks | <60s each | (overlaps) |

The mise parallel DAG already overlaps every task it can; the bottleneck is that one task is far longer than the sum of the rest, so the DAG has nothing left to schedule against it.

## Why `//cdk:test` was so expensive

The Jest transform (`ts-jest`) type-checked every file at test time. But `//cdk:compile` (`tsc --build`) already performs the authoritative type-check in the same build DAG, so type-checking was paid for twice. The fix was to make the test transform **transpile-only** (`isolatedModules`), leaving `//cdk:compile` as the sole type-check gate.

> **Key insight:** the speedup comes from *not type-checking twice*, not from any particular transform engine. A transpile-only `ts-jest` and a Rust-based transform (`@swc/jest`) land at essentially the same wall time. The engine choice is therefore decided by *risk*, not speed — and `isolatedModules` keeps `require()` in source order, avoiding the ES-spec import-hoisting behaviour that would otherwise break tests relying on `const` / `process.env` set before the module-under-test is imported.

## Recommendations — status and sequence

| # | Recommendation | Status | Effect |
|---|---|---|---|
| 1 | Skip the redundant jest type-check (transpile-only transform) | ✅ Done | build step ~710s → ~346s (−51%); `//cdk:test` ~649s → ~298s |
| 2 | Shard the CDK suite across a job matrix (`jest --shard=N/M`) | Open | ~298s → ~75–100s wall (4-way); stacks on top of #1 |
| 3 | Gate `collectCoverage` to `merge_group` only (skip on PR push) | Open | trims instrumentation on the high-frequency PR event |
| 4 | Bump the default runner (4-core → 8/16-core; label path already exists) | Open | direct win for jest workers + parallel synth |
| 5 | Path-filtered builds so docs/CLI/agent-only PRs skip `//cdk:test` | Open | biggest win for the long tail of non-CDK PRs |

### Suggested sequencing

1. **#2 (shard)** — attacks the now-dominant ~298s long pole directly. Biggest remaining bang.
2. **#5 (path filters)** — orthogonal; removes the whole tax from docs/CLI/agent-only PRs.
3. **#4 (bigger runner)** — cheap, immediate experiment, but a recurring per-run cost; good to A/B against #2.
4. **#3 (PR-only coverage)** — smallest win; fold in opportunistically.

## Implementer notes

These constraints are easy to miss and expensive to get wrong:

- **The cost shape shifted after #1.** `//cdk:test` was ~91% of the build step; at ~298s it is now ~86% of a ~346s step — still the long pole, but half the absolute size. The DAG cannot overlap it, so the next gain must come from parallelizing the suite (#2) or not running it when irrelevant (#5).

- **The `build` check is *required* and must report on `merge_group`.** Marking it required without it running on the `merge_group` event would deadlock the merge queue (the check would never report). This shapes #2 and #5:
  - **#2 (shard):** the *required* check must **aggregate** shard results. Either keep one `build` job that runs shards internally, or add a gate job that `needs:` all shards and is the one marked required. Do **not** mark individual shard jobs required. Watch that per-shard fixed overhead (checkout, install, cache restore) does not erode the win; measure wall-clock, not sum-of-shards.
  - **#5 (path filter):** you cannot simply skip the `build` job for docs-only PRs (the required check would never report). Keep the job and make the *expensive steps* conditional (e.g. `dorny/paths-filter` gating `//cdk:test`), emitting success when CDK paths are untouched. Annotate what was skipped so a skipped suite is not mistaken for a covered one.

- **Coverage thresholds are the merge gate (#3).** Thresholds live in `cdk/package.json` / `cli/package.json` and the agent pytest `fail_under`, kept in sync via `contracts/coverage-thresholds.json` and the `check:coverage-thresholds-sync` drift check. If `collectCoverage` is skipped on `pull_request`, thresholds must still be enforced on `merge_group` so nothing merges under-covered.

- **Runner sizing is one line (#4).** `build.yml` already resolves the runner from `vars.DEFAULT_RUNNER_LABEL` and PR labels (`self-hosted`, `ubuntu-latest-4-cores`). Jest workers scale with cores (`maxWorkers` defaults to cores−1) and synth is CPU-bound, so more cores helps both — weighed against the recurring per-run cost.

## Item #2 — sharding the CDK suite (design)

This is the next lever and the focus of active work under [#363](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/363). Because `//cdk:test` (~298s after item #1) is the long pole that the mise DAG cannot overlap, the only way to cut it further is to run the suite across multiple workers in parallel and aggregate the results.

### Mechanism

Jest 30 supports `--shard=<index>/<total>`, which deterministically partitions the test files into `total` groups and runs only group `index`. Running N shards as N parallel CI jobs turns a single ~298s task into N jobs of roughly `298/N + fixed_overhead` seconds, where `fixed_overhead` is the per-job checkout + install + cache-restore (~90–100s today).

| Shards | Ideal test slice | + fixed overhead (~95s) | Approx. wall |
|---|---|---|---|
| 1 (today) | 298s | n/a | ~298s |
| 2 | ~149s | ~95s | ~245s |
| 4 | ~75s | ~95s | ~170s |
| 6 | ~50s | ~95s | ~145s |

> **Insight — overhead dominates past ~4 shards.** With ~119 test suites, the test slice shrinks linearly but the ~95s fixed per-job overhead does not. Beyond ~4 shards the overhead is the majority of each job's wall time, so returns diminish fast. **4-way is the recommended starting point**; measure before going higher, and invest in cache hit-rate (node_modules, agent venv, jest transform cache) before adding shards.

### Required-check wiring (the part that's easy to get wrong)

`build` is a **required** status check and must report on the `merge_group` event (see the comment block atop `build.yml` and #327). A naive matrix (`shard: [1,2,3,4]`) creates **four separate check runs** — `build (1)`, `build (2)`, … — none of which is the single `build` context that branch protection requires. Marking all four required is fragile (renaming/recount changes contexts); marking none required defeats the gate.

The robust pattern is **fan-out + aggregate gate**:

```
build-shard (matrix: shard ∈ [1..N])   # parallel; NOT individually required
        │
        ▼
build (needs: build-shard)             # single required context; succeeds
                                       # only if every shard succeeded
```

- The matrix job (`build-shard`) runs `jest --shard=${{ matrix.shard }}/N` and uploads its `cdk.out` / coverage artifacts.
- A single aggregate job named **`build`** `needs: [build-shard]` and fails if any shard failed (`if: ${{ contains(needs.*.result, 'failure') }}`). **This** job is the required context — one stable name regardless of shard count.
- Coverage must be **merged across shards** before the threshold gate runs (each shard only sees its slice). Collect per-shard `coverage-final.json`, merge (e.g. `nyc merge` / `istanbul-merge`), then enforce `coverageThreshold` once on the merged report — otherwise every shard fails its own threshold.
- The **self-mutation check** (drift detection) should run once in the aggregate job (or a dedicated single job), not per-shard, to avoid N redundant `git diff` runs and racy artifact uploads.

### Open design questions for the implementer

- **Synth + non-test tasks:** `//cdk:synth:quiet`, `//cli:*`, `//docs:build`, `//agent:quality` are not sharded and finish in the first ~90s. Decide whether they run in the aggregate job, a separate job, or shard 1 only — keep them off the critical path.
- **Artifact strategy:** the deploy pipeline consumes `cdk-agentcore-out`. Sharding test execution should not change synth output; ensure exactly one job still produces the deploy artifact.
- **Shard balance:** `--shard` partitions by file count, not by runtime. A few heavy suites (full `App` + cdk-nag synth) can skew one shard. If imbalance is material, consider ordering/grouping heavy suites or a runtime-aware splitter; measure first.

## Measurement protocol

Every change here must report a real **4-core CI** before/after (the apples-to-apples gate), not just a local figure. Local machines have more cores and will understate the CI win; the CI number is the one that matters for the merge-queue experience. Read the `build` step duration and the per-task `Time:` line from the run log. For sharding specifically, report **wall-clock of the slowest shard + aggregate job**, not the sum of shard times.
