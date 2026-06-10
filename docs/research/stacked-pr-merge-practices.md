# Stacked PR merge practices — research findings (#247 A4/A5)

> Compiled 2026-06-10 to settle how ABCA's Linear orchestration (Mode A)
> should structure child PRs and how they get merged. Sources are
> live-fetched (URLs inline). Where a claim is industry practice rather
> than documented behavior, it is labelled.

## TL;DR for #247

- **Children stack: PR-A → main, PR-B → A's branch, PR-C → B's branch.**
- **A downstream PR does NOT wait for upstream PRs to merge.** Because
  C's branch is cut from B's (which was cut from A's), C's branch
  *already physically contains* A's and B's commits. C's author/agent
  works on top of them immediately; C's PR *diff* shows only C's changes
  (diffed against B). Review status of A/B is irrelevant to this.
- **Merge is bottom-up, one PR at a time** — NOT "merge the top and the
  whole stack lands." Merge A, then B, then C.
- **GitHub auto-retargets** the dependent PRs as lower ones merge — but
  only **when you delete the merged head branch** (see exact quote).
- **Auto-merging a stack** is a real, supported pattern via merge queues,
  gated on required approvals + green CI. It is a deliberate follow-up for
  ABCA, not MVP (#247 lists "auto-merge when all children complete" as
  out of scope).

## Q1/Q2 — Merge flow + retargeting (GitHub native)

**GitHub automatically retargets dependent PRs when the merged branch is
deleted** (not from the merge itself):

> "If you delete a branch that has open pull requests based on it, GitHub
> automatically updates any such pull requests, changing their base
> branch to the merged pull request's base branch."
> — GitHub Docs, *Deleting and restoring branches*
> https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-repository

Practical consequence for a stack A←B←C: merge A to `main` and delete
`feat/A` → B's base auto-flips from `feat/A` to `main`, and B's diff stays
clean (it no longer double-counts A's commits, since A is now in main).
Repeat for B, then C. This is the **bottom-up, one-at-a-time** model.

## Q3 — How downstream work proceeds during review (the key mechanic)

Stacking decouples *building dependent work* from *merging*. From the
Pragmatic Engineer analysis of stacked diffs
(https://newsletter.pragmaticengineer.com/p/stacked-diffs):

> stacks "can be built continuously, one on top of the other, allowing
> engineers to stay unblocked."

And the unit of change becomes the individual commit/diff, each of which
"can be tested, reviewed, landed, and reverted individually." The
dependency is physical (git branch lineage), so a downstream change sees
upstream code the moment the branch exists — **no waiting for merge.**

When an upstream PR changes after review, the stack must be **restacked**
(rebased): "later diffs cannot be landed to the main branch while they
don't contain changes from the updated Diff 1" → resolved via
`git rebase -i` up the stack (Pragmatic Engineer). Tools (ghstack,
Graphite) automate this restack.

## Q4 — Tooling: ghstack (Meta's open-source tool)

ghstack (https://github.com/ezyang/ghstack) — "Conveniently submit stacks
of diffs to GitHub as separate pull requests."
- Each commit on top of `main` becomes its own PR.
- Land with `ghstack land $PR_URL` — lands a ghstack'd PR (handles the
  base rewriting so the rest of the stack stays correct).
- Stack another PR by `git commit` on top + re-run `ghstack`.
This is the closest reference for an **automated agent** opening stacked
PRs: one branch/PR per commit, tool owns the base-branch bookkeeping.

## Q5 — Auto-merging a stack (GitHub merge queue)

GitHub **merge queue** supports ordered, stack-like merging
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue):

- Entry gate: "Once a pull request has passed all required branch
  protection checks, a user with write access ... can add the pull
  request to the queue." → **required status checks + approvals** gate it.
- Ordering: "merged in a first-in-first-out order where the required
  checks are always satisfied."
- Stacking semantics: each queued PR's temp branch "contains code changes
  from the target branch, pull request #1, and pull request #2" — i.e.
  later entries build on earlier ones, exactly like a stack.
- Caveat: cannot be used with wildcard (`*`) branch protection patterns.

So "auto-merge the stack once all green + approved" is a real pattern, but
it rides on branch-protection + merge-queue config — a per-repo/per-project
policy decision, hence a follow-up for ABCA rather than MVP.

## On research papers

Stacked diffs is an **industry practice**, not an academic topic — there
is no peer-reviewed literature on "stacked PRs" mechanics. The scholarly
grounding is for the *premise* (small, incremental changes review better),
not the stacking technique:
- Bacchelli & Bird, *Expectations, Outcomes, and Challenges of Modern Code
  Review*, ICSE 2013 — foundational modern-code-review empirical study.
- Rigby & Bird, *Convergent Contemporary Software Peer Review Practices*,
  FSE 2013 — documents small-incremental-change review.
Treat blogs/tool-docs (above) as authoritative for the *mechanics*; the
papers only justify *why small stacked PRs beat one large PR*.

## Implications for #247 A4 / A5

- **A4 (base-branch targeting):** child B's branch must be cut from A's
  branch and B's PR `base` set to `feat/A` (GitHub API `base` param on
  `POST /repos/{owner}/{repo}/pulls`). Roots target `main`. This makes the
  downstream-sees-upstream-code property hold without waiting on merges.
- **A5 (rollup + docs):** "orchestration complete" means *all child PRs
  opened*, NOT merged. Document the **human bottom-up merge + delete-branch
  (for auto-retarget)** flow. Auto-merge stays a follow-up (per-project
  opt-in, gated on approvals+CI via merge queue).
- **ADR-001 ambiguity to resolve:** the ADR says both "PR N targets PR
  N-1's branch" and "Final PR merges the full stack to main." Per GitHub's
  actual behavior, the correct reading is **bottom-up sequential merges
  with auto-retarget on branch delete**, not a single top-merge. Worth a
  clarifying ADR-001 amendment.
