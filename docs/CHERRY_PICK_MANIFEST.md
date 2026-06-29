# Cherry-pick manifest — debuggability arc (K1–K7)

Working notes for slicing this session's work onto `main` (or a clean main-bound
PR branch). Authored 2026-06-29. All commits below are on
`feat/slack-channel-mapping` (the dev-deploy integration branch) and are
**deployed to `backgroundagent-dev` but NOT pushed** to any remote.

Origin: 2026-06-28 dogfooding feedback — "sub-issues complete with proper PRs but
the parent orchestration fails (npm build errors), and we can't debug it."

## Classification at a glance

| Commit | What | Main-bound? | Touches |
|--------|------|-------------|---------|
| `40bfecb` | **K1+K2** failed-node panel reason + CloudWatch-not-PR copy | **MIXED** | `failure-reply.ts` (agnostic) **+** `orchestration-rollup.ts`, `orchestration-reconciler.ts` (Linear/orch) |
| `46a407f` | **K4** build-verify timeout ≠ build failure + cap 600→1800s | **MOSTLY main** | `agent/` (agnostic) **+** `failure-reply.ts` (agnostic) |
| `def2d01` | **K5** classifier matches `subtype=` wrapper | **YES, clean** | `error-classifier.ts` + test only |
| `9a88dd8` | **K7** stuck/runaway guard | **YES, clean** | `agent/src/stuck_guard.py`, `hooks.py` + tests |

`main` today is platform-agnostic; the Linear orchestration layer
(`orchestration-*.ts`, the maturing panel) lives on `linear-vercel`, NOT main.
So commits that touch `orchestration-rollup.ts` / `orchestration-reconciler.ts`
**cannot** cherry-pick to main as-is — only their agnostic slices can.

## Per-commit guidance

### `def2d01` — K5 classifier (CLEANEST — take whole)
- Files: `cdk/src/handlers/shared/error-classifier.ts` + `error-classifier.test.ts`.
- No Linear/orchestration coupling. **Cherry-pick the whole commit to main.**

### `9a88dd8` — K7 stuck-guard (CLEAN — take whole)
- Files: `agent/src/stuck_guard.py` (new), `agent/src/hooks.py`,
  `agent/tests/test_stuck_guard.py` (new), `agent/tests/test_hooks.py`,
  `agent/tests/test_nudge_hook.py`.
- Pure agent-runtime; surfaces via channel-neutral `error_message`.
- **Cherry-pick whole.** Only conflict risk: `hooks.py` `between_turns_hooks`
  registry order if main's hooks.py has drifted — verify the registry still
  reads `[cancel, stuck_guard, nudge, denial]`.

### `46a407f` — K4 timeout (MOSTLY main-bound)
- Agnostic + main-safe: `agent/src/post_hooks.py` (VerifyOutcome + cap),
  `agent/src/pipeline.py` (`build_ok=timeout`), `agent/src/workflow/runner.py`,
  the agent tests, AND `cdk/src/handlers/shared/failure-reply.ts` +
  `failure-reply.test.ts` (timeout copy — agnostic).
- The failure-reply timeout copy depends on K1's `renderPanelFailureReason`
  (added in `40bfecb`). If K1 isn't on main, drop the
  `renderPanelFailureReason` timeout branch and keep only the
  `renderFailureReply` timeout branch. **Cherry-pick whole, then resolve the
  failure-reply.ts overlap with K1's state on main.**

### `40bfecb` — K1+K2 (MIXED — split required)
- **Agnostic slice (main-safe):** `cdk/src/handlers/shared/failure-reply.ts`
  (`renderPanelFailureReason` + CloudWatch-not-PR copy in `renderFailureReply`)
  + `failure-reply.test.ts`. This is generic failure rendering.
- **Linear/orch slice (NOT main):** `orchestration-rollup.ts` (panel sub-line),
  `orchestration-reconciler.ts` (`resolveChildFailureReasons` batch-read),
  and their tests. These belong to the orchestration layer that isn't on main.
- **To cherry-pick to main:** take only the `failure-reply.*` hunks (e.g.
  `git cherry-pick -n 40bfecb` then `git restore --staged` the orchestration
  files and `git checkout` them, OR hand-apply the failure-reply diff). The
  `renderPanelFailureReason` export is harmless on main even unused.

## Suggested main-PR composition (smallest → safest)
1. `def2d01` (K5) — whole.
2. `40bfecb` failure-reply.ts slice only (K2 CloudWatch copy +
   `renderPanelFailureReason`).
3. `46a407f` (K4) — whole, reconcile failure-reply.ts against step 2.
4. `9a88dd8` (K7) — whole.
Then the orchestration-layer slices of K1 go to the `linear-vercel` PR, not main.

## NOT for cherry-pick (stay on linear-vercel)
- **K6 heartbeat** (`c7f4509`, **BUILT**) — edits the Linear maturing reply via a
  scheduled sweep. Linear-specific (`IterationHeartbeat` construct + sweep
  handler + the `working`-state elapsed suffix in `iteration-reply.ts`). The
  `iteration-reply.ts` `working` suffix is arguably agnostic, but the sweep +
  construct are Linear-only, so the whole commit stays on linear-vercel.
- Any `orchestration-*.ts` change.

## Live-verification state (dev)
- K1: live-verified — ABCA-478 panel rendered `↳ Build/tests failed — see the
  build log in CloudWatch for task ...`.
- K4/K5/K7: unit-tested + deployed; K5+K7 not yet live-fired against a fresh
  organic loop (K7 would have caught the ABCA-483 22-min grind).
- Full build green at commit time: 2814 cdk + 1158 agent + 570 cli tests.
