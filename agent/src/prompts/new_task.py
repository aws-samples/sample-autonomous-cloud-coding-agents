"""Workflow section for new_task (create a new PR)."""

NEW_TASK_WORKFLOW = """\
## Workflow

Follow these steps in order:

1. **Understand the codebase**
   Read relevant files, check the project structure, look at existing tests, \
build scripts, and CI configuration. Understand the project before changing it.

2. **Work on the task**
   Make the necessary code changes. Be thorough but focused — only change what \
the task requires. Do not refactor unrelated code.

3. **Test your changes**
   This step is MANDATORY — do NOT skip it.
   - Run the project build: `mise run build`
   - Run linters and type-checkers if available.
   - If the project has tests, run them (e.g., `npm test`, `pytest`, `make test`).
   - If the project has no tests, validate your changes manually (e.g., syntax \
check, dry-run) and note this in the PR.
   - Report test and build results in the PR description — both passes and failures.

4. **Commit and push frequently**
   After each logical unit of work, commit and push:
   ```
   git add <specific files>
   git commit -m "<type>(<module>): <description>"
   git push -u origin {branch_name}
   ```
   Follow the repo's commit conventions if specified in CONTRIBUTING.md, \
CLAUDE.md, or prior commits. If no convention is apparent, default to \
conventional commit format (`<type>(<module>): description`). \
Do NOT accumulate large uncommitted changes — pushing frequently is your \
durability mechanism.

5. **Create a Pull Request**
   When the work is complete (or after exhausting attempts), you MUST create a PR. \
Do NOT skip this step or tell the user to do it manually.

   The PR body must include a section titled "## Agent notes" with:
   - What went well and what was difficult
   - Any patterns or conventions you discovered about this repo
   - Suggestions for future tasks on this repo

   Run:
   ```
   gh pr create --repo {repo_url} --head {branch_name} --base {default_branch} --title "<type>(<module>): <description>" --body "<body>"
   ```
   Follow the repo's PR title conventions if specified. If no convention is \
apparent, use conventional commit format: `<type>(<module>): description`. \
Examples:
   - `feat(auth): add OAuth2 login flow`
   - `fix(api): handle null response from payments endpoint`
   - `chore(github): update RFC issue template`
   - `docs(readme): add deployment instructions`
   The `<module>` is a short identifier for the area of the codebase being changed \
(e.g., `auth`, `api`, `github`, `ci`, `docs`). Never omit the module scope.

   The PR body must include:
   - Summary of changes
   - Link to the issue (if provided)
   - Build and test results (what commands were run, output summary, pass/fail)
   - Decisions made (if the task was ambiguous, explain your choices)
   - The following sentence: "By submitting this pull request, I confirm that you \
can use, modify, copy, and redistribute this contribution, under the terms of \
the [project license](https://github.com/krokoko/agent-plugins/blob/main/LICENSE)."\
"""
