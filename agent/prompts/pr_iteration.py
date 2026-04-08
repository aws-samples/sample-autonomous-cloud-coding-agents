"""Workflow section for pr_iteration (iterate on an existing PR)."""

PR_ITERATION_WORKFLOW = """\
## Workflow

You are iterating on an existing pull request (PR #{pr_number}). Your goal is to \
address review feedback and push updates to the same branch.

Follow these steps in order:

1. **Understand and triage the review feedback**
   Read all review comment threads and conversation comments on the PR carefully. \
For each review thread, classify it as:
   - **Actionable** — the request is clear and you can address it directly.
   - **Needs clarification** — the request is ambiguous, contradictory, or you \
cannot determine what change is being asked for. Do not guess — ask for clarification.
   - **Won't address** — the request is out of scope for this iteration, or you \
disagree with the suggestion (explain why in your reply).

2. **Address the actionable feedback**
   Make focused changes to address the review feedback you classified as actionable. \
Only change what the reviewers requested — do not refactor unrelated code or add \
unrequested features.

3. **Test your changes**
   This step is MANDATORY — do NOT skip it.
   - Run the project build: `mise run build`
   - Run linters and type-checkers if available.
   - If the project has tests, run them (e.g., `npm test`, `pytest`, `make test`).

4. **Commit and push to `{branch_name}`**
   After each logical unit of work, commit and push:
   ```
   git add <specific files>
   git commit -m "<type>(<module>): <description>"
   git push origin {branch_name}
   ```
   Follow the repo's commit conventions if specified in CONTRIBUTING.md, \
CLAUDE.md, or prior commits. If no convention is apparent, default to \
conventional commit format (`<type>(<module>): description`). \
Do NOT accumulate large uncommitted changes — pushing frequently is your \
durability mechanism.

5. **Reply to each review comment thread**
   For each review comment thread listed in the Review Comments section above, \
reply directly to that thread using the GitHub API:
   ```
   gh api repos/{repo_url}/pulls/{pr_number}/comments/<comment_id>/replies \\
     -f body="<your reply>"
   ```
   Replace `<comment_id>` with the top-level comment ID shown next to each \
thread (e.g. `reply with comment_id: 12345678`).

   Your reply MUST follow these guidelines:
   - **If you addressed the comment**: Briefly explain what you changed, the rationale, and in \
which commit. Example: "Fixed in abc1234 — added the null check as suggested."
   - **If you need clarification**: Explain what is unclear and ask a specific \
question. Example: "I'm not sure what validation you'd like here — should this \
reject empty strings, or only null/undefined values?"
   - **If you won't address it**: Explain why (out of scope, disagree, etc.). \
Example: "This is outside the scope of this PR — I'll open a separate issue for it."
   - Keep replies concise and factual.

6. **Post a summary comment on the PR**
   When done, add a top-level summary comment to the PR:
   ```
   gh pr comment {pr_number} --repo {repo_url} --body "<summary>"
   ```
   The summary must include:
   - What was changed to address feedback
   - Which comments were addressed (brief list)
   - Which comments need clarification from reviewers
   - Build and test results (what commands were run, pass/fail)\
"""
