# Orchestration branch maintenance design (#247 → #305/A6 + #16)

**Status:** proposed (design only — not built). Sequenced after the verified
A1–A5 executor + A4 stacking + the parent lifecycle / trigger-agnostic work.

Two related gaps in stacked orchestration, both **post-DAG-creation branch
maintenance**, hence one design:

- **#16 — combined result for fan-out.** When an epic's DAG has multiple
  *leaves* (sub-issues with no successors), there is no single artifact that
  combines them. Each leaf is an independent PR; nothing shows "everything
  together."
- **#305 / A6 — re-stack on predecessor change.** A4 merges a predecessor's
  code into a dependent child *once, at child-creation time*. If the
  predecessor's PR is **edited after** the dependent already merged it in,
  the dependent goes stale (it has old predecessor code).

A4 handles *initial* base/merge selection; this design handles *keeping that
relationship correct over the epic's life* and *guaranteeing one combined
result*.

---

## Part 1 — #16: auto-integration node for fan-out leaves

### Decision

When a validated DAG has **more than one leaf**, the platform appends a
**synthetic integration node** that depends on all leaves. It is a diamond
fan-in over the leaves, so it reuses A4's existing multi-predecessor merge
**unchanged** — its branch is cut from `main` and every leaf branch is
merged in, producing one combined PR/preview. That PR *is* the "see it all
together" artifact, surfaced on the parent epic.

| Case | Today | With #16 |
|---|---|---|
| linear chain (1 leaf) | last node is cumulative ✓ | unchanged — no integration node added |
| explicit diamond (1 fan-in leaf) | fan-in node is the combined result ✓ | unchanged — already 1 leaf |
| **pure fan-out (N leaves)** | N independent PRs, **no combined result** | synthetic integration node merges all N → 1 combined PR |

### Where it's injected

`orchestration-discovery.ts`, **after `validateDag` succeeds, before
`seedOrchestration`** — NOT in the graph-source layer (graph sources are
channel-agnostic producers; "compute leaves + integrate" is an
orchestration concern that needs the validated DAG shape). `validateDag`
exposes roots (`layers[0]`) but not leaves, so compute leaves here:
a leaf is any node id that appears in no other node's `depends_on`.

```
children = graphSource()           # tier 1/2/3 (#11)
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

It flows through the whole pipeline unchanged. Verified seam-by-seam:

| Seam | Behaviour with synthetic node |
|---|---|
| `selectBaseBranch` (diamond) | N predecessors → base `main` + merge all leaf branches. **Reused as-is.** |
| `repo.py` `_merge_predecessor_branch` | merges each leaf branch into the integration branch (conflict → abort + note, agent resolves). **Reused as-is.** |
| release / `createTaskCore` | normal child release; idempotency key `${orch}_${orch}#integration`. `sub_issue_id` is an opaque DDB SK — any string works. |
| status block / rollup render | label falls back to `title` when `linear_identifier` is absent → renders "Integration — …". **Graceful.** |
| **agent reactions** (`linear_reactions.py`) | 👀/✅/❌ `reactionCreate(issueId=<synthetic>)` **fails 4xx** — there's no real Linear issue. Already best-effort/advisory (logged, never gates the task). **Acceptable graceful-degrade.** |

### Open sub-decisions (#16)

1. **Integration task description.** It's a merge-and-reconcile task, not a
   feature task. Description should tell the agent: "all sub-issue branches
   are merged into your branch; resolve any conflicts, ensure the combined
   result builds, open a PR." Likely wants its own workflow
   (`coding/integration-v1`) rather than `coding/new-task-v1`, so the prompt
   is merge-focused. (TBD — could start with new-task-v1 + a templated
   description.)
2. **Where the combined result shows on the parent.** The rollup/status
   block should link the integration node's PR as the headline "combined
   result" (vs. the per-leaf PRs). Small render change.
3. **Skip when a single leaf already integrates.** Linear chains + explicit
   diamonds already have one leaf — no node added (the `leaves.length > 1`
   guard). Confirm we never double-integrate.

---

## Part 2 — #305 / A6: re-stack on predecessor change

### The staleness

A4 merges predecessor code into a dependent **once**, when the dependent is
released. Lifecycle that breaks it:

1. Child D released; A4 merges predecessor B's branch into D. D's PR is correct.
2. Reviewer asks B's author (the agent or a human) for changes; **B's branch
   gets new commits**.
3. D still has B's *old* code. D's PR is now stale — it will conflict or ship
   wrong behaviour when merged.

### Detection: webhook (primary) + sweep (backstop)

| | Webhook | Sweep |
|---|---|---|
| trigger | `pull_request: synchronize` (new commits on a PR) | scheduled scan (extend `reconcile-stranded-orchestrations`) |
| latency | seconds | minutes |
| role | **primary** | recovery (missed/failed webhooks) |

The GitHub webhook receiver (`github-webhook.ts`) today handles **only**
`deployment_status`; it's a general signed App webhook, so adding a
`pull_request` branch is a filter + parse + dispatch extension, not new
infra. The sweep already iterates all orchestrations and can compare each
released child's predecessor head SHA against what the child last merged.

### The missing lookup (required for either path)

There is **no PR/branch → orchestration-child index** today (only
`ChildTaskIndex` on `child_task_id`). When a `pull_request` event arrives we
have the head branch; we must find *which orchestration children depend on
the sub-issue whose branch this is*. Options:

1. **New sparse GSI on `child_branch_name`** — O(1) "who is on this branch",
   then walk the orchestration's rows for dependents. **Recommended.**
2. Parse `{taskId}` out of the `bgagent/{taskId}/...` branch and use the
   existing `ChildTaskIndex`. Fragile if the agent renamed the branch (see
   the session's branch-discipline fixes) — but post-fix the branch is the
   provisioned one, so viable as a fallback.

### The re-stack action — reuse, don't reinvent

A re-stack of dependent D against changed predecessor B is: fetch B's new
branch, merge it into D's branch, push. This is **exactly**
`_merge_predecessor_branch` again, run as a follow-up task on D's existing
branch. So model it as a **`coding/restack-v1` workflow** that uses the
`pr_iteration` family's `ensure_pr(push_resolve)` strategy (push follow-up
commits to the existing PR branch, resolve the existing PR URL — no new PR).

Idempotency key includes the predecessor SHA so the same predecessor update
doesn't re-stack twice: `restack_${orch}_${childSub}_${predHeadSha}`.

### The key design call: conflict → agent, NOT human

When the re-merge **conflicts**, do **not** escalate to a human approval
gate. Spawn the re-stack as a normal agent task whose job is to resolve the
conflict and push — **PR review is the safety net** (a human reviews the
re-stacked PR like any other). This matches the existing
`_merge_predecessor_branch` philosophy (abort the raw merge, hand the agent
a clean tree + a note) and avoids turning every predecessor edit into a
human interrupt. Rationale: the agent already resolves merge conflicts as
part of normal work; a stale-dependent is a coding task, not a policy
decision.

### Cascade + bounding

- A re-stack of D pushes new commits to D → if D itself has dependents, they
  are now stale → cascade. Re-stack walks **down** the DAG from the changed
  node, re-stacking each dependent in topo order.
- **Bound the cascade**: an idempotency key per (child, predecessor-SHA)
  prevents loops; a per-orchestration re-stack budget (mirror the
  approval-gate cap) prevents a thrash storm if PRs are being rapidly edited.
- Re-stack only **released, non-terminal-merged** children. A child whose PR
  is already merged to main is out of the stack — leave it (its code is in
  main; GitHub's auto-retarget-on-delete handles the rest, per ADR-001 §8).

### What this does NOT do

- Not auto-**merge** the stack — merge stays human + bottom-up (ADR-001 §8/§9).
- Not re-stack on every `push` — only `pull_request: synchronize` on a branch
  that is a *predecessor of a still-open dependent in an active orchestration*.

---

## Build order

1. **#16 first** (small, self-contained, no new infra): leaf computation +
   synthetic node in discovery; render the integration PR as the combined
   result on the parent; tests (multi-leaf → node added, single-leaf →
   not, synthetic node renders, reuses diamond merge). Live-verify with a
   pure-fan-out epic.
2. **#305 lookup**: add the `child_branch_name` GSI; PR→child resolver.
3. **#305 detection**: extend `github-webhook.ts` for `pull_request:
   synchronize`; dispatch to a re-stack handler; mirror into the sweep as
   backstop.
4. **#305 action**: `coding/restack-v1` workflow (push_resolve + re-merge);
   cascade in topo order; idempotency + budget bound; conflict → agent task.

## Open risks

- **Re-stack thrash** during active review of an early predecessor — bounded
  by the per-(child,SHA) idempotency key + per-orchestration budget, but
  worth a metric + cap-fires log.
- **Synthetic-node identity** leaks into any future code that assumes
  `sub_issue_id` is a real Linear issue — guard with a clear
  `#integration`-suffixed id and a helper `isSyntheticNode()`.
- Diamond re-merge conflict resolution quality is only as good as the agent;
  PR review remains the gate (by design).

## References

- `docs/research/a4-stacked-base-branch-design.md` — the initial stacking it extends
- `docs/decisions/ADR-001-stacked-pull-requests.md` §8/§9 — merge semantics + #247 extension
- `cdk/src/handlers/shared/orchestration-base-branch.ts` — `selectBaseBranch` (reused)
- `cdk/src/handlers/shared/orchestration-discovery.ts` — injection point for #16
- `cdk/src/handlers/github-webhook.ts` — webhook to extend for #305
- `cdk/src/handlers/reconcile-stranded-orchestrations.ts` — sweep backstop
