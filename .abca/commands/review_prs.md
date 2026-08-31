# Review Multiple Pull Requests in ABCA

## Persona

Hold the same bar as [`review_pr`](./review_pr.md): a **Principal AWS Solutions Architect** who
is direct, specific, justifies every concern with a concrete risk and a `file:line`, distinguishes
blocking issues from nits, and never rubber-stamps. This command orchestrates that single-PR
review across a *set* of PRs — it does **not** restate the review process. Each PR is reviewed by
the full `review_pr` workflow, so the review bar stays single-sourced.

This is **ABCA (Autonomous Background Coding Agents on AWS)** — a self-hosted platform for
background coding agents. Bounded blast radius applies to the *reviewer* too: this command can
fan out many concurrent sub-reviews, so it is explicit about scope, cost, and what it skips.

**How the fan-out runs — and why it keeps the caller's context fresh.** Stage 1 (scouting the
work-list) runs inline in the main context; it is small and cheap. Stage 2 (the per-PR reviews)
runs as a **`Workflow`** — a deterministic multi-agent orchestration — *not* as prose-directed
subagent dispatch. Each PR's heavy work (a large diff, the three nested `review_pr` review agents,
the full review body) is confined to a Workflow-spawned subagent's context; only a **small
structured result per PR** (number, verdict, one-line rationale, review URL) returns to the caller.
Making the fan-out a `Workflow` means that isolation is a property of the control flow, not
something an executor must remember to do — so a large queue can't blow the main window on diff
bodies and agent transcripts. (Caveat: per-PR *summaries* still accrete linearly in the caller, so
"fresh" ≠ "constant" — a 200-PR run still returns 200 rows.)

## Execution context — interactive operator only

**This is an interactive Claude Code / Cursor command, run by a human operator. It is NOT — and
cannot be — executed by ABCA's headless agent runtime.** The distinction matters because Stage 2's
core tool, `Workflow`, is unavailable to headless tasks by construction:

- The runtime hard-blocks `Workflow` via a **deny-list**, which is the load-bearing mechanism.
  `agent/src/runner.py` passes `disallowed_tools=_DISALLOWED_TOOLS` (`= ["Workflow", "Task", "Agent",
  "Monitor", "SendMessage", "CronCreate", "CronDelete", "CronList"]`) to `ClaudeAgentOptions` — the
  incident-driven hardening after a repo-less task launched a detached background `Workflow` and
  finalized on a placeholder. This is the *only* thing that removes the tool from the surface: the
  runtime runs under `permission_mode="bypassPermissions"`, so a tool that is merely **absent from
  the `allowed_tools` auto-approve list is auto-*allowed*, not blocked** (runner.py is emphatic:
  "`disallowed_tools` is the only hard lock … do not rely on this allow-list, nor on Cedar, to remove
  a tool from the surface" — Cedar PreToolUse default-permits on no-match). So the guarantee rests on
  `disallowed_tools`, not on `Workflow` being off the allow-list. Interactive Claude Code / Cursor
  sessions are not gated this way, so `Workflow` is available there — which is where this command runs.
- The runtime loads project `.claude/` config only when a repo is cloned:
  `_resolve_setting_sources(config)` returns `["project"]` when `config.repo_url` is set and `[]`
  for a repo-less task (defense-in-depth that also stops a stray on-disk skill from being reachable).
  So this command's stub **is** discoverable to a repo-cloning task — which is exactly why the
  `disallowed_tools` block, not mere obscurity, is the guarantee: even though the file is on disk and
  reachable on that path, the tool it calls is off the surface.
- The read-only review workflow (`coding/pr-review-v1`) cannot be steered into `/review_prs`: it is
  bound to a fixed `pr_review` system prompt (`PR_REVIEW_WORKFLOW` in `agent/src/prompts/pr_review.py`,
  selected by `get_system_prompt` in `agent/src/prompts/__init__.py`) that drives the agent through
  fixed steps — there is no "invoke a slash command" path, and `Workflow` is deny-listed regardless.
  (The `coding/pr-review-v1 → pr_review` entry in `agent/src/workflow/loader.py` is the Cedar
  *principal* audit tag, not the prompt binding.)

In short: operators run `/review_prs`; the ABCA runtime never does, and structurally cannot.

## Arguments

Optional.

- **No arguments** — review every PR that currently requests your review (the default query in
  Stage 1).
- **Explicit list** — e.g. `#616 #612 590` — review exactly those PRs, skipping Stage-1 derivation.
- **Natural-language filter** — e.g. "all open non-fork PRs with green CI", "everything P1 and
  above requesting my review" — translate to the appropriate `gh` search and gates in Stage 1.

## Stage 1: Build the work-list

Derive the candidate PRs. The default set is *ready-to-review, not mine, not yet approved by me,
requesting my review, excluding forks*:

```sh
gh pr list --repo <owner>/<repo> \
  --search "is:open is:pr draft:false -author:@me -review:approved review-requested:@me" \
  --json number,isCrossRepository,headRepositoryOwner \
  --jq '.[] | select(.isCrossRepository == false) | .number'
```

- **Fork exclusion is client-side.** GitHub's issue/PR search has **no fork qualifier** — `is:fork`
  is a *repository*-search qualifier and is silently ignored in a PR search (it returns a superset,
  not an error). Filter on `isCrossRepository == false` (a PR whose head branch lives in a fork is
  cross-repository); `headRepositoryOwner.login` (fetched above) tells you *which* fork — surface it
  when announcing a dropped cross-repo PR (e.g. `#42 — dropped: fork PR from acme-labs`).
- **Optional CI-green gate (only when the user asks for "green" / "passing" / "CI clean").** Keep a
  PR iff its checks are all terminal **and** all passed — i.e. `gh pr checks <n>` exits `0`. Do
  **not** pass `--json` to `gh pr checks` in the gate: with `--json` it always exits `0` and the
  exit code stops meaning anything (use `--json state,bucket` only for *reporting* the state). The
  gate is opt-in, not the default: a red or still-running PR is often exactly the one that needs a
  "request changes", so gating it out by default would hide the work.
- **Announce what you drop.** For every PR removed by the CI gate (or any other filter), say so and
  why. Silent truncation reads as "reviewed everything" when it wasn't.
- **Empty list** — if nothing matches, say so and stop. Never invent PR numbers.
- **Transient by design** — submitting a review clears `review-requested:@me`, so re-running the
  default query later returns a *different* set. That is correct for a worklist; do not treat it as
  a bug or try to re-review already-reviewed PRs.

Present the resolved list (with the reason any candidate was dropped) before fanning out.

## Stage 2: Fan out via `Workflow` — one full `review_pr` per PR

Run the per-PR reviews as a **`Workflow`**, not as inline subagent dispatch. The `Workflow` tool
requires explicit opt-in — reaching for it here is warranted because the user invoked a batch
review, and it is what keeps the diffs and nested-agent transcripts out of the caller's context
(see the Persona note). For a **single** PR, skip the Workflow and just run `review_pr` directly —
orchestration overhead isn't worth it for `N == 1`.

**Pre-stage shared git state ONCE, inline, before invoking the Workflow** — worktree/branch
creation mutates shared `.git` state and must not race across concurrent agents:

1. `git fetch origin main` (single fetch; reason about base freshness against the current tip).
2. Per PR: fetch its head with a **forced** refspec — `git fetch origin +pull/<n>/head:pr<n>head`
   (the leading `+` overwrites an existing `pr<n>head`, so a re-run after an interrupted or
   uncleaned run doesn't fail on the stale local branch). Add a worktree on that ref, dump
   `gh pr diff <n>` to a scratch file, and capture the head SHA (`gh pr view <n> --json
   headRefOid`) and base branch (`--json baseRefName`). Use a run-scoped scratch dir (e.g. a
   per-invocation temp path) so concurrent or repeated runs don't collide on worktree paths.

Assemble one descriptor per PR — `{ number, worktreePath, diffPath, headSha, baseRef }` — and pass
the **array** as the Workflow's `args`. Then invoke `Workflow` with a self-contained script that:

- reads the descriptors from `args` and fans out **one agent per PR concurrently** (`parallel()`
  over the descriptors, or `pipeline()` if you add a downstream stage); the tool caps real
  concurrency, so pass all PRs — they queue and drain automatically.
- has each agent execute the full [`review_pr`](./review_pr.md) workflow for its PR and **submit**
  the review (inline suggestions + an Approve / Comment / Request-changes decision) via the Stage-3
  mechanism. The agent prompt must include that PR's `worktreePath`, `diffPath`, `headSha` (the
  review `commit_id`), and `baseRef` — and **flag stacked PRs** whose `baseRef != main` (the diff
  is against the base branch, not `main`, and merge order matters).
- carries the standing `review_pr` governance rule into each agent prompt: the gate is an
  **approved backing issue** (see
  [ADR-003](../../docs/decisions/ADR-003-contribution-governance.md)); a `pr/*` branch name is a
  de-facto-waived nit, **not** a blocker. Each agent must **read existing review threads first**
  and independently verify any prior blocking claim against current code before finalizing.
- returns a **compact `schema`-validated result per PR** — `{ number, verdict, rationale,
  reviewUrl }` — and nothing larger. The `schema` is what guarantees only the summary crosses back
  to the caller; without it an agent's free-text return could drag a full review body into the main
  context, defeating the freshness goal. The Workflow's return value is the array of these results.

Sketch (illustrative — adapt names/paths):

```js
export const meta = {
  name: 'review-prs',
  description: 'Review a set of PRs, one review_pr per PR, return compact verdicts',
  phases: [{ title: 'Review' }],
}
const RESULT = { type: 'object', required: ['number', 'verdict', 'rationale', 'reviewUrl'], properties: {
  number: { type: 'number' },
  verdict: { enum: ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] },
  rationale: { type: 'string' },
  reviewUrl: { type: 'string' },
} }
const results = await parallel(args.map((pr) => () =>
  agent(
    `Run the /review_pr workflow for PR #${pr.number} and SUBMIT the review with inline ` +
    `suggestions. Worktree: ${pr.worktreePath}. Diff: ${pr.diffPath}. commit_id: ${pr.headSha}. ` +
    `Base: ${pr.baseRef}${pr.baseRef !== 'main' ? ' (STACKED — diff is vs the base branch)' : ''}. ` +
    `Governance: gate is an approved backing issue; a pr/* branch is a waived nit. Read existing ` +
    `review threads first and verify prior blocking claims. Submit via gh api (see Stage 3).`,
    { label: `review:#${pr.number}`, phase: 'Review', schema: RESULT },
  )))
return results.filter(Boolean)
```

Scale the depth to the request inside each agent: a routine queue is one agent per PR running
`review_pr` once; "audit these thoroughly" lets each agent invoke the deeper Stage-3 agent fan-out
that `review_pr` itself prescribes.

## Stage 3: Submit & report

- **Submission mechanism** — the GitHub MCP `pull_request_review_write` tool may lack the required
  token scope (`Resource not accessible by personal access token`). When it does, submit via the
  `gh` CLI instead:

  ```sh
  gh api --method POST repos/<owner>/<repo>/pulls/<n>/reviews --input <review>.json
  ```

  where `<review>.json` has `commit_id`, `event` (`APPROVE` | `COMMENT` | `REQUEST_CHANGES`),
  `body`, and `comments[]`. Inline comments must anchor to a line present on the **RIGHT** side of
  the diff, or the call returns `422` — move any such finding into the review body instead.
  Each Workflow agent submits its own review this way from inside its context — the review bodies
  never return to the caller (only the compact `schema` result does).
- **Clean up — unconditionally.** Remove every per-PR worktree (`git worktree remove --force`) and
  `pr<n>head` branch created in Stage 2, **whether the Workflow succeeded, threw, or the run was
  interrupted** — not only on the happy path. A partial or failed run still leaves worktrees and
  branches in the shared `.git`, so treat teardown as a `finally`, not a trailing step: bounded
  blast radius applies to the reviewer too. (The forced refspec in Stage 2 also lets a later run
  self-heal if a crash skipped teardown entirely.)
- **Report** — assemble a summary table from the Workflow's returned results:
  **PR · verdict · one-line rationale · review URL**. Include the count reviewed and the count
  (and reasons) dropped in Stage 1.

## Notes

- This command is a thin orchestrator over `review_pr`. It intentionally does not duplicate the
  review stages, agent-invocation requirements, or output structure — refinements to the review bar
  land in [`review_pr`](./review_pr.md) and are inherited here automatically.
- The Stage-2 fan-out uses the **`Workflow`** tool so context-freshness is enforced by the control
  flow rather than left to an executor following prose. This command *uses* `Workflow`; it does not
  modify orchestration infrastructure. Git pre-staging (worktrees/branches) stays inline before the
  Workflow because it mutates shared `.git` state and must not race across concurrent agents.
