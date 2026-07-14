# Automated PR review gate setup guide

Wire your repo so that when a pull request's CI finishes, ABCA automatically triages it and — once it's green and up to date — kicks off a structured [`coding/pr-review-v1`](./USER_GUIDE.md) review, posting the findings back on the PR. The goal is to keep up with AI-authored PR volume: a review is waiting by the time a human looks, and review compute is never spent on a PR whose tests are red.

> This gate is **advisory and comments-only** — it never posts a check-run, commit status, or formal approve/request-changes review. It cannot block a merge or interfere with your branch-protection rules or [Mergify](../../.mergify.yml) queue. It only reads CI state, posts one edit-in-place comment, and (on green) fires the review webhook.

## What you get

When `build` (or `integ`) completes on an open PR, the gate evaluates the PR head and does exactly one of:

| PR state | What the gate does |
|---|---|
| **CI failing** | Edits a single `❌ CI is failing` comment listing the failing check names. **No review is triggered** — no wasted compute. Re-checks on every later CI run. |
| **CI still pending** | Polls briefly, then exits quietly. The next CI completion re-evaluates. |
| **Merge conflict** (`dirty`) | Edits a `⚠️ Merge conflict` comment asking the author to resolve and push. |
| **Behind base, no conflict** | Calls GitHub's [update-branch API](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch) to merge the base in so CI re-runs, then comments `🔄 Updated branch`. (Fork PRs get a "please update your branch" comment instead — see [Fork PRs](#fork-prs-vs-same-repo-branches).) |
| **Green + up to date** | HMAC-signs and POSTs to the ABCA Task API webhook to start a `coding/pr-review-v1` review, then comments `🤖 ABCA review requested`. Findings post shortly after. |

All status lives in **one** comment per PR (marked with a hidden `<!-- abca-review-gate -->`), edited in place — the gate never spams. Review triggering is idempotent per commit SHA, so re-runs on the same commit don't re-review; a new commit does.

## How it works

```
build / integ completes → workflow_run (trusted base-repo context)
                                    ↓
                        review-gate.yml resolves PR head SHA
                                    ↓
              aggregate check-runs + commit statuses for that SHA
                        ┌───────────┴────────────┐
                     failing/pending          all green
                        ↓                         ↓
              comment & stop           check mergeable_state
                                    ┌───────┬──────────┬─────────┐
                                  dirty   behind      clean/blocked
                                    ↓       ↓              ↓
                              comment   update-branch   HMAC POST
                                        (PAT, re-runs   /v1/webhooks/tasks
                                         CI)            {workflow_ref:
                                                         coding/pr-review-v1,
                                                         repo, pr_number}
                                                            ↓
                                                  ABCA read-only review agent
                                                  posts structured findings on PR
```

Design notes:

- **Runs in the trusted base-repo context.** The workflow triggers on `workflow_run` (not `pull_request`), so `secrets`/`vars`/the PAT are available even for fork PRs. No PR code is ever checked out or executed — the gate is pure `gh api` + `curl`.
- **Reviews on green + not-behind + not-dirty**, *not* strictly `mergeable_state == clean`. Under branch protection a green, conflict-free PR reports `blocked` (awaiting approval), never `clean` — and the whole point is to review *before* a human approves.
- **Auto-update needs a PAT.** A branch push made with the default `GITHUB_TOKEN` does not re-trigger `build` (GitHub's recursion prevention). The update-branch call uses `AUTOMATION_GITHUB_TOKEN` so CI re-fires and the gate re-pulses.
- **The review agent itself is read-only.** `coding/pr-review-v1` posts findings via the GitHub Reviews API as `COMMENT` (never approve/request-changes) — see the [User guide](./USER_GUIDE.md).

## Prerequisites

- ABCA stack deployed (`mise //cdk:deploy`) — note the `ApiUrl` stack output (it already includes the `/v1/` stage).
- The `bgagent` CLI installed and authenticated (`bgagent configure`, `bgagent login`).
- The target repo is **onboarded** to ABCA with a Blueprint (`bgagent repo …`) — `coding/pr-review-v1` requires an onboarded repo. Confirm with `bgagent repo list`.
- Admin access to the GitHub repo's **Settings → Secrets and variables → Actions** (to add repo vars/secrets).
- An `AUTOMATION_GITHUB_TOKEN` repo secret already exists (a PAT with `contents` + `pull-requests` write). It's shared with the `upgrade-main` / `auto-approve` workflows.

## Step-by-step setup

### Step 1 — Register an ABCA webhook

The gate authenticates to the Task API with a per-webhook HMAC secret. Mint one:

```bash
bgagent webhook create --name review-gate
```

Output (the secret is shown **once** — copy it now):

```
Webhook:     01J…              # ← this is ABCA_WEBHOOK_ID
Name:        review-gate
Created:     2026-07-14T…

Secret (store securely — shown only once):
a1b2c3…                        # ← this is ABCA_WEBHOOK_SECRET
```

The webhook's owning Cognito user must be allowed to submit `coding/pr-review-v1`. The secret is stored server-side at `bgagent/webhook/<webhook_id>` in Secrets Manager; the value you paste into GitHub below must match it exactly.

### Step 2 — Set the repo variables and secret

Using the [`gh` CLI](https://cli.github.com/) against your repo (or the GitHub UI, Settings → Secrets and variables → Actions):

```bash
REPO=<owner>/<repo>

# Variables (non-secret) — ApiUrl output, NO trailing slash (a trailing slash
# produces //webhooks/tasks and the call 404s):
gh variable set ABCA_TASK_API_URL --repo "$REPO" --body "https://<api-id>.execute-api.<region>.amazonaws.com/v1"
gh variable set ABCA_WEBHOOK_ID   --repo "$REPO" --body "01J…"

# Secret — the value printed by `bgagent webhook create`:
gh secret set ABCA_WEBHOOK_SECRET --repo "$REPO" --body "a1b2c3…"
```

`ABCA_TASK_API_URL` is the `ApiUrl` stack output verbatim (it already ends in `/v1`); the workflow appends `/webhooks/tasks`.

### Step 3 — Confirm the workflow is on the default branch

`workflow_run` workflows only run from the copy of the file on the repo's **default branch**. Merge `.github/workflows/review-gate.yml` to the default branch (it ships with the repo). It is inert on any other branch.

Until it's merged, you can exercise it manually: **Actions → review-gate → Run workflow**, pick the branch, and pass a `pr_number`.

### Step 4 — Smoke test

Verify the webhook end to end without waiting for a PR, using the same signing scheme the gate uses:

```bash
bgagent webhook test --repo <owner>/<repo> --secret "<ABCA_WEBHOOK_SECRET>"
```

A `2xx` means the webhook + secret are wired correctly. Then open a small test PR and watch the `review-gate` workflow run in the Actions tab: a red PR should get the `❌ CI is failing` comment; a green one should get `🤖 ABCA review requested` followed by the agent's review.

## Fork PRs vs same-repo branches

The gate handles both, but auto-update differs:

- **Same-repo branch PRs** (the common case, e.g. `bgagent/…` branches the agent opens on your fork): a `behind` branch is auto-updated via the PAT, CI re-runs, and the gate re-pulses to green.
- **Cross-fork PRs**: GitHub's update-branch API requires "Allow edits by maintainers" **and** PAT write access to the fork, which usually isn't available. When the head repo differs from the base repo and the branch is behind, the gate posts a "please update your branch" comment instead of attempting the API call.

## Excluding some PRs from auto-review (optional)

By default the gate evaluates **every** open PR whose CI completes, including autonomous `bgagent/…` PRs. If you'd rather not auto-review certain PRs (e.g. to save compute on throwaway ones), filter in the resolve step of `review-gate.yml` — for example, skip when the head branch matches a prefix or the author is a bot. This is a workflow edit and is CODEOWNERS-gated to admins upstream.

## Troubleshooting

### The `review-gate` workflow doesn't run at all

- It only fires from the **default-branch** copy of the file. Confirm `.github/workflows/review-gate.yml` is on the default branch, not just a feature branch.
- It triggers on `build`/`integ` completion. A PR that hasn't had `build` run yet won't have pulsed the gate — push a commit or use **Run workflow** (`workflow_dispatch`).

### Gate logs `ABCA webhook not configured`

One of `ABCA_TASK_API_URL` / `ABCA_WEBHOOK_ID` (repo **variables**) or `ABCA_WEBHOOK_SECRET` (repo **secret**) is unset. Note vars and secrets are separate GitHub stores — check both. Re-run Step 2.

### Task API returns 401 / 403

The signature didn't verify. Almost always the `ABCA_WEBHOOK_SECRET` in GitHub doesn't match the value stored at `bgagent/webhook/<id>` in Secrets Manager — re-run `bgagent webhook create` and update the secret, or confirm you copied the full value. (The secret is only shown at creation; if you lost it, create a new webhook.)

### Task API returns 422 `repo not onboarded`

`coding/pr-review-v1` requires the repo to be onboarded with a Blueprint. Run `bgagent repo list` and onboard it if missing.

### A green PR isn't triggering a review

- Check the run log for the resolved `mergeable_state`. `dirty`/`behind` are handled separately (conflict/update comments). Only genuinely green + not-behind + not-dirty triggers a review.
- Review triggering is per-SHA idempotent. If the gate already commented `🤖 ABCA review requested` for the current commit, it won't fire again until a new commit lands.

### The branch was auto-updated but approvals disappeared

Expected. Mergify's "dismiss stale approvals on new commits" treats the update-branch merge commit as a push, so prior approvals are dismissed and re-approval is required after CI re-runs — the intended invariant, not a regression.
