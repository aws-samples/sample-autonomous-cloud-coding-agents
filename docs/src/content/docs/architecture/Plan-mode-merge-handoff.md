---
title: Plan mode merge handoff
---

# Plan-mode stack — merge / handoff

> **For:** the #247-reporting fix session (owner of `linear-webhook-processor.ts`,
> `orchestration-reconciler.ts`, `orchestration-decomposition-*`).
> **From:** plan-mode QA/design session (958d5e85), 2026-07-06→07.
> **Ask:** review + merge the 7-commit stack below into the mainline decompose work.

## TL;DR

A 7-commit stack on branch **`fix/492-t1-short-negation`** (branched from **`be933e9`**),
**deployed to dev, live-verified on `abca-demo` (AgentCore), NOT pushed.** It closes 4
dogfooding-caught defects (ABCA-583/584/585/588) and lands the "make plan-mode feel like
chatting with Claude" work (T1/T4/T5/T2). Full monorepo build green throughout
(agent 1197 + cli 575 + cdk 2942 tests + synth + docs). Nothing reached `main`.

- **Worktree:** `/tmp/abca-t1-shortneg` (branch `fix/492-t1-short-negation`).
- **Base:** `be933e9` ("second PM QA batch"). Diff: **+1918 / −105, 23 files.**
- **Design context:** `PLAN_MODE_REFACTOR.md` (per-thread STATUS blocks) +
  `ECS_RIGHTSIZED_PLANNING.md` (a separate-workstream proposal, NOT built).

## The commits (oldest → newest)

| Commit | What | Live-verified |
|--------|------|---------------|
| `c45c8bf` | **T1** — close the short-negation reject-guard gap: a short negation carrying an instruction (`no, just 2 tasks`) no longer discards the plan; explicit `reject`/`discard`/… still discard; bare `no`/`nope` → `ambiguous` → nudge. Parser + webhook routing. | ABCA-574 |
| `afba940` | **T4** — direct-manipulation command grammar (`drop 3` / `merge 1 2` / `size 2 S`): deterministic, instant, no agent; positional-edge re-indexing; collapse/out-of-range guards leave the plan untouched. | ABCA-575 |
| `6c8d8e2` | **T5** — structural commands mature the ONE plan comment in place (edit, not stack). | ABCA-580 |
| `5c31b1c` | **T2** — warm repo digest: the planner emits a structural `repo_digest`+cloned-sha in the plan JSON; a semantic revise feeds the prior digest back via `channel_metadata` (guardrail-safe) so the agent reuses exploration instead of re-deriving. Agent-side drift check. (+ repo.py fix: capture `head_sha_before` for non-PR workflows.) | ABCA-582 |
| `5fb96c5` | **F-prlink** — the ✅ completion comment renders the PR link (was ⚠️-only; relied on the agent's own PR-opened comment, which can silently not fire → link lost, ABCA-584). | ABCA-586 |
| `6c1f368` | **F-single-gate** — `:decompose` that declines to split now PROPOSES the single task + waits for `@bgagent approve` (was auto-running, silently bypassing the approve-first gate — ABCA-584/585). `:auto` still auto-runs. New `pending_kind:'single'` + `handleSingleTaskVerdict`. | ABCA-586 |
| `ff37340` | **F-revise-in-place** — a semantic revise edits the ONE plan comment in place + settles the feedback comment 👀→✅ when done (was: fresh "Updated breakdown" each round, ack in a split thread, 👀 never settled — ABCA-585/588). | ABCA-591 |

## Findings this stack fixes (all user-caught by dogfooding)

- **F-reject-revision residual** (T1): `no, just 2 tasks` deleted the plan (short-negation gap).
- **F-prlink** (ABCA-584): PR opened but no link anywhere in the Linear thread on ✅ success.
- **F-single-gate** (ABCA-584/585): "if it looks like a single change and just runs, what's the
  point of approving?" — `:decompose`→single auto-ran, bypassing the gate.
- **F-revise-in-place** (ABCA-585/588): revise cluttered the thread (fresh plan comment per round),
  the ack sat in a separate thread, and the 👀 on the feedback comment never settled ("finished but
  I can't tell").

## Review guidance (where to look, by risk)

- **Highest-value / lowest-risk:** `orchestration-plan-commands.ts` (T4) is a NEW pure module with
  178 lines of tests — the correctness-critical bit is positional `depends_on` re-indexing on
  drop/merge (covered).
- **Parser change (T1):** `parsePlanVerdict` in `orchestration-comment-trigger.ts` — note the new
  `'ambiguous'` verdict and the explicit-vs-soft negation split. The webhook routing narrowed the
  verdict path to `approve|reject` so `'ambiguous'` can't reach `runPlanVerdict`.
- **Agent-contract touch (T2):** `agent/src/prompts/decompose.py` (emit `repo_digest`+sha) +
  `prompt_builder.py` (inject prior digest / drift note) + `repo.py` (capture non-PR HEAD sha). This
  is the one piece that changes what the agent emits — worth a close read. Guardrail-safe by design
  (digest rides `channel_metadata`, never `task_description`).
- **Store shape (T2 + F-single-gate):** `orchestration-decomposition-store.ts` `PendingPlan` gained
  `repo_digest`/`repo_digest_sha` (T2) and `pending_kind`/`single_task_description` (F-single-gate).
  All optional + back-compat (absent = old behavior).
- **Shared fanout file (F-prlink):** `fanout-task-events.ts` — a 1-line behavior change (render
  `pr_url` on ✅ too). This is arguably the fanout workstream's file — flag for their eyes.

## Known loose ends / caveats (be honest)

1. **Everything is verified on `abca-demo` (AgentCore) only.** The ECS substrate (`abca-fork-dev`)
   is NOT provisioned on this dev stack, so nothing was verified there. The plan-mode code is
   substrate-agnostic (same code both substrates), so this is a coverage gap, not a known break.
2. **`deleteComment` helper** (linear-feedback.ts) is added + tested but ended up **unused** (the
   F-revise-in-place rework moved from delete-the-ack to swap-👀→✅). Kept as a small tested
   primitive; remove if you prefer no dead exports.
3. **`renderRevisingNote`** is now unused by product code (still exported + unit-tested). Same call.
4. **The two design docs are untracked in the `abca-lv-247-integ` worktree, NOT on this branch** —
   `PLAN_MODE_REFACTOR.md`, `ECS_RIGHTSIZED_PLANNING.md`, and this file. Decide whether to commit
   them onto the branch (they won't travel with a cherry-pick otherwise). They're `docs/design/` so
   a `//docs:sync` would be needed if committed (they're source, but the Starlight mirror check runs
   in CI).
5. **Round-0 clutter is out of scope** — T5/F-revise-in-place mature the plan comment on *revises*;
   the initial "🗂️ On it — working out…" round-0 ack is still a separate comment (low priority).

## NOT built (deferred, with rationale)

- **T6** (fast-model tier / speculative pre-warm / per-repo planning memory) — the fast-model swap
  was deliberately deferred to isolate T2's quality signal; the rest are nice-to-haves.
- **T7** (SnapStart the dispatch Lambda, then maybe adaptive keepalive) — research said measure-first;
  T4 already absorbed most fast follow-ups. See `PLAN_MODE_REFACTOR.md` §T7.
- **ECS right-sized planning** — a real design (`ECS_RIGHTSIZED_PLANNING.md`) but it's the ECS-substrate
  workstream's domain (`ecs-agent-cluster.ts` etc.) + resolves the `orchestrator.ts:242` tension they
  authored. Handed off as a spec, not built.

## Deploy note (if you redeploy)

`npx cdk synth --quiet` ONCE, then `npx cdk deploy --app cdk.out --require-approval never` — a fresh
synth rebuilds the agent Docker image (~8-min ARM64 build). Deploying from a cached `cdk.out` after a
`mise //cdk:build` re-uploads only changed Lambda code (fast). Do NOT loop `mise //cdk:deploy` (wipes
cdk.out → forces a re-synth each retry).
