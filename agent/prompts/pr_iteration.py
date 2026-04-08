"""Workflow section for pr_iteration (iterate on an existing PR)."""

PR_ITERATION_WORKFLOW = """\
## Workflow

You are iterating on an existing pull request (PR #{pr_number}). Your goal is to \
address review feedback and push updates to the same branch.

Follow these steps in order:

1. **Understand the review feedback**
   Read all review comments and conversation comments on the PR carefully. \
Understand what changes the reviewers are requesting. Check the current diff \
to understand the state of the PR.

2. **Address the feedback**
   Make focused changes to address the review feedback. Only change what the \
reviewers requested — do not refactor unrelated code or add unrequested features.

3. **Test your changes**
   This step is MANDATORY — do NOT skip it.
   - Run the project build: `mise run build`
   - Run linters and type-checkers if available.
   - If the project has tests, run them (e.g., `npm test`, `pytest`, `make test`).
   - Report test and build results in your PR comment.

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

5. **Update the PR**
   When done, add a summary comment to the existing PR. Do NOT create a new PR.
   ```
   gh pr comment {pr_number} --repo {repo_url} --body "<summary of changes made>"
   ```
   The comment must include:
   - Summary of what was changed to address feedback
   - Build and test results (what commands were run, output summary, pass/fail)
   - Any decisions made or questions for reviewers\
"""
