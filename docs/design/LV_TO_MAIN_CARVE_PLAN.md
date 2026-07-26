# linear-vercel → main carve plan (draft PRs)

**Status:** plan for review. **Author:** 2026-07-24. **Scope:** land the whole #247
orchestration + Mode-B + A6-iteration arc (currently only on `linear-vercel`) onto
`aws-samples/main` as a sequence of independently-reviewable **draft** PRs.

## Why this exists

`linear-vercel` (lv) is **432 commits / 218 files / +43.7k lines** ahead of `main`;
`main` is 0 ahead. That divergence is the entire orchestration arc, which has never
merged upstream (the standing #54 governance call). The recent stress-fix batch
(F1/F3/F6/F9 + PM-P0-1/P1-1/P1-2, commits `8a3c29c3..75194a8a`) patches code inside
that arc, so it **cannot be cherry-picked to main standalone** — the files it edits
(`orchestration-release.ts`, `orchestration-reconciler.ts`, `orchestration-comment-trigger.ts`,
`orchestration-parent-comment.ts`) don't exist on main. The arc must land as a whole,
in slices.

> Note on F1 specifically: it's a **no-op on `aws-samples/main`** — main's default
> branch IS `main`, so a diamond child basing off `'main'` is already correct there.
> F1 only matters on a fork whose default ≠ main (the isadeks/`linear-vercel` setup).
> It still travels with the arc (in the `repo.py` diamond block) but changes nothing
> for upstream users; call this out in the relevant PR.

## What is ALREADY on main (so lv changes there are MODIFICATIONS, not net-new)

- **ECS compute substrate** — `ecs-agent-cluster.ts`, `ecs-strategy.ts`, `compute-strategy.ts`, bootstrap `compute-ecs` policies. (lv only adds the rightsized-planning tier.)
- **Linear v1 integration** — `linear-integration.ts`, `linear-webhook-processor.ts`, `linear-webhook.ts`, `linear-feedback.ts`, `linear-oauth-resolver.ts`, project-mapping table.
- **Slack integration** — `slack-integration.ts`, command-processor, events.
- **Shared foundation** — `types.ts`, `validation.ts`, `workflows.ts`, `create-task-core.ts`, `orchestrator.ts`, `error-classifier.ts`, `task-table.ts`; agent `pipeline.py`, `repo.py`, `models.py`, `channel_mcp.py`.

lv-only (net-new): the #247 orchestration DAG/reconciler, Mode-B decompose, A6
iteration/comment-trigger, Linear attachments + issue-context probe, Slack
channel→repo mapping, `agent/workflows/coding/decompose-v1` + `restack-v1`.

## The load-bearing fact that makes slicing possible

TypeScript compiles the whole project, so **a net-new library file compiles even when
nothing imports it yet** — it just sits dormant. And the webhook's orchestration path
is **env-gated**: `linear-webhook-processor.ts:144` reads
`const ORCHESTRATION_TABLE = process.env.ORCHESTRATION_TABLE_NAME`, dormant until the
stack sets it. So we can land the orchestration/decompose/iteration **libraries first
as low-risk additive PRs**, then flip them on with a small number of "activation"
slices. Verified: env-gate present at line 144; import graph is a clean DAG (no cycles).

> **Slice-1 build learning (2026-07-24):** while building S1 as a real draft PR,
> the full CDK suite caught that lv's `DEFAULT_MAX_TURNS` is a **100→200 behavioral
> change**, not an additive field — `orchestrate-task.test.ts` expects 100. It was
> excluded from S1 (kept at main's 100) and flagged for its own justified PR. Lesson:
> a "dormant foundation" slice must be scanned for value-CHANGES (removed lines), not
> just additions; the compiler passes them but the test suite catches the behavior shift.
>
> **Slice-2 build learnings (2026-07-24):**
> 1. **`repo-config.ts` moved to S1.** Building S2 (ECS) failed to compile because
>    `orchestrator.ts` reads `build_command`/`lint_command` off `RepoConfig`/`BlueprintConfig`
>    — additive optional fields that belong in the S1 foundation. Added them to S1
>    (purely additive) and S2 now inherits them. Rule of thumb: if a later slice's
>    modified shared file references a new field, that field's declaration belongs in S1.
> 2. **`orchestrate-task.test.ts` max-turns expectation kept at 100 in S2.** lv's copy
>    of that test asserts the 200 default; since the 200 bump is excluded (see S1
>    learning), S2 keeps the assertion at 100 to match the shipped behavior.
> 3. **Every arc file carries internal-ref comments** (`ABCA-###`, `#NNN`, `K14`, dates)
>    as their sole explanation. Each slice rewrites its files' comments to plain
>    what/why before its PR (this code is public-sample-bound). Not optional polish —
>    it's part of making each slice upstream-clean.

## Slice sequence (dependency-ordered draft PRs)

Two independent analyses converged on the same dependency spine; they differ only in
grouping (10 vs 11 slices — mainly whether agent-Python no-MCP is its own slice and
where Mode-B sits relative to the reconciler). The table below is the working set;
the exact grouping is what the plan PR is for reviewers to confirm. Each slice compiles
+ is reviewable atop its predecessors. The library slices are **dormant**
(import-resolvable, unexercised) until the webhook-activation slice flips the path on.

| # | Slice | What's in it | Depends on | ~size | Risk |
|---|-------|--------------|-----------|-------|------|
| **1** | **Foundation contracts** | additive optional fields on `types.ts` (`orchestration_id`, `depends_on`, `linear_issue_id`, `code_changed`, `head_sha`…), `validation.ts`, `workflows.ts` (register `decompose-v1`/`restack-v1` + `readOnly`), `error-classifier.ts`, `repo-config.ts`/`blueprint.ts` (`build/lint_command`), agent `models.py`; **+ the jest OOM guards** (`--maxWorkers=25%`, `workerIdleMemoryLimit`, `testf`) so later big slices' synth tests don't OOM in CI | — | ~10f / ~400 | LOW (additive) |
| **2** | **ECS rightsized planning** | `ecs-agent-cluster.ts` (BUILD 16vCPU/120GB + read-only planning def), `ecs-strategy.ts`, `orchestrate-task.ts` readOnly route, `orchestrator.ts` build/lint hunk, COMPUTE/ECS_RIGHTSIZED docs | 1 | ~6f / ~700 | MED (CFN task-def revision) |
| **3** | **Linear no-MCP + deterministic feedback + attachments** | agent `channel_mcp.py`/`config.py`/`linear_reactions.py`/`prompt_builder.py`; `linear-attachments.ts`, `linear-feedback.ts` extensions, `linear-issue-context-probe.ts`, `attachment-screening.ts`, pdf-parse pin+`.d.ts` deletion (must travel together), ADR-016 | 1 | ~15f / ~4000 | MED-HIGH (touches agent `pipeline.py`/`repo.py`) |
| **4** | **Orchestration DAG core + store** *(dormant lib)* | `orchestration-dag.ts`, `-log-events`, `-base-branch`, `-integration-node`, `-epic-tip`, `-store`, `-graph-source`, `-comment-trigger`, `linear-subissue-fetch`, `linear-task-by-issue`, `constructs/orchestration-table.ts` | 1 | ~12f / ~2500 | LOW (dormant) |
| **5** | **Mode-B decompose** *(dormant lib)* | `orchestration-decomposition-*` (types/caps/mode/planner/render/writeback/store/flow), `orchestration-plan-*` (commands/revise/revise-interpret); agent `prompts/decompose.py`, `workflows/coding/decompose-v1.yaml`, `clarification_tool.py` | 1, 4 | ~14f / ~3500 | LOW (dormant) |
| **6** | **A6 iteration + failure/clarify** *(dormant lib)* | `iteration-reply.ts`, `iteration-heartbeat.ts`, `clarify-resume.ts`, `failure-reply.ts`, `constructs/iteration-heartbeat.ts`, `handlers/iteration-heartbeat-sweep.ts`; agent `prompts/restack.py`, `workflows/coding/restack-v1.yaml` | 1 | ~8f / ~1200 | LOW (dormant) |
| **7** | **Orchestration compute plane** | `orchestration-{discovery,reconcile,release,restack,rollup,parent-comment}.ts`, `handlers/orchestration-reconciler.ts` (2060 lines, imports 25 mods), `handlers/reconcile-stranded-orchestrations.ts`, reconciler constructs | 4, 5, 6 | ~12f / ~5000 | MED (big file, dormant until 8b) |
| **8a** | **Stack wiring / activation-infra** | `stacks/agent.ts` (+331: instantiate OrchestrationTable/Reconciler/Stranded/IterationHeartbeat + stream + env), `task-table.ts` (NEW_IMAGE stream + `LinearIssueIndex` GSI), `linear-integration.ts` props, `create-task-core.ts` (`linear_issue_id` hoist) | 2,3,4,6,7 | ~6f / ~800 | MED-HIGH (in-place CFN: stream enable + **immutable** GSI) |
| **8b** | **Webhook-processor activation (big-bang)** | `linear-webhook-processor.ts` (**+3931**, the rewrite wiring Mode-A+B+comment-trigger+iteration+attachments), `github-webhook-processor.ts` (screenshot→node), `fanout-task-events.ts`, remaining agent `pipeline.py`/`repo.py` hunks | 8a + all prior | ~5f / ~5500 | **HIGHEST** (single-file near-total rewrite) |
| **9** | **Slack channel→repo mapping** | `slack-channel-mapping-table.ts`, `slack-integration.ts`, `slack-command-processor.ts`, `cli/commands/slack.ts` | 1 | ~6f / ~350 | LOW-MED (floats; independent) |
| **10** | **Docs / ADR / research / scripts** | ADR-001/016/018, PLAN_MODE docs, research, DEMO_RUNBOOK, `scripts/linear_epic.py` | topical | ~25f / ~2500 | LOW (can accompany relevant code slices) |

The recent **stress-fix batch** is already folded into slices 4/7/8b (it edits files
in those slices) — it is NOT a separate slice; it rides in whichever slice owns each
edited file (F9→7, F1→3's `repo.py`, F3/P0-1/P1-2→8b, F6→7).

## Cross-cutting friction (handle deliberately)

- **`linear-webhook-processor.ts` (+3931, one file, 8 subsystems)** — cannot be carved; it IS the activation boundary (slice 8b). Dedicated PR, heavy review, lands last.
- **agent `pipeline.py` / `repo.py`** — multi-arc files (no-MCP + decompose + restack + clarify hunks interleave). Co-locate the full diff in whichever slice lands first, rebase later slices.
- **`stacks/agent.ts`** — the CDK wiring hub; all activation converges in slice 8a.
- Consolidate all additive `types.ts`/`validation.ts`/`workflows.ts` field additions in **slice 1** so downstream slices only *reference* them.

## Top risks

- **R1** — 8b is a 463→4307-line rewrite of a shared main file; the dominant review artifact. Land only after every dormant library slice is merged.
- **R3** — 8a enables a `NEW_IMAGE` stream on `TaskTable` and adds `LinearIssueIndex` (in-place CFN updates; **GSI projection is immutable** — a later projection change needs a new index name). ECS task-def bump (slice 2) forces a revision.
- **R4** — pdf-parse pin + `pdf-parse.d.ts` deletion + `@types/pdf-parse` removal MUST travel together (slice 3) or the build breaks.
- **R5** — knip dead-code ratchet (baseline 78) will flag dormant unused exports in slices 4–7. It is **advisory, not blocking** today; keep it advisory until 8b activates them.
- **R7** — no circular deps among new modules (clean DAG), which is what makes this ordering achievable.

## Governance note

This is the #54 call: whether the arc lands upstream at all, and if so on what cadence.
The draft PRs make the divergence reviewable slice-by-slice without committing to merge.
Recommend landing 1→3 (foundation + ECS + no-MCP, all low-risk modifications) first to
build reviewer confidence, then the dormant libraries 4→7, then the 8a/8b activation
pair as the reviewed "go-live."
