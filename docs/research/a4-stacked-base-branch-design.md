# Base-branch targeting design for orchestrated children

Decided: **stacking, no delay, full code visibility**. **Multi-dependency
(diamond) is first-class**, not deferred.

## The uniform rule

Every child branches so that it *sees all its predecessors' code* without
waiting for a human merge:

| Child shape | Base branch | Mechanism | PR diff |
|---|---|---|---|
| **0 predecessors** (root) | `main` | branch off main (today) | clean |
| **1 predecessor** (linear) | predecessor's branch | true stack (`base = pred branch`) | clean (only child's changes) |
| **N predecessors** (diamond) | `main` + merge all predecessor branches in | branch off main, octopus-merge predecessors | noisier (shows merged-in code until predecessors land) |

A single predecessor is the clean stacked-PR case. A child with several
predecessors can't target two bases, so the child branches off main and
**merges its predecessor branches into its own branch** before the agent
starts. D sees B's and C's code and starts as soon as both are
task-complete. No human merge is needed.

### Sub-decision: merge-into-D vs `bc` join branch
Build **merge-into-D directly** for the MVP. The `bc` shared-join-branch
optimization pays off only when distinct children share the *same*
predecessor set. It adds branches that have no PR and no review, plus
collapse bookkeeping. Start with merge-into-D, which is always
correct and needs no synthetic branches. Add the join-branch optimization
later, if and only if shared fan-in shows up in real epics.

## Data flow (threading base + merge-list)

1. **`createTaskCore`.** Accept optional `base_branch` (string) and
   `merge_branches` (string[]) on the request. Persist them onto the
   TaskRecord.
2. **Release path.** This is `releaseChild`, the reconciler and the stranded
   sweep. When releasing child C, look up each predecessor's `branch_name`
   from its TaskRecord. Predecessors are `succeeded`, so their branch is
   known:
   - With 1 predecessor, `base_branch = pred.branch_name` and `merge_branches = []`.
   - With N predecessors, `base_branch = main` and `merge_branches = [all pred branches]`.
   - With 0 predecessors, neither is set (a root, today's behavior).
3. **Orchestrator.** Forward `base_branch` and `merge_branches` into the
   agent payload. The `base_branch` wiring mostly exists for PR tasks.
4. **Agent `repo.py`.** For `new_task`, branch from `base_branch` if it is
   set. Today `repo.py` ignores `base_branch` for `new_task`. Then
   `git merge` each `merge_branches` entry. On a conflict in a predecessor
   merge, the **agent resolves it**. Re-stacking takes the same stance. The
   conflict is a coding task, and PR review is the safety net. Fall back to
   a clear failure if the conflict is unresolvable.
5. **Agent `post_hooks.py`.** Open the PR with `--base <base_branch>`. Today
   the base is hardcoded to the default branch for non-PR tasks.

## Predecessor branch_name availability
A predecessor is `succeeded` before its dependent releases, so its
TaskRecord and its `branch_name` exist. Note: `branch_name` is generated at
create time as `bgagent/{task_id}/{slug}` and may be updated to the agent's
resolved head ref. The release path must therefore read the CURRENT
persisted `branch_name`, not reconstruct it.

## What this does NOT change
- Gating (release on predecessor success) is unchanged.
- The stranded-child sweep already goes through the release path, so it inherits base selection.
- The merge flow is unchanged. Humans still merge bottom-up, and GitHub auto-retargets.

## Open risk (flagged, not blocking)
The risk is re-merge churn for a multi-predecessor merge-into-D. If B is
edited in review after D merged it in, D's branch has stale B. The
auto-restack design addresses the same staleness (see
`orchestration-branch-maintenance-design.md`). Multi-dependency children are
in scope for the re-merge handling of that follow-up.

## Build order
1. Base-selection logic (pure, testable). Given predecessor rows, return
   `{base_branch, merge_branches}`. Start here.
2. `createTaskCore` and types. Accept and persist the fields.
3. Release path. Compute the selection from the predecessor TaskRecords and
   pass it through.
4. Agent `repo.py` and `post_hooks.py`. Honor the base and the merge list
   for `new_task`.
5. Orchestrator forwarding, tests, and synth.
