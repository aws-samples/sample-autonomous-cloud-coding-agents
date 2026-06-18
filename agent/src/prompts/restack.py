"""Workflow section for restack (#305 A6 — re-merge a changed predecessor).

A stacked child's predecessor PR was edited after the child already merged the
predecessor's code in, so the child is stale. The platform re-runs the child on
its EXISTING branch with the updated predecessor branch(es) merged into the
working tree before the agent starts (same mechanism as the initial A4 diamond
merge). The agent's job is narrow: reconcile, verify, push to the same branch —
NOT new feature work.
"""

RESTACK_WORKFLOW = """\
## Workflow

You are RE-STACKING an existing pull request branch (`{branch_name}`). A
predecessor branch this work was built on has changed, and its updated code has
already been merged into your working tree before you started. Your only job is
to reconcile that update — do NOT add features or change scope.

Follow these steps in order:

1. **Assess the merged-in predecessor changes**
   The setup notes above record which predecessor branch(es) were merged in and
   whether the merge was clean or left conflicts. Read them first.
   - If a merge was aborted due to conflicts, the predecessor branch is fetched
     as `origin/<pred-branch>`; merge it now and resolve the conflicts so your
     branch contains both your original work AND the updated predecessor code.
   - If the merge was clean, just verify your original changes still apply on top
     of the updated predecessor code (the predecessor may have moved code you
     depended on).

2. **Reconcile — keep BOTH sides**
   The goal is a branch that has your sub-issue's changes correctly layered on
   the predecessor's NEW code. Do not drop your work, and do not revert the
   predecessor's update. Resolve conflicts by integrating both intents.

3. **Test your changes (MANDATORY)**
   - Run the project build: `mise run build`
   - Run linters/type-checkers if available.
   - Run tests if the project has them (`npm test`, `pytest`, `make test`).
   - The combined result must build — a re-stack that doesn't build is worse
     than the stale state it replaced.

4. **Commit and push to `{branch_name}` (the SAME branch — do not create a new one)**
   ```
   git add <specific files>
   git commit -m "chore(restack): re-merge updated predecessor into {branch_name}"
   git push origin {branch_name}
   ```
   Pushing to the existing branch updates the existing PR in place — the
   platform does NOT open a new PR for a re-stack.

5. **Post a brief summary comment on the PR**
   ```
   gh pr comment {pr_number} --repo {repo_url} --body "<summary>"
   ```
   Note which predecessor change was absorbed, any conflicts resolved, and the
   build/test result. Keep it concise — this is a maintenance update, not a new
   review.\
"""
