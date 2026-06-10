# A4 — base-branch targeting design (#247)

Decided: **stacking, no delay, full code visibility**, and **multi-dep
(diamond) is first-class** (not deferred).

## The uniform rule

Every child branches so it *sees all its predecessors' code* without
waiting for a human merge:

| Child shape | Base branch | Mechanism | PR diff |
|---|---|---|---|
| **0 predecessors** (root) | `main` | branch off main (today) | clean |
| **1 predecessor** (linear) | predecessor's branch | true stack (`base = pred branch`) | clean (only child's changes) |
| **N predecessors** (diamond) | `main` + merge all predecessor branches in | branch off main, octopus-merge predecessors | noisier (shows merged-in code until predecessors land) |

Single-predecessor is the clean stacked-PR case. Multi-predecessor can't
target two bases, so the child branches off main and **merges its
predecessor branches into its own branch** before the agent starts — D
sees B's and C's code, starts as soon as both are task-complete (no human
merge needed).

### Sub-decision: merge-into-D vs `bc` join branch
Build **merge-into-D directly** for MVP. The `bc` shared-join-branch
optimization only pays off when distinct children share the *same*
predecessor set; it adds no-PR/no-review branches + collapse bookkeeping.
Start with merge-into-D (always correct, no synthetic branches); add the
join-branch optimization later iff shared fan-in shows up in real epics.

## Data flow (threading base + merge-list)

1. **`createTaskCore`** — accept optional `base_branch` (string) and
   `merge_branches` (string[]) on the request; persist onto TaskRecord.
2. **release path** (`releaseChild` / reconciler / #303 sweep) — when
   releasing child C, look up each predecessor's `branch_name` from its
   TaskRecord (predecessors are `succeeded`, so their branch is known):
   - 1 predecessor → `base_branch = pred.branch_name`, `merge_branches = []`
   - N predecessors → `base_branch = main`, `merge_branches = [all pred branches]`
   - 0 → neither (root, today's behavior)
3. **orchestrator** — forward `base_branch` + `merge_branches` into the
   agent payload (base_branch wiring mostly exists for PR tasks).
4. **agent `repo.py`** — for `new_task`: branch from `base_branch` if set
   (today it ignores it for new_task); then `git merge` each
   `merge_branches` entry. Conflict on a predecessor-merge → **agent
   resolves it** (same ABCA-native stance as #305: it's a coding task; PR
   review is the safety net). Fall back to a clear failure if unresolvable.
5. **agent `post_hooks.py`** — open the PR with `--base <base_branch>`
   (today hardcoded to default branch for non-PR tasks).

## Predecessor branch_name availability
A predecessor is `succeeded` before its dependent releases, so its
TaskRecord (and `branch_name`) exists. NOTE: `branch_name` is generated at
create-time as `bgagent/{task_id}/{slug}` and may be updated to the agent's
resolved head ref — the release path must read the CURRENT persisted
`branch_name`, not reconstruct it.

## What this does NOT change
- Gating (release-on-predecessor-success) — unchanged from A1–A3.
- #303 backstop — already release-path-based, inherits base selection.
- Merge flow — humans still merge bottom-up (A5 docs); GitHub auto-retargets.

## Open risk (flagged, not blocking)
Multi-predecessor merge-into-D re-merge churn: if B is edited in review
after D merged it in, D's branch has stale B. This is the same restack
concern #305 (auto-restack) addresses — multi-dep children are in scope
for that follow-up's re-merge handling.

## Build order
1. base-selection logic (pure, testable) — given predecessor rows, return
   `{base_branch, merge_branches}`. ← start here
2. `createTaskCore` + types: accept/persist the fields.
3. release path: compute selection from predecessor TaskRecords, pass through.
4. agent `repo.py` + `post_hooks.py`: honor base + merge for new_task.
5. orchestrator forwarding + tests + synth.
