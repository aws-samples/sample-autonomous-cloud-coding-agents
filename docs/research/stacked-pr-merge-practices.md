# Stacked PR merge practices — research findings

> Compiled to settle how ABCA's Linear orchestration should structure child
> PRs and how they get merged. Sources were fetched directly (URLs inline).
> Where a claim is industry practice rather than documented behavior, it is
> labelled.

## TL;DR

- **Children stack.** PR-A targets main, PR-B targets A's branch, and PR-C
  targets B's branch.
- **A downstream PR does NOT wait for upstream PRs to merge.** C's branch
  is cut from B's branch, which was cut from A's branch, so C's branch
  *already physically contains* A's and B's commits. C's author or agent
  works on top of them immediately. C's PR *diff* shows only C's changes,
  because it is diffed against B. The review status of A and B is
  irrelevant to this.
- **Merge is bottom-up, one PR at a time.** It is NOT "merge the top and the
  whole stack lands." Merge A, then B, then C.
- **GitHub auto-retargets** the dependent PRs as lower ones merge, but
  only **when you delete the merged head branch** (see the exact quote).
- **Auto-merging a stack** is a real, supported pattern through merge queues,
  gated on required approvals and green CI. It is a deliberate follow-up for
  ABCA, not MVP. The first orchestration release explicitly leaves
  "auto-merge when all children complete" out of scope.

## Q1/Q2 — Merge flow + retargeting (GitHub native)

**GitHub automatically retargets dependent PRs when the merged branch is
deleted**, not on the merge itself:

> "If you delete a branch that has open pull requests based on it, GitHub
> automatically updates any such pull requests, changing their base
> branch to the merged pull request's base branch."
> — GitHub Docs, *Deleting and restoring branches*
> https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-repository

In practice, for a stack A←B←C, merge A to `main` and delete `feat/A`.
B's base then flips automatically from `feat/A` to `main`, and B's diff
stays clean. The diff no longer double-counts A's commits, because A is now
in main. Repeat for B, then C. This is the **bottom-up, one-at-a-time**
model.

## Q3 — How downstream work proceeds during review (the key mechanic)

Stacking decouples *building dependent work* from *merging*. From the
Pragmatic Engineer analysis of stacked diffs
(https://newsletter.pragmaticengineer.com/p/stacked-diffs):

> stacks "can be built continuously, one on top of the other, allowing
> engineers to stay unblocked."

The unit of change becomes the individual commit or diff, each of which
"can be tested, reviewed, landed, and reverted individually." The
dependency is physical (git branch lineage), so a downstream change sees
upstream code the moment the branch exists, with **no waiting for merge.**

When an upstream PR changes after review, the stack must be **restacked**
(rebased): "later diffs cannot be landed to the main branch while they
don't contain changes from the updated Diff 1". The fix is
`git rebase -i` up the stack (Pragmatic Engineer). Tools (ghstack,
Graphite) automate this restack.

## Q4 — Tooling: ghstack (Meta's open-source tool)

ghstack (https://github.com/ezyang/ghstack) is a tool to "Conveniently
submit stacks of diffs to GitHub as separate pull requests."
- Each commit on top of `main` becomes its own PR.
- Land with `ghstack land $PR_URL`. The command lands a ghstack'd PR and
  handles the base rewriting, so the rest of the stack stays correct.
- To stack another PR, `git commit` on top and re-run `ghstack`.
This is the closest reference for an **automated agent** that opens stacked
PRs: one branch and one PR per commit, and the tool owns the base-branch
bookkeeping.

## Q5 — Auto-merging a stack (GitHub merge queue)

GitHub **merge queue** supports ordered, stack-like merging
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue):

- Entry gate: "Once a pull request has passed all required branch
  protection checks, a user with write access ... can add the pull
  request to the queue." So **required status checks and approvals** gate
  it.
- Ordering: "merged in a first-in-first-out order where the required
  checks are always satisfied."
- Stacking semantics: each queued PR's temporary branch "contains code
  changes from the target branch, pull request #1, and pull request #2".
  That is, later entries build on earlier ones, exactly like a stack.
- Caveat: a merge queue cannot be used with wildcard (`*`) branch
  protection patterns.

So "auto-merge the stack once all green + approved" is a real pattern, but
it depends on branch-protection and merge-queue configuration. That
configuration is a policy decision per repo or per project, hence a
follow-up for ABCA rather than MVP.

## On research papers

Stacked diffs is an **industry practice**, not an academic topic. There
is no peer-reviewed literature on the mechanics of "stacked PRs". The
scholarly grounding is for the *premise* (small, incremental changes review
better), not for the stacking technique:
- Bacchelli & Bird, *Expectations, Outcomes, and Challenges of Modern Code
  Review*, ICSE 2013. It is a foundational empirical study of modern code
  review.
- Rigby & Bird, *Convergent Contemporary Software Peer Review Practices*,
  FSE 2013. It documents the review of small, incremental changes.
Treat the blogs and tool docs above as authoritative for the *mechanics*.
The papers justify only *why small stacked PRs beat one large PR*.

## Implications for ABCA's orchestration

- **Base-branch targeting.** Child B's branch must be cut from A's
  branch, and B's PR `base` must be set to `feat/A` (the GitHub API `base`
  parameter on `POST /repos/{owner}/{repo}/pulls`). Roots target `main`.
  With that, a downstream child sees upstream code without waiting on
  merges.
- **Rollup + docs.** The phrase "orchestration complete" means *all child
  PRs opened*, NOT merged. Document the **human bottom-up merge +
  delete-branch (for auto-retarget)** flow. Auto-merge stays a follow-up. It
  would be a per-project opt-in, gated on approvals and CI through a merge
  queue.
- **ADR-001 ambiguity to resolve.** The ADR says both "PR N targets PR
  N-1's branch" and "Final PR merges the full stack to main." Given GitHub's
  actual behavior, the correct reading is **bottom-up sequential merges
  with auto-retarget on branch delete**, not a single top-merge. This is
  worth a clarifying amendment to ADR-001.
