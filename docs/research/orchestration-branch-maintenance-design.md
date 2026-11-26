# Orchestration branch maintenance design

**Status:** proposed (design only, not built). Sequenced after the verified
child executor, stacked base-branch selection, and the parent lifecycle /
trigger-agnostic work.

Stacked orchestration has two related gaps. Both are **post-DAG-creation
branch maintenance**, hence one design:

- **Combined result for fan-out.** When an epic's DAG has multiple
  *leaves* (sub-issues with no successors), there is no single artifact that
  combines them. Each leaf is an independent PR, and nothing shows
  "everything together."
- **Re-stack on predecessor change.** Base-branch selection merges a
  predecessor's code into a dependent child *once, at child-creation time*. If
  the predecessor's PR is **edited after** the dependent already merged it in,
  the dependent goes stale, because it has old predecessor code.

Base-branch selection handles the *initial* choice of base and merges. This
design handles *keeping that relationship correct over the epic's life* and
*guaranteeing one combined result*.

---

## Part 1 — auto-integration node for fan-out leaves

### Decision

When a validated DAG has **more than one leaf**, the platform appends a
**synthetic integration node** that depends on all leaves. The node is a
diamond fan-in over the leaves, so it reuses the existing multi-predecessor
merge **unchanged**. Its branch is cut from `main` and every leaf branch is
merged in. The result is one combined PR/preview. That PR *is* the "see it
all together" artifact, and it is shown on the parent epic.

| Case | Today | With an integration node |
|---|---|---|
| linear chain (1 leaf) | last node is cumulative ✓ | unchanged, no integration node added |
| explicit diamond (1 fan-in leaf) | fan-in node is the combined result ✓ | unchanged, already 1 leaf |
| **pure fan-out (N leaves)** | N independent PRs, **no combined result** | synthetic integration node merges all N → 1 combined PR |

### Where it's injected

Inject the node in `orchestration-discovery.ts`, **after `validateDag`
succeeds, before `seedOrchestration`**, and NOT in the graph-source layer.
Graph sources are channel-agnostic producers, and "compute leaves +
integrate" is an orchestration concern that needs the validated DAG shape.
`validateDag` exposes roots (`layers[0]`) but not leaves, so compute the
leaves here. A leaf is any node id that appears in no other node's
`depends_on`.

```
children = graphSource()           # whichever graph-source tier applies
validateDag(children)              # cycle / dangling / dup
leaves = nodesWithNoSuccessors(children)
if leaves.length > 1:
    children += syntheticIntegrationNode(depends_on = leaves)
    validateDag(children)          # re-validate: still acyclic, no dangles
seedOrchestration(children)
```

### Synthetic node shape

```
id:          `${orchestrationId}#integration`   (NOT a real Linear issue id)
depends_on:  [all leaf ids]
title:       "Integration — combine sub-issue results"
identifier:  undefined
```

The synthetic node passes through the whole pipeline unchanged. This was
verified seam by seam:

| Seam | Behaviour with synthetic node |
|---|---|
| `selectBaseBranch` (diamond) | N predecessors → base `main` + merge all leaf branches. **Reused as-is.** |
| `repo.py` `_merge_predecessor_branch` | merges each leaf branch into the integration branch (conflict → abort + note, agent resolves). **Reused as-is.** |
| release / `createTaskCore` | normal child release. Idempotency key `${orch}_${orch}#integration`. `sub_issue_id` is an opaque DDB SK, so any string works. |
| status block / rollup render | label falls back to `title` when `linear_identifier` is absent, so it renders "Integration — …". **Graceful.** |
| **agent reactions** (`linear_reactions.py`) | 👀/✅/❌ `reactionCreate(issueId=<synthetic>)` **fails 4xx**, because there's no real Linear issue. Reactions are already best-effort and advisory (logged, never gate the task). **Acceptable graceful-degrade.** |

### Open sub-decisions (integration node)

1. **Integration task description.** The integration task is a
   merge-and-reconcile task, not a feature task. The description should tell
   the agent: "all sub-issue branches are merged into your branch; resolve
   any conflicts, ensure the combined result builds, open a PR." The task
   likely needs its own workflow (`coding/integration-v1`) rather than
   `coding/new-task-v1`, so that the prompt is merge-focused. (To be
   decided. It could start with new-task-v1 and a templated description.)
2. **Where the combined result shows on the parent.** The rollup/status
   block should link the integration node's PR as the headline "combined
   result", as opposed to the per-leaf PRs. This is a small render change.
3. **Skip when a single leaf already integrates.** Linear chains and
   explicit diamonds already have one leaf, so no node is added (the
   `leaves.length > 1` guard). Confirm that we never double-integrate.

---

## Part 2 — re-stack on predecessor change

### The staleness

Base-branch selection merges predecessor code into a dependent **once**, when
the dependent is released. The lifecycle that breaks it:

1. Child D is released, and predecessor B's branch is merged into D. D's PR
   is correct.
2. A reviewer asks B's author (the agent or a human) for changes, and **B's
   branch gets new commits**.
3. D still has B's *old* code. D's PR is now stale. It will conflict or ship
   wrong behaviour when merged.

### Detection: webhook (primary) + sweep (backstop)

| | Webhook | Sweep |
|---|---|---|
| trigger | `pull_request: synchronize` (new commits on a PR) | scheduled scan (extend `reconcile-stranded-orchestrations`) |
| latency | seconds | minutes |
| role | **primary** | recovery (missed/failed webhooks) |

The GitHub webhook receiver (`github-webhook.ts`) today handles **only**
`deployment_status`. It is a general signed App webhook, so adding a
`pull_request` branch is an extension of filter, parse and dispatch, not new
infrastructure. The sweep already iterates all orchestrations and can compare
each released child's predecessor head SHA against what the child last merged.

### The missing lookup (required for either path)

There is **no index from a PR or branch to an orchestration child** today,
only `ChildTaskIndex` on `child_task_id`. When a `pull_request` event
arrives, we have the head branch. We must find *which orchestration children
depend on the sub-issue whose branch this is*. Options:

1. **New sparse GSI on `child_branch_name`.** It gives an O(1) answer to
   "who is on this branch". Then walk the orchestration's rows for
   dependents. **Recommended.**
2. Parse `{taskId}` out of the `bgagent/{taskId}/...` branch and use the
   existing `ChildTaskIndex`. This is fragile if the agent renamed the branch
   (see the session's branch-discipline fixes). After those fixes the branch
   is the provisioned one, so this option is viable as a fallback.

### The re-stack action — reuse, don't reinvent

A re-stack of dependent D against changed predecessor B has three steps:
fetch B's new branch, merge it into D's branch, push. This is **exactly**
`_merge_predecessor_branch` again, run as a follow-up task on D's existing
branch. So model it as a **`coding/restack-v1` workflow** that uses the
`ensure_pr(push_resolve)` strategy of the `pr_iteration` family. That
strategy pushes follow-up commits to the existing PR branch and resolves the
existing PR URL. It opens no new PR.

The idempotency key includes the predecessor SHA, so that the same
predecessor update doesn't re-stack twice:
`restack_${orch}_${childSub}_${predHeadSha}`.

### The key design call: conflict → agent, NOT human

When the re-merge **conflicts**, do **not** escalate to a human approval
gate. Spawn the re-stack as a normal agent task whose job is to resolve the
conflict and push. **PR review is the safety net.** A human reviews the
re-stacked PR like any other. This matches the existing approach of
`_merge_predecessor_branch` (abort the raw merge, hand the agent a clean
tree and a note), and it avoids turning every predecessor edit into a human
interrupt. Rationale: the agent already resolves merge conflicts as part of
normal work. A stale dependent is a coding task, not a policy decision.

### Cascade + bounding

- A re-stack of D pushes new commits to D. If D itself has dependents, they
  are now stale, so the re-stack cascades. Re-stack walks **down** the DAG
  from the changed node and re-stacks each dependent in topological order.
- **Bound the cascade.** An idempotency key per (child, predecessor-SHA)
  prevents loops. A per-orchestration re-stack budget (mirror the
  approval-gate cap) prevents re-stack thrash if PRs are being rapidly
  edited.
- Re-stack only **released, non-terminal-merged** children. A child whose PR
  is already merged to main is out of the stack. Leave it. Its code is in
  main, and GitHub's auto-retarget-on-delete handles the rest, per ADR-001 §8.

### What this does NOT do

- It does not auto-**merge** the stack. Merge stays human and bottom-up
  (ADR-001 §8/§9).
- It does not re-stack on every `push`. It re-stacks only on
  `pull_request: synchronize` on a branch that is a *predecessor of a
  still-open dependent in an active orchestration*.

---

## Build order

1. **Integration node first** (small, self-contained, no new
   infrastructure). Add the leaf computation and the synthetic node in
   discovery. Render the integration PR as the combined result on the parent.
   Add tests: a multi-leaf DAG gets the node, a single-leaf DAG does not, the
   synthetic node renders, and it reuses the diamond merge. Verify against a
   pure-fan-out epic end-to-end.
2. **Re-stack lookup.** Add the `child_branch_name` GSI and the resolver
   from a PR to its child.
3. **Re-stack detection.** Extend `github-webhook.ts` for
   `pull_request: synchronize`. Dispatch to a re-stack handler. Mirror the
   detection into the sweep as the backstop.
4. **Re-stack action.** Build the `coding/restack-v1` workflow (push_resolve
   and re-merge). Cascade in topological order. Bound the cascade with the
   idempotency key and the budget. A conflict becomes an agent task.

## Open risks

- **Re-stack thrash** during active review of an early predecessor. The
  per-(child,SHA) idempotency key and the per-orchestration budget bound it,
  but it is worth a metric and a log line when the cap fires.
- **Synthetic-node identity** leaks into any future code that assumes
  `sub_issue_id` is a real Linear issue. Guard with a clear
  `#integration`-suffixed id and a helper `isSyntheticNode()`.
- The quality of conflict resolution in a diamond re-merge is only as good as
  the agent. PR review remains the gate, by design.

## References

- `docs/research/a4-stacked-base-branch-design.md`, the initial stacking that this design extends
- `docs/decisions/ADR-001-stacked-pull-requests.md` §8/§9, merge semantics and the orchestration extension
- `cdk/src/handlers/shared/orchestration-base-branch.ts`, `selectBaseBranch` (reused)
- `cdk/src/handlers/shared/orchestration-discovery.ts`, injection point for the integration node
- `cdk/src/handlers/github-webhook.ts`, the webhook to extend for re-stack detection
- `cdk/src/handlers/reconcile-stranded-orchestrations.ts`, the sweep backstop
